/**
 * Irmia Agent — `send_media` 的宿主侧投递口（从 main.ts 里抽出来，好用用例把这条胶水钉住）
 *
 * 为什么单独一个文件：工具层有测、通道层有测，但**中间这段胶水**原来写在 main.ts 里，
 * 一次都没被执行过（验收脚本照出来的正是这一类）。它的三条规则都很实在：
 *
 *   ① **只读允许根里的文件**：`resolve` 之后必须真的落在某个允许根里面——`../` 绕出去、
 *      同前缀的兄弟目录（`data-evil/`）都要挡住；
 *   ② 读到字节交给通道层（工具层自己不碰字节：它只递路径）；
 *   ③ **网络地址直接透传**：让平台自己去回源，我们不做下载中转。
 *
 * **两个允许根，按顺序试（P1，2026-10-04）**：这段注释原来写着"与 fs 工具同一条边界，
 * 落在 `dataDir` 里面"——那句话是错的，而且错得有代价。fs 那一族的边界是
 * `ctx.workspaceRoot`（**仓库根**），`http_download` 也落在那里；而这里只认 `<dataDir>`
 * （= `data/`）。于是她**下载下来的图发不出去**（实测 t285 连撞两次才试对路径）。
 *
 * 为什么不是"把根换成仓库根"：她四天里发成的 32 次媒体，路径形态都是
 * `workspace/tmp/irmia_selfie_*.png` —— 那是相对 `<dataDir>` 写的（落在 `data/workspace/tmp/`）。
 * 换成仓库根会让这 32 次里的一律指到仓库根那个**同名** `workspace/` 上去，等于修一半坏一半。
 * 两个根都要能到，所以是"**按顺序试、第一个存在的赢**"：
 *
 *   候选 1 = `resolve(dataDir, path)`（她既有的写法走这条）
 *   候选 2 = `resolve(workspaceRoot, path)`（`http_download` 的落点走这条）
 *
 * 顺序固定 + 存在性判定 ⇒ 确定性（同一份盘、同一个输入，永远同一个结果）。
 * **每个候选必须落在它自己的根之内**才算数，所以 `../` 一律两个候选都过不了——
 * 允许根变多了，"能绕出去的地方"一点没多。
 *
 *   ④ **受保护路径（凭据）不外发**（2026-10-05，用户点名）：`data/.keys.json` 这类凭据文件
 *      落在允许根里，于是"发得出去"曾经是成立的——读到本机文件与把密钥交给第三方通道
 *      是两件事，后者必须单独挡。名单**不在这里另写一份**：装配层把同一份受保护路径
 *      （fs 写入口用的那份）传进来，判定复用 `fs/path-guard.ts` 的 `insideAny`。
 *      判定读的是 **realpath**：一个指向凭据的目录联接（`link/.keys.json`）绕不过去。
 *      拒绝发生在**读字节之前**——回执里因此不可能带上凭据内容。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

import { createChannelMediaPoster, type ChannelAdapter } from './qq-official.ts';
import { ONEBOT_CHANNEL_NAME, isOneBotFamilyChannel, parseReplyUrl as parseOneBotReplyUrl } from './onebot.ts';
import { parseReplyUrlAny, type MediaRequest, type ReplyOutcome, type ReplyTarget } from '../tools/admin.ts';
import { insideAny } from '../tools/fs/path-guard.ts';
import type { MediaPoster } from '../tools/admin.ts';

/** 单个媒体的大小上限：官方软限制 200MB（文件类），我们只做一道"别把内存打爆"的粗线 */
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

/**
 * **按回投地址分派**的媒体投递口（`send_media` 的唯一出口）。
 *
 * 为什么要有它（2026-10-07 对齐两条通道时补的）：在这之前，媒体投递口是**按通道名写死**的
 * 两处——`qq-official.ts` 的工厂只认 `qq:` 前缀与 `QQ_CHANNEL_NAME`，`main.ts` 也照着写死
 * "只有装了 QQ 官方通道才造它"。后果不是"少一个小功能"：OneBot 上 `send_media` **根本不存在**
 * （工具在、线没接），而她的工具清单是恒定的——她只会看到那件工具报"没有接线"。
 *
 * 分派判据与 `speak` 那条路**同一份**（`admin.parseReplyUrlAny`：scheme → 通道名 + chatType + chatId）：
 * 两条出口各写一份判据，迟早会出现"文本发得出去、媒体发不出去"这种只看名字看不出原因的错。
 * 名字之外的**能力**仍由通道自己说了算：没有 `sendMediaTo` 就如实说清是哪条通道、为什么不支持。
 */
export function createMediaDispatcher(
  channels: ReadonlyMap<string, ChannelAdapter>,
  options: { timeoutMs?: number } = {},
): MediaPoster {
  return {
    async post(target: ReplyTarget, media: MediaRequest): Promise<ReplyOutcome> {
      const parsed = parseReplyUrlAny(target.url);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      // ⚠️ 判据与 `admin.replyUrlForWake` **同一处**（`isOneBotFamilyChannel`，覆盖别名实例）。
      // 这一处**今天**其实不会出错：`parseReplyUrlAny` 认的是 URL 的 scheme（`onebot:`），
      // 它返回的 `parsed.channel` 已经归一了。但它与 `replyUrlForWake` 是**同一件事的两份写法**——
      // 哪天 `parseReplyUrlAny` 改成把别名原样带出来（那才是更忠实的做法），这里就会立刻漏判。
      // 所以两处共用同一个谓词：一处改、另一处跟着对，不再"只改了一处"。
      if (isOneBotFamilyChannel(parsed.channel)) {
        // OneBot 的媒体接口在它自己的模块里（`oneBotMediaCall` 把它翻成消息段/上传文件动作），
        // 地址解析也用它自己的那份（`onebot:c2c:` / `onebot:group:`）
        const poster = createChannelMediaPoster(channels, {
          channelName: ONEBOT_CHANNEL_NAME,
          parseUrl: (url) => {
            const one = parseOneBotReplyUrl(url);
            return one.ok ? { ok: true, chatType: one.chatType, chatId: one.chatId } : one;
          },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        return await poster.post(target, {
          fileType: media.fileType,
          ...(media.url === undefined ? {} : { url: media.url }),
          ...(media.data === undefined ? {} : { data: media.data }),
          ...(media.path === undefined ? {} : { path: media.path }),
          ...(media.name === undefined ? {} : { name: media.name }),
        });
      }
      const poster = createChannelMediaPoster(channels, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return await poster.post(target, media);
    },
  };
}

export interface WorkspaceMediaPosterOptions {
  /** 允许读取的第一个根（数据目录）。她的既有写法（`workspace/tmp/…`）相对它 */
  dataDir: string;
  /**
   * 允许读取的第二个根（**工作根 = 仓库根**，与 fs 工具族、`http_download` 同源）。
   * 省略时行为与从前一字不差（只有 `dataDir` 一个根）。
   */
  workspaceRoot?: string;
  /** 通道表（键是通道名） */
  channels: ReadonlyMap<string, ChannelAdapter>;
  /** 单文件字节上限（测试用） */
  maxBytes?: number;
  /**
   * 受保护路径（**绝对路径**，与 fs 工具族写入口用的是同一份名单）：这些文件**不许外发**。
   *
   * 为什么它与"写入口拒绝"共用一份名单：两类文件是同一批——钩子配置（定义「谁能改我」）
   * 与本机凭据（密钥、界面密码、webhook 凭据）。名单只有一处定义（装配层），
   * 每个消费点各自决定"怎么用"：写入口拒绝改写，这里拒绝发出去。
   * 不传 = 不设这道门（老调用点与单测行为不变）。
   */
  protectedPaths?: readonly string[];
}

/**
 * 造一个 `MediaPoster`：读允许根里的文件 → 交给通道层上传并发送。
 *
 * 没有 QQ 官方通道时调用方应该**不要装它**（工具会如实报"没有接线"）——这个工厂只管造，
 * 装不装是装配层的事。
 */
export function createWorkspaceMediaPoster(options: WorkspaceMediaPosterOptions): MediaPoster {
  const roots = [
    resolve(options.dataDir),
    ...(options.workspaceRoot === undefined ? [] : [resolve(options.workspaceRoot)]),
  ];
  const label = roots.join(' ｜ ');
  const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES;
  return {
    async post(target, media) {
      const poster = createMediaDispatcher(options.channels);
      // 已经是字节（宿主自己的调用方）或本来就是网络地址：直接交给通道层
      if (media.data !== undefined || media.path === undefined) {
        return await poster.post(target, media);
      }
      // 每个候选都必须落在**它自己的根**之内：`../` 于是两个候选都过不了，
      // 允许根从 1 个变成 2 个并没有让"能绕出去的地方"变多。
      const candidates: string[] = [];
      for (const root of roots) {
        const full = resolve(root, media.path);
        if (full !== root && !full.startsWith(root + sep)) continue;
        candidates.push(full);
      }
      if (candidates.length === 0) {
        return { ok: false, reason: `只能发工作区（${label}）里的文件，收到：${media.path}` };
      }
      const full = candidates.find((candidate) => existsSync(candidate));
      if (full === undefined) {
        return {
          ok: false,
          reason: candidates.length === 1
            ? `文件不存在：${media.path}`
            // 两个候选都试过还说"不存在"是不诚实的：把找过的地方摆出来，她才知道该往哪儿放
            : `文件不存在：${media.path}（找过：${candidates.join(' ｜ ')}）`,
        };
      }
      // 受保护路径（本机凭据）：**在读字节之前**拒。按 realpath 判——允许根里的一个
      // 目录联接（`link/.keys.json`）在字符串层看不出问题，展开后才是真正要读的那个文件。
      const protectedPaths = options.protectedPaths ?? [];
      if (protectedPaths.length > 0) {
        const real = realpathSync(full);
        if (insideAny(protectedPaths, real)) {
          return {
            ok: false,
            reason:
              `拒绝外发：${basename(full)} 是本机凭据文件（受保护路径），不会交给任何通道。`
              + '要换密钥或密码请在设置页填写（或由人直接改盘上那份文件）；'
              + '确实需要把内容发出去时，请先复制一份、去掉敏感字段，再发那份副本。',
          };
        }
      }
      let size: number;
      try {
        const stat = statSync(full);
        if (!stat.isFile()) return { ok: false, reason: `不是一个文件：${media.path}` };
        size = stat.size;
      } catch (err) {
        return { ok: false, reason: `读文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      if (size > maxBytes) {
        return { ok: false, reason: `文件太大（${size} 字节，上限 ${maxBytes}）：${media.path}` };
      }
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(full);
      } catch (err) {
        return { ok: false, reason: `读文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      return await poster.post(target, { ...media, data: bytes, name: basename(full) });
    },
  };
}

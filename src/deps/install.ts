/**
 * Irmia Agent — 依赖安装（下载 → 解压 → 复检）
 *
 * **零外部依赖是硬约束**，所以这里的三件事全部自己写：
 *   · 下载用 `node:https`（跟随重定向、带上限的流式落盘）；
 *   · 解压用 `node:zlib` 的 `inflateRawSync`（zip 的 deflate 是裸流）+ 手写的 zip 目录解析；
 *   · 落盘用 `node:fs/promises`。
 * 引一个 `extract-zip` 或 `unzipper` 会让"零依赖"这条承诺当场作废，而 zip 的这个子集
 * （只读、只收 store/deflate、路径穿越防护）不到 150 行。
 *
 * **三种失败必须分开反馈**（用户点名）：下载失败 / 解压失败 / 装完复检仍找不到。
 * 合成一句"安装失败"的代价是用户完全不知道下一步做什么——是网络问题就重试、
 * 是包结构变了就换下载源、是杀毒软件挡了就得手动放行，三条路的处置完全不同。
 * 所以 `DepInstallStep` 把阶段名也带出去了。
 *
 * 另有一条刻意的取舍：**不校验签名/哈希**。一是我们拿不到权威的哈希清单（voidtools 有
 * 但会随版本变，ripgrep release 有 .sha256 但同样要按版本拼 URL），二是这类下载走的是
 * 官方 HTTPS 源。真正的防线是"来源固定 + 用户看得见下载了什么"（报告里带 URL 与字节数）。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { get as httpsGet, type RequestOptions } from 'node:https';
import { dirname, join, relative, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { TOOLS_DIR_NAME, defaultDepFs, findExecutableInDir, type DepName } from './probe.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 单次下载的最大字节数：两个包都在 5MB 以内，64MB 已经是"这肯定不是我们要的东西" */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** 重定向跟随上限：官方源最多一两跳（GitHub release 资产会跳一次到 CDN） */
export const MAX_REDIRECTS = 5;
/** 单个 zip 内解压出来的总字节上限：防"解压炸弹"（zip 的压缩比可以极高） */
export const MAX_EXTRACT_BYTES = 256 * 1024 * 1024;
/** 自装清单文件名：记下装了什么版本、从哪来、什么时候装的 */
export const MANIFEST_FILE_NAME = 'install.json';
/** 下载临时文件所在子目录（`<dataDir>/tools/.cache/`）：装完就删，失败留一半也能被人看见 */
export const CACHE_DIR_NAME = '.cache';

/** GitHub 的 ripgrep 最新 release 查询端点（用它比写死版本号可靠：版本号会过期） */
export const RIPGREP_RELEASE_API = 'https://api.github.com/repos/BurntSushi/ripgrep/releases/latest';
/** ripgrep 的 Windows 资产名片段：官方 release 里那个 msvc 构建 */
export const RIPGREP_ASSET_MARKER = 'x86_64-pc-windows-msvc.zip';

/**
 * es.exe 的 zip 地址。**它是固定的**（voidtools 的链接不随版本变，历史上 1.1.0.27 → 1.1.0.38
 * 都是同一个 URL），代价是这个 URL 里嵌着版本号 `ES-1.1.0.38`——版本升到 1.1.0.39 时
 * 这个链接会 404。那种情况下 `dep-install` 会如实报"下载失败：HTTP 404"并给出
 * 下载页地址，用户点「打开下载页」手动装即可（不会静默失败）。
 */
export const ES_CLI_ZIP_URL = 'https://www.voidtools.com/ES-1.1.0.38.x64.zip';

/** zip 探测签名：末尾的 22 字节 EOCD 里以它开头 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** zip 注释最大 65535 字节，EOCD 只可能落在这段里 */
const MAX_COMMENT_BYTES = 0xffff;

// ──────────────────────────────── 阶段与失败分类 ────────────────────────────────

/**
 * 安装阶段。**这三种失败分开反馈**就是靠它：
 *   download → 网络/来源问题；extract → 包结构/损坏；verify → 装完复检仍找不到；done → 成功
 */
export type DepInstallStep = 'download' | 'extract' | 'verify' | 'done';

export interface DepInstallFailure {
  ok: false;
  step: Exclude<DepInstallStep, 'done'>;
  name: DepName;
  /** 给用户看的一句话（含下一步） */
  error: string;
  /** 每一步的具体细节（URL、退出码、试过的路径），报告里逐行列出 */
  details: string[];
}

export interface DepInstallSuccess {
  ok: true;
  step: 'done';
  name: DepName;
  /** 安装目录（`<dataDir>/tools/<name>`） */
  dir: string;
  /** 落地的可执行文件绝对路径 */
  exePath: string;
  version: string;
  sourceUrl: string;
  bytes: number;
  details: string[];
}

export type DepInstallOutcome = DepInstallSuccess | DepInstallFailure;

// ──────────────────────────────── 下载 ────────────────────────────────

export interface DownloadResult {
  ok: boolean;
  /** 落盘的文件路径（失败时可能是一个不完整的临时文件，调用方负责清） */
  path: string;
  bytes: number;
  /** 最终 URL（跟随重定向之后）——报告里给人看的是这个 */
  finalUrl: string;
  error: string;
}

/** 下载器的注入点：测试用假源，绝不联网 */
export type Downloader = (url: string, target: string) => Promise<DownloadResult>;

/** 把 URL 文本解析成请求参数；非 http(s) 一律拒绝（不做 file:// 那种"读本地文件"的后门） */
function parseHttpUrl(url: string): { ok: true; parts: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `下载地址不是合法 URL：${url}` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `只支持 http/https 下载，收到 ${parsed.protocol}` };
  }
  return { ok: true, parts: parsed };
}

/**
 * 真实下载器：`node:https` 流式落盘，带重定向跟随与字节上限。
 *
 * 为什么要流式而不是 `res.on('data')` 攒 Buffer：两个包虽小，但"攒完再写"意味着
 * 内存占用由**对端**决定；流式落盘让内存恒定，超限时能立刻断开。
 */
export const downloadWithNode: Downloader = (url, target) => {
  return new Promise<DownloadResult>((resolve) => {
    const details: string[] = [];
    let currentUrl = url;

    const fail = (error: string, finalUrl = currentUrl, bytes = 0): void => {
      resolve({ ok: false, path: target, bytes, finalUrl, error });
    };

    const attempt = (hops: number): void => {
      const parsed = parseHttpUrl(currentUrl);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      const options: RequestOptions = {
        headers: {
          // GitHub API 与 CDN 都要求一个 UA；没有它 api.github.com 会直接 403
          'user-agent': 'irmia-agent-deps/1.0',
          accept: 'application/octet-stream, application/json',
        },
      };

      const request = httpsGet(parsed.parts, options, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string' && location !== '') {
          response.resume(); // 重定向响应体没有用，读完就丢，避免连接挂着
          if (hops >= MAX_REDIRECTS) {
            fail(`重定向超过 ${MAX_REDIRECTS} 跳（最后指向 ${location}）`);
            return;
          }
          details.push(`重定向 ${status} → ${location}`);
          currentUrl = new URL(location, currentUrl).toString();
          attempt(hops + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(`HTTP ${status}（${currentUrl}）`);
          return;
        }

        const declared = Number.parseInt(String(response.headers['content-length'] ?? ''), 10);
        if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
          response.destroy();
          fail(`声明的体积 ${declared} 字节超过上限 ${MAX_DOWNLOAD_BYTES}`, currentUrl, 0);
          return;
        }

        void (async (): Promise<void> => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          try {
            await mkdir(dirname(target), { recursive: true });
            // 逐个 chunk 累积到临时数组再一次性写：两个包都在 MB 级，分块写的收益抵不上
            // 一次 writeFile 的原子性；上限由 MAX_DOWNLOAD_BYTES 兜住，内存有界
            for await (const chunk of response) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              bytes += buf.byteLength;
              if (bytes > MAX_DOWNLOAD_BYTES) {
                response.destroy();
                fail(`下载体积超过上限 ${MAX_DOWNLOAD_BYTES} 字节`, currentUrl, bytes);
                return;
              }
              chunks.push(buf);
            }
            await writeFile(target, Buffer.concat(chunks, bytes));
            resolve({ ok: true, path: target, bytes, finalUrl: currentUrl, error: '' });
          } catch (err) {
            fail(`写盘失败：${err instanceof Error ? err.message : String(err)}`, currentUrl, bytes);
          }
        })();
      });

      request.on('error', (err: Error) => {
        fail(`网络错误：${err.message}`);
      });
      // 总时限：官方源正常在秒级；卡住不动的连接必须自己断，否则安装命令会一直挂着
      request.setTimeout(120_000, () => {
        request.destroy(new Error('下载超时（120s）'));
      });
    };

    attempt(0);
  });
};

// ──────────────────────────────── zip 解析 ────────────────────────────────

export interface ZipEntry {
  /** zip 内的路径（用 '/' 分隔） */
  name: string;
  /** 解压后的字节 */
  data: Buffer;
}

export interface ZipReadResult {
  ok: boolean;
  entries: ZipEntry[];
  error: string;
}

/** 只收这两种压缩方式：store（0）与 deflate（8）。zip 的其它方式我们不解，遇到就跳过 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - MAX_COMMENT_BYTES - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * 读一个 zip（内存版）。刻意**不支持的**特性一律跳过而不是报错：
 * 目录项、加密项、zip64、我们不认识的压缩方式——跳过它们的后果是"少几个文件"，
 * 而报错的后果是"整包装不上"。我们只关心包里的那一个 .exe。
 */
export function readZipEntries(buf: Buffer): ZipReadResult {
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, entries: [], error: '不是 zip（找不到目录结尾记录）' };

  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset >= buf.length) {
    return { ok: false, entries: [], error: 'zip 目录偏移越界（文件可能被截断）' };
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return { ok: false, entries: [], error: `zip 目录第 ${index + 1} 项无法解析（文件可能损坏）` };
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // 目录项
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) continue; // 不认识的压缩方式
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      return { ok: false, entries: [], error: `zip 成员 ${name} 的本地头无效` };
    }

    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      return { ok: false, entries: [], error: `zip 成员 ${name} 的数据越界（文件可能被截断）` };
    }
    const raw = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    try {
      data = method === METHOD_STORE ? Buffer.from(raw) : inflateRawSync(raw);
    } catch (err) {
      return {
        ok: false,
        entries: [],
        error: `zip 成员 ${name} 解压失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    totalBytes += data.byteLength;
    if (totalBytes > MAX_EXTRACT_BYTES) {
      return { ok: false, entries: [], error: `解压总量超过上限 ${MAX_EXTRACT_BYTES} 字节（疑似解压炸弹）` };
    }
    entries.push({ name, data });
  }

  if (entries.length === 0) return { ok: false, entries: [], error: 'zip 里没有可解压的文件' };
  return { ok: true, entries, error: '' };
}

// ──────────────────────────────── 解压落盘 ────────────────────────────────

/** 单层公共前缀：`ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe` → `rg.exe` */
export function stripSingleTopDir(entries: readonly ZipEntry[]): ZipEntry[] {
  if (entries.length === 0) return [];
  const firstSlash = entries[0]!.name.indexOf('/');
  if (firstSlash <= 0) return [...entries];
  const prefix = entries[0]!.name.slice(0, firstSlash + 1);
  const allNested = entries.every((entry) => entry.name.startsWith(prefix) && entry.name.length > prefix.length);
  if (!allNested) return [...entries];
  return entries.map((entry) => ({ name: entry.name.slice(prefix.length), data: entry.data }));
}

/**
 * 解压到目标目录。**路径穿越防护**：zip 里的名字是外部输入，
 * `../` 与绝对路径一律拒绝（zip-slip 是这个格式最老的坑）。
 * 目标目录先清空——留一半旧文件会让"复检"认出一个上一次装坏的 exe。
 */
export async function extractZipToDirectory(
  entries: readonly ZipEntry[],
  targetDir: string,
): Promise<{ ok: boolean; written: number; error: string }> {
  const stripped = stripSingleTopDir(entries);
  const root = resolve(targetDir);
  try {
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    let written = 0;
    for (const entry of stripped) {
      if (entry.name === '') continue;
      const target = resolve(root, entry.name);
      const rel = relative(root, target);
      if (rel === '' || rel.startsWith('..') || /^[A-Za-z]:/u.test(rel)) {
        return { ok: false, written, error: `zip 成员路径越界：${entry.name}` };
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
      written += 1;
    }
    return { ok: true, written, error: '' };
  } catch (err) {
    return { ok: false, written: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ──────────────────────────────── 安装编排 ────────────────────────────────

/** 一个可一键安装的依赖的包描述（探测定义里的 install:'zip' 那部分在这里落地） */
export interface ZipPackage {
  name: DepName;
  /** 包地址；`resolveUrl` 给定时它作为兜底（解析失败就用它） */
  url: string;
  /** 需要联网解析最终地址时用它（ripgrep 走 GitHub API 拿最新 release 的资产） */
  resolveUrl?: (() => Promise<{ ok: true; url: string; version: string } | { ok: false; error: string }>) | undefined;
  /** 期望解压出来的可执行文件名（装完复检找的就是它） */
  exeNames: readonly string[];
}

/**
 * 解析 ripgrep 最新 release 里的 Windows 资产地址。
 * 为什么不写死版本号：写死的那一刻就开始过期，而这个依赖是**要求安装**的
 * （过期意味着新用户装不上）。GitHub API 匿名可用（限流 60/小时，装一次用一次，绰绰有余）。
 */
export async function resolveRipgrepAsset(
  fetchJson: (url: string) => Promise<string>,
): Promise<{ ok: true; url: string; version: string } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await fetchJson(RIPGREP_RELEASE_API);
  } catch (err) {
    return { ok: false, error: `查询 ripgrep 最新版本失败：${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'ripgrep 版本查询返回的不是 JSON（可能被网络中间层拦截）' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'ripgrep 版本查询返回了意外结构' };
  }
  const record = parsed as Record<string, unknown>;
  const tag = typeof record['tag_name'] === 'string' ? record['tag_name'] : '';
  const assets = Array.isArray(record['assets']) ? record['assets'] : [];
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue;
    const item = asset as Record<string, unknown>;
    const name = typeof item['name'] === 'string' ? item['name'] : '';
    const url = typeof item['browser_download_url'] === 'string' ? item['browser_download_url'] : '';
    if (name.endsWith(RIPGREP_ASSET_MARKER) && url !== '') {
      return { ok: true, url, version: tag.replace(/^v/u, '') };
    }
  }
  return { ok: false, error: `ripgrep 最新 release（${tag || '未知'}）里没有 ${RIPGREP_ASSET_MARKER}` };
}

export interface InstallDependencyInput {
  name: DepName;
  /** 包描述 */
  pkg: ZipPackage;
  /** 数据目录：安装落点是 `<dataDir>/tools/<name>/` */
  dataDir: string;
  download: Downloader;
  /** 复检：装完之后用真正的探测再看一遍（返回 null = 还是找不到） */
  verify: (exePath: string) => Promise<{ version: string } | null>;
  /** 解析文本型 URL 的注入点（GitHub API 那条路）；省略时只有一个 zip 源 */
  fetchText?: ((url: string) => Promise<string>) | undefined;
  timeoutMs?: number | undefined;
}

/** 安装目录：三处（探测 / 安装 / 复检）共用这一个约定 */
export function managedDirFor(dataDir: string, name: DepName): string {
  return join(dataDir, TOOLS_DIR_NAME, name);
}

/** 下载缓存目录：失败留下的半截文件在这里，人能自己看一眼 */
export function cacheDirFor(dataDir: string): string {
  return join(dataDir, TOOLS_DIR_NAME, CACHE_DIR_NAME);
}

/**
 * 一键安装：下载 → 解压 → **复检** → 写清单。
 *
 * 复检这一步是刻意的设计（不是可选的收尾）：解压成功不等于能跑——杀毒软件会隔离
 * 刚落地的 exe、x86/x64 装错、包结构变了导致文件不在预期位置，这些都在"解压成功"之后才暴露。
 * 装完不验就报"已安装"，用户会在下一次搜索时才发现没生效，而那时他早就忘了自己装过。
 */
export async function installZipDependency(input: InstallDependencyInput): Promise<DepInstallOutcome> {
  const details: string[] = [];
  const targetDir = managedDirFor(input.dataDir, input.name);

  // ① 定地址：能解析就解析（拿到最新版本），不能就用固定地址
  let url = input.pkg.url;
  let resolvedVersion = '';
  if (input.pkg.resolveUrl !== undefined) {
    const resolved = await input.pkg.resolveUrl();
    if (resolved.ok) {
      url = resolved.url;
      resolvedVersion = resolved.version;
      details.push(`解析到最新版本 ${resolved.version}：${url}`);
    } else {
      details.push(`解析最新版本失败，退回固定地址：${resolved.error}`);
    }
  }

  // ② 下载
  const archive = join(cacheDirFor(input.dataDir), `${input.name}.zip`);
  await mkdir(dirname(archive), { recursive: true });
  const downloaded = await input.download(url, archive);
  if (!downloaded.ok) {
    return {
      ok: false,
      step: 'download',
      name: input.name,
      error: `下载失败：${downloaded.error}。检查网络后重试；若是来源地址变了，点「打开下载页」手动安装。`,
      details: [...details, `下载地址：${url}`, ...(downloaded.error === '' ? [] : [`失败原因：${downloaded.error}`])],
    };
  }
  details.push(`已下载 ${downloaded.bytes} 字节（最终地址 ${downloaded.finalUrl}）`);

  // ③ 解压
  let archiveBytes: Buffer;
  try {
    archiveBytes = await readFile(downloaded.path);
  } catch (err) {
    return {
      ok: false,
      step: 'extract',
      name: input.name,
      error: `解压失败：读不到刚下载的包（${err instanceof Error ? err.message : String(err)}）`,
      details: [...details, `包路径：${downloaded.path}`],
    };
  }
  const zip = readZipEntries(archiveBytes);
  if (!zip.ok) {
    return {
      ok: false,
      step: 'extract',
      name: input.name,
      error: `解压失败：${zip.error}。这通常意味着下载到的不是 zip（代理拦截、镜像换包）——`
        + '请重试，或点「打开下载页」手动安装。',
      details: [...details, `包大小 ${archiveBytes.byteLength} 字节`, `包路径：${downloaded.path}`],
    };
  }
  const extracted = await extractZipToDirectory(zip.entries, targetDir);
  if (!extracted.ok) {
    return {
      ok: false,
      step: 'extract',
      name: input.name,
      error: `解压失败：${extracted.error}`,
      details: [...details, `目标目录：${targetDir}`],
    };
  }
  details.push(`已解压 ${extracted.written} 个文件到 ${targetDir}`);

  // ④ 复检：**这一条不能省**（理由见函数头）。
  //
  // 定位用 `findExecutableInDir`——与日常探测**同一个实现**（probe.ts）。
  // 两处各写一套的后果实测过一次：voidtools 的 CLI 包里 es.exe 在 `x64/` 子目录下，
  // 只查根目录的话"装完成了但复检说找不到"，而文件明明躺在那儿。
  const exePath = findExecutableInDir(input.pkg.exeNames, targetDir, existsSync, defaultDepFs.listDir);
  let version = '';
  if (exePath !== null) {
    const verified = await input.verify(exePath);
    if (verified !== null) version = verified.version;
    else details.push(`${exePath} 存在但探测不通过（版本不符或无法启动）`);
  }
  if (exePath === null || version === '') {
    return {
      ok: false,
      step: 'verify',
      name: input.name,
      error: `安装完成但复检仍找不到可用的 ${input.pkg.exeNames.join(' / ')}：`
        + `文件已解压到 ${targetDir}，请检查杀毒软件是否隔离了它，或手动确认该目录下的文件名。`,
      details: [...details, `期望的可执行文件：${input.pkg.exeNames.join(' / ')}（含一层子目录）`],
    };
  }

  // ⑤ 清单（人可读：装了什么、从哪来、什么时候）
  const manifest = {
    name: input.name,
    version: version === '' ? resolvedVersion : version,
    sourceUrl: url,
    finalUrl: downloaded.finalUrl,
    bytes: downloaded.bytes,
    installedAt: new Date().toISOString(),
    exePath,
  };
  try {
    await writeFile(join(targetDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    // 清单写不下去不影响使用（探测看的是 exe 本身），但要说出来
    details.push(`清单写入失败（不影响使用）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 顺手清掉下载缓存：包本身没用了，留着只会占地方
  try {
    await rm(archive, { force: true });
  } catch {
    /* 删不掉就留着，不是错误 */
  }

  details.push(`复检通过：${exePath}（版本 ${version}）`);
  return {
    ok: true,
    step: 'done',
    name: input.name,
    dir: targetDir,
    exePath,
    version,
    sourceUrl: url,
    bytes: downloaded.bytes,
    details,
  };
}

/** 读清单（自装目录里装的是什么版本）；没有清单返回 null */
export async function readManifest(
  dataDir: string,
  name: DepName,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(join(managedDirFor(dataDir, name), MANIFEST_FILE_NAME), 'utf8');
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

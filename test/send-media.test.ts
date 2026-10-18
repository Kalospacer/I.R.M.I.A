/**
 * send_media（2026-10-03，官 bot 富媒体）：她发媒体的出口。
 *
 * 只测工具层的行为——白名单与字节读取在宿主（main.ts），这里用假的投递口钉住"工具把什么
 * 交给了宿主"，以及四种应当**如实报错**的情形。
 *
 * ⚠ v64（出站类＝写类）：`send_media` 开始按 `trust.mode` 判一次（`full` 档不限制路径、
 * `workspace` 档只许工作目录内），并把本机文件**读成字节**交给投递口（投递口那一层只收
 * `data\`/仓库根之内）。所以这一份里有两个 ctx：
 *   · `CTX` = 不传 `boundaryRoot`（历史默认＝把 `workspaceRoot` 当边界）⇒ 用来测"拒"；
 *   · `OPEN_CTX` = `boundaryRoot: null`（完全信任，**现场默认就是它**）⇒ 用来测"发得出去"。
 *
 * ⚠ 2026-10-17：`kind:file` 的载荷补上 `path`（校验后的绝对路径）与 `name`——
 * 少了它们，OneBot 的文件永远报"要一个本机路径"、官方上传体里没有 `file_name`（QQ 显示
 * "未命名"）。图/视频/语音**不加**这两个字（那三条路是好的，见本文件末尾的回归用例）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TimerStore } from '../src/wake/timer-store.ts';
import { createWorkspaceMediaPoster } from '../src/channel/media-poster.ts';
import { ONEBOT_CHANNEL_NAME, oneBotMediaCall } from '../src/channel/onebot.ts';
import { QqMessageSender, type ChannelAdapter } from '../src/channel/qq-official.ts';
import { createAdminTools, type MediaRequest } from '../src/tools/admin.ts';

const CTX = {
  callId: 'call-media-1',
  turn: 7,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
} as never;

/** 完全信任那一档（`boundaryRoot: null`）：出站类不受边界约束——现场默认就是它 */
const OPEN_CTX = {
  callId: 'call-media-2',
  turn: 7,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
  boundaryRoot: null,
} as never;

function toolkit(poster: ((media: MediaRequest) => void) | null) {
  const seen: MediaRequest[] = [];
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: () => {},
    ...(poster === null ? {} : {
      mediaPoster: {
        async post(_target, media) {
          seen.push(media);
          poster(media);
          return { ok: true as const, status: 200 };
        },
      },
    }),
  });
  return { tool: tk.byName('send_media'), seen };
}

test('send_media：本机文件由**工具层读成字节**交给宿主（v64：出站要按边界判一次）', async () => {
  const { tool, seen } = toolkit(() => {});
  // v64 起 `send_media` 属**出站类＝写类**：`full` 档（`boundaryRoot: null`）不限制路径，
  // 由工具层把字节读出来交给投递口（投递口那一层只收 data\ / 仓库根之内，政策判在工具层）。
  const file = join(await mkdtemp(join(tmpdir(), 'irmia-media-')), 'a.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await tool.handler({ path: file, kind: 'image', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.fileType, 1, 'image → 1');
  assert.equal(seen[0]?.path, undefined, '不再把路径交给宿主（由工具层读字节）');
  assert.equal(seen[0]?.data?.byteLength, 4, '交给宿主的是那一份字节');
  assert.match(result.content, /已发往/u);
});

test('send_media：`workspace` 档下越界文件被拒（出站类＝写类），理由说清边界在哪', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await mkdtemp(join(tmpdir(), 'irmia-media-out-'));
  const file = join(dir, 'outside.png');
  await writeFile(file, Buffer.from([1, 2, 3]));

  // ① 显式边界（生产里 `workspace` 档就是这样：`ctx.boundaryRoot` 来自 config）⇒ 措辞要说清怎么改
  const explicit = { ...(CTX as object), boundaryRoot: process.cwd() } as never;
  const denied = await tool.handler({ path: file, kind: 'image', to: 'qq:c2c:USER-1' }, explicit);
  assert.equal(denied.isError, true, `workspace 档该拒：${denied.content}`);
  assert.match(denied.content, /trust\.mode/u, '要说清怎么改');
  assert.equal(seen.length, 0, '被拒时一份都不许发出去');

  // ② 历史默认（不传 boundaryRoot）同样拒——措辞不同（没有 trust.mode 那一句），但**必须拒**
  const implicit = await tool.handler({ path: file, kind: 'image', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(implicit.isError, true, `不传 boundaryRoot 时也该拒：${implicit.content}`);
  assert.equal(seen.length, 0);
});

test('send_media：四种 kind 映到官方的 file_type；url 那条路不带 path', async () => {
  const { tool, seen } = toolkit(() => {});
  for (const [kind, fileType] of [['image', 1], ['video', 2], ['voice', 3], ['file', 4]] as const) {
    await tool.handler({ url: 'https://example.invalid/x', kind, to: 'qq:c2c:USER-1' }, CTX);
    assert.equal(seen.at(-1)?.fileType, fileType, `${kind} → ${fileType}`);
    assert.equal(seen.at(-1)?.url, 'https://example.invalid/x');
    assert.equal(seen.at(-1)?.path, undefined);
    assert.equal(seen.at(-1)?.name, undefined, '网络地址没有本机文件名，不编一个');
  }
});

test('send_media：path 与 url 必须给且只给一个（两边都不给 / 都给都拒）', async () => {
  const { tool, seen } = toolkit(() => {});
  const neither = await tool.handler({ to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(neither.isError, true);
  assert.match(neither.content, /必须给且只给一个/u);
  const both = await tool.handler({ path: 'a.png', url: 'https://example.invalid/b.png', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(both.isError, true);
  assert.equal(seen.length, 0, '参数不合法就不该去发');
});

test('send_media：没接线时如实报"没有接线"，不假装发过', async () => {
  const { tool } = toolkit(null);
  const result = await tool.handler({ path: 'a.png', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(result.isError, true);
  assert.match(result.content, /没有装配媒体投递口/u);
});

test('send_media：宿主回报失败时如实转述理由（不吞）', async () => {
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: () => {},
    mediaPoster: {
      async post() {
        return { ok: false as const, reason: '上传被拒（code=40093002 当日配额已用尽）' };
      },
    },
  });
  // v64：`full` 档才走得下去（`CTX` 那一档会先被边界拦）⇒ 这条测的是"宿主失败如实转述"
  const file = join(await mkdtemp(join(tmpdir(), 'irmia-media-fail-')), 'a.png');
  await writeFile(file, Buffer.from([1]));
  const result = await tk.byName('send_media').handler({ path: file, to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(result.isError, true);
  assert.match(result.content, /40093002/u);
  assert.match(result.content, /当日配额已用尽/u);
});

// ─────────────────── 2026-10-17：`kind:file` 的两条病（OneBot 发不出 / 官方"未命名"） ───────────────────
//
// 根因同一个：v64 起 `send_media` 把本机文件**读成字节**交给投递口，`path` 与 `name` 两个字
// 从来没填进 `MediaRequest` ⇒ OneBot 的文件那条拿不到本机路径（`upload_*_file` 要路径，
// 不是消息段）、官方的上传体里没有 `file_name`（QQ 显示"未命名"）。
// **只给文件类补这两个字**：图/视频/语音那三条路是好的，载荷必须与从前逐字节相同。

test('OneBot 文件：交下去的 path 是**校验后的绝对路径**，通道终于能构造上传动作', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await mkdtemp(join(tmpdir(), 'irmia-media-onebot-'));
  const file = join(dir, 'report.pdf');
  await writeFile(file, Buffer.from([0x25, 0x50, 0x44, 0x46]));
  // 相对路径进来、绝对路径出去：`workspaceRoot` 指到那个临时目录（`full` 档，v64 默认）
  const ctx = { ...(OPEN_CTX as object), workspaceRoot: dir } as never;
  const result = await tool.handler({ path: 'report.pdf', kind: 'file', to: 'onebot:c2c:10001' }, ctx);
  assert.equal(result.isError, undefined, result.content);

  const media = seen[0]!;
  assert.equal(media.fileType, 4);
  assert.equal(media.path, file, '交给通道的是**绝对**路径（不是原样相对路径）');
  assert.equal(media.name, 'report.pdf', '文件名跟着走（官方 `file_name` 的唯一来源）');
  assert.equal(media.data?.byteLength, 4, '字节照旧给（图/视频/语音与其它通道都用它）');

  // 关键：通道层不再报"要一个本机路径"——它拿到的是 `upload_private_file` 的合法入参
  const c2c = oneBotMediaCall(false, '10001', media);
  assert.ok(c2c.ok, `不该再说"要一个本机路径"：${JSON.stringify(c2c)}`);
  assert.equal(c2c.action, 'upload_private_file');
  assert.deepEqual(c2c.params, { user_id: 10001, file, name: 'report.pdf' });

  const group = oneBotMediaCall(true, '20002', media);
  assert.ok(group.ok, JSON.stringify(group));
  assert.equal(group.action, 'upload_group_file');
  assert.deepEqual(group.params, { group_id: 20002, file, name: 'report.pdf' });
});

test('OneBot 文件也走**同一道**边界：`workspace` 档下越界仍被拒，投递口一次都不调用', async () => {
  const { tool, seen } = toolkit(() => {});
  const outside = join(await mkdtemp(join(tmpdir(), 'irmia-media-file-out-')), 'secret.pdf');
  await writeFile(outside, Buffer.from([1]));
  // 判据是 v64 那条（`boundaryRootFor('write', …)`）：这里只是确认"补 path"没有绕开它
  // 用**显式**边界那一档（生产里 `workspace` 档就是这样），措辞里会给出怎么改
  const explicit = { ...(CTX as object), boundaryRoot: process.cwd() } as never;
  const denied = await tool.handler({ path: outside, kind: 'file', to: 'onebot:c2c:10001' }, explicit);
  assert.equal(denied.isError, true, String(denied.content));
  assert.match(denied.content, /trust\.mode/u, '要说清怎么改');
  assert.equal(seen.length, 0, '被拒时一份载荷都不该产生（也就没有 path 外泄）');
});

test('官方通道：`name` 会被写成上传体的 `file_name`（第二次改英文名也没救的那条）', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await mkdtemp(join(tmpdir(), 'irmia-media-official-'));
  const file = join(dir, '季度报告.pdf');
  await writeFile(file, Buffer.from([1, 2, 3]));
  const result = await tool.handler({ path: file, kind: 'file', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.equal(seen[0]?.name, '季度报告.pdf', '交给通道的载荷里要有文件名');

  // 真发送器 + 假 HTTP：断言**真正发出去的那个请求体**（不假装调用成功，只验形状）
  const requests: Array<{ url: string; jsonBody: Record<string, unknown> }> = [];
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'),
    http: (async (input: { url: string; jsonBody?: unknown }) => {
      requests.push({ url: input.url, jsonBody: (input.jsonBody ?? {}) as Record<string, unknown> });
      return { status: 200, text: '', body: { file_uuid: 'U1', file_info: 'FI-1', ttl: 300 } };
    }) as never,
  });
  const uploaded = await sender.uploadMedia('c2c', 'USER-1', seen[0]!);
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal(requests[0]?.url, 'https://api.bot.qq.com/v2/users/USER-1/files');
  assert.equal(requests[0]?.jsonBody['file_name'], '季度报告.pdf', '官方字段就叫 file_name');
  assert.equal(requests[0]?.jsonBody['file_type'], 4);
  assert.equal(typeof requests[0]?.jsonBody['file_data'], 'string', '字节照旧走 file_data');
});

test('回归：图片/视频/语音的载荷与改动前**逐字节相同**（只有文件类多那两个字）', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await mkdtemp(join(tmpdir(), 'irmia-media-kinds-'));
  const bytes = Buffer.from([7, 8, 9]);
  for (const [kind, fileType] of [['image', 1], ['video', 2], ['voice', 3]] as const) {
    const file = join(dir, `${kind}.bin`);
    await writeFile(file, bytes);
    await tool.handler({ path: file, kind, to: 'qq:c2c:USER-1' }, OPEN_CTX);
    assert.deepEqual(seen.at(-1), { fileType, data: bytes }, `${kind} 的载荷必须与从前一字不差`);
  }
});

// ─────────────── 安全回归（2026-10-17）：`protectedPaths` 对 `send_media` 自 v64 起失效 ───────────────
//
// 时间点：v64 `da9a15e` 让工具层把本机文件读成字节，投递口于是走 `data !== undefined` 的早退
// 分支——而凭据判定（`protectedPaths`）原来只写在"只带路径"那条路上，**整条被跳过**：
// 她能把 `data/.keys.json` 原样发出去（本机到通道），而这条门正是 2026-10-05 用户点名要的。
// 判据仍然只有一处（`channel/media-poster.ts` 的 `refuseProtected`，realpath + `insideAny`），
// 修法只是把它**挪到早退之前**；三档信任都不能放宽（这道门与 `trust.mode` 无关）。

/** 真投递口 + 假 OneBot 通道：把"工具 → 投递口 → 通道"整条串起来，只记载荷、不真的发 */
function realPosterToolkit(options: { dataDir: string; protectedPaths: readonly string[] }) {
  const seen: MediaRequest[] = [];
  const onebot = {
    name: ONEBOT_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: 'S', passive: false, msgSeq: 0 }),
    sendMediaTo: async (_chatType: string, _chatId: string, media: MediaRequest) => {
      seen.push(media);
      return { ok: true as const, messageId: '', passive: false, msgSeq: 0 };
    },
  } as unknown as ChannelAdapter;
  const channels = new Map<string, ChannelAdapter>([[ONEBOT_CHANNEL_NAME, onebot]]);
  const poster = createWorkspaceMediaPoster({
    dataDir: options.dataDir,
    workspaceRoot: process.cwd(),
    channels,
    protectedPaths: options.protectedPaths,
  });
  const tk = createAdminTools({ timers: new TimerStore(null), emit: () => {}, mediaPoster: poster });
  return { tool: tk.byName('send_media'), seen };
}

test('受保护路径**三档信任都不许发**：full / workspace（显式）/ workspace（隐式）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-media-protected-'));
  const secret = join(dir, '.keys.json');
  const sentinel = 'SENTINEL-KEYS-0123456789';
  await writeFile(secret, sentinel);
  const { tool, seen } = realPosterToolkit({ dataDir: dir, protectedPaths: [secret] });

  const ctxs: Array<[string, Record<string, unknown>]> = [
    ['full（默认，整台电脑）', { ...(OPEN_CTX as object) }],
    ['workspace（显式边界）', { ...(CTX as object), boundaryRoot: dir }],
    ['workspace（隐式边界）', { ...(CTX as object), workspaceRoot: dir }],
  ];
  for (const [label, ctx] of ctxs) {
    const result = await tool.handler({ path: secret, kind: 'file', to: 'onebot:c2c:10001' }, ctx as never);
    assert.equal(result.isError, true, `${label} 该拒：${result.content}`);
    // 文案沿用投递口既有的那句（不另写一套）
    assert.match(result.content, /拒绝外发/u, label);
    assert.match(result.content, /本机凭据文件（受保护路径）/u, label);
    assert.match(result.content, /不会交给任何通道/u, label);
    assert.ok(!result.content.includes(sentinel), `${label}：内容不得出现在回执里`);
  }
  assert.equal(seen.length, 0, '三档加起来，凭据一次都不该到通道层');

  // 对照：同一份目录里的普通文件照旧发得出去（门只挡凭据）
  const normal = join(dir, 'report.pdf');
  await writeFile(normal, Buffer.from([1, 2, 3]));
  const ok = await tool.handler({ path: normal, kind: 'file', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(ok.isError, undefined, String(ok.content));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.path, normal);
});

test('`url` 那条路不涉及本机文件 ⇒ 不受凭据门影响（别误伤）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-media-protected-url-'));
  const secret = join(dir, '.keys.json');
  await writeFile(secret, 'SENTINEL-KEYS');
  const { tool, seen } = realPosterToolkit({ dataDir: dir, protectedPaths: [secret] });
  const result = await tool.handler(
    { url: 'https://example.invalid/a.pdf', kind: 'file', to: 'onebot:c2c:10001' },
    OPEN_CTX,
  );
  assert.equal(result.isError, undefined, String(result.content));
  assert.equal(seen.length, 1, '网络地址照旧交下去');
  assert.equal(seen[0]?.path, undefined, '没有本机路径 ⇒ 凭据门无从触发，也不该拦');
});

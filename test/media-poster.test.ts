/**
 * `send_media` 的宿主侧投递口：白名单 / 大小 / 字节读取三条规则。
 *
 * 这一段原来写在 main.ts 里，工具层与通道层各自有测、**中间这段胶水一次都没被执行过**——
 * 验收脚本（tools/channel-check.ts）照出来的正是这一类"写了但没人跑过"的地方。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceMediaPoster } from '../src/channel/media-poster.ts';
import type { ChannelAdapter } from '../src/channel/qq-official.ts';
import { QQ_CHANNEL_NAME, QqMessageSender } from '../src/channel/qq-official.ts';

/** 假的平台 HTTP：上传给 file_info、发送给 id；记下每一次请求 */
function fakePlatform() {
  const requests: Array<{ url: string; method: string; jsonBody: unknown }> = [];
  const fn = async (input: { url: string; method: string; jsonBody?: unknown }) => {
    requests.push({ url: input.url, method: input.method, jsonBody: input.jsonBody });
    if (input.url.includes('/files')) {
      return { status: 200, text: '', body: { file_uuid: 'U1', file_info: 'FI-1', ttl: 300 } };
    }
    return { status: 200, text: '', body: { id: 'SENT-1' } };
  };
  return { fn, requests };
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "irmia-media-"));
  mkdirSync(join(root, "pics"), { recursive: true });
  writeFile(join(root, "pics", "a.png"), Buffer.from([1, 2, 3, 4]));
  return root;
}

function posterFor(dataDir: string, http: { fn: unknown }) {
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'),
    http: http.fn as never,
  });
  const channel = {
    name: QQ_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: "S", passive: false, msgSeq: 1 }),
    // 通道的活：先上传换 file_info，再按 msg_type=7 发（与 QqOfficialChannel.sendMediaTo 同形）
    sendMediaTo: async (chatType: never, chatId: string, media: never, options: never) => {
      const uploaded = await sender.uploadMedia(chatType, chatId, media);
      if (!uploaded.ok) return { ok: false as const, reason: uploaded.reason, passive: false };
      return await sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
    },
  } as unknown as ChannelAdapter;
  const channels = new Map<string, ChannelAdapter>([[QQ_CHANNEL_NAME, channel]]);
  return createWorkspaceMediaPoster({ dataDir, channels });
}

test('工作区里的文件：读成字节交给通道层，上传 + msg_type=7 一条龙', async () => {
  const root = workspace();
  const http = fakePlatform();
  const poster = posterFor(root, http);
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, { fileType: 1, path: 'pics/a.png' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/v2/users/U-1/files');
  assert.equal((http.requests[0]?.jsonBody as Record<string, unknown>)['file_name'], 'a.png', '文件名取自真实路径');
  const sent = http.requests[1]?.jsonBody as Record<string, unknown>;
  assert.equal(sent["msg_type"], 7);
  assert.deepEqual(sent['media'], { file_info: 'FI-1' });
});

test('白名单：`../` 绕出去、同前缀的兄弟目录、不存在的文件，一律拒且不发请求', async () => {
  const root = workspace();
  const http = fakePlatform();
  const poster = posterFor(root, http);
  const target = { url: 'qq:c2c:U-1', idempotencyKey: 't1' };
  const escape = await poster.post(target, { fileType: 1, path: '../outside.png' });
  assert.equal(escape.ok, false);
  assert.ok(escape.ok === false && escape.reason.includes('只能发工作区'));
  const sibling = await poster.post(target, { fileType: 1, path: `${root}-evil/x.png` });
  assert.equal(sibling.ok, false, '同前缀的兄弟目录也要挡（不是简单的 startsWith）');
  const missing = await poster.post(target, { fileType: 1, path: 'pics/none.png' });
  assert.equal(missing.ok, false);
  assert.ok(missing.ok === false && missing.reason.includes('不存在'));
  assert.equal(http.requests.length, 0, "被拒的路径一次网络都不该发");
});

test('网络地址直接透传（不去下载中转）；超过上限的文件拒掉', async () => {
  const root = workspace();
  const http = fakePlatform();
  const channels = new Map<string, ChannelAdapter>();
  const sender = new QqMessageSender({ token: () => Promise.resolve("ACCESS"), http: http.fn as never });
  const channel = {
    name: QQ_CHANNEL_NAME, start: () => {}, stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: "S", passive: false, msgSeq: 1 }),
    // 通道的活：先上传换 file_info，再按 msg_type=7 发（与 QqOfficialChannel.sendMediaTo 同形）
    sendMediaTo: async (chatType: never, chatId: string, media: never, options: never) => {
      const uploaded = await sender.uploadMedia(chatType, chatId, media);
      if (!uploaded.ok) return { ok: false as const, reason: uploaded.reason, passive: false };
      return await sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
    },
  } as unknown as ChannelAdapter;
  channels.set(QQ_CHANNEL_NAME, channel);
  const tiny = createWorkspaceMediaPoster({ dataDir: root, channels, maxBytes: 2 });
  const outcome = await tiny.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, { fileType: 1, path: 'pics/a.png' });
  assert.equal(outcome.ok, false, '超过上限就拒（别把内存打爆）');
  assert.ok(outcome.ok === false && outcome.reason.includes('太大'));

  const poster = createWorkspaceMediaPoster({ dataDir: root, channels });
  const url = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, url: 'https://example.invalid/remote.png' });
  assert.equal(url.ok, true);
  const upload = http.requests.filter((r) => r.url.includes('/files')).at(-1);
  assert.equal((upload?.jsonBody as Record<string, unknown>)['url'], 'https://example.invalid/remote.png',
    '网络地址原样交给平台（我们不做下载中转）');
});

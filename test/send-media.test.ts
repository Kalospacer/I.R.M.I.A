/**
 * send_media（2026-10-03，官 bot 富媒体）：她发媒体的出口。
 *
 * 只测工具层的行为——白名单与字节读取在宿主（main.ts），这里用假的投递口钉住"工具把什么
 * 交给了宿主"，以及四种应当**如实报错**的情形。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TimerStore } from '../src/wake/timer-store.ts';
import { createAdminTools, type MediaRequest } from '../src/tools/admin.ts';

const CTX = {
  callId: 'call-media-1',
  turn: 7,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
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

test('send_media：本机文件走 path，交给宿主的是路径（字节由宿主读）', async () => {
  const { tool, seen } = toolkit(() => {});
  const result = await tool.handler({ path: 'shots/a.png', kind: 'image', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.fileType, 1, 'image → 1');
  assert.equal(seen[0]?.path, 'shots/a.png');
  assert.equal(seen[0]?.data, undefined, '工具层不读字节');
  assert.match(result.content, /已发往/u);
});

test('send_media：四种 kind 映到官方的 file_type；url 那条路不带 path', async () => {
  const { tool, seen } = toolkit(() => {});
  for (const [kind, fileType] of [['image', 1], ['video', 2], ['voice', 3], ['file', 4]] as const) {
    await tool.handler({ url: 'https://example.invalid/x', kind, to: 'qq:c2c:USER-1' }, CTX);
    assert.equal(seen.at(-1)?.fileType, fileType, `${kind} → ${fileType}`);
    assert.equal(seen.at(-1)?.url, 'https://example.invalid/x');
    assert.equal(seen.at(-1)?.path, undefined);
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
  const result = await tk.byName('send_media').handler({ path: 'a.png', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(result.isError, true);
  assert.match(result.content, /40093002/u);
  assert.match(result.content, /当日配额已用尽/u);
});

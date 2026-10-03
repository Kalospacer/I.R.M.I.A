/**
 * 图片附件预热测试 — src/runtime/real-loop.ts 的 prewarmRecentAttachments
 *
 * 这里锁的是一个**时序缺陷**：图片常常在她正忙着一个 turn 的时候到达。那个 turn 认领的是
 * 更早的一条消息，而新到的 wake/channel 会立刻作为后续 step 的历史出现在她眼前——
 * 如果那时本地还没有字节，她就只看到一行文件名与临时链接（实测正是如此，
 * 她只好自己 http_download 下来才看到图）。
 *
 * 所以断言的重点不是"能不能下载"，而是**什么时候下载**：每一拍都要把新到的图补上，
 * 而不是等它被某个 turn 认领。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { attachmentPath } from '../src/channel/attachment-store.ts';

const TZ = 'Asia/Shanghai';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

interface ImageHost {
  origin: string;
  hits: () => number;
  close: () => Promise<void>;
}

async function startImageHost(): Promise<ImageHost> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from('fake-jpeg-bytes'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Rig {
  dir: string;
  loop: () => RealLoop;
  write: (type: string, data: unknown) => AppEvent;
  /** 换一个全新的 RealLoop 实例（模拟重启：游标归零） */
  restart: () => void;
  close: () => void;
}

async function makeRig(t: test.TestContext, ds?: unknown): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-prewarm-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-01T07:00:00.000Z');

  const build = (): RealLoop => new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: TZ,
    // tickOnce 在没有 pending 时不会真的调模型；但早期几拍会问一下当前路由的模型名，
    // 所以这个占位实现得答得出来（只此一问）
    ds: (ds ?? { modelFor: () => 'fake-model' }) as unknown as DsClient,
    registry: new ToolRegistry(),
    persona: PERSONA,
    config: defaultConfig(dir),
    out: () => {},
    pollMs: 3_600_000,
  });

  let loop = build();
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    loop: () => loop,
    restart: () => { loop = build(); },
    write: (type, data) => {
      const event = {
        seq: log.nextSeq(),
        ts: now().toISOString(),
        type,
        data,
        visibility: defaultVisibility(type),
        origin: 'test/prewarm',
      } as unknown as AppEvent;
      log.append(event, { sync: true });
      applyOne(projection, event);
      return event;
    },
    close: () => log.close(),
  };
}

function imageWake(url: string): unknown {
  return {
    channel: 'qq-official',
    chatType: 'c2c',
    person: 'OPENID',
    chatId: 'OPENID',
    text: '',
    messageId: 'm1',
    msgSeq: 1,
    dedupeKey: 'm1',
    attachments: [{ type: 'image/jpeg', name: 'a.jpg', url }],
  };
}

test('新到的图片在**下一拍**就落盘，不必等它被某个 turn 认领', async (t) => {
  const host = await startImageHost();
  t.after(() => host.close());
  const rig = await makeRig(t);
  const url = `${host.origin}/a.jpg`;
  const target = attachmentPath(rig.dir, url);

  assert.equal(existsSync(target), false, '还没预热时本地不该有这份字节');

  // 队列里没有任何输入：她要过一会儿才会被这条唤醒叫醒。但预热必须在**它被认领之前**
  // 就发生——否则她第一眼看到的只有文件名。
  rig.write('wake/channel', imageWake(url));
  await rig.loop().tickOnce();
  assert.equal(existsSync(target), true, 'tickOnce 该把新到的图补下来');
  assert.equal(host.hits(), 1);
});

test('游标只扫新事件：第二拍不会把同一张图再下一次', async (t) => {
  const host = await startImageHost();
  t.after(() => host.close());
  const rig = await makeRig(t);
  const url = `${host.origin}/a.jpg`;

  rig.write('wake/channel', imageWake(url));
  await rig.loop().tickOnce();
  const afterFirst = host.hits();

  await rig.loop().tickOnce();
  await rig.loop().tickOnce();
  assert.equal(host.hits(), afterFirst, '每拍都重扫全窗口的话，同一张图会被反复拉');
});

test('重启后游标归零：从窗口起点补扫一次，之前漏掉的图补回来', async (t) => {
  const host = await startImageHost();
  t.after(() => host.close());
  const rig = await makeRig(t);
  const url = `${host.origin}/later.jpg`;
  const target = attachmentPath(rig.dir, url);

  // 图是在上一段进程里到达的，但那时没来得及预热（比如正好被重启打断）
  rig.write('wake/channel', imageWake(url));
  assert.equal(existsSync(target), false);

  rig.restart();
  await rig.loop().tickOnce();
  assert.equal(existsSync(target), true, '新实例第一次 tick 要从窗口起点补扫');
});

test('她正忙着一个 turn 时到达的图，也在这一拍就落盘（不等它被认领）', async (t) => {
  // 这是 YG 实际撞上的那个时序：他在她说话的中途发图。那个 turn 认领的是更早的消息，
  // 而新到的 wake/channel 会立刻作为后续 step 的历史出现在她眼前——此刻本地没有字节，
  // 她就只看到一行文件名与临时链接，只好自己 http_download。
  const host = await startImageHost();
  t.after(() => host.close());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // 主循环走的是 ds.stream（不是 generate）：stub 必须卡在真正被调用的那个方法上，
  // 否则 turn 会当场抛错结束、busy 立刻落回 false，这条用例就测不到"她正忙着"的场景
  const ds = {
    modelFor: () => 'fake-model',
    stream: async () => { await gate; throw new Error('本用例只关心"卡住"这一段'); },
  };
  const rig = await makeRig(t, ds);
  const url = `${host.origin}/mid-turn.jpg`;
  const target = attachmentPath(rig.dir, url);

  // 先让一个 turn 跑起来，并卡在模型调用上 → busy 为 true
  rig.write('wake/manual', { note: '先说句话', person: '用户', dedupeKey: 'k1' });
  const running = rig.loop().tickOnce();
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  // 图片在这时到达。tickOnce 在 busy 时会早退，所以预热门必须在 busy 检查**之前**——
  // 否则这一拍什么都不会做，而她的下一步请求里已经带着这条消息了。
  rig.write('wake/channel', imageWake(url));
  await rig.loop().tickOnce();
  assert.equal(existsSync(target), true, '她还在忙，但图已经该落地了');

  release();
  await running.catch(() => {});
});

test('非图片附件与没有地址的附件都不进这条通道', async (t) => {
  const host = await startImageHost();
  t.after(() => host.close());
  const rig = await makeRig(t);

  rig.write('wake/channel', {
    channel: 'onebot',
    chatType: 'c2c',
    person: 'U1',
    chatId: 'U1',
    text: 'hi',
    messageId: 'm2',
    msgSeq: 1,
    dedupeKey: 'm2',
    attachments: [
      { type: 'file', name: 'report.pdf', url: `${host.origin}/r.pdf` },
      { type: 'image/jpeg', name: 'no-url.jpg' },
    ],
  });
  await rig.loop().tickOnce();
  assert.equal(host.hits(), 0, '文件与没有地址的附件都不该触发下载');
});

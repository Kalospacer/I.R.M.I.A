/**
 * TimerStore 测试 — src/wake/timer-store.ts
 *
 * 覆盖 docs/design.md §4.3 的四要点、§4.22 的 cron 周期语义、以及
 * review.md 缺陷 4 要求的「以日志为准重建」。
 * 全部用虚拟时钟 + 临时目录，不产生真实等待，不碰仓库里的任何文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsp from 'node:fs/promises';

import {
  MAX_TIMEOUT_MS,
  TimerStore,
  nextCronTime,
  parseCron,
  timerEntriesFromEvents,
  type TimerSnapshot,
  type TimerStoreDeps,
  type StoredTimerEntry,
} from '../src/wake/timer-store.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CATCHUP_STAGGER_MS = 5_000;

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

interface VirtualClock {
  now(): Date;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * 按到期先后依次回调，直到下一次到期时刻越过 deadline；返回本次实际派发数。
   * 语义与真实事件循环一致：每个回调都在它自己的到期时刻执行，期间新排的
   * 定时器按真实剩余时间顺延。
   */
  advance(deadlineMs: number): number;
  /** 最近一次布防的延迟，用于验证分段长度 */
  lastDelayMs: number;
  /** 在途定时器数 */
  pendingCount(): number;
  /** 下一次到期的绝对时刻，没有在途定时器时返回 null */
  nextDeadlineMs(): number | null;
}

/**
 * 确定性虚拟时钟：按真实事件循环的语义推进时间。
 * 用 deadline 表达「推进到某个时刻」或「推进 N 毫秒」，不需要任何快进特例——
 * 离线场景由「没人调用 advance」自然表达。
 */
function createVirtualClock(startMs: number): VirtualClock {
  interface Task { at: number; seq: number; handler: () => void }
  let currentMs = startMs;
  let seq = 0;
  const tasks = new Map<number, Task>();
  let lastDelayMs = 0;

  const runUntil = (deadlineMs: number): number => {
    let fired = 0;
    for (;;) {
      let pick: Task | null = null;
      for (const task of tasks.values()) {
        if (task.at > deadlineMs) continue;
        if (pick === null || task.at < pick.at || (task.at === pick.at && task.seq < pick.seq)) pick = task;
      }
      if (pick === null) break;
      tasks.delete(pick.seq);
      if (pick.at > currentMs) currentMs = pick.at;
      fired += 1;
      pick.handler();
    }
    if (deadlineMs > currentMs) currentMs = deadlineMs;
    return fired;
  };

  return {
    get lastDelayMs() {
      return lastDelayMs;
    },
    now: () => new Date(currentMs),
    setTimeout: (handler, ms) => {
      lastDelayMs = ms;
      const id = ++seq;
      tasks.set(id, { at: currentMs + ms, seq: id, handler });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') tasks.delete(handle);
    },
    advance: (deadlineMs) => runUntil(deadlineMs),
    pendingCount: () => tasks.size,
    nextDeadlineMs: () => {
      let min: number | null = null;
      for (const task of tasks.values()) {
        if (min === null || task.at < min) min = task.at;
      }
      return min;
    },
  };
}

/** 把虚拟时钟推进 N 毫秒（同时把微任务队列清空） */
async function advanceMs(clock: VirtualClock, ms: number): Promise<number> {
  const fired = clock.advance(clock.now().getTime() + ms);
  await flushMicrotasks();
  return fired;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * 测试用依赖集合：调度与时钟走虚拟时钟，读盘/落盘走真实文件系统。
 * 注意现在的时间与调度必须同源，否则虚拟时间推进不会驱动定时器。
 */
function virtualStoreDepsForTest(clock: VirtualClock, extra: Partial<TimerStoreDeps> = {}): Partial<TimerStoreDeps> {
  return {
    now: () => clock.now(),
    setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    readFile: async (path: string) => readFile(path, 'utf8'),
    writeFile: async (path: string, data: string) => {
      await writeFile(path, data, 'utf8');
    },
    ...extra,
  };
}

interface Harness {
  store: TimerStore;
  clock: VirtualClock;
  file: string;
  dir: string;
  fired: Array<{ id: string; at: number; entry: StoredTimerEntry }>;
  startMs: number;
}

async function makeHarness(startMs: number, storeDeps: Partial<TimerStoreDeps> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const clock = createVirtualClock(startMs);
  const deps: Partial<TimerStoreDeps> = {
    ...virtualStoreDepsForTest(clock),
    ...storeDeps,
  };
  const store = new TimerStore(file, deps);
  await store.load();
  const fired: Array<{ id: string; at: number; entry: StoredTimerEntry }> = [];
  store.start((entry) => {
    fired.push({ id: entry.timerId, at: clock.now().getTime(), entry });
  });
  return { store, clock, file, dir, fired, startMs };
}

async function cleanup(h: Harness): Promise<void> {
  h.store.stop();
  // 触发路径的落盘是异步的：先等写链落定，再删目录，避免删完又被写回
  await h.store.flush();
  await removeTree(h.dir);
}

async function readSnapshot(file: string): Promise<TimerSnapshot> {
  return JSON.parse(await readFile(file, 'utf8')) as TimerSnapshot;
}

/**
 * 手工按 cron 语义逐分钟前推，作为 nextCronTime 的独立参照。
 * 只用于期望落在窗口内的表达式（周级别以内），月级别用语义断言。
 */
function bruteForceNext(cron: string, afterMs: number, limit = 20_000): number | null {
  const parsed = parseCron(cron);
  assert.equal(parsed.ok, true, `测试参照用的 cron 应当合法：${cron}`);
  if (!parsed.ok) return null;
  const set = parsed.cron;
  const monthIndex = (m: number) => m + 1;
  const baseMs = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS;
  for (let i = 1; i <= limit; i++) {
    const d = new Date(baseMs + i * MINUTE_MS);
    if (set.minute[d.getMinutes()] !== true) continue;
    if (set.hour[d.getHours()] !== true) continue;
    if (set.month[monthIndex(d.getMonth())] !== true) continue;
    const domHit = set.dom[d.getDate()] === true;
    const dowHit = set.dow[d.getDay()] === true;
    const hit = !set.domAll && !set.dowAll
      ? domHit || dowHit
      : (set.domAll || domHit) && (set.dowAll || dowHit);
    if (hit) return d.getTime();
  }
  return null;
}

/** 断言某个时刻之前没有任何匹配分钟（配合上界一起构成「它就是下一次」的证明） */
function assertNoEarlierMatch(cron: string, afterMs: number, untilMs: number): void {
  // bruteForceNext 的候选点是 floor(after)+i 分钟，i 从 1 起；区间端点必须排掉 untilMs 本身
  const before = bruteForceNext(cron, afterMs, Math.ceil((untilMs - afterMs) / MINUTE_MS) - 2);
  assert.equal(before, null, `${cron} 在 ${new Date(untilMs).toISOString()} 之前不应有更早的匹配`);
}

// ──────────────────────────────── 布防与触发 ────────────────────────────────

test('设 50ms 后的定时器到期后触发一次并从表里消失', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const res = await h.store.set({ at: new Date(h.clock.now().getTime() + 50).toISOString(), payload: { note: 'x' } });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(h.store.armedCount(), 1);

    await advanceMs(h.clock, 49);
    assert.equal(h.fired.length, 0, '49ms 时未到期');

    await advanceMs(h.clock, 1);
    assert.equal(h.fired.length, 1, '刚过 50ms 即触发');
    assert.equal(h.fired[0]?.id, res.id);
    assert.equal(h.fired[0]?.at, h.startMs + 50, '触发时刻就是到期时刻');
    assert.deepEqual(h.fired[0]?.entry.payload, { note: 'x' });

    // 一次性条目触发后移除，且不再有在途 handle
    assert.equal(h.store.get(res.id), null);
    assert.equal(h.store.list().length, 0);
    assert.equal(h.store.armedCount(), 0);

    await h.store.flush();
    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries, []);
  } finally {
    await cleanup(h);
  }
});

test('set 落盘的内容能被新实例 load 回来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const nowMs = 1_800_000_000_000;
  const clockA = createVirtualClock(nowMs);
  const a = new TimerStore(file, virtualStoreDepsForTest(clockA));
  await a.load();
  const res = await a.set({ at: new Date(nowMs + 3_600_000).toISOString(), payload: 42 });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const clockB = createVirtualClock(nowMs);
  const b = new TimerStore(file, virtualStoreDepsForTest(clockB));
  await b.load();
  const loaded = b.list();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.timerId, res.id);
  assert.equal(loaded[0]?.payload, 42);
  assert.equal(loaded[0]?.at, new Date(nowMs + 3_600_000).toISOString());
  assert.deepEqual(b.warnings(), []);
  a.stop();
  b.stop();
  await removeTree(dir);
});

test('已过期条目在 start() 时立即触发（once 语义，不跳过）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  const past = new Date(startMs - 5 * MINUTE_MS).toISOString();

  // 预置一份「上次运行留下的、已经过期」的表
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: past,
      entries: [{ timerId: 't_overdue', at: past, payload: 'wake-me', skipped: 0 }],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  // 构造时只读盘，不布防、不触发
  assert.equal(store.list().length, 1);

  const fired: StoredTimerEntry[] = [];
  store.start((entry) => {
    fired.push(entry);
  });

  // start() 内部就完成了触发，不需要推进时钟
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.timerId, 't_overdue');
  assert.equal(fired[0]?.payload, 'wake-me');
  assert.equal(store.get('t_overdue'), null);
  assert.equal(store.armedCount(), 0);

  store.stop();
  await removeTree(dir);
});

test('已过期的 cron 条目在 start() 时补最近一次并重新布防', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  const lastDue = new Date(startMs - 3 * DAY_MS).toISOString();
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: lastDue,
      entries: [{ timerId: 't_daily', at: lastDue, cron: '0 9 * * *', payload: { kind: 'digest' }, skipped: 0 }],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: StoredTimerEntry[] = [];
  store.start((entry) => {
    fired.push(entry);
  });

  assert.equal(fired.length, 1);
  const after = store.get('t_daily');
  assert.notEqual(after, null);
  assert.ok(Date.parse(after?.at ?? '') > startMs, '下一次到期必须在未来');
  assert.ok((after?.skipped ?? 0) >= 3, `离线段数应被记数，实际 ${after?.skipped}`);
  assert.deepEqual(after?.payload, { kind: 'digest' });

  store.stop();
  await removeTree(dir);
});

test('start() 重复调用不会重复布防，stop() 清空在途 handle', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    await h.store.set({ at: new Date(h.clock.now().getTime() + 60_000).toISOString() });
    assert.equal(h.store.armedCount(), 1);
    h.store.start(() => {});
    assert.equal(h.store.armedCount(), 1, '不应因重复 start 叠加 handle');

    h.store.stop();
    assert.equal(h.store.armedCount(), 0);
    await advanceMs(h.clock, 120_000);
    assert.equal(h.fired.length, 0, 'stop 之后不得触发');

    // stop 不改表也不删文件
    assert.equal(h.store.list().length, 1);
    await h.store.flush();
    const snap = await readSnapshot(h.file);
    assert.equal(snap.entries.length, 1);
  } finally {
    await cleanup(h);
  }
});

test('cancel() 移除条目、清 handle 并落盘', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const res = await h.store.set({ at: new Date(h.clock.now().getTime() + 1_000).toISOString() });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(await h.store.cancel(res.id), true);
    assert.equal(await h.store.cancel(res.id), false);
    assert.equal(h.store.armedCount(), 0);
    await advanceMs(h.clock, 5_000);
    assert.equal(h.fired.length, 0);

    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries, []);
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 分段布防 ────────────────────────────────

test('30 天后的定时器按 2^31-1ms 分段布防，不溢出也不提前触发', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const due = h.clock.now().getTime() + 30 * DAY_MS;
    const res = await h.store.set({ at: new Date(due).toISOString() });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    // 第一段顶到上限
    assert.equal(h.clock.lastDelayMs, MAX_TIMEOUT_MS);
    assert.equal(h.store.armedCount(), 1);

    // 第一段醒来时还没到点：重新接力而不是触发
    await advanceMs(h.clock, MAX_TIMEOUT_MS);
    assert.equal(h.fired.length, 0);
    assert.ok(h.clock.lastDelayMs > 0 && h.clock.lastDelayMs <= MAX_TIMEOUT_MS, '接力段必须落在上限内');

    // 最后一段收尾
    await advanceMs(h.clock, 30 * DAY_MS - MAX_TIMEOUT_MS);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.id, res.id);
    assert.equal(h.fired[0]?.at, due);
    assert.equal(h.store.armedCount(), 0);
  } finally {
    await cleanup(h);
  }
});

test('超过上限仅一点点的延迟也会被切成两段', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const due = h.clock.now().getTime() + MAX_TIMEOUT_MS + 1_000;
    await h.store.set({ at: new Date(due).toISOString() });
    assert.equal(h.clock.lastDelayMs, MAX_TIMEOUT_MS);
    await advanceMs(h.clock, MAX_TIMEOUT_MS);
    assert.equal(h.fired.length, 0);
    assert.equal(h.clock.lastDelayMs, 1_000);
    await advanceMs(h.clock, 1_000);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.at, due);
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── cron ────────────────────────────────

test('cron "*/1 * * * *" 触发后不删除条目，自动结算下一次', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const res = await h.store.set({ cron: '*/1 * * * *', payload: 'tick' });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const first = h.store.get(res.id);
    assert.equal(first?.at, new Date(h.startMs + MINUTE_MS).toISOString());

    await advanceMs(h.clock, MINUTE_MS);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.at, h.startMs + MINUTE_MS);

    const after = h.store.get(res.id);
    assert.notEqual(after, null, '周期条目触发后必须留在表里');
    assert.equal(after?.at, new Date(h.startMs + 2 * MINUTE_MS).toISOString());
    assert.equal(after?.cron, '*/1 * * * *');
    assert.equal(after?.skipped, 0);
    assert.equal(h.store.armedCount(), 1, '应当已重新布防');
    assert.equal(h.clock.lastDelayMs, MINUTE_MS);

    await advanceMs(h.clock, MINUTE_MS);
    assert.equal(h.fired.length, 2);
    assert.equal(h.store.get(res.id)?.at, new Date(h.startMs + 3 * MINUTE_MS).toISOString());

    // 落盘的表里也是推进后的 at，重启不会回到第一拍
    await h.store.flush();
    const snap = await readSnapshot(h.file);
    assert.equal(snap.entries[0]?.at, new Date(h.startMs + 3 * MINUTE_MS).toISOString());
  } finally {
    await cleanup(h);
  }
});

test('cron 跨过多拍时只补最近一次并记 skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  // 模拟「进程离线 2 小时」留下的表：上次到期时刻停在 2 小时前
  const lastDueMs = startMs - 2 * 3_600_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: new Date(lastDueMs).toISOString(),
      entries: [{ timerId: 't_tick', at: new Date(lastDueMs).toISOString(), cron: '*/1 * * * *', payload: null, skipped: 0 }],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: string[] = [];
  store.start((entry) => {
    fired.push(entry.timerId);
  });

  // 前 119 拍被跨过：只在当前时刻补一次
  assert.deepEqual(fired, ['t_tick'], '离线跨过的拍次只补最近一次');
  const entry = store.get('t_tick');
  assert.ok((entry?.skipped ?? 0) >= 120, `跨过的拍次要计数，实际 ${entry?.skipped}`);
  assert.equal(store.armedCount(), 1, '周期条目触发后仍在表里且已重新布防');

  // 下一次到期落在未来，延迟不超过一个周期
  const nextAt = Date.parse(entry?.at ?? '');
  assert.ok(nextAt > startMs, '下一次到期必须在未来');
  assert.ok(nextAt - startMs <= MINUTE_MS, '重新布防的延迟不超过一个周期');

  // 再走一拍：正常触发，并且仍然留在表里
  const fired2 = clock.advance(nextAt);
  await flushMicrotasks();
  assert.equal(fired2, 1);
  assert.equal(fired.length, 2);
  const after = store.get('t_tick');
  assert.notEqual(after, null);
  assert.ok(Date.parse(after?.at ?? '') > nextAt);

  store.stop();
  await removeTree(dir);
});

test('cron 解析：五段语法与对照参照逐拍一致', async () => {
  const startMs = 1_800_000_000_000;

  // "*/15 9-18 * * 1-5"：工作日 9-18 点的每 15 分钟
  const a = parseCron('*/15 9-18 * * 1-5');
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const aOut = nextCronTime(a.cron, new Date(startMs));
  assert.notEqual(aOut, null);
  if (aOut === null) return;
  assert.ok((aOut.getMinutes() % 15) === 0);
  assert.ok(aOut.getHours() >= 9 && aOut.getHours() <= 18);
  assert.ok((aOut.getDay() >= 1 && aOut.getDay() <= 5));

  // "0 3 1 * *"：每月 1 号 3 点（日段受限、周段为 *，不能落到 OR 分支）
  const b = parseCron('0 3 1 * *');
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const bOut = nextCronTime(b.cron, new Date(startMs));
  assert.notEqual(bOut, null);
  if (bOut === null) return;
  assert.equal(bOut.getDate(), 1);
  assert.equal(bOut.getHours(), 3);
  assert.equal(bOut.getMinutes(), 0);
  // 下一次之前的 3 天里不应有更早的匹配
  assertNoEarlierMatch('0 3 1 * *', startMs, bOut.getTime());

  // 日与周同时受限 → vixie 的 OR 语义
  const c = parseCron('0 0 1 * 1');
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const cOut = nextCronTime(c.cron, new Date(startMs));
  assert.equal(bruteForceNext('0 0 1 * 1', startMs), cOut?.getTime());

  // 星期 7 等同 0（周日）
  const d = parseCron('30 5 * * 7');
  assert.equal(d.ok, true);
  if (!d.ok) return;
  const dOut = nextCronTime(d.cron, new Date(startMs));
  assert.equal(dOut?.getDay(), 0);
  assert.equal(dOut?.getMinutes(), 30);
});

test('cron 解析拒绝非法表达式', () => {
  const bad = [
    '',
    '* * * *',
    '* * * * * *',
    '61 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '5-1 * * * *',
    '*/0 * * * *',
    'a * * * *',
    '* * * JAN *',
    '@daily',
  ];
  for (const expr of bad) {
    const res = parseCron(expr);
    assert.equal(res.ok, false, `应拒绝：${expr}`);
  }
  const good = ['* * * * *', '*/5 * * * *', '0 9 * * 1-5', '0,30 8-18 * * *', '15 4 1,15 * *'];
  for (const expr of good) {
    assert.equal(parseCron(expr).ok, true, `应接受：${expr}`);
  }
});

test('set() 拒绝非法输入，重复 id 由 store 自管', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const missing = await h.store.set({});
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /至少提供一个/);

    const badAt = await h.store.set({ at: '2026-09-30 14:00:00' });
    assert.equal(badAt.ok, false);
    if (!badAt.ok) assert.match(badAt.error, /ISO 8601/);

    const badCron = await h.store.set({ cron: '99 * * * *' });
    assert.equal(badCron.ok, false);
    if (!badCron.ok) assert.match(badCron.error, /cron 非法/);

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const badPayload = await h.store.set({ at: new Date(h.clock.now().getTime() + 1_000).toISOString(), payload: circular });
    assert.equal(badPayload.ok, false);
    if (!badPayload.ok) assert.match(badPayload.error, /序列化/);

    const farFuture = await h.store.set({ at: '9999-01-01T00:00:00Z' });
    assert.equal(farFuture.ok, false);
    if (!farFuture.ok) assert.match(farFuture.error, /50 年/);

    // at 与 cron 同时给出：以 at 为准并留 warning
    const bothAt = new Date(h.clock.now().getTime() + 5_000).toISOString();
    const both = await h.store.set({ at: bothAt, cron: '0 0 * * *' });
    assert.equal(both.ok, true);
    if (!both.ok) return;
    const stored = h.store.get(both.id);
    assert.equal(stored?.cron, undefined, '同时给出时 cron 必须被忽略');
    assert.equal(stored?.at, bothAt);
    assert.ok(h.store.warnings().some((w) => w.includes('以 at 为准')));
    assert.equal(h.store.list().length, 1, '每次 set 都拿到独立 id，互不覆盖');

    await h.store.cancel(both.id);
    assert.equal(h.store.list().length, 0);

    // cron 形式的 set 正常入表，并且结算出下一次到期
    const byCron = await h.store.set({ cron: '0 9 * * *' });
    assert.equal(byCron.ok, true);
    if (!byCron.ok) return;
    const cronEntry = h.store.get(byCron.id);
    assert.equal(cronEntry?.cron, '0 9 * * *');
    assert.ok(Date.parse(cronEntry?.at ?? '') > h.clock.now().getTime());
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 落盘 ────────────────────────────────

test('布局：set 后原文件存在，tmp 文件被 rename 掉', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    assert.equal(await stat(h.file).then(() => true, () => false), false, '首次 set 前不应有表文件');
    await h.store.set({ at: new Date(h.clock.now().getTime() + 60_000).toISOString() });
    const files = await readdir(h.dir);
    await h.store.flush();
    const files2 = await readdir(h.dir);
    assert.deepEqual(files2, ['timers.json'], '落盘结束后只应留下正式文件');
    assert.equal((await stat(h.file)).size > 0, true);
  } finally {
    await cleanup(h);
  }
});

/**
 * 清理临时目录。Windows 上目录刚被写过的瞬间常报 ENOTEMPTY（空目录也删不掉，
 * 通常是防病毒/索引持有句柄），所以退避重试，且绝不让清理失败掩盖断言结果。
 */
async function removeTree(dir: string): Promise<void> {
  let delay = 20;
  for (let attempt = 0; attempt < 9; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* 清理失败不影响测试结论：临时目录留在系统 temp 里由 OS 回收 */
  }
}

test('save() 走 .tmp + rename，且原文件在整个过程中始终存在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const clock = createVirtualClock(1_800_000_000_000);
  const seen: Array<{ from: string; to: string; destExisted: boolean; tmpReadable: string }> = [];
  let destMissing = 0;
  // 用注入的 createExclusive/rename 观察两阶段写入：esm 的命名空间导出不可改，
  // 但依赖注入点本来就为可观测性预留
  const store = new TimerStore(file, virtualStoreDepsForTest(clock, {
    createExclusive: async (path: string, data: string) => {
      await fsp.open(path, 'wx').then(async (handle) => {
        await handle.truncate(0);
        await handle.writeFile(data, 'utf8');
        await handle.sync();
        await handle.close();
      });
    },
    rename: async (from: string, to: string) => {
      const destExisted = await stat(to).then(() => true, () => false);
      if (!destExisted) destMissing += 1;
      const tmpReadable = await readFile(from, 'utf8');
      seen.push({ from, to, destExisted, tmpReadable });
      await fsp.rename(from, to);
    },
  }));
  await store.load();

  await store.set({ at: new Date(clock.now().getTime() + 1_000).toISOString() });
  const before = await readSnapshot(file);
  assert.equal(before.entries.length, 1);
  assert.equal(seen.length, 1, '第一次 set 也应经由 rename 落盘');

  await store.set({ at: new Date(clock.now().getTime() + 2_000).toISOString() });
  await store.flush();

  assert.equal(seen.length >= 2, true, `覆盖写必须经由 rename，实际 ${seen.length} 次`);
  for (const call of seen) {
    assert.equal(call.to, file);
    assert.match(call.from, /^.*timers\.json\.tmp\.\d+$/, `tmp 文件名应为 <path>.tmp.<pid>：${call.from}`);
    // rename 之前原文件仍在（不允许先删原文件）
    assert.ok(call.tmpReadable.includes('"entries"'), 'tmp 文件在 rename 前必须已写入内容');
  }
  assert.equal(destMissing, 1, '只有第一次 set 时目标文件不存在，此后每次都在');

  const after = await readSnapshot(file);
  assert.equal(after.entries.length, 2);
  const files = await readdir(dir);
  assert.deepEqual(files, ['timers.json']);
  store.stop();
  await removeTree(dir);
});

test('落盘失败只记 warning，内存表与既有文件都不被破坏', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const clock = createVirtualClock(1_800_000_000_000);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock, { rename: async () => { throw new Error('EIO: 磁盘故障'); } }));
  await store.load();
  const res = await store.set({ at: new Date(clock.now().getTime() + 1_000).toISOString() });
  assert.equal(res.ok, true);
  assert.equal(store.list().length, 1);
  assert.ok(store.warnings().some((w) => w.includes('EIO')), '失败必须留下可告警的痕迹');
  store.stop();
  await removeTree(dir);
});

test('损坏或非法的 timers.json 不会让 load 抛错，只留 warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const nowMs = 1_800_000_000_000;
  await writeFile(file, '{ 这不是 JSON', 'utf8');
  const clockA = createVirtualClock(nowMs);
  const a = new TimerStore(file, virtualStoreDepsForTest(clockA));
  await a.load();
  assert.deepEqual(a.list(), []);
  assert.equal(a.warnings().length, 1);
  a.stop();

  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: 'x',
      entries: [
        { timerId: 'ok', at: new Date(nowMs + 60_000).toISOString(), payload: null, skipped: 0 },
        { timerId: 'no-at' },
        { at: new Date(nowMs + 60_000).toISOString() },
        { timerId: 'bad-cron', at: new Date(nowMs + 60_000).toISOString(), cron: '99 * * * *' },
        { timerId: 'ok', at: new Date(nowMs + 120_000).toISOString() },
      ],
    }),
    'utf8',
  );
  const clockB = createVirtualClock(nowMs);
  const b = new TimerStore(file, virtualStoreDepsForTest(clockB));
  await b.load();
  assert.deepEqual(b.list().map((e) => e.timerId), ['ok']);
  assert.ok(b.warnings().some((w) => w.includes('非法表项')));
  assert.ok(b.warnings().some((w) => w.includes('去重')));
  b.stop();
  await removeTree(dir);
});

// ──────────────────────────────── 错峰补触发 ────────────────────────────────

test('多条过期条目按到期先后串行补触发，相邻间隔 >= 5s', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  const ago = (ms: number) => new Date(startMs - ms).toISOString();

  // 故意乱序写入，验证按 at 排序而不是按文件顺序
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: ago(DAY_MS),
      entries: [
        { timerId: 't_late', at: ago(3 * DAY_MS), payload: 'third', skipped: 0 },
        { timerId: 't_first', at: ago(9 * DAY_MS), payload: 'first', skipped: 0 },
        { timerId: 't_second', at: ago(5 * DAY_MS), payload: 'second', skipped: 0 },
      ],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: Array<{ id: string; at: number }> = [];
  const listsInsideCb: number[] = [];
  store.start((entry) => {
    fired.push({ id: entry.timerId, at: clock.now().getTime() });
    listsInsideCb.push(store.list().length);
  });

  // 第一发立即（start 内同步完成），后续各让出 5 秒
  assert.deepEqual(fired.map((f) => f.id), ['t_first']);
  // 回调触发时条目已经结算（一次性条目已从表里摘掉）
  assert.deepEqual(listsInsideCb, [2]);

  // 推进到第二条到期前 1ms：不得触发
  assert.equal(clock.advance(startMs + 5_000 - 1), 0, '不到 5 秒不得触发第二条');
  assert.equal(fired.length, 1);
  // 再前进 1ms 到第二个到期点
  assert.equal(clock.advance(startMs + 5_000), 1);
  await flushMicrotasks();
  assert.deepEqual(fired.map((f) => f.id), ['t_first', 't_second']);
  // 第三个到期点在 +5s，中间不得有夹带触发
  assert.equal(clock.advance(startMs + 10_000 - 1), 0);
  assert.equal(fired.length, 2);
  assert.equal(clock.advance(startMs + 10_000), 1);
  await flushMicrotasks();
  assert.deepEqual(fired.map((f) => f.id), ['t_first', 't_second', 't_late']);

  const gaps = [fired[1]!.at - fired[0]!.at, fired[2]!.at - fired[1]!.at];
  for (const gap of gaps) assert.ok(gap >= 5_000, `相邻间隔必须 >= 5s，实际 ${gap}`);
  assert.equal(store.list().length, 0);
  assert.ok(store.warnings().some((w) => w.includes('已过期')));

  store.stop();
  await removeTree(dir);
});

test('单条过期条目的立即触发不被错峰延迟', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: new Date(startMs - DAY_MS).toISOString(),
      entries: [{ timerId: 't_only', at: new Date(startMs - DAY_MS).toISOString(), payload: null, skipped: 0 }],
    }),
    'utf8',
  );
  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: string[] = [];
  store.start((entry) => {
    fired.push(entry.timerId);
  });
  assert.deepEqual(fired, ['t_only']);
  assert.equal(clock.now().getTime(), startMs, '不得为唯一一条付错峰代价');
  store.stop();
  await removeTree(dir);
});

test('未来条目与过期条目共存：未来的照常守时，过期的不冲掉它', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-timer-'));
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: new Date(startMs - DAY_MS).toISOString(),
      entries: [
        { timerId: 't_past', at: new Date(startMs - DAY_MS).toISOString(), payload: null, skipped: 0 },
        { timerId: 't_future', at: new Date(startMs + 30_000).toISOString(), payload: null, skipped: 0 },
      ],
    }),
    'utf8',
  );
  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: Array<{ id: string; at: number }> = [];
  store.start((entry) => {
    fired.push({ id: entry.timerId, at: clock.now().getTime() });
  });
  assert.deepEqual(fired.map((f) => f.id), ['t_past']);
  await advanceMs(clock, 30_000);
  assert.deepEqual(fired.map((f) => f.id), ['t_past', 't_future']);
  assert.equal(fired[1]?.at, startMs + 30_000);
  store.stop();
  await removeTree(dir);
});

// ──────────────────────────────── 真相源校准 ────────────────────────────────

test('snapshotFromEntries 与 importEntries：日志折算是真相源', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const stale = await h.store.set({ at: new Date(h.clock.now().getTime() + 3_600_000).toISOString(), payload: 'stale' });
    assert.equal(stale.ok, true);
    assert.equal(h.store.list().length, 1);

    const fromLog: unknown[] = [
      { timerId: 't_a', at: new Date(h.clock.now().getTime() + 120_000).toISOString(), payload: { a: 1 }, skipped: 0 },
      { timerId: 't_b', at: new Date(h.clock.now().getTime() + 240_000).toISOString(), skipped: 2 },
      { timerId: 'bad', at: 'not-a-time' },
    ];
    const res = await h.store.importEntries(fromLog);
    assert.equal(res.imported, 2);
    assert.equal(res.rejected.length, 1);

    // 盘上的旧条目不在了，并且真的写进了文件
    assert.deepEqual(h.store.snapshotFromEntries().map((e) => e.timerId), ['t_a', 't_b']);
    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries.map((e) => e.timerId), ['t_a', 't_b']);
    assert.equal(snap.entries[1]?.skipped, 2);
    assert.equal(h.store.armedCount(), 2, '导入时已在运行，应重新布防');
    await h.store.flush();
    assert.deepEqual(await h.store.snapshotFromEntries(), (await readSnapshot(h.file)).entries, 'snapshotFromEntries 必须与落盘一致');
  } finally {
    await cleanup(h);
  }
});

test('reconcile：盘上 hint 与日志不一致时以日志为准并回报差异', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const nowMs = h.clock.now().getTime();
    // 盘上塞两个 hint 条目：一个日志里没有（脏），一个到期时刻和日志不一致（陈旧）
    await h.store.importEntries([
      { timerId: 't_keep', at: new Date(nowMs + 60_000).toISOString(), payload: 'keep', skipped: 0 },
      { timerId: 't_dirty', at: new Date(nowMs + 90_000).toISOString(), payload: 'dirty', skipped: 0 },
      { timerId: 't_stale', at: new Date(nowMs + 600_000).toISOString(), payload: 'stale', skipped: 0 },
    ]);
    assert.equal(h.store.list().length, 3);

    const logDerived: unknown[] = [
      { timerId: 't_keep', at: new Date(nowMs + 60_000).toISOString(), payload: 'keep', skipped: 0 },
      { timerId: 't_stale', at: new Date(nowMs + 300_000).toISOString(), payload: 'stale', skipped: 0 },
      { timerId: 't_new', at: new Date(nowMs + 420_000).toISOString(), payload: 'new', skipped: 0 },
    ];
    const diff = await h.store.reconcile(logDerived);

    assert.equal(diff.mismatch, true);
    assert.deepEqual(diff.missing, ['t_new']);
    assert.deepEqual(diff.extra, ['t_dirty']);
    assert.deepEqual(diff.different, ['t_stale']);
    assert.equal(diff.sourceCount, 3);
    assert.equal(diff.fileCount, 3);
    assert.ok(h.store.warnings().some((w) => w.includes('按日志重建')));

    // 内存与磁盘都已按日志重建
    assert.deepEqual(h.store.snapshotFromEntries().map((e) => e.timerId), ['t_keep', 't_stale', 't_new']);
    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries.map((e) => e.timerId), ['t_keep', 't_stale', 't_new']);
    assert.equal(snap.entries[1]?.at, new Date(nowMs + 300_000).toISOString());
  } finally {
    await cleanup(h);
  }
});

test('reconcile：一致时不改动盘上文件', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const nowMs = h.clock.now().getTime();
    const entries: unknown[] = [
      { timerId: 't_x', at: new Date(nowMs + 60_000).toISOString(), payload: 1, skipped: 0 },
      { timerId: 't_y', at: new Date(nowMs + 120_000).toISOString(), cron: '0 9 * * *', payload: 2, skipped: 3 },
    ];
    await h.store.importEntries(entries);
    const rawBefore = await readFile(h.file, 'utf8');

    const diff = await h.store.reconcile(entries);
    assert.equal(diff.mismatch, false);
    assert.deepEqual(diff.missing, []);
    assert.deepEqual(diff.extra, []);
    assert.deepEqual(diff.different, []);
    assert.equal(await readFile(h.file, 'utf8'), rawBefore, '一致时不得重写文件');
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 事件折叠辅助 ────────────────────────────────

test('timerEntriesFromEvents 折叠 timer/set 与 timer/cancelled', () => {
  const events = [
    { type: 'timer/set', data: { timerId: 't1', at: '2026-09-30T14:00:00+08:00', payload: { a: 1 } } },
    { type: 'timer/set', data: { timerId: 't2', cron: '0 9 * * *', payload: null } },
    { type: 'timer/set', data: { timerId: 't3', at: '2026-09-30T15:00:00+08:00', payload: null } },
    { type: 'timer/cancelled', data: { timerId: 't3' } },
    { type: 'timer/set', data: {} },
    { type: 'timer/fired', data: { timerId: 't1' } },
    { type: 'timer/set', data: { timerId: 't4', payload: null } },
  ];
  const folded = timerEntriesFromEvents(events);
  assert.deepEqual(folded.map((e) => e.timerId), ['t1', 't2']);
  assert.deepEqual(folded[0]?.at, '2026-09-30T14:00:00+08:00');
  assert.deepEqual(folded[0]?.payload, { a: 1 });
  assert.equal(folded[1]?.cron, '0 9 * * *');
});

test('折叠结果经 importEntries 能被直接采用', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const nowMs = h.clock.now().getTime();
    const events = [
      { type: 'timer/set', data: { timerId: 't1', at: new Date(nowMs + 60_000).toISOString(), payload: 'p' } },
      { type: 'timer/set', data: { timerId: 't2', at: 'not-a-time', payload: 'q' } },
    ];
    const res = await h.store.importEntries(timerEntriesFromEvents(events));
    assert.equal(res.imported, 1);
    assert.equal(res.rejected.length, 1);
    assert.equal(h.store.list()[0]?.timerId, 't1');
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 常量护栏 ────────────────────────────────

test('MAX_TIMEOUT_MS 就是 2^31-1', () => {
  assert.equal(MAX_TIMEOUT_MS, 2 ** 31 - 1);
  assert.equal(new Date(MAX_TIMEOUT_MS).getTime() > 0, true);
});

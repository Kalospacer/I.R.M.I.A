/**
 * 心跳与空闲退避测试（milestones.md M5-3 / M5-14、docs/design.md §4.12）
 *
 * 覆盖面：
 *   - ① 退避公式：基线 × min(2^idleTicks, 上限) × (1.5 − pressure)，压力高压扁退避
 *   - ② 复位语义：noteActivity 把空拍归零并按基线重新计时；心跳自己不复位（fire 时 +1）
 *   - ③ 节律策略：返回 null 不产生任何事实、不递增空拍，并按重查间隔重新排期
 *   - ④ 策略容错：策略抛错按"照常心跳"处理（心跳是活性保障，不能被策略 bug 掐死）
 *   - ⑤ 唤醒源接线：fire 时把 {quietSeconds, idleTicks, pressure} 交给 sink
 *   - ⑥ quietSeconds 口径：优先"距她上次开口"，其次"距上次被唤醒"，缺参照时为 0
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppEvent, Projection, WakeHeartbeat } from '../src/log/types.ts';
import { emptyProjection } from '../src/log/types.ts';
import {
  DEFAULT_BACKOFF_MAX, DEFAULT_HEARTBEAT_CEIL_MS, DEFAULT_HEARTBEAT_FLOOR_MS,
  Heartbeat, HeartbeatSource, POLICY_RECHECK_MS,
  type HeartbeatFiring, type HeartbeatSink,
} from '../src/wake/heartbeat.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const MIN = 60_000;
const BASELINE = 30 * MIN;
const T0 = Date.parse('2026-02-14T10:00:00.000+08:00');

/** 假闹钟：手动推进定时器，不依赖真实时钟（心跳测试必须是确定的） */
interface FakeClock {
  now: () => Date;
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** 当前挂起的定时器（null 表示没有） */
  pending: () => { ms: number; handle: number } | null;
  /** 推进 ms 毫秒并触发到点的定时器 */
  advance: (ms: number) => void;
  /** 定时器被重新布防的次数（noteActivity 是否真的重排了） */
  arms: () => number;
}

function fakeClock(startMs = T0): FakeClock {
  let current = startMs;
  let nextHandle = 0;
  let armed: { ms: number; handle: number } | null = null;
  let armCount = 0;
  const table = new Map<number, () => void>();

  const fire = (handle: number): void => {
    const handler = table.get(handle);
    table.delete(handle);
    armed = null;
    handler?.();
  };

  return {
    now: () => new Date(current),
    setTimer: (handler, ms) => {
      nextHandle += 1;
      armCount += 1;
      armed = { ms, handle: nextHandle };
      table.set(nextHandle, handler);
      return nextHandle;
    },
    clearTimer: (handle) => {
      table.delete(handle as number);
      if (armed?.handle === handle) armed = null;
    },
    pending: () => (armed === null ? null : { ...armed }),
    advance: (ms) => {
      current += ms;
      const due = armed;
      if (due !== null && ms >= due.ms) fire(due.handle);
    },
    arms: () => armCount,
  };
}

/** 投影替身：只用得到 idleTicks / pressure / lastAssistantAt / lastWake */
function projectionOf(patch: Partial<Projection> = {}): Projection {
  return { ...emptyProjection(), ...patch };
}

function heartbeatEvent(data: WakeHeartbeat['data'], seq = 1): AppEvent {
  return {
    seq,
    ts: new Date(T0).toISOString(),
    type: 'wake/heartbeat',
    data,
    visibility: 'model',
    origin: 'test',
  } as unknown as AppEvent;
}

interface Harness {
  clock: FakeClock;
  /** 建一个心跳（附投影）：投影是副本，测试改它不影响别人 */
  make: (
    patch?: Partial<Projection>,
    options?: HeartbeatOptionsForTest,
  ) => { beat: Heartbeat; projection: Projection };
}

interface HeartbeatOptionsForTest {
  baselineMs?: number;
  backoffMax?: number;
  policy?: () => 'fire' | 'skip' | null;
  /**
   * 默认**不设区间**（floor 1ms / ceil ∞），好让公式测试看到裸值。
   * 生产默认是 10~60 分钟，那一组在区间小节里单独测。
   */
  floorMs?: number;
  ceilMs?: number;
}

function makeHarness(startMs = T0): Harness {
  const clock = fakeClock(startMs);
  const make = (
    patch: Partial<Projection> = {},
    options: HeartbeatOptionsForTest = {},
  ): { beat: Heartbeat; projection: Projection } => {
    // 每个实例拿自己的投影副本：共享一份会被测试互相污染（这里踩过一次）
    const projection = { ...emptyProjection(), ...patch };
    const beat = new Heartbeat({
      projection,
      baselineMs: options.baselineMs ?? BASELINE,
      backoffMax: options.backoffMax ?? DEFAULT_BACKOFF_MAX,
      floorMs: options.floorMs ?? 1,
      ceilMs: options.ceilMs ?? Number.POSITIVE_INFINITY,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { beat, projection };
  };
  return { clock, make };
}

// ──────────────────────────────── ① 退避公式 ────────────────────────────────

test('M5-3 退避公式：基线 × min(2^idleTicks, 上限) × (1.5 − pressure)', () => {
  const h = makeHarness();

  // 压力为 0：乘数 1.5；空拍 0：倍数 1
  assert.equal(h.make({ idleTicks: 0, pressure: 0 }).beat.nextDelayMs(), BASELINE * 1.5);

  // 空拍翻倍：1 → ×2，2 → ×4，3 → ×8（上限）
  for (const [ticks, factor] of [[1, 2], [2, 4], [3, 8]] as const) {
    const { beat } = h.make({ idleTicks: ticks, pressure: 0 });
    assert.equal(beat.nextDelayMs(), BASELINE * factor * 1.5, `空拍 ${ticks} 应翻倍到 ×${factor}`);
  }

  // 封顶：空拍再多也不超过 idleBackoffMax 倍
  for (const ticks of [4, 10, 50]) {
    const { beat } = h.make({ idleTicks: ticks, pressure: 0 });
    assert.equal(beat.nextDelayMs(), BASELINE * DEFAULT_BACKOFF_MAX * 1.5, `空拍 ${ticks} 应封顶在 ×8`);
  }
});

test('M5-14 压力调制：压力高压扁退避（有牵挂时睡不沉）', () => {
  const h = makeHarness();

  const calm = h.make({ idleTicks: 2, pressure: 0 }).beat;
  const pressed = h.make({ idleTicks: 2, pressure: 1 }).beat;
  assert.equal(pressed.nextDelayMs(), BASELINE * 4 * 0.5, '压力满格时乘数压到 0.5');
  assert.ok(pressed.nextDelayMs() < calm.nextDelayMs(), '压力升高必须让下一拍更早');

  // 单调性：0 → 1 逐档收紧
  let previous = Number.POSITIVE_INFINITY;
  for (const pressure of [0, 0.25, 0.5, 0.75, 1]) {
    const delay = h.make({ idleTicks: 1, pressure }).beat.nextDelayMs();
    assert.ok(delay < previous, `压力 ${pressure} 应比上一档更早`);
    previous = delay;
  }
});

// ──────────────────────────────── ② 复位与自增 ────────────────────────────────

test('M5-3 外部事件复位：noteActivity 清空拍并按基线重新计时', () => {
  const h = makeHarness();
  const { beat } = h.make({ idleTicks: 5, pressure: 0 });

  beat.start();
  assert.equal(h.clock.pending()?.ms, BASELINE * 1.5, '首拍按基线等价间隔布防（不带空拍退避）');
  const armsBefore = h.clock.arms();

  beat.noteActivity();
  assert.ok(h.clock.arms() > armsBefore, '复位必须重新布防');
  assert.equal(h.clock.pending()?.ms, BASELINE * 1.5, '复位后回到基线，退避被清掉');

  // 对照：不清空拍的话，下一拍本来要等 ×8
  const idle = h.make({ idleTicks: 5, pressure: 0 }).beat;
  assert.equal(idle.nextDelayMs(), BASELINE * DEFAULT_BACKOFF_MAX * 1.5);
  assert.ok((h.clock.pending()?.ms ?? 0) < idle.nextDelayMs(), '复位确实把间隔拉回了基线');

  beat.stop();
  assert.equal(h.clock.pending(), null, 'stop 清掉在途定时器');
});

test('M5-3 心跳自己不复位：每拍把空拍 +1（退避靠它累积）', () => {
  const h = makeHarness();
  const { beat, projection } = h.make({ idleTicks: 3, pressure: 0 });
  beat.start();

  const first = beat.fireNow();
  assert.equal(first?.idleTicks, 4, '空拍在交付事实里 +1');

  // 投影回读（日志折叠结果）成为下一拍依据
  projection.idleTicks = first?.idleTicks ?? 0;
  assert.equal(beat.nextDelayMs(), BASELINE * DEFAULT_BACKOFF_MAX * 1.5, '空拍 4 已封顶在 ×8');

  projection.idleTicks = 0;
  assert.equal(beat.nextDelayMs(), BASELINE * 1.5, '复位后回到基线');

  beat.stop();
});

test('定时器到点自动重排下一拍，且间隔按新空拍增长', () => {
  const h = makeHarness();
  const { beat, projection } = h.make({ idleTicks: 0, pressure: 0 });
  beat.start();

  // 到点：把事实里的空拍写回投影（模拟日志折叠），下一拍就会翻倍
  beat.setOnFire((firing) => {
    projection.idleTicks = firing.idleTicks;
  });
  h.clock.advance(BASELINE * 1.5);
  assert.equal(beat.beatCount, 1, '到点交付一拍');
  assert.equal(projection.idleTicks, 1);
  assert.equal(h.clock.pending()?.ms, BASELINE * 2 * 1.5, '下一拍按 ×2 布防');

  h.clock.advance(BASELINE * 3);
  assert.equal(beat.beatCount, 2);
  assert.equal(projection.idleTicks, 2);
  assert.equal(h.clock.pending()?.ms, BASELINE * 4 * 1.5);

  beat.stop();
});

// ──────────────────────────────── ③ 节律策略 ────────────────────────────────

test('节律策略返回 null：此刻不心跳，不产生任何事实，按重查间隔重排', () => {
  const h = makeHarness();
  const { beat, projection } = h.make({ idleTicks: 2, pressure: 0 }, { policy: () => null });
  beat.start();
  // 让回调写回空拍，好验证"被否决的那一拍不 +1"
  beat.setOnFire((firing) => {
    projection.idleTicks = firing.idleTicks;
  });

  const seen: HeartbeatFiring[] = [];
  beat.setOnFire((firing) => {
    seen.push(firing);
    projection.idleTicks = firing.idleTicks;
  });

  assert.equal(beat.fireNow(), null, '策略否决时必须返回 null（零事件、零回调、零计数）');
  assert.equal(beat.beatCount, 0, '被否决的一拍不计入心跳数');
  assert.deepEqual(seen, [], '否决不交付任何事实');
  assert.equal(h.clock.pending()?.ms, POLICY_RECHECK_MS, '重查排到 POLICY_RECHECK_MS 之后');

  // 策略改口（模拟热更）：重查到点后正常心跳
  beat.setPolicy(() => 'fire');
  h.clock.advance(POLICY_RECHECK_MS);
  assert.equal(beat.beatCount, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.idleTicks, 3, '被否决的那一拍不 +1');
  assert.equal(projection.idleTicks, 3);

  beat.stop();
});

test("策略返回 'skip' 与 null 等价；返回 'fire' 照常", () => {
  const h = makeHarness();
  assert.equal(h.make({}, { policy: () => 'skip' }).beat.fireNow(), null);

  const firing = h.make({}, { policy: () => 'fire' }).beat.fireNow();
  assert.notEqual(firing, null);
  assert.equal(firing?.idleTicks, 1);
});

test('策略抛错按照常心搏处理：心跳不允许被策略 bug 掐死', () => {
  const h = makeHarness();
  const { beat } = h.make({}, {
    policy: () => {
      throw new Error('策略炸了');
    },
  });
  const firing = beat.fireNow();
  assert.notEqual(firing, null, '策略异常时仍必须心跳');
  assert.equal(beat.beatCount, 1);
});

// ──────────────────────────────── ④ 唤醒源接线 ────────────────────────────────

test('HeartbeatSource 把事实交给 sink（{quietSeconds, idleTicks, pressure} 三键齐备）', () => {
  const h = makeHarness();
  const { beat } = h.make(
    { idleTicks: 4, pressure: 0.35, lastAssistantAt: new Date(T0 - 90_000).toISOString() },
  );

  const written: WakeHeartbeat['data'][] = [];
  const sink: HeartbeatSink = { emitHeartbeat: (data) => written.push(data) };
  const source = new HeartbeatSource(beat, sink);
  assert.equal(source.name, 'heartbeat');

  source.start();
  // 首拍按基线等价间隔（不带空拍退避）：压力 0.35 → 乘数 1.15。
  // 加 1ms 的容差：1.5-0.35 的浮点结果是 1.1499999…，正好差一点点不到点
  h.clock.advance(BASELINE * (1.5 - 0.35) + 1);
  source.stop();

  assert.equal(written.length, 1);
  // 安静时长 = 构造时的 90 秒 + 时钟推进的秒数（首拍间隔不带空拍退避，故为 34.5 分钟）
  const advancedSeconds = Math.round(BASELINE * (1.5 - 0.35) / 1000);
  assert.deepEqual({ ...written[0] }, { quietSeconds: 90 + advancedSeconds, idleTicks: 5, pressure: 0.35 });
  assert.equal(beat.beatCount, 1);
});

test('quietSeconds：优先距上次发言，其次距上次被唤醒，缺参照为 0', () => {
  const h = makeHarness();

  assert.equal(
    h.make({ lastAssistantAt: new Date(T0 - 3 * 3600_000).toISOString() }).beat.fireNow()?.quietSeconds,
    3 * 3600,
    '3 小时 → 10800 秒',
  );

  assert.equal(
    h.make({
      lastAssistantAt: null,
      lastWake: { source: 'manual', at: new Date(T0 - 600_000).toISOString() },
    }).beat.fireNow()?.quietSeconds,
    600,
    '无发言记录时用上次唤醒时刻',
  );

  assert.equal(
    h.make({ lastAssistantAt: null, lastWake: null }).beat.fireNow()?.quietSeconds,
    0,
    '全新实例不凭空造一个巨大安静时长',
  );

  assert.equal(
    h.make({ lastAssistantAt: new Date(T0 + 60_000).toISOString() }).beat.fireNow()?.quietSeconds,
    0,
    '参照时刻在未来时归零，不给负数',
  );
});

// ─────────────────────────── ⑤ 区间（体感） ───────────────────────────

// 为什么要有上下限：心跳太快是骚扰，太慢是“她睡死了”。两个方向都得封口。
test('M5-3 间隔夹在 [下限, 上限]：退避再深也不超过一小时，压力再大也不短于十分钟', () => {
  const h = makeHarness();
  const range = { floorMs: DEFAULT_HEARTBEAT_FLOOR_MS, ceilMs: DEFAULT_HEARTBEAT_CEIL_MS };

  // 静默很久：公式 30×8×1.5 = 360 分钟 → 夹到 60 分钟
  const deep = h.make({ idleTicks: 12, pressure: 0 }, range);
  assert.equal(deep.beat.nextDelayMs(), 60 * MIN, '再安静也不该超过一小时不露面');

  // 压力满格 + 小基线：公式 5×1×0.5 = 2.5 分钟 → 抬到 10 分钟
  const hot = h.make({ idleTicks: 0, pressure: 1 }, { ...range, baselineMs: 5 * MIN });
  assert.equal(hot.beat.nextDelayMs(), 10 * MIN, '压力再大也不短于十分钟一拍');
});

test('M5-3 区间可配：上下限自己定，配反了以下限为准', () => {
  const h = makeHarness();

  const custom = h.make({ idleTicks: 40, pressure: 0 }, { floorMs: 2 * MIN, ceilMs: 20 * MIN });
  assert.equal(custom.beat.nextDelayMs(), 20 * MIN, '上限以配置为准');

  // 上限写小于下限是配置写反了：心跳更快不危险，静默更久才危险 → 取上限为下限
  const inverted = h.make({ idleTicks: 40, pressure: 0 }, { floorMs: 20 * MIN, ceilMs: 5 * MIN });
  assert.equal(inverted.beat.nextDelayMs(), 20 * MIN, '上限低于下限时不要把间隔压到下限以下');
});

test('布防第一拍也受区间约束（刚重启就不该立刻心跳）', () => {
  const h = makeHarness();
  const { beat } = h.make(
    { idleTicks: 0, pressure: 0 },
    { baselineMs: 300 * MIN, floorMs: 10 * MIN, ceilMs: 60 * MIN },
  );
  beat.start();
  // 基线 300×1.5 = 450 分钟，但不该把首次心跳排到七个半小时后
  assert.equal(h.clock.pending()?.ms, 60 * MIN, '首拍也要夹进区间');
  beat.stop();
});

// ──────────────────────────────── ⑥ 退化 ────────────────────────────────

test('布防幂等：start 重复调用不叠加定时器；stop 后不再触发', () => {
  const h = makeHarness();
  const { beat } = h.make();

  beat.start();
  const afterFirst = h.clock.arms();
  beat.start();
  assert.equal(h.clock.arms(), afterFirst, '重复 start 不重新布防');

  beat.stop();
  h.clock.advance(BASELINE * 100);
  assert.equal(beat.beatCount, 0, 'stop 之后不再心跳');
});

test('退化输入不产生热循环：基线非法时落回默认 30 分钟，上限非法时落回 8 倍', () => {
  const h = makeHarness();
  // 压力取 0，好让期望值只反映基线与退避倍率（默认底噪 0.05 会让乘数变成 1.45）
  const calm = { pressure: 0 };
  // 非法基线（0 / NaN）必须回落到默认值，而不是被抬到 1 秒再乘 1.45（那是个热循环）
  assert.equal(h.make(calm, { baselineMs: 0 }).beat.nextDelayMs(), 30 * MIN * 1.5);
  assert.equal(h.make(calm, { baselineMs: Number.NaN }).beat.nextDelayMs(), 30 * MIN * 1.5);

  const capped = h.make({ ...calm, idleTicks: 40 }, { baselineMs: MIN, backoffMax: 0 }).beat;
  assert.equal(capped.nextDelayMs(), MIN * DEFAULT_BACKOFF_MAX * 1.5, '非法上限回落到默认 8 倍');
});

test('心跳事件替身形状与 schema 一致（提醒：改 schema 必须同步这里）', () => {
  const event = heartbeatEvent({ quietSeconds: 30, idleTicks: 1, pressure: 0.05 });
  assert.deepEqual(Object.keys(event.data as object).sort(), ['idleTicks', 'pressure', 'quietSeconds']);
});

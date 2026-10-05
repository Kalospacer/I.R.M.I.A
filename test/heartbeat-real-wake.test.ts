/**
 * 心跳"真实唤醒"的判据（2026-10-05 用户改口径；docs/design.md §4.11 / §4.12）
 *
 * 用户原话（逐字）：
 *
 * > 「我告诉你一个为什么我要设置心跳是真实唤醒：**唤醒一次的花费远少于缓存前缀被供方回收的花费**。
 * > 心跳真实唤醒也可以**维护供方处的 KV cache**。」
 *
 * 本次要拆开的是**两件事**：调模型（每一拍都要做）与开不开口（她自己在 turn 里定）。
 * 改之前它们是一件事——回复必要性门在**调模型之前**就判"空转"，于是心跳一拍一个请求都不发
 * （实测全库 52 次心跳走了模型的 0 次），供方那边的 KV 前缀一次都没被刷新。
 * **那道门 2026-10-05 已拆**（原意、为什么废与"别再把它接回心跳拍"的警告见 docs/design.md
 * 「试过并废掉的口径：回复必要性门」）——本文件是那条口径的生产级判据。
 *
 * 覆盖：
 *   ① 纯心跳拍**必须发生一次模型调用**（heavy 车道），并落 `budget/consumed{lane:'heavy'}`
 *   ② 非心跳拍**与改动前逐字节一致**（事件序列 + 剥掉此刻层后的请求指纹；基线在改动前捕获）
 *   ③ "调模型"与"开不开口"解耦：她整拍不说话（`spoke:false`），调用照样发生；唤醒提示一字未改
 *   ④ 可审计：`memory/selected{injection:'heartbeat'}` + `step/start` + `budget/consumed` 同现，
 *      且顺序落定（不新增事件类型，复用既有的 `isHeartbeatTurn` 派生字段）
 *   ⑤ 同一份冻结前缀：心跳拍与普通回合共用同一份 `instructions`（人格常驻层）与同一份工具清单
 *
 * 台子见 `test/fixtures/real-wake-rig.ts`：真 RealLoop + 真 agent-loop + 真折叠，只有模型是假的。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { heartbeatData, makeRealWakeRig, requestFingerprint } from './fixtures/real-wake-rig.ts';

// ──────────────────────────────── 改动前的基线 ────────────────────────────────

/*
 * 基线的取法：`node --experimental-strip-types _research/heartbeat-real-wake-baseline.mjs`
 * 在本改动**之前**的代码上跑（脚本用的就是同一个台子与同一个指纹函数）。改动之后复跑，
 * 非心跳拍的两组值必须一字不变——这正是"非心跳拍行为与改动前逐字节一致"的证据。
 *
 * 指纹口径（`requestFingerprint`）：`instructions` + 工具名 + `input` 里**剥掉此刻层**的 items。
 * 剥此刻层是因为它含本机事实（磁盘剩余空间、临时工作根路径）——那是环境噪声，不是行为差异。
 */

/** 改动前：非心跳拍（单条 `wake/manual`） */
const BEFORE_MANUAL_TYPES = [
  'wake/manual', 'budget/rollover', 'snapshot/checkpoint', 'turn/start', 'input/claimed',
  'memory/selected', 'step/start', 'message/assistant', 'budget/consumed', 'step/end', 'turn/end',
];
const BEFORE_MANUAL_FINGERPRINT = '9550a4c44b930e6a';

/** 改动前：混批（心跳 + `wake/manual`）——按"非纯心跳"处理，与改动前一致 */
const BEFORE_MIXED_TYPES = [
  'wake/heartbeat', 'wake/manual', 'budget/rollover', 'snapshot/checkpoint', 'turn/start', 'input/claimed',
  'memory/selected', 'step/start', 'message/assistant', 'budget/consumed', 'step/end', 'turn/end',
];
const BEFORE_MIXED_FINGERPRINT = 'd8ba95e5f40b7516';

/** 改动前：纯心跳拍 —— 事件序列里**没有任何 step**，请求数 0（这就是要修的那个形态） */
const BEFORE_HEARTBEAT_TYPES = [
  'wake/heartbeat', 'budget/rollover', 'snapshot/checkpoint', 'turn/start', 'input/claimed', 'turn/end',
];

/** 一次整拍：落一条唤醒 → 跑一拍（生产定时器回调与 `tick()` 是同一份逻辑） */
async function runOneWake(
  wake: { type: string; data: unknown },
  script: Array<{ text?: string; toolCalls?: unknown[] }> = [{ text: '', toolCalls: [] }],
): Promise<Awaited<ReturnType<typeof makeRealWakeRig>>> {
  const rig = await makeRealWakeRig({ stream: script });
  try {
    rig.append(wake.type, wake.data);
    await rig.tick();
    return rig;
  } catch (err) {
    rig.dispose();
    throw err;
  }
}

// ──────────────────────────────── ① 真实唤醒 ────────────────────────────────

test('① 纯心跳拍真的发出一次 heavy 请求，并落 budget/consumed{lane:heavy}', async (t) => {
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(rig.dispose);

  assert.equal(rig.requests.length, 1, '心跳拍必须恰好发一次请求（不多不少）');
  const [sent] = rig.requests;
  assert.equal(sent!.lane, 'heavy', '走主力车道：只有它与普通回合共用同一条前缀，light 判定请求刷不到那条缓存');
  assert.equal(sent!.request.model, 'fake-heavy');
  assert.equal(
    rig.requests.filter(item => item.lane === 'light').length, 0,
    '"真实唤醒"= 这一拍走主力车道；它不需要、也不该再有一条"先花一次 light 判定"的路',
  );

  const events = await rig.events();
  const steps = events.filter(event => event.type === 'step/start');
  const consumed = events.filter(event => event.type === 'budget/consumed');
  assert.equal(steps.length, 1, '心跳拍起了 step（旧形态是一步都没有）');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]!.data.lane, 'heavy', '这一拍的账记在 heavy 上（不是 light）');
  assert.equal(consumed[0]!.data.turn, steps[0]!.data.turn, '账挂在同一个 turn 上');

  // 改动前的形态：请求 0 次、一个 step 都没有——这条断言是"确实改了"的反面参照
  assert.notDeepEqual((await rig.types()), BEFORE_HEARTBEAT_TYPES);
});

test('①b 一整库"牵挂"全无（到期意图/待确认/待办/等回答/死信都没有）也照样起一拍', async (t) => {
  // 这正是当年被规则短路吃掉的形态："没事"曾经等于"不发请求"。现在"没事"由她自己在 turn 里
  // 得出结论（并且照样可以整拍不说话），但**请求必须发出去**——前缀就是靠它保温的。
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(3600, 3) });
  t.after(rig.dispose);

  assert.deepEqual(rig.projection.pending, [], '心跳已被认领出队（走过的是正常 turn 的认领路径）');
  assert.equal(rig.requests.length, 1, '无牵挂不再是"不发请求"的理由');
});

// ──────────────────────────────── ② 非心跳拍回归 ────────────────────────────────

test('② 非心跳拍与改动前逐字节一致：事件序列 + 请求指纹（基线在改动前捕获）', async (t) => {
  const manual = await runOneWake({ type: 'wake/manual', data: { note: '帮我看看日志' } });
  t.after(manual.dispose);
  assert.deepEqual(await manual.types(), BEFORE_MANUAL_TYPES, '非心跳拍的事件序列必须与改动前一字不差');
  assert.deepEqual(
    manual.requests.map(item => `${item.lane}:${requestFingerprint(item.request)}`),
    [`heavy:${BEFORE_MANUAL_FINGERPRINT}`],
    '非心跳拍的请求字节（剥掉此刻层）必须与改动前一致',
  );
});

test('②b 混批（心跳 + 人）仍按"有真实事件"处理：与改动前逐字节一致', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }] });
  t.after(rig.dispose);
  rig.append('wake/heartbeat', heartbeatData(1800, 1));
  rig.append('wake/manual', { note: '混批' });
  await rig.tick();

  assert.deepEqual(await rig.types(), BEFORE_MIXED_TYPES);
  assert.deepEqual(
    rig.requests.map(item => `${item.lane}:${requestFingerprint(item.request)}`),
    [`heavy:${BEFORE_MIXED_FINGERPRINT}`],
  );
});

// ──────────────────────────────── ③ 调模型 ≠ 开口 ────────────────────────────────

test('③ 她不开口（spoke:false）时真实调用照样完成：两件事解耦', async (t) => {
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(rig.dispose);
  const events = await rig.events();

  const end = events.filter(event => event.type === 'turn/end').at(-1);
  assert.deepEqual(end?.data.reason, { kind: 'completed' });
  assert.equal(end?.data.spoke, false, '她整拍没说话——这是允许的正常结局');
  assert.equal(events.filter(event => event.type === 'message/assistant').length, 1, '但模型确实回了一次');
  assert.equal(rig.requests.length, 1, '不说话不等于不调模型：请求已经发出去了');

  // 唤醒提示一个字没改：她仍然被告知"没事就接着睡"
  const prompt = (rig.requests[0]!.request.input as Array<{ content?: unknown }>)
    .map(item => (typeof item.content === 'string' ? item.content : ''))
    .join('\n');
  assert.match(prompt, /心跳自省：无事发生是常态，看一眼待办与意图，没事就接着睡/);
});

// ──────────────────────────────── ④ 可审计 ────────────────────────────────

test('④ 可审计：既有事件链就能看出"这一拍是心跳驱动的真实调用"', async (t) => {
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(rig.dispose);
  const events = await rig.events();

  const claimed = events.find(event => event.type === 'input/claimed');
  const selected = events.find(event => event.type === 'memory/selected');
  const step = events.find(event => event.type === 'step/start');
  const consumed = events.find(event => event.type === 'budget/consumed');
  assert.ok(claimed && selected && step && consumed, '五件事实必须都在：认领 / 注入账 / 起 step / 记账');

  // `injection:'heartbeat'` 由既有的 `isHeartbeatTurn` 判据派生（agent-loop 的 planMemorySelection）：
  // 它与 step/start、budget/consumed 同现，就是"心跳驱动的真实调用"的可查凭据——没有新事件类型。
  assert.equal(selected.data.injection, 'heartbeat');
  assert.equal(selected.data.indexHash, '', '心跳轮什么都不注入（2026-10-04 的口径未动）');
  assert.equal(selected.data.entries, 0);
  assert.deepEqual(claimed.data.wakeSeqs.length, 1);
  assert.ok(selected.seq < step.seq, '装配账落在 step 之前（schema §15 的不变量）');
  assert.ok(step.seq < consumed.seq, '先起 step，再落账');
});

// ──────────────────────────────── ⑤ 同一份冻结前缀 ────────────────────────────────

test('⑤ 心跳拍与普通回合共用同一份冻结前缀（instructions / 工具清单逐字节相同）', async (t) => {
  const beat = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(beat.dispose);
  const manual = await runOneWake({ type: 'wake/manual', data: { note: '帮我看看日志' } });
  t.after(manual.dispose);

  const a = beat.requests[0]!.request;
  const b = manual.requests[0]!.request;
  assert.equal(a.instructions, b.instructions, '人格常驻层（instructions）逐字节相同：这是被刷新的那段前缀的头');
  assert.deepEqual(
    (a.tools ?? []).map(tool => tool.name),
    (b.tools ?? []).map(tool => tool.name),
    '工具清单也共用（清单随会话变会让之后整段历史失效）',
  );
});

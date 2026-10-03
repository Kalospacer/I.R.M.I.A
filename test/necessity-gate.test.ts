/**
 * 回复必要性门测试（milestones.md M5-4 / M5-5、docs/design.md §4.11、docs/persona.md §6）
 *
 * 覆盖面：
 *   - ① 规则短路各分支：仅心跳且无牵挂 → 零模型调用；牵挂命中 → 放行
 *   - ② 分类边界：非心跳来源的批次一律直接放行（规则层不替真实事件做决定）
 *   - ③ 模型门：json_schema 强约束请求的形状（lane=light / effort=low），解析与容错
 *   - ④ 记账：模型门自己写 budget/consumed{lane:'light'}，失败按 failed 记账（失败刹车看得见）
 *   - ⑤ 沉默 turn 的事件序列：turn/start → input/claimed → turn/end{completed, spoke:false}
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import type {
  AppEvent, AssistantMessage, BudgetConsumed, ModelLane, Projection, TurnEnd, TurnStart, UserMessage,
} from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import { DsClientError, type DsClient, type DsOutputItem, type DsRequest, type DsResponse, type DsUsage } from '../src/model/ds-client.ts';
import { runTurn, type AgentLoopDeps, type AgentLoopPersona } from '../src/runtime/agent-loop.ts';
import { NecessityGate, parseDecision, type NecessityGateDeps } from '../src/runtime/necessity-gate.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const NOW = '2026-02-14T10:00:00.000+08:00';
const NOW_MS = Date.parse(NOW);

const PERSONA: AgentLoopPersona = {
  identity: '我是 Irmia。',
  constitution: '沉默是正常动作。',
  style: '简短。',
  state: '待命。',
  personaHash: 'hash-1',
};

const ZERO_USAGE: DsUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };

function usage(input: number, output: number, cached = 0): DsUsage {
  return { inputTokens: input, outputTokens: output, cachedTokens: cached, reasoningTokens: 0 };
}

/** 模型替身：记录 generate 请求，按脚本返回判定文本或抛错 */
interface FakeModel {
  ds: DsClient;
  requests: DsRequest[];
  setAnswer: (text: string | null, patch?: Partial<DsResponse>) => void;
  setThrows: (error: unknown) => void;
}

function fakeModel(): FakeModel {
  const requests: DsRequest[] = [];
  let answer: string | null = null;
  let patch: Partial<DsResponse> = {};
  let thrown: { error: unknown } | null = null;

  const ds = {
    modelFor: (lane: ModelLane): string => (lane === 'light' ? 'fake-light' : 'fake-heavy'),
    generate: async (request: DsRequest): Promise<DsResponse> => {
      requests.push(request);
      if (thrown !== null) throw thrown.error;
      const items: DsOutputItem[] = answer === null
        ? []
        : [{ type: 'message', id: 'm1', text: answer }];
      return {
        status: 'completed',
        outputItems: items,
        usage: usage(120, 20, 100),
        incompleteReason: null,
        model: 'fake-light',
        responseId: 'resp_1',
        durationMs: 8,
        ...patch,
      };
    },
  } as unknown as DsClient;

  return {
    ds,
    requests,
    setAnswer: (text, extra = {}) => {
      answer = text;
      patch = extra;
    },
    setThrows: (error) => {
      thrown = { error };
    },
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file',
    description: '读文件',
    parameters: { type: 'object', properties: {} },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 1000,
    handler: async () => ({ content: 'ok' }),
  });
  return registry;
}

interface Harness {
  log: EventLog;
  projection: Projection;
  append: (type: string, data: unknown, ts?: string) => AppEvent;
  gateOf: (ds: DsClient, overrides?: Partial<NecessityGateDeps>) => NecessityGate;
  loopDeps: (ds: DsClient, overrides?: Partial<AgentLoopDeps>) => AgentLoopDeps;
  events: () => Promise<AppEvent[]>;
}

async function makeHarness(t: TestContext): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-necessity-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (type: string, data: unknown, ts = NOW): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts,
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return event;
  };

  const events = async (): Promise<AppEvent[]> => {
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };

  return {
    log,
    projection,
    append,
    events,
    gateOf: (ds, overrides = {}) => new NecessityGate({
      ds,
      log,
      projection,
      now: () => new Date(NOW_MS),
      ...overrides,
    }),
    loopDeps: (ds, overrides = {}) => ({
      log,
      ds,
      registry: makeRegistry(),
      projection,
      persona: PERSONA,
      now: () => NOW,
      timezone: 'Asia/Shanghai',
      workspaceRoot: dir,
      ...overrides,
    }),
  };
}

/** 心跳唤醒（已落库并折进投影）：quietSeconds 默认 30 分钟 */
function heartbeat(h: Harness, quietSeconds = 1800, idleTicks = 1): AppEvent {
  return h.append('wake/heartbeat', { quietSeconds, idleTicks, pressure: 0.1 });
}

/** agent-loop 的 stub 模型：它跑 turn 时用的 stream */
function loopModel(): { ds: DsClient; requests: DsRequest[] } {
  const requests: DsRequest[] = [];
  const ds = {
    modelFor: (lane: ModelLane): string => (lane === 'light' ? 'fake-light' : 'fake-heavy'),
    stream: async (request: DsRequest) => {
      requests.push(request);
      return {
        status: 'completed' as const,
        text: '我看了一眼。',
        reasoning: '',
        toolCalls: [],
        outputItems: [],
        usage: { ...ZERO_USAGE },
        incompleteReason: null,
        model: 'fake-heavy',
        responseId: 'r1',
        durationMs: 5,
        interrupted: false,
        failure: null,
      };
    },
  } as unknown as DsClient;
  return { ds, requests };
}

function ofType<T extends AppEvent>(events: AppEvent[], type: T['type']): T[] {
  return events.filter((event): event is T => event.type === type);
}

// ──────────────────────────────── ① 规则短路 ────────────────────────────────

test('M5-4 规则短路：仅心跳且无牵挂 → 沉默，零模型调用', async (t) => {
  const h = await makeHarness(t);
  const model = fakeModel();
  const hb = heartbeat(h);

  const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 1 });

  assert.deepEqual(verdict, {
    shouldReply: false,
    by: 'rule',
    reason: '空转：仅心跳，无到期任务、无待办、无待确认',
  });
  assert.equal(model.requests.length, 0, '规则短路必须一个模型调用都不发');
  // 判定不该留下任何模型账：短路是零成本的
  assert.equal(ofType<BudgetConsumed>(await h.events(), 'budget/consumed').length, 0);
});

test('规则短路各分支：硬牵挂（到期意图 / 待确认 / 待人工回答 / 新增死信）直接放行', async (t) => {
  const cases: Array<{ name: string; setup: (h: Harness) => void }> = [
    {
      name: '到期意图',
      setup: (h) => {
        h.append('intention/raised', {
          intentionId: 'i1', content: '提醒她看备份', triggerAt: new Date(NOW_MS - 60_000).toISOString(),
        });
      },
    },
    {
      name: '待确认调用',
      setup: (h) => {
        h.append('tool/call', {
          turn: 0, step: 0, callId: 'c1', name: 'shell', arguments: '{}', sideEffect: 'destructive',
        });
        h.append('tool/result', {
          turn: 0, step: 0, callId: 'c1', callSeq: 2, status: 'unknown', content: '',
        });
      },
    },
    {
      name: '待人工回答',
      setup: (h) => {
        h.append('human/asked', { question: '要继续吗？', context: '备份前确认', turn: 0 });
      },
    },
    {
      name: '新增死信',
      setup: (h) => {
        h.append('input/dead-letter', { inputSeq: 7, claimCount: 3 });
      },
    },
  ];

  for (const item of cases) {
    const h = await makeHarness(t);
    const model = fakeModel();
    item.setup(h);
    const hb = heartbeat(h);

    const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 1 });

    assert.equal(verdict.shouldReply, true, `${item.name} 命中时必须放行`);
    assert.equal(verdict.by, 'rule', `${item.name} 是硬牵挂：不必花钱问模型`);
    assert.equal(model.requests.length, 0, `${item.name} 不该触发 light 调用`);
  }
});

test('软牵挂（未完成 todo）：小到不值得开口则短路沉默，大到超阈值才问模型', async (t) => {
  // 小牵挂：沉默
  {
    const h = await makeHarness(t);
    const model = fakeModel();
    h.append('todo/updated', { items: [{ content: '整理日志', status: 'pending' }] });
    const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [heartbeat(h, 1800, 1)], turn: 1 });
    assert.equal(verdict.shouldReply, false);
    assert.equal(verdict.by, 'rule');
    assert.equal(model.requests.length, 0);
    assert.match(verdict.reason, /牵挂不足以值得开口/);
  }

  // 大牵挂（摘要超 200 字符）：走模型门
  {
    const h = await makeHarness(t);
    const model = fakeModel();
    model.setAnswer(JSON.stringify({ should_reply: true, reason: '那件事该做了' }));
    h.append('todo/updated', { items: [{ content: '甲'.repeat(220), status: 'pending' }] });
    const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [heartbeat(h, 1800, 1)], turn: 1 });
    assert.equal(verdict.by, 'model');
    assert.equal(verdict.shouldReply, true);
    assert.equal(model.requests.length, 1);
  }
});

test('安静够久（超过阈值）即使牵挂很小也问模型', async (t) => {
  const h = await makeHarness(t);
  const model = fakeModel();
  model.setAnswer(JSON.stringify({ should_reply: false, reason: '还是没必要' }));
  h.append('todo/updated', { items: [{ content: '整理日志', status: 'pending' }] });
  const hb = heartbeat(h, 7 * 3600, 5);

  const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 1 });

  assert.equal(model.requests.length, 1, '安静超过 6 小时要走模型门');
  assert.equal(verdict.by, 'model');
  assert.equal(verdict.shouldReply, false, '模型说沉默就沉默');
});

// ──────────────────────────────── ② 分类边界 ────────────────────────────────

test('非心跳来源的批次直接放行：规则层不替真实事件做决定', async (t) => {
  const h = await makeHarness(t);
  const model = fakeModel();
  const cases: Array<{ name: string; event: AppEvent }> = [
    { name: 'manual', event: h.append('wake/manual', { note: '看一眼' }) },
    { name: 'timer', event: h.append('wake/timer', { timerId: 't1', scheduledAt: NOW, firedAt: NOW }) },
    { name: 'webhook', event: h.append('wake/webhook', { path: '/h', body: '{}', headers: {} }) },
    { name: 'file', event: h.append('wake/file', { path: 'a.md', kind: 'changed' }) },
    { name: 'intention', event: h.append('wake/intention', { intentionId: 'i', content: 'x' }) },
    { name: 'job', event: h.append('wake/job', { jobId: 'j' }) },
  ];

  for (const item of cases) {
    const gate = h.gateOf(model.ds);
    assert.equal(gate.appliesTo([item.event]), false, `${item.name} 不该过门`);
    const verdict = await gate.judge({ wakeEvents: [item.event], turn: 1 });
    assert.equal(verdict.shouldReply, true, `${item.name} 必须放行`);
    assert.equal(verdict.by, 'rule');
  }
  assert.equal(model.requests.length, 0, '放行判定不需要任何模型调用');

  // 心跳与其他来源混在一批时按"非纯心跳"处理：真实事件在场，不能短路
  const mixed = [heartbeat(h), h.append('wake/manual', { note: '混批' })];
  assert.equal(h.gateOf(model.ds).appliesTo(mixed), false);
});

// ──────────────────────────────── ③ 模型门形状与解析 ────────────────────────────────

test('M5-5 模型门请求形状：lane=light、effort=low、json_schema 强约束、输入只带三样', async (t) => {
  const h = await makeHarness(t);
  const model = fakeModel();
  model.setAnswer(JSON.stringify({ should_reply: true, reason: '答应过的事到期了' }));
  // 大牵挂（摘要超 200 字符阈值）才会走到模型门：硬牵挂会在规则层直接放行
  h.append('todo/updated', { items: [{ content: '答应她今天写日记（'.repeat(40), status: 'pending' }] });
  const hb = heartbeat(h, 7200, 3);

  const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 4 });

  assert.equal(model.requests.length, 1);
  const request = model.requests[0]!;
  assert.equal(request.lane, 'light', '必要性判定必须走 light 车道');
  assert.equal(request.reasoning?.effort, 'low');
  assert.equal(request.text?.type, 'json_schema');
  const format = request.text as { type: 'json_schema'; name: string; schema: Record<string, unknown> };
  assert.equal(format.name, 'reply_necessity');
  assert.deepEqual(format.schema['required'], ['should_reply', 'reason']);
  assert.equal((format.schema['properties'] as Record<string, { type: string }>)['should_reply']?.['type'], 'boolean');
  assert.equal(request.tools, undefined, '门不带工具：它只出一个判定');

  // 输入只带三样：唤醒源类型 + 安静时长 + 待办摘要
  const prompt = request.input as string;
  assert.match(prompt, /唤醒源：heartbeat/);
  assert.match(prompt, /安静时长：2\.0 小时/);
  assert.match(prompt, /未完成待办：答应她今天写日记/);
  assert.equal(verdict.shouldReply, true);
  assert.equal(verdict.by, 'model');
  assert.equal(verdict.reason, '答应过的事到期了');
});

test('json_schema 判定解析：正常 JSON、围栏包裹、多余字段都能读', () => {
  const items = (text: string): DsOutputItem[] => [{ type: 'message', id: 'm', text }];

  assert.deepEqual(parseDecision(items('{"should_reply":true,"reason":"有事"}')), { shouldReply: true, reason: '有事' });
  assert.deepEqual(parseDecision(items('{"should_reply":false,"reason":"没事"}')), { shouldReply: false, reason: '没事' });
  // 围栏：json_schema 正常不会，但坏一次不该让门崩
  assert.deepEqual(
    parseDecision(items('```json\n{"should_reply":true,"reason":"x"}\n```')),
    { shouldReply: true, reason: 'x' },
  );
  // reason 缺失/非字符串：不影响判定
  assert.deepEqual(parseDecision(items('{"should_reply":true}')), { shouldReply: true, reason: '' });
  assert.deepEqual(parseDecision(items('{"should_reply":false,"reason":42}')), { shouldReply: false, reason: '' });
  // 多余字段不干扰
  assert.deepEqual(parseDecision(items('{"should_reply":true,"reason":"y","extra":1}')), { shouldReply: true, reason: 'y' });
});

test('判定容错：坏 JSON / 缺字段 / 非对象 / 空输出 都返回 null，由调用方按应当回复放行', () => {
  const items = (text: string): DsOutputItem[] => [{ type: 'message', id: 'm', text }];

  assert.equal(parseDecision(items('不是 JSON')), null);
  assert.equal(parseDecision(items('{"reason":"只有理由"}')), null, '缺 should_reply 判为无法解析');
  assert.equal(parseDecision(items('{"should_reply":"yes"}')), null, '类型不对同样判为无法解析');
  assert.equal(parseDecision(items('[{"should_reply":true}]')), null, '数组不是对象');
  assert.equal(parseDecision(items('   ')), null, '空文本');
  assert.equal(parseDecision([]), null, '只有 reasoning、没有 message');
  assert.equal(parseDecision([{ type: 'reasoning', text: '{"should_reply":true}' }]), null, '思维链不算判定');
});

test('模型门坏输出 → 按照应当回复放行（沉默是成本优化，不是行为承诺）', async (t) => {
  for (const answer of ['不是 JSON', '{"reason":"缺字段"}', '']) {
    const h = await makeHarness(t);
    const model = fakeModel();
    model.setAnswer(answer);
    // 造一条足够长的待办摘要（软牵挂），让规则门放它到模型门
    h.append('todo/updated', { items: [{ content: '乙'.repeat(220), status: 'pending' }] });
    const hb = heartbeat(h, 3600, 2);

    const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 1 });

    assert.equal(verdict.shouldReply, true, `坏输出「${answer}」必须放行`);
    assert.equal(verdict.by, 'error');
    assert.match(verdict.reason, /无法解析/);
  }
});

// ──────────────────────────────── ④ 记账 ────────────────────────────────

test('M5-5 模型门记账：budget/consumed 记 lane=light、model=light 路由，不占 heavy', async (t) => {
  const h = await makeHarness(t);
  const model = fakeModel();
  model.setAnswer(JSON.stringify({ should_reply: false, reason: '没必要' }), { usage: usage(300, 40, 200) });
  // 待办摘要超过阈值（200 字符）→ 灰色地带，走 light 门
  h.append('todo/updated', { items: [{ content: '甲'.repeat(220), status: 'pending' }] });
  const hb = heartbeat(h, 100, 1);

  const before = h.projection.budget.tokensTodayHeavy;
  const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 3 });

  assert.equal(verdict.shouldReply, false);
  assert.equal(verdict.by, 'model');
  const consumed = ofType<BudgetConsumed>(await h.events(), 'budget/consumed');
  assert.equal(consumed.length, 1, '一次门判定只记一笔账');
  const data = consumed[0]!.data;
  assert.equal(data.lane, 'light');
  assert.equal(data.model, 'fake-light');
  assert.equal(data.turn, 3);
  assert.equal(data.inputTokens, 300);
  assert.equal(data.outputTokens, 40);
  assert.equal(data.cacheHitTokens, 200);
  assert.equal(data.cacheMissTokens, 100);
  assert.equal(data.finishReason, 'completed');
  assert.equal(h.projection.budget.tokensTodayHeavy, before, 'light 记账不得挤占 heavy');
  assert.equal(h.projection.budget.tokensTodayLight, 340);
});

test('模型门失败也记账：finishReason=failed 且 failStreak 递增（失败刹车看得见）', async (t) => {
  const h = await makeHarness(t);
  const model = fakeModel();
  model.setThrows(new DsClientError({ kind: 'server', code: 'http_500', message: '服务端 500' }));
  // 长待办摘要（软牵挂）让规则门放行到 light 调用，调用失败
  h.append('todo/updated', { items: [{ content: '丙'.repeat(220), status: 'pending' }] });
  const hb = heartbeat(h, 7200, 4);

  const verdict = await h.gateOf(model.ds).judge({ wakeEvents: [hb], turn: 2 });

  assert.equal(verdict.shouldReply, true, '判定失败一律放行');
  assert.equal(verdict.by, 'error');
  const consumed = ofType<BudgetConsumed>(await h.events(), 'budget/consumed');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]!.data.finishReason, 'failed');
  assert.equal(consumed[0]!.data.lane, 'light');
  assert.equal(h.projection.failStreak, 1, 'light 失败必须计入连续失败');
  assert.equal(h.projection.lastModelSuccessAt, null, '失败不得刷新成功水位');
});

// ──────────────────────────────── ⑤ 沉默 turn 的事件序列 ────────────────────────────────

test('M5-4 沉默 turn 事件序列：turn/start → input/claimed → turn/end{completed, spoke:false}，零模型调用', async (t) => {
  const h = await makeHarness(t);
  const judgeModel = fakeModel();
  const loop = loopModel();
  const gate = h.gateOf(judgeModel.ds);
  const hb = heartbeat(h, 1800, 1);

  const reason = await runTurn(
    h.loopDeps(loop.ds, {
      necessityGate: (wakeText, wakeEvents) => gate.judge({ wakeEvents: wakeEvents ?? [], turn: 0 }).then(v => v.shouldReply),
    }),
    [hb],
  );

  assert.deepEqual(reason, { kind: 'completed' });
  assert.equal(loop.requests.length, 0, '沉默 turn 一个 heavy 调用都不能发');
  assert.equal(judgeModel.requests.length, 0, '规则短路连 light 调用也省掉');

  const events = await h.events();
  assert.deepEqual(
    events.map(event => event.type),
    ['wake/heartbeat', 'turn/start', 'input/claimed', 'turn/end'],
    '留痕顺序：唤醒 → 起拍 → 认领 → 收拍',
  );
  const start = ofType<TurnStart>(events, 'turn/start')[0]!;
  const end = ofType<TurnEnd>(events, 'turn/end')[0]!;
  assert.equal(end.data.turn, start.data.turn);
  assert.deepEqual(end.data.reason, { kind: 'completed' });
  assert.equal(end.data.spoke, false, '沉默 turn 必须记 spoke:false');
  assert.equal(events.filter(event => event.type === 'step/start').length, 0, '一个 step 都没开');
  // 认领也发生了：否则这条心跳会永远留在队列里被反复评估
  assert.equal(events.filter(event => event.type === 'input/claimed').length, 1);
  assert.deepEqual(h.projection.pending, [], '心跳被认领后出队');

  // 没有 message/assistant：沉默就是不说话
  assert.equal(ofType<AssistantMessage>(events, 'message/assistant').length, 0);
  assert.equal(ofType<UserMessage>(events, 'message/user').length, 0);
});

test('同一条门用于真实事件：manual 批次直接进 turn（spoke 反映模型是否说话）', async (t) => {
  const h = await makeHarness(t);
  const judgeModel = fakeModel();
  const loop = loopModel();
  const gate = h.gateOf(judgeModel.ds);
  const wake = h.append('wake/manual', { note: '帮我看看日志' });

  const reason = await runTurn(
    h.loopDeps(loop.ds, {
      necessityGate: (wakeText, wakeEvents) => gate.judge({ wakeEvents: wakeEvents ?? [], turn: 0 }).then(v => v.shouldReply),
    }),
    [wake],
  );

  assert.deepEqual(reason, { kind: 'completed' });
  assert.equal(loop.requests.length, 1, '真实事件必须进 turn 并调用 heavy');
  assert.equal(judgeModel.requests.length, 0, '非心跳批次不过门，不产生 light 调用');

  const events = await h.events();
  const end = ofType<TurnEnd>(events, 'turn/end')[0]!;
  assert.equal(end.data.spoke, true);
  assert.equal(events.filter(event => event.type === 'step/start').length, 1);
});

test('门只在心跳批次上生效（appliesTo 的语义边界）', async (t) => {
  const h = await makeHarness(t);
  const gate = h.gateOf(fakeModel().ds);
  const hb = heartbeat(h);
  const manual = h.append('wake/manual', { note: 'x' });

  assert.equal(gate.appliesTo([hb]), true);
  assert.equal(gate.appliesTo([hb, hb]), true);
  assert.equal(gate.appliesTo([hb, manual]), false);
  assert.equal(gate.appliesTo([]), true, '空批次没有事要办，按仅心跳处理');
  assert.equal(gate.appliesTo([manual]), false);
});

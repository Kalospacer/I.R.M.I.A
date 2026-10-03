/**
 * 上下文审计测试 — src/model/context-audit.ts + render 的归因副产物（2026-10-03）
 *
 * 三件事分开测，因为它们是三件不同的事：
 *   ① **归因**（每步一条事实）：段边界由渲染层给出，token / 条数 / 哈希都对得上；
 *   ② **哨兵**（只在真破坏时记）：逐类覆盖 persona / tools / memory / history / render / idle，
 *      并钉死"正常追加尾巴不算破坏"——那是这个哨兵唯一容易写成刷屏的地方；
 *   ③ **重放保真**：哨兵的基准取自日志（`lastAuditedCall`），不是内存里的"上一次"。
 *
 * 全部用例不读时钟、不碰文件：时间由事件 ts 给，基线由构造出来的 `BudgetConsumed` 给。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CACHE_BREAK_CLASS_LABEL, CONTEXT_LABEL, DEFAULT_CACHE_BREAK_THRESHOLDS,
  detectCacheBreak, describeContext, hashOf, lastAuditedCall,
  type AuditedCall, type ContextBreakdown,
} from '../src/model/context-audit.ts';
import { RENDER_VERSION, render, type RenderInput, type RenderPersona } from '../src/model/render.ts';
import { defaultVisibility } from '../src/log/types.ts';
import type { AppEvent, BudgetConsumed } from '../src/log/types.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0_MS = Date.parse('2026-03-01T00:00:00.000Z');
const MIN_MS = 60_000;

const PERSONA: RenderPersona = {
  identity: 'IDENTITY：你是 Irmia。',
  constitution: 'CONSTITUTION：不越权。',
  style: 'STYLE：短句。',
  state: 'STATE：待命中。',
};

const TOOLS = [
  { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } },
  { name: 'speak', description: '说话', parameters: { type: 'object', properties: {} } },
];

function renderOnce(o: Partial<RenderInput> = {}): ReturnType<typeof render> {
  return render({
    events: o.events ?? [],
    persona: o.persona ?? PERSONA,
    tools: o.tools ?? TOOLS,
    wakeEvent: o.wakeEvent ?? null,
    taskCard: o.taskCard ?? null,
    now: o.now ?? new Date(T0_MS).toISOString(),
    timezone: o.timezone ?? 'Asia/Shanghai',
    model: o.model ?? 'deepseek-flash',
    lane: o.lane ?? 'heavy',
    softHint: o.softHint ?? null,
    ...(o.skillCatalog === undefined ? {} : { skillCatalog: o.skillCatalog }),
  });
}

/** 一次被审计的调用：只给归因与命中数，够哨兵用 */
function call(context: ContextBreakdown, minutes: number, hit: number, miss: number): AuditedCall {
  return {
    context,
    ts: new Date(T0_MS + minutes * MIN_MS).toISOString(),
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}

/** 把一次调用原样包成 `budget/consumed` 事件（哨兵的日志来源） */
function consumedEvent(c: AuditedCall, seq: number): BudgetConsumed {
  return {
    seq,
    ts: c.ts,
    type: 'budget/consumed',
    data: {
      turn: 1, step: seq, lane: 'heavy', model: 'deepseek-flash',
      inputTokens: c.cacheHitTokens + c.cacheMissTokens, outputTokens: 0,
      cacheHitTokens: c.cacheHitTokens, cacheMissTokens: c.cacheMissTokens,
      durationMs: 1, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 0,
      context: c.context,
    },
    visibility: defaultVisibility('budget/consumed'),
  };
}

// ──────────────────────────────── ① 归因 ────────────────────────────────

describe('归因：render 是段边界的唯一知情人', () => {
  test('每一段都记了 token 与条数，input 合计等于各 item 段之和', () => {
    const rendered = renderOnce();
    const c = rendered.context;

    assert.equal(c.renderVersion, RENDER_VERSION);
    // instructions 就是渲染出来的那一整段（人格三层 + SELF_BRIEF）
    assert.ok(c.instructions.tokens > 0);
    assert.equal(c.instructions.hash, hashOf(rendered.instructions));
    assert.equal(c.instructions.items, undefined, 'instructions 不是 input item，没有条数');
    // 工具清单：条数如实
    assert.equal(c.tools.count, TOOLS.length);
    assert.equal(c.tools.hash, hashOf(JSON.stringify(rendered.tools)));
    // 各段条数加起来就是 input 的条数（没有一段被漏掉）
    const counted = (c.memory.items ?? 0) + (c.history.items ?? 0) + (c.now.items ?? 0)
      + (c.wake.items ?? 0) + (c.hint.items ?? 0);
    assert.equal(counted, c.input.items);
    assert.equal(counted, rendered.input.length);
    // 合计只数 item 段（instructions / tools 是另外两个顶层字段）
    assert.equal(
      c.input.tokens,
      c.memory.tokens + c.history.tokens + c.now.tokens + c.wake.tokens + c.hint.tokens,
    );
  });

  test('此刻层恒为一条、本轮输入只在首 step 出现、插播单独成段', () => {
    const noWake = renderOnce();
    assert.equal(noWake.context.now.items, 1, '此刻层永远是尾部那一条 developer 消息');
    assert.equal(noWake.context.wake.items, 0, 'turn 内后续 step 没有本轮新输入');

    const hint = renderOnce({ softHint: '手上的事做完就收尾' });
    assert.equal(hint.context.hint.items, 1, '尾部插播（软阈值提示）也是上下文的一段');
    assert.ok(hint.context.hint.tokens > 0);
    assert.equal(hint.context.input.items, noWake.context.input.items + 1);
  });

  test('同一份输入渲染两次：归因逐字节相同（缓存铁律 1 的归因版）', () => {
    const a = renderOnce().context;
    const b = renderOnce().context;
    assert.deepEqual(a, b);
  });

  test('人格改写 → instructions 段的哈希变；工具改动 → tools 段的哈希变', () => {
    const base = renderOnce().context;
    const otherPersona = renderOnce({ persona: { ...PERSONA, identity: 'IDENTITY：改过了。' } }).context;
    assert.notEqual(base.instructions.hash, otherPersona.instructions.hash);
    assert.equal(base.tools.hash, otherPersona.tools.hash, '人格改动不该动工具段');

    const fewerTools = renderOnce({ tools: TOOLS.slice(0, 1) }).context;
    assert.notEqual(base.tools.hash, fewerTools.tools.hash);
    assert.equal(fewerTools.tools.count, 1);
  });

  test('历史前段哈希不随"追加尾巴"而变（哨兵靠它区分追加与重写）', () => {
    const base = renderOnce().context;
    const again = renderOnce().context;
    assert.equal(base.history.headHash, again.history.headHash);
  });

  test('describeContext 是一行人话：分部与合计自洽，不出现任何价格/货币字样', () => {
    const breakdown = renderOnce().context;
    const text = describeContext(breakdown);
    assert.match(text, /指令/u);
    assert.match(text, /工具 /u);
    assert.match(text, /历史/u);
    assert.match(text, /整条/u);
    // 用户明确不要计价：措辞里不许出现钱
    assert.equal(/[元$€£]|价格|费用|花费|计费|美元|人民币/u.test(text), false);

    // 2026-10-04 的回归：他看到的旧版是"指令 0.4万 · 工具 0.4万×25 · … · 合计 0.6万"——
    // 合计只数 input 段，却印在整行末尾，像是前面几项的和。这条钉住新的口径与形状：
    // 整条 = 指令 + 工具 + input 段，且每一项都是**精确整数**（能自己加一遍）。
    const m = /整条 ([\d,]+) = 指令 ([\d,]+) \+ 工具 ([\d,]+)（(\d+) 件） \+ input 段 ([\d,]+)/u.exec(text);
    assert.ok(m !== null, `这一行的形状变了，核对措辞与断言：${text}`);
    const num = (raw: string): number => Number(raw.replace(/,/gu, ''));
    const whole = num(m[1]!);
    const instructions = num(m[2]!);
    const tools = num(m[3]!);
    const count = Number(m[4]!);
    const inputSegment = num(m[5]!);
    assert.equal(instructions, breakdown.instructions.tokens, '第二项是指令');
    assert.equal(tools, breakdown.tools.tokens, '第三项是工具合计（不是每件的量）');
    assert.equal(count, breakdown.tools.count, '工具那一段要写明"多少件"，不能只丢一个乘号让人猜');
    assert.equal(inputSegment, breakdown.input.tokens, '第五项是 input 段（instructions / tools 不在里面）');
    assert.equal(instructions + tools + inputSegment, whole, '等式两边必须真的相等（旧版读起来像瞎写就是这里）');
    // 分段明细跟在 input 段后面，数字照旧精确
    assert.match(text, new RegExp(`记忆 ${breakdown.memory.tokens}`, 'u'));
    assert.match(text, new RegExp(`历史 ${breakdown.history.tokens}（${breakdown.history.items} 条）`, 'u'));
  });

  test('标签词由后端给，界面不维护第二份词表', () => {
    assert.equal(CONTEXT_LABEL, '上下文');
    assert.equal(CACHE_BREAK_CLASS_LABEL.persona, '人格文件变更');
    assert.equal(CACHE_BREAK_CLASS_LABEL.idle, '空闲过期');
  });
});

// ──────────────────────────────── ② 哨兵 ────────────────────────────────

describe('缓存破坏哨兵：只在真破坏时记一条', () => {
  const base = renderOnce().context;

  test('第一次调用不报（没有可比的对象）', () => {
    assert.equal(detectCacheBreak(null, call(base, 0, 0, 0)), null);
  });

  test('只有尾巴变（历史追加、此刻层刷新）→ 不报', () => {
    const prev = call(base, 0, 100, 100);
    const cur = call({
      ...base,
      history: { ...base.history, tokens: base.history.tokens + 500, items: base.history.items + 3, hash: 'tail-grew' },
      now: { ...base.now, hash: 'now-moved' },
    }, 1, 100, 100);
    assert.equal(detectCacheBreak(prev, cur), null, '追加是常态，不是破坏');
  });

  test('人格文件变更 → persona（头部失守）', () => {
    const cur = call({ ...base, instructions: { ...base.instructions, hash: 'new-persona' } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.ok(found !== null);
    assert.equal(found.class, 'persona');
    assert.deepEqual(found.classes, ['persona']);
    assert.match(found.reason, /人格文件被改写/u);
    assert.match(found.reason, /IDENTITY \/ CONSTITUTION \/ STYLE/u);
  });

  test('工具清单变更 → tools', () => {
    const cur = call({ ...base, tools: { ...base.tools, hash: 'new-tools' } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'tools');
    assert.match(found?.reason ?? '', /工具清单变了/u);
  });

  test('压缩改写长期记忆层 → memory（从最前面失守）', () => {
    const cur = call({ ...base, memory: { tokens: 10, hash: 'summary-rewritten', items: 1 } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'memory');
    assert.match(found?.reason ?? '', /长期记忆层被改写/u);
  });

  test('历史前段被重写 → history', () => {
    const cur = call({ ...base, history: { ...base.history, headHash: 'rewritten' } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'history');
    assert.match(found?.reason ?? '', /历史前段被重写/u);
  });

  test('前 8 条还没攒够时正常追加不算重写（窗口长度不同 ≠ 内容变了）', () => {
    const three = call({ ...base, history: { tokens: 30, hash: 'h3', items: 3, headHash: 'head-of-3' } }, 0, 100, 0);
    const ten = call({ ...base, history: { tokens: 100, hash: 'h10', items: 10, headHash: 'head-of-10' } }, 1, 100, 0);
    assert.equal(detectCacheBreak(three, ten), null, '3 条涨到 10 条：窗口本就不同长，不是重写');

    // 攒满之后窗口就固定了：前 8 条逐字节变了才是重写
    const tenB = call({ ...base, history: { tokens: 100, hash: 'h10b', items: 10, headHash: 'other' } }, 2, 100, 0);
    assert.equal(detectCacheBreak(ten, tenB)?.class, 'history');

    // 条数变少（遮蔽/抹掉）同样是重写，不管有没有攒满
    const five = call({ ...base, history: { tokens: 50, hash: 'h5', items: 5, headHash: 'x' } }, 3, 100, 0);
    assert.equal(detectCacheBreak(ten, five)?.class, 'history');
  });

  test('渲染版本变更 → render（正交：不是某一段的事）', () => {
    const cur = call({ ...base, renderVersion: 'x' }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'render');
  });

  test('多处同时失守：主类别取**最早**那一段，其余进 classes', () => {
    const prev = call(base, 0, 100, 0);
    const cur = call({
      ...base,
      instructions: { ...base.instructions, hash: 'p2' },
      tools: { ...base.tools, hash: 't2' },
      memory: { ...base.memory, hash: 'm2' },
    }, 1, 0, 100);
    const found = detectCacheBreak(prev, cur);
    assert.equal(found?.class, 'persona', '头部失守才是"整段前缀没了"的答案');
    assert.deepEqual(found?.classes, ['persona', 'tools', 'memory']);
  });

  test('空闲过期：隔得久 **且** 命中率塌陷才算', () => {
    const prev = call(base, 0, 900, 100); // 命中 90%
    // ① 隔得久但命中率没塌（前缀还在）：不报
    assert.equal(detectCacheBreak(prev, call(base, 60, 900, 100)), null);
    // ② 命中率塌了但没隔多久（另有原因）：不报
    assert.equal(detectCacheBreak(prev, call(base, 1, 10, 990)), null);
    // ③ 两个都命中：报 idle
    const found = detectCacheBreak(prev, call(base, 60, 10, 990));
    assert.equal(found?.class, 'idle');
    assert.match(found?.reason ?? '', /空闲太久/u);
    assert.equal(found?.gapMs, 60 * MIN_MS);
  });

  test('空闲判据的边界：上次本来就没命中（输入很短）时不报——跌无可跌', () => {
    const prev = call(base, 0, 0, 5);
    assert.equal(detectCacheBreak(prev, call(base, 120, 0, 500)), null);
  });

  test('阈值可配：把空闲线调到 5 分钟，同一个间隔就报出来了', () => {
    const prev = call(base, 0, 900, 100);
    const cur = call(base, 10, 10, 990);
    assert.equal(detectCacheBreak(prev, cur), null, '默认 30 分钟：10 分钟不算空闲过期');
    const found = detectCacheBreak(prev, cur, { idleMs: 5 * MIN_MS, hitDrop: 0.5 });
    assert.equal(found?.class, 'idle');
  });

  test('默认阈值是保守的：空闲线 30 分钟、跌幅门槛一半', () => {
    assert.equal(DEFAULT_CACHE_BREAK_THRESHOLDS.idleMs, 30 * MIN_MS);
    assert.equal(DEFAULT_CACHE_BREAK_THRESHOLDS.hitDrop, 0.5);
  });
});

// ──────────────────────────────── ③ 重放保真 ────────────────────────────────

describe('哨兵的基准取自日志：重放时从同一个地方取数据', () => {
  const base = renderOnce().context;
  const first = call(base, 0, 100, 100);
  const second = call({ ...base, instructions: { ...base.instructions, hash: 'p2' } }, 5, 0, 200);

  test('lastAuditedCall 取的是**最后一次**带归因的调用', () => {
    const events: AppEvent[] = [consumedEvent(first, 1), consumedEvent(second, 2)];
    const found = lastAuditedCall(events);
    assert.equal(found?.ts, second.ts);
    assert.equal(found?.context.instructions.hash, 'p2');
  });

  test('没有归因的老事件被跳过（不拿它当基准，免得得出"到处都变了"）', () => {
    const legacy: AppEvent = {
      ...consumedEvent(first, 1),
      data: {
        turn: 1, step: 1, lane: 'heavy', model: 'm', inputTokens: 1, outputTokens: 0,
        cacheHitTokens: 0, cacheMissTokens: 1, durationMs: 1, retryCount: 0,
        finishReason: 'completed', tokensTodayAccum: 0,
      },
    } as unknown as AppEvent;
    assert.equal(lastAuditedCall([legacy]), null);
    // 新旧混着：基准应当是那条**有归因**的
    assert.equal(lastAuditedCall([consumedEvent(second, 2), legacy])?.ts, second.ts);
  });

  test('把日志喂回来 → 同一份结论（重放可重算，不是只有运行期才有的字段）', () => {
    // 运行期那一刻，日志里只有**上一次**调用；重放时把同一段事件喂进来，基准就是同一条
    const atSecondCall: AppEvent[] = [consumedEvent(first, 1)];
    const replayed = detectCacheBreak(lastAuditedCall(atSecondCall), second);
    const live = detectCacheBreak(first, second);
    assert.deepEqual(replayed, live);
    assert.equal(replayed?.class, 'persona');
  });
});

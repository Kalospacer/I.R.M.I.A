/**
 * Irmia Agent — 回复必要性门（docs/design.md §4.11、docs/persona.md §6、milestones M5-4/M5-5）
 *
 * 「唤醒不等于说话。」常驻体的大多数唤醒，正确结局是"看一眼，没我的事，接着睡"。
 * 这道门就是那个判断，它必须在**发起主力模型调用之前**做出结论——否则沉默就变成了
 * 一次昂贵的 heavy 调用。两道门，便宜的在前面：
 *
 *   ① **规则短路**（零成本）：心跳是唯一的新事件，且投影里没有任何"欠着的事"
 *      （到期意图 / 待确认 / 未完成 todo / 待人工回答 / 新增死信）→ 直接沉默。
 *      一个模型调用都不发，turn 以 `{completed}`、`spoke:false` 结束。
 *   ② **模型门**（light 车道）：灰色地带（比如心跳期间待办里确实有东西，或安静很久了）
 *      交给轻量模型判。输入只有三样：唤醒源类型、安静时长、待办摘要（几百 token），
 *      输出是 `json_schema` 强约束的 `{should_reply, reason}`，`reasoning.effort = low`。
 *
 * 为什么"仅心跳"是规则短路的必要条件：批次里只要混着任何其他 wake 源（手工注入、定时器、
 * 文件变化、webhook、意图到期、后台完成），那都是**真实发生的事**，规则层没有资格替她闭嘴——
 * 那种情况走模型门，让"她"自己判断值不值得回。规则层只负责最确定的一类：空转。
 *
 * 失败方向是有意的：模型门出错（接口挂、JSON 坏、字段缺）一律**放行**（应当回复）。
 * 一个永久闭嘴的常驻体比多说一句话糟糕得多——沉默是成本优化，不是行为承诺。
 *
 * 预算记账：门自己写 `budget/consumed`（lane: light），这样 M5-5 的"light 路由可观测"
 * 不需要循环层参与，也让失败能正确计入 `failStreak`（否则接口坏了会让失败刹车永远看不到）。
 */

import type { AppEvent, Projection, TurnEndReason } from '../log/types.js';
import type { DsClient, DsReasoningEffort, DsTextFormat } from '../model/ds-client.js';
import type { EventLog } from '../log/event-log.js';
import { applyOne, finalizePressure } from '../state/fold.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

const ORIGIN = 'runtime/necessity-gate';

/**
 * 模型门的触发阈值（决定"规则短路之后还要不要问模型"）：
 * 待办摘要超过这么多字符，或安静时长超过这么久（秒），才值得花一次 light 调用。
 * 两个阈值都取"确实有事"的量级——门是成本闸门，不是又一个审稿人。
 */
export const MODEL_GATE_HINT_CHARS = 200;
export const MODEL_GATE_QUIET_SECONDS = 6 * 60 * 60;

/** 待办摘要长度上限（进提示词的字符数；防止日志里的长文本把 light 请求撑大） */
const HINT_CLIP_CHARS = 400;

/** 新增死信的回看条数上限：门在每拍的最热路径上，绝不做全量日志扫描 */
const DEAD_LETTER_LOOKBACK = 500;

/** 判定结果的 JSON Schema（DeepSeek Responses 的 `text.format = json_schema`） */
const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    should_reply: {
      type: 'boolean',
      description: 'true = 值得开口（有该做的事、该回应的人）；false = 此刻沉默更合适',
    },
    reason: { type: 'string', description: '一句话理由，用于复盘与调参' },
  },
  required: ['should_reply', 'reason'],
  additionalProperties: false,
};

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 必要性判定结果 */
export interface NecessityVerdict {
  /** true = 应当开口（放行到主力模型）；false = 沉默 */
  shouldReply: boolean;
  /** 判定路径：'rule' 零成本短路 / 'model' light 门 / 'error' 出错后放行 */
  by: 'rule' | 'model' | 'error';
  reason: string;
}

/** 一次判定的输入 */
export interface NecessityInput {
  /** 本批唤醒事件（已落库，seq 有效） */
  wakeEvents: readonly AppEvent[];
  /** 本 turn 号（budget/consumed 落账用） */
  turn: number;
  /** 判定参照时刻（ISO 8601），默认取注入的 now() */
  now?: string;
}

export interface NecessityGateDeps {
  ds: DsClient;
  log: EventLog;
  projection: Projection;
  /** 时钟注入：记账的 ts / 默认参照时刻都用它（判定本身不读环境时钟） */
  now: () => Date;
  /** 诊断输出 */
  out?: (line: string) => void;
  /** 外部取消（shutdown）：透传给 light 请求 */
  signal?: AbortSignal;
  /** 模型门阈值覆盖点（测试用） */
  modelGateHintChars?: number;
  modelGateQuietSeconds?: number;
}

// ──────────────────────────────── 判定器 ────────────────────────────────

/**
 * 回复必要性门。它对外的唯一承诺是：**给出一个结论**，且在做结论的路上花的钱是确定的——
 * 规则短路 0 token，模型门一次 light 调用，其余情况绝不调 heavy。
 */
export class NecessityGate {
  private readonly deps: NecessityGateDeps;
  private readonly modelGateHintChars: number;
  private readonly modelGateQuietSeconds: number;

  constructor(deps: NecessityGateDeps) {
    this.deps = deps;
    this.modelGateHintChars = deps.modelGateHintChars ?? MODEL_GATE_HINT_CHARS;
    this.modelGateQuietSeconds = deps.modelGateQuietSeconds ?? MODEL_GATE_QUIET_SECONDS;
  }

  /**
   * M5-4 需要的判据：本批唤醒**只有心跳**。
   * 空批次（理论上不该出现）也算"仅心跳"——没有输入就是没有事要办。
   */
  static isHeartbeatOnly(wakeEvents: readonly AppEvent[]): boolean {
    if (wakeEvents.length === 0) return true;
    return wakeEvents.every((event) => event.type === 'wake/heartbeat');
  }

  /**
   * 门是否对这批输入生效。只有心跳批次需要过门，其他来源（人、定时器、文件、webhook、
   * 意图、后台完成）直接进 turn：它们都是真实发生的事，由她自己在 turn 里决定怎么回应。
   */
  appliesTo(wakeEvents: readonly AppEvent[]): boolean {
    return NecessityGate.isHeartbeatOnly(wakeEvents);
  }

  /**
   * 主入口。心跳批次先过规则短路，灰色地带再问模型；非心跳批次调用方不应走到这里
   * （调用方用 `appliesTo` 分流），真走到了也按"应当回复"放行——规则层不替真实事件做决定。
   */
  async judge(input: NecessityInput): Promise<NecessityVerdict> {
    const now = input.now ?? this.deps.now().toISOString();
    if (!this.appliesTo(input.wakeEvents)) {
      return this.settle({ shouldReply: true, by: 'rule', reason: '非心跳来源的唤醒，直接进 turn' });
    }

    const matters = this.pendingMatters(now);
    if (matters.hard.length === 0 && matters.soft.length === 0) {
      // 规则短路：零模型调用。这是 M5-4 的判定点
      return this.settle({ shouldReply: false, by: 'rule', reason: '空转：仅心跳，无到期任务、无待办、无待确认' });
    }
    // 硬牵挂直接放行：有人在等回应、或有事情没做完，不需要模型投票
    if (matters.hard.length > 0) {
      return this.settle({
        shouldReply: true,
        by: 'rule',
        reason: `有必须看见的事：${matters.hard.join('；')}`,
      });
    }

    const quietSeconds = this.quietSeconds(input.wakeEvents, now);
    const hint = matters.soft.join('；');
    if (hint.length < this.modelGateHintChars && quietSeconds < this.modelGateQuietSeconds) {
      // 只是"有点待办"、也没安静很久：不值得为它花一次 light 调用，留到真正模糊时再说
      return this.settle({
        shouldReply: false,
        by: 'rule',
        reason: `空转：牵挂不足以值得开口（${hint.length} 字符，安静 ${quietSeconds}s）`,
      });
    }

    return this.askModel(input, hint, quietSeconds);
  }

  // ── 规则门：投影里"欠着的事" ──

  /**
   * 欠着的事（命中任意一条 => 规则门不短路）。全部取自投影与最近日志，不读环境时钟是做不到的
   * （到期判定本来就要"现在"，所以参照时刻统一由调用方给定）。
   */
  /**
   * 欠着的事（命中任意一条 => 规则门不短路）。全部取自投影与最近日志，
   * 参照时刻由调用方给定（到期判定本来就要"现在"，但那个"现在"必须是注入的时钟）。
   *
   * 分两档，因为它们的处置不同：
   *   - `hard`：**确定需要她看见**的事实（到期意图、待确认、等人回答、新增死信）。
   *     命中即放行，不必花钱问模型——这些要么是人/机制在等一个回应，要么是上一次没做完。
   *   - `soft`：只是"有点事"（未完成的 todo）。它走模型门，或者在小到不值得开口时沉默。
   *
   * `openTurn` 刻意**不算**牵挂：门是在本 turn 的 turn/start 之后被调用的，
   * 此刻 openTurn 必然非空——把它当牵挂会让规则短路永远失效（每一拍都放行）。
   */
  private pendingMatters(now: string): { hard: string[]; soft: string[] } {
    const p = this.deps.projection;
    const hard: string[] = [];
    const soft: string[] = [];

    const dueIntentions = p.intentions.filter(
      (item) => item.triggerAt !== undefined && Date.parse(item.triggerAt) <= Date.parse(now),
    );
    for (const item of dueIntentions) hard.push(`到期意图：${item.content}`);

    if (p.needsReview.length > 0) hard.push(`待确认调用 ${p.needsReview.length} 条`);
    if (p.waitingHuman !== null) hard.push(`等待人回答：${p.waitingHuman.question}`);
    for (const item of this.recentDeadLetters()) hard.push(`新增死信：seq ${item.inputSeq}`);

    const todo = p.todoList.filter((item) => item.status !== 'completed').map((item) => item.content);
    if (todo.length > 0) soft.push(`未完成待办：${todo.join('、')}`);

    return { hard, soft };
  }

  /**
   * 最近新增的死信。判据取"日志里最后一笔 turn/end 之后写入的 input/dead-letter"：
   * 死信是"这条输入试过三次都失败"的事实，处理过它之后就该翻篇；
   * 用"投影里有没有死信"当判据会让门永远短路失败（一条旧死信就顶住了所有心跳）。
   * 只看最近 DEAD_LETTER_LOOKBACK 条事件：本函数在每拍最热路径上。
   */
  private recentDeadLetters(): Array<{ inputSeq: number }> {
    const log = this.deps.log;
    const latest = log.latestSeq();
    const from = Math.max(1, latest - DEAD_LETTER_LOOKBACK + 1);
    let since = from - 1;
    for (let seq = latest; seq >= from; seq -= 1) {
      const event = log.get(seq);
      if (event === null) continue;
      if (event.type === 'turn/end') {
        since = seq;
        break;
      }
    }
    const out: Array<{ inputSeq: number }> = [];
    for (let seq = since + 1; seq <= latest; seq += 1) {
      const event = log.get(seq);
      if (event !== null && event.type === 'input/dead-letter') out.push({ inputSeq: event.data.inputSeq });
    }
    return out;
  }

  // ── 模型门：light 车道 ──

  /**
   * 灰色地带问一次轻量模型。输入刻意只有三样（唤醒源类型、安静时长、待办摘要）——
   * 门的提示词不含人格资产，也不含历史：它是**成本闸门**，不是第二个主循环。
   * 判定失败（抛错/坏 JSON/字段缺失）一律放行并记账，理由见文件头。
   */
  private async askModel(input: NecessityInput, hint: string, quietSeconds: number): Promise<NecessityVerdict> {
    const prompt = buildPrompt(hint, quietSeconds, input.now ?? this.deps.now().toISOString());
    const text: DsTextFormat = { type: 'json_schema', name: 'reply_necessity', schema: DECISION_SCHEMA };
    const effort: DsReasoningEffort = 'low';
    const request = {
      lane: 'light' as const,
      input: prompt,
      text,
      reasoning: { effort },
      ...(this.deps.signal !== undefined ? { signal: this.deps.signal } : {}),
    };
    const startedAt = this.deps.now().getTime();
    try {
      const response = await this.deps.ds.generate(request);
      this.account(input.turn, response.usage, response.model, Math.max(0, this.deps.now().getTime() - startedAt), 'completed');
      const answered = parseDecision(response.outputItems);
      if (answered === null) {
        return this.settle({
          shouldReply: true,
          by: 'error',
          reason: 'light 判定无法解析（缺 should_reply），按应当回复处理',
        });
      }
      return this.settle({
        shouldReply: answered.shouldReply,
        by: 'model',
        reason: answered.reason === '' ? 'light 判定无理由' : answered.reason,
      });
    } catch (err) {
      // 失败也记账：否则 light 通道坏了会让 failStreak 永远为 0，失败刹车形同虚设
      this.account(input.turn, null, this.deps.ds.modelFor('light'), Math.max(0, this.deps.now().getTime() - startedAt), 'failed');
      const message = err instanceof Error ? err.message : String(err);
      return this.settle({
        shouldReply: true,
        by: 'error',
        reason: `light 判定失败（${message}），按应当回复处理`,
      });
    }
  }

  /** light 调用的账：lane=light，与 heavy 的日额度分开计数（M5-8 两级独立） */
  private account(
    turn: number,
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null,
    model: string,
    durationMs: number,
    finishReason: 'completed' | 'failed',
  ): void {
    const log = this.deps.log;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cacheHit = Math.max(0, Math.min(usage?.cachedTokens ?? 0, inputTokens));
    const event = {
      seq: log.nextSeq(),
      ts: this.deps.now().toISOString(),
      type: 'budget/consumed',
      data: {
        turn,
        step: 0,
        lane: 'light',
        model,
        inputTokens,
        outputTokens,
        cacheHitTokens: cacheHit,
        cacheMissTokens: Math.max(0, inputTokens - cacheHit),
        durationMs,
        retryCount: 0,
        finishReason,
        tokensTodayAccum: this.deps.projection.budget.tokensToday + inputTokens + outputTokens,
      },
      // 观测类：与 agent-loop 的记账同一节奏（step 边界 flush），此处由调用方 flush
      visibility: 'internal',
      origin: ORIGIN,
    } as unknown as AppEvent;
    log.append(event, { sync: false });
    // 记账口径不在这里重复实现：折进投影与 agent-loop / loop 走同一份 applyOne
    applyOne(this.deps.projection, event);
    finalizePressure(this.deps.projection, event.ts);
  }

  // ── 收尾 ──

  /** 安静时长（秒）：本批心跳事件自报的 quietSeconds 优先（它取自投影，是日志内的口径） */
  private quietSeconds(wakeEvents: readonly AppEvent[], now: string): number {
    let max = 0;
    for (const event of wakeEvents) {
      if (event.type !== 'wake/heartbeat') continue;
      const value = event.data.quietSeconds;
      if (Number.isFinite(value) && value > max) max = value;
    }
    if (max > 0) return max;
    const reference = this.deps.projection.lastAssistantAt ?? this.deps.projection.lastWake?.at ?? null;
    if (reference === null) return 0;
    const at = Date.parse(reference);
    if (Number.isNaN(at)) return 0;
    const ref = Date.parse(now);
    if (Number.isNaN(ref)) return 0;
    return Math.max(0, Math.floor((ref - at) / 1000));
  }

  /** 统一出口：留痕（一行控制台可读摘要）后返回结论 */
  private settle(verdict: NecessityVerdict): NecessityVerdict {
    this.deps.out?.(`[必要性门] ${verdict.shouldReply ? '应当回复' : '沉默'}（${verdict.by}）：${verdict.reason}`);
    return verdict;
  }
}

// ──────────────────────────────── 提示词 ────────────────────────────────

/**
 * 模型门提示词。刻意短：门花的是 light 的钱，但省的是 heavy 的钱——
 * 输入里塞人格资产或历史会让它慢慢长成第二个主循环，那就破坏了整条成本论证。
 */
export function buildPrompt(hint: string, quietSeconds: number, now: string): string {
  const clipped = hint.length > HINT_CLIP_CHARS ? `${hint.slice(0, HINT_CLIP_CHARS)}…` : hint;
  const quiet = quietSeconds < 60
    ? `${Math.floor(quietSeconds)} 秒`
    : quietSeconds < 3600
      ? `${Math.floor(quietSeconds / 60)} 分钟`
      : `${(quietSeconds / 3600).toFixed(1)} 小时`;
  return [
    '判断这一拍是否值得开口。只回答 JSON。',
    `唤醒源：heartbeat（心跳自省，不是人给的输入）`,
    `安静时长：${quiet}（她上次说话到现在）`,
    `当前牵挂：${clipped}`,
    `现在：${now}`,
    '判据：牵挂里有需要她动手或该回应的（到期的事、答应过的事、悬着的问题、失败的输入）才回 true；',
    '仅仅"有点待办""安静很久"不构成开口的理由——没有新的必须回应的事就回 false（沉默是正常动作）。',
  ].join('\n');
}

// ──────────────────────────────── 解析与记账 ────────────────────────────────

/** 从 outputItems 里取 JSON 文本（light 车道用 json_schema，正常形态就是一条 message） */
function jsonTextOf(items: ReadonlyArray<{ type: string; text?: string }>): string | null {
  let text = '';
  for (const item of items) {
    if (item.type !== 'message') continue;
    const part = item.text ?? '';
    if (part !== '') text += part;
  }
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 判定解析。容错边界写死在这里：
 *   - 非 JSON / 不是对象 / 缺 `should_reply` / 类型不对 → 返回 null，调用方按"应当回复"放行；
 *   - 容忍模型把 JSON 包在 ```json 围栏里（json_schema 正常不会，但坏一次不该让门崩）；
 *   - `reason` 缺失或非字符串 → 空串，不影响判定。
 */
export function parseDecision(items: ReadonlyArray<{ type: string; text?: string }>): { shouldReply: boolean; reason: string } | null {
  const raw = jsonTextOf(items);
  if (raw === null) return null;
  const body = stripFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const flag = obj['should_reply'];
  if (typeof flag !== 'boolean') return null;
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : '';
  return { shouldReply: flag, reason };
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutHead = trimmed.replace(/^```[a-zA-Z]*\s*/, '');
  return withoutHead.replace(/\s*```$/, '').trim();
}

/**
 * 把 light 记账折进投影的口径不在这里重复实现：gate 直接调 state/fold.ts 的 applyOne，
 * 与 agent-loop / loop 的记账保持同一份代码。此处只说明为什么必须记这一笔——
 * 不记的话 light 通道坏了会让 failStreak 永远为 0，§4.6 的失败刹车形同虚设。
 */

/** 门把 verdict 落成事件时用的数据形状（宿主写 internal 事件；此处只声明，不写日志） */
export interface NecessityVerdictEvent {
  turn: number;
  shouldReply: boolean;
  by: NecessityVerdict['by'];
  reason: string;
}

/** 事件类型名（宿主写入用；schema 未定义该类型，故由宿主按需决定是否落库） */
export const NECESSITY_VERDICT_ORIGIN = ORIGIN;

/** 沉默 turn 的结局：写 turn/end 时的 reason（与 agent-loop 的 endTurn 同一形状） */
export const SILENT_TURN_REASON: TurnEndReason = { kind: 'completed' };

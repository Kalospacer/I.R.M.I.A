/**
 * Irmia Agent — 交接笔记（handoff note）
 *
 * 依据：docs/persona.md §4（连续性：交接笔记）、docs/design.md §4.11 / §4.13、
 * docs/milestones.md M5-2。算法照搬 Cortico `bots/cormini/persona/handoffNote.ts`，
 * 五条规则逐条落地：
 *   1. 收录范围：user 消息、事件帧（wake/*）、工具入参与回执。
 *      不收：assistant 正文、思维链（message/reasoning）、上一份笔记（compaction/summary）、
 *      纯流程类调用（flow 工具：定时器布防、告警、发言——只推进流程，不带交接信息）。
 *   2. 预算按年龄衰减：最近 1/4 条目给满单条预算（foldTokens，默认 1024），往前 1/4 给 1/4，
 *      更早只留开头（1/16，下限 48 token 估算）。
 *   3. 去重：状态类条目（快照类工具、心跳）按 key 只留最新一次；逐字重复的条目合并并
 *      标注"(同样的一条重复了 N 次)"。
 *   4. 装配：从最近往远装入总预算（budgetTokens，默认 4096），装不下的早期条目只记数量。
 *   5. 分段：按时间切"历史"与"最近"两段，各标明时间范围（ISO 时刻原样，不做相对时间）。
 *
 * 两条硬约束：
 * - **纯函数、确定性**（缓存铁律 1）：本模块不读时钟、不读文件、不引随机。时间一律取自事件
 *   自带的 ts，分区参照时刻缺省取最新条目的 ts。同一批事件在任何时刻、任何机器上渲染出
 *   同一字节串——它是 `compaction/summary` 的正文来源，而遮蔽段渲染必须唯一确定（§4.13）。
 * - **总预算硬保证**：返回文本的 token 估算 ≤ budgetTokens（装配时逐条试探，末尾再削一轮，
 *   最后用 foldToBudget 兜底），因此笔记可以安全地放进状态层而不挤爆上下文。
 *
 * token 估算口径与 tools/registry.ts 的 `estimateTokens` 同源（design §4.12：中文约 1.5 字/token、
 * 英文约 4 字符/token），测试里对同一批样本断言两者逐值一致，防止两处口径悄悄漂移。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import type { AppEvent } from '../log/types.js';
import { renderExternalEvent, renderWake, wakeTitle } from '../model/render.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 笔记总预算（token 估算）：persona.md §4 默认 4096 */
export const DEFAULT_HANDOFF_BUDGET_TOKENS = 4096;
/** 最近 1/4 条目的单条满预算：persona.md §4 默认 1024 */
export const DEFAULT_HANDOFF_FOLD_TOKENS = 1024;
/** 更早条目的最小保留量：persona.md §4「1/16，下限 48 token」 */
export const HANDOFF_MIN_FOLD_TOKENS = 48;

/**
 * 纯流程类工具：只推进流程、不携带交接信息，入参与回执都不收录。
 * 它们的作用已经落在投影与人格文件里（定时器表、告警出口），再进笔记只是噪音。
 *
 * v27 之后 `notify` 不在这里了——那件工具已删（它与 speak 重复）。
 * 发言出口现在是 `speak`（日常）与 `report`（正式内容），两者仍都算流程类。
 */
export const FLOW_TOOLS: readonly string[] = ['set_timer', 'cancel_timer', 'speak', 'report'];

/**
 * 状态类工具：回执只描述"此刻是什么样"，历史值没有交接价值——按 `tool:<name>:<角色>` 只留最新一次
 * （入参与回执各自只留最新：它们是同一次调用的两面，挤在同一个 key 上会互相抵消）。
 * 注意与 FLOW_TOOLS 的分工：流程类是"发出去的动作"，状态类是"读回来的快照"。
 */
export const STATE_TOOLS: readonly string[] = ['list_timers', 'todo'];

/** 笔记首行标题（进不了任何分段，但仍计入总预算） */
const HEADER = '# 交接笔记';

/** 重复合并的标注模板（persona.md §4 原文措辞） */
function repeatLabel(times: number): string {
  return ` (同样的一条重复了 ${times} 次)`;
}

// ──────────────────────────────── 条目 ────────────────────────────────

/**
 * 条目种类。
 *
 * `user` = 有人在跟她说话（界面消息 / 外部通道来话），`assistant` = 她说出去的话。
 * 后两者一起构成"对话本身"——压缩把它们遮蔽掉时，笔记是唯一的替代品，所以它们必须进笔记
 * （2026-10-02 补，理由见 `collectHandoffEntries` 的注释）。
 */
export type HandoffEntryKind = 'user' | 'assistant' | 'wake' | 'tool-call' | 'tool-result';

/** 笔记条目：一条事件压缩成一行可读文本 */
export interface HandoffEntry {
  seq: number;
  ts: string;
  kind: HandoffEntryKind;
  /** 工具名（kind 为 tool-call / tool-result 时有值） */
  tool?: string;
  /** 状态类去重键；无 key 即非状态类条目（不参与"只留最新"） */
  stateKey?: string;
  /** 条目正文（尚未按档位截断） */
  text: string;
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface HandoffOptions {
  /** 笔记总预算（token 估算），默认 4096 */
  budgetTokens?: number;
  /** 最近 1/4 条目的单条满预算，默认 1024 */
  foldTokens?: number;
  /** 距今多少毫秒以内算"最近"（与 splitAt 同时给出时 splitAt 优先） */
  splitAtMs?: number;
  /** "最近"段的绝对起点（ISO 时刻）；缺省按最近 1/4 条目切 */
  splitAt?: string;
  /** 纯流程类工具名，默认 FLOW_TOOLS */
  flowTools?: readonly string[];
  /** 状态类工具名，默认 STATE_TOOLS */
  stateTools?: readonly string[];
  /** 分区参照时刻（通常是当前 now）；缺省取最新条目的 ts */
  now?: string;
}

export type HandoffSectionName = '历史' | '最近';

export interface HandoffSection {
  name: HandoffSectionName;
  /** 段内最早 / 最晚条目的 ts（段为空时为 null） */
  from: string | null;
  to: string | null;
  count: number;
}

export interface HandoffNote {
  /** 最终笔记文本（token 估算 ≤ budgetTokens） */
  text: string;
  /** 笔记自身的 token 估算 */
  tokens: number;
  /** 装入笔记的条目数 */
  included: number;
  /** 装不下、只记数量的早期条目数 */
  omitted: number;
  /** 分段元信息（顺序固定：历史 → 最近） */
  sections: HandoffSection[];
}

export interface FoldResult {
  text: string;
  /** 折叠后文本的 token 估算 */
  tokens: number;
  /** 被折叠掉的部分约多少 token（0 表示没折叠） */
  foldedTokens: number;
}

// ──────────────────────────────── token 估算 ────────────────────────────────

/** 宽字符（中日韩 + 全角）判定：与 tools/registry.ts 的 CJK_RE 逐字一致 */
const WIDE_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u;

/** 权重基准 12：宽字符 8/12（=1/1.5 字/token），其余 3/12（=1/4 字符/token） */
const WIDE_WEIGHT = 8;
const NARROW_WEIGHT = 3;
const WEIGHT_BASE = 12;

/**
 * 零依赖 token 估算（design §4.12）：中文约 1.5 字/token、英文约 4 字符/token。
 * 用整数权重求和再取上界，不引 tokenizer——误差由软阈值机制吸收。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(weightOf(text) / WEIGHT_BASE);
}

function weightOf(text: string): number {
  let weight = 0;
  for (const ch of text) weight += WIDE_RE.test(ch) ? WIDE_WEIGHT : NARROW_WEIGHT;
  return weight;
}

/** 按 token 预算取最长前缀（码点粒度，不切断代理对） */
function takeTokens(text: string, budgetTokens: number): string {
  const limit = Math.floor(budgetTokens * WEIGHT_BASE);
  if (limit <= 0) return '';
  let weight = 0;
  let out = '';
  for (const ch of text) {
    const cost = WIDE_RE.test(ch) ? WIDE_WEIGHT : NARROW_WEIGHT;
    if (weight + cost > limit) break;
    weight += cost;
    out += ch;
  }
  return out;
}

/** 单条截断：只留开头，末尾一个省略号（"更早只留开头"，任务里的硬规则） */
function clipTokens(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  const head = takeTokens(text, Math.max(0, budgetTokens - estimateTokens('…')));
  return head === '' ? '' : `${head}…`;
}

/**
 * 超预算文本截断 + 痕迹行："…[后面约 N token 已折叠]"。
 * 返回文本的 token 估算必然 ≤ budgetTokens（预算小到装不下痕迹行时，只留痕迹行本身）。
 */
export function foldToBudget(text: string, budgetTokens: number): FoldResult {
  const budget = Math.max(0, Math.floor(budgetTokens));
  const total = estimateTokens(text);
  if (total <= budget) return { text, tokens: total, foldedTokens: 0 };

  // 痕迹行是自描述的（N 的位数会影响长度），先按上界给它留位置，再逐字符收敛
  const reserve = estimateTokens('…[后面约 999999 token 已折叠]');
  let head = takeTokens(text, Math.max(0, budget - reserve));
  let out = markFolded(head, total);
  while (estimateTokens(out) > budget && head.length > 0) {
    // 中文 1.5 字/token 的粒度让边界可能上浮零点几 token：从尾部逐码点回退
    head = [...head].slice(0, -1).join('');
    out = markFolded(head, total);
  }
  if (estimateTokens(out) > budget) {
    // 连痕迹行都装不下：退化为"只剩痕迹"，它仍带信息（后面有多少内容被折叠了）
    out = `…[后面约 ${total} token 已折叠]`;
    while (estimateTokens(out) > budget && out.length > 0) out = [...out].slice(0, -1).join('');
  }
  return { text: out, tokens: estimateTokens(out), foldedTokens: Math.max(0, total - estimateTokens(head)) };
}

function markFolded(head: string, total: number): string {
  const folded = Math.max(0, total - estimateTokens(head));
  return head === '' ? `…[后面约 ${folded} token 已折叠]` : `${head}…[后面约 ${folded} token 已折叠]`;
}

// ──────────────────────────────── 收录 ────────────────────────────────

/** timerId → 最近一条 timer/set 的 payload（与 render 同源：wake/timer 自身不带 payload） */
function timerPayloadsOf(events: readonly AppEvent[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const e of events) {
    if (e.type === 'timer/set') map.set(e.data.timerId, e.data.payload);
    if (e.type === 'timer/cancelled') map.delete(e.data.timerId);
  }
  return map;
}

/** 多行文本折成单行：笔记是逐行清单，换行会破坏它的可读性 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

const WAKE_TYPES = new Set<string>([
  'wake/timer', 'wake/file', 'wake/webhook', 'wake/manual',
  'wake/heartbeat', 'wake/intention', 'wake/job',
]);

/**
 * 收录事件 → 条目（保持输入的时间正序）。
 *
 * **收四类**：外部来话（`wake/channel`，谁在哪个会话里说了什么）、界面消息（`message/user`）、
 * 心跳/定时器这类事件帧（`WAKE_TYPES`）、工具入参与回执。
 *
 * **2026-10-02 补进"对话本身"**：原来刻意不收 `wake/channel` 与 `message/assistant`
 * （理由是"已经说完的话，不是交接的东西"）。那个理由只在"这些话还留在现场"时成立——
 * 而压缩的遮蔽点一旦落在这段对话中间，现场就只剩半截（他的问题被遮、她的回答留着），
 * 用户实测到的"压缩后又把已经回复过的东西再回复一遍"正是这么来的。
 * 笔记是**遮蔽段的唯一替代品**，所以它必须带上"他说了什么、我答了什么"——
 * 否则遮蔽等于把对话删掉，而不是把它变成摘要。
 *
 * 仍然不收：思维链（内部过程）、上一份笔记（会自我复制）。
 */
export function collectHandoffEntries(
  events: readonly AppEvent[],
  opts: HandoffOptions = {},
): HandoffEntry[] {
  const flowTools = new Set(opts.flowTools ?? FLOW_TOOLS);
  const stateTools = new Set(opts.stateTools ?? STATE_TOOLS);
  const payloads = timerPayloadsOf(events);

  // callId → 工具名：工具回执本身不带名字，得从对应的 tool/call 取
  const nameById = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'tool/call') nameById.set(e.data.callId, e.data.name);
  }

  const out: HandoffEntry[] = [];
  for (const e of events) {
    if (e.type === 'wake/channel') {
      // 谁在哪儿说的：只写会话类型（私聊/群聊），不写 openid——名字在会话清单里，这里要的是"他说了什么"
      const where = e.data.chatType === 'c2c' ? '私聊' : '群聊';
      out.push({
        seq: e.seq, ts: e.ts, kind: 'user',
        text: `[他 · ${where}] ${oneLine(e.data.text)}`,
      });
      continue;
    }
    if (WAKE_TYPES.has(e.type)) {
      const entry: HandoffEntry = {
        seq: e.seq, ts: e.ts, kind: 'wake',
        text: `[唤醒] ${oneLine(wakeTitle(e, payloads))}`,
      };
      // 心跳是纯粹的"还在、没事"信号：同一份状态重复多少次都只留最新一次
      if (e.type === 'wake/heartbeat') entry.stateKey = 'wake:heartbeat';
      out.push(entry);
      continue;
    }
    if (e.type === 'message/user') {
      out.push({
        seq: e.seq, ts: e.ts, kind: 'user',
        text: `[用户] ${oneLine(e.data.text)}`,
      });
      continue;
    }
    if (e.type === 'message/assistant') {
      const text = oneLine(e.data.text ?? '');
      if (text === '') continue;
      out.push({ seq: e.seq, ts: e.ts, kind: 'assistant', text: `[我] ${text}` });
      continue;
    }
    if (e.type === 'tool/call') {
      if (flowTools.has(e.data.name)) continue; // 纯流程调用：不收录
      const entry: HandoffEntry = {
        seq: e.seq, ts: e.ts, kind: 'tool-call', tool: e.data.name,
        text: `[调用] ${e.data.name}(${oneLine(e.data.arguments)})`,
      };
      if (stateTools.has(e.data.name)) entry.stateKey = `tool:${e.data.name}:call`;
      out.push(entry);
      continue;
    }
    if (e.type === 'tool/result') {
      const name = nameById.get(e.data.callId) ?? '?';
      if (flowTools.has(name)) continue;
      const entry: HandoffEntry = {
        seq: e.seq, ts: e.ts, kind: 'tool-result', tool: name,
        text: resultText(name, e),
      };
      if (stateTools.has(name)) entry.stateKey = `tool:${name}:result`;
      out.push(entry);
      continue;
    }
    // 其余事件类型：不收录（reasoning、compaction/summary 等）
  }
  return out;
}

/** 工具回执文本：状态模板化（同一状态渲染出同一字节串，与 render 的固定模板同精神） */
function resultText(name: string, e: AppEvent & { type: 'tool/result' }): string {
  const d = e.data;
  const head = `[结果] ${name} ${d.status}`;
  let body: string;
  switch (d.status) {
    case 'ok': body = oneLine(d.content); break;
    case 'error': body = oneLine(d.error?.message ?? d.content); break;
    case 'timeout': body = '执行超时，结果未知'; break;
    case 'denied': body = `被策略拒绝：${oneLine(d.error?.message ?? d.content)}`; break;
    case 'unknown': body = '结果未知（Its outcome is unknown.）：只有只读或幂等操作允许重试'; break;
    case 'aborted': body = '未派发（取消时仍在队列）'; break;
    case 'over-limit': body = '未派发（单步工具调用数超限）'; break;
  }
  return body === '' ? head : `${head}：${body}`;
}

// ──────────────────────────────── 去重与合并 ────────────────────────────────

/** 状态类条目按 key 只留最新：同 key 的旧值对交接没有价值（新值已经包含了此刻的真相） */
function dedupeByStateKey(entries: readonly HandoffEntry[]): HandoffEntry[] {
  const seen = new Set<string>();
  const out: HandoffEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const key = entry.stateKey;
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(entry);
  }
  return out.reverse();
}

/**
 * 逐字重复合并：正文完全相同的条目并成一条，取最新一次的位置与时刻，标注重复次数。
 * 取最新时刻是刻意的——重复条目最新一次往往才是"现在正在发生的事"，
 * 按首次时刻算年龄会让它被误判成陈年旧账、只分到 1/16 的预算。
 */
function mergeRepeats(entries: readonly HandoffEntry[]): HandoffEntry[] {
  const countByText = new Map<string, number>();
  for (const entry of entries) {
    countByText.set(entry.text, (countByText.get(entry.text) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: HandoffEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    const times = countByText.get(entry.text) ?? 1;
    out.push(times > 1 ? { ...entry, text: `${entry.text}${repeatLabel(times)}` } : entry);
  }
  return out.reverse();
}

// ──────────────────────────────── 预算分档 ────────────────────────────────

/**
 * 按年龄衰减的单条预算（下标 0 = 最新条目）：
 * 最近 1/4 满预算，往前 1/4 给 1/4，更早给 1/16 且不低于 48 token。
 */
function tierBudgets(count: number, foldTokens: number): number[] {
  const quarter = Math.ceil(count / 4);
  const recentEnd = Math.min(count, quarter);
  const midEnd = Math.min(count, recentEnd + quarter);
  const mid = Math.max(1, Math.round(foldTokens / 4));
  const early = Math.max(HANDOFF_MIN_FOLD_TOKENS, Math.round(foldTokens / 16));
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(i < recentEnd ? foldTokens : i < midEnd ? mid : early);
  }
  return out;
}

/** 行内时刻：ISO 取 HH:MM:SS 省 token；非常规格式原样保留（确定性优先） */
function clockOf(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

/**
 * 渲染交接笔记。纯函数：不读时钟、不读文件，同一批事件任何时刻渲染出同一字节串。
 * 返回的 `text` 可直接用作 `compaction/summary.summary`（design §4.13：遮蔽段渲染由该事件唯一确定）。
 */
export function renderHandoffNote(events: readonly AppEvent[], opts: HandoffOptions = {}): HandoffNote {
  const budgetTokens = Math.max(0, Math.floor(opts.budgetTokens ?? DEFAULT_HANDOFF_BUDGET_TOKENS));
  const foldTokens = Math.max(1, Math.floor(opts.foldTokens ?? DEFAULT_HANDOFF_FOLD_TOKENS));

  const ordered = mergeRepeats(dedupeByStateKey(collectHandoffEntries(events, opts)));
  const desc = [...ordered].reverse(); // 最近 → 最远：预算从最近往远装入
  const tiers = tierBudgets(desc.length, foldTokens);

  const refMs = opts.now !== undefined ? Date.parse(opts.now) : Date.parse(desc[0]?.ts ?? '');
  const recentStart = recentStartIndex(ordered, opts, refMs);
  const isRecent = new Set<number>(ordered.slice(recentStart).map(entry => entry.seq));

  // 装入：装不下即停，剩下的早期条目只记数量（总预算优先给最近的）
  let used = estimateTokens(HEADER);
  const included: Array<{ entry: HandoffEntry; text: string }> = [];
  for (let i = 0; i < desc.length; i += 1) {
    const entry = desc[i];
    if (entry === undefined) continue;
    const text = clipTokens(entry.text, tiers[i] ?? foldTokens);
    if (text === '') break; // 预算连一个字符都装不下：后面同样装不下
    const cost = estimateTokens(text);
    if (used + cost > budgetTokens) break;
    included.push({ entry, text });
    used += cost;
  }
  let omitted = desc.length - included.length;

  const compose = (): string => buildText(included, isRecent, omitted);
  let text = compose();
  // 省略计数行也要占预算：装不下就再吐出一条（从最早装入的那条开始），保证总量硬 ≤ 预算
  while (estimateTokens(text) > budgetTokens && included.length > 0) {
    included.pop();
    omitted += 1;
    text = compose();
  }
  if (estimateTokens(text) > budgetTokens) text = foldToBudget(text, budgetTokens).text;

  const sections = sectionMeta(included, isRecent);
  return {
    text,
    tokens: estimateTokens(text),
    included: included.length,
    omitted,
    sections,
  };
}

/** "最近"段的起始下标（升序数组）：splitAt 优先，其次 splitAtMs，缺省按最近 1/4 条目切 */
function recentStartIndex(
  ordered: readonly HandoffEntry[],
  opts: HandoffOptions,
  refMs: number,
): number {
  const splitAt = opts.splitAt;
  if (splitAt !== undefined) {
    const at = Date.parse(splitAt);
    if (!Number.isNaN(at)) {
      const index = ordered.findIndex(entry => Date.parse(entry.ts) >= at);
      return index === -1 ? ordered.length : index;
    }
  }
  if (opts.splitAtMs !== undefined && !Number.isNaN(refMs)) {
    const at = refMs - opts.splitAtMs;
    const index = ordered.findIndex(entry => Date.parse(entry.ts) >= at);
    return index === -1 ? ordered.length : index;
  }
  return Math.max(0, ordered.length - Math.ceil(ordered.length / 4));
}

function buildText(
  included: ReadonlyArray<{ entry: HandoffEntry; text: string }>,
  isRecent: ReadonlySet<number>,
  omitted: number,
): string {
  const lines: string[] = [HEADER];
  const history = included.filter(item => !isRecent.has(item.entry.seq)).reverse();
  const recent = included.filter(item => isRecent.has(item.entry.seq)).reverse();

  for (const [name, items] of [['历史', history], ['最近', recent]] as const) {
    if (items.length === 0) continue;
    lines.push(sectionTitle(name, items), ...items.map(item => `- [${clockOf(item.entry.ts)}] ${item.text}`));
  }
  if (omitted > 0) lines.push(`（更早的 ${omitted} 条已省略）`);
  return lines.join('\n');
}

function sectionTitle(
  name: HandoffSectionName,
  items: ReadonlyArray<{ entry: HandoffEntry; text: string }>,
): string {
  const first = items[0]?.entry.ts ?? '';
  const last = items[items.length - 1]?.entry.ts ?? '';
  return `## ${name}（${first} ~ ${last} · ${items.length} 条）`;
}

function sectionMeta(
  included: ReadonlyArray<{ entry: HandoffEntry; text: string }>,
  isRecent: ReadonlySet<number>,
): HandoffSection[] {
  const out: HandoffSection[] = [];
  for (const name of ['历史', '最近'] as const) {
    // included 是装入顺序（新→旧），段内取回时间正序后才谈得上"最早 / 最晚"
    const items = included.filter(item => (name === '最近') === isRecent.has(item.entry.seq)).reverse();
    out.push({
      name,
      from: items[0]?.entry.ts ?? null,
      to: items[items.length - 1]?.entry.ts ?? null,
      count: items.length,
    });
  }
  return out;
}

// ──────────────────────────────── 压缩阈值口径 ────────────────────────────────

/**
 * 可见历史规模（token 估算）：未被最新 `compaction/summary` 遮蔽的 model 可见事件之和。
 * 运行期用它判定"要不要压缩"——阈值一过就写摘要，写完历史立刻变短（遮蔽生效），
 * 于是自然形成"积累到阈值才压一次"的节奏，而不是每轮都压。
 */
export function estimateHistoryTokens(events: readonly AppEvent[]): number {
  let coveredUpToSeq = 0;
  for (const e of events) {
    if (e.type === 'compaction/summary' && e.data.coveredUpToSeq > coveredUpToSeq) {
      coveredUpToSeq = e.data.coveredUpToSeq;
    }
  }
  const payloads = timerPayloadsOf(events);
  let tokens = 0;
  for (const e of events) {
    if (e.seq <= coveredUpToSeq) continue;
    // 遮蔽段不进请求，不计入。
    // v3 起**思维链也进请求**（思考模式要求回传 reasoning_text），所以它必须计入历史规模：
    // 这一条曾经把 reasoning 排除在外，与渲染口径不一致，后果是历史被低估、压缩迟迟不触发——
    // 实测上下文涨到 50k（阈值 32k）仍然没压过，每轮都在为同一批历史付费。
    if (e.visibility !== 'model') continue;
    if (e.type === 'compaction/summary') continue;
    tokens += estimateTokens(historyTextOf(e, payloads));
  }
  return tokens;
}

/** 历史规模里各事件的渲染口径（与 render 的事件流同源，细节不必逐字相同——它只是阈值口径） */
function historyTextOf(e: AppEvent, payloads: Map<string, unknown>): string {
  switch (e.type) {
    case 'message/user': return e.data.text;
    case 'message/assistant': return e.data.text ?? '';
    case 'message/reasoning': return e.data.text;
    // **他的消息也占上下文**（2026-10-02 补）：漏掉 `wake/channel` 与漏掉 reasoning 是同一类错
    // ——被遮蔽区间之外的历史被低估，压缩就迟迟不触发，每一轮都在为同一批历史付费
    case 'wake/channel': return renderExternalEvent(e.data);
    case 'tool/call': return `${e.data.name}${e.data.arguments}`;
    case 'tool/result': return e.data.content;
    case 'developer/message': return `工具清单变更 ${e.data.added.join(',')} ${e.data.removed.join(',')}`;
    case 'policy/denied': return `策略拒绝 ${e.data.tool} ${e.data.reason}`;
    case 'review/resolved': return `人工确认 ${e.data.callId} ${e.data.outcome} ${e.data.note}`;
    case 'human/asked': return `等待人工回答 ${e.data.question} ${e.data.context}`;
    case 'human/answered': return `人工回答 ${e.data.answer}`;
    // 超时事实也占历史（它在上下文里是一段「人可能不在」的注入）：漏掉它会让历史被低估
    case 'human/expired': return `未批准未拒绝（超时无人答复） ${e.data.question}`;
    default:
      return WAKE_TYPES.has(e.type) ? renderWake(e, payloads) : '';
  }
}

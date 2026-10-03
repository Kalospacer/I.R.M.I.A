/**
 * Irmia Agent — 上下文审计（归因事实 + 缓存破坏哨兵）
 *
 * 两份产出，性质不同，别混：
 *   ① **归因**（每步一条，`ContextBreakdown`）：这次请求的上下文由哪几段组成、各占多少 token。
 *      它是**事实**，不是警告——所以它挂在已有的 `budget/consumed` 上（第 4 条硬约束：
 *      不新增事件类型），随那笔模型调用一起落库。
 *   ② **哨兵**（`CacheBreak`，只在真失守时记）：相邻两次请求的前缀比对结论。它同样挂在
 *      `budget/consumed` 上——同一条事件讲一次调用，谁也不用去别处找"这次是谁坏了"。
 *
 * ⚠ 本模块**不引入任何价格 / 货币 / 计费概念**（用户的明确口径）：只记 token 与结构。
 *
 * 为什么归因必须由渲染层算（而不是在这里重估）：
 * 段边界只有装配请求的那段代码知道（`model/render.ts` 的 `render()`）——`instructions`
 * 到哪结束、哪一条是长期记忆层、哪一条是此刻层、哪条是本轮新输入。在这里拿 `RenderedRequest`
 * 反推边界就是第二份口径，迟早漂移。所以：**render 产出事实，本模块只做比对与措辞**。
 *
 * 重放保真（仓库核心不变量）：
 *   · 归因是渲染的纯函数副产物，`deriveRequest` 是运行期与重放共用的同一个函数
 *     （`runtime/replay.ts` 的 `rebuildRenderedRequest`、`web/server.ts` 的请求预览都走它），
 *     所以"同一份日志 + 同一份配置 ⟹ 同一份归因"；
 *   · 哨兵虽然要**相邻两次**比对，但基准取自日志本身（{@link lastAuditedCall} 从 `budget/consumed`
 *     里读上一次的归因），不是内存里的"上一次"。于是重放时把同一段事件喂进来，
 *     得到的是逐字段相同的结论——它既是记录下来的事实，也是可重算的事实。
 */

import { createHash } from 'node:crypto';

import type { AppEvent } from '../log/types.js';
import { estimateTokens } from '../tools/registry.ts';

// ──────────────────────────────── 归因事实 ────────────────────────────────

/** 段落哈希位数：16 位十六进制（与告警指纹同一长度，够区分且短到人眼能比对） */
export const SEGMENT_HASH_CHARS = 16;

/**
 * 一段上下文的事实：**token 数 + 渲染字节的哈希 + 条数**。
 *
 * 为什么 token 数不够、还要哈希：token 估算是有损的（`estimateTokens` 是启发式），
 * 两个长度相近的段落估出同一个数太容易了——而哨兵要判的是"字节有没有变"，
 * 那必须拿字节说话。哈希只吃已经渲染好的文本，不引入任何新口径。
 */
export interface ContextSegment {
  /** 该段的 token 估算（与 tools/registry 的 `estimateTokens` 同源） */
  tokens: number;
  /** 该段渲染文本的 sha256 前 {@link SEGMENT_HASH_CHARS} 位 */
  hash: string;
  /** 该段由几条 input item 组成（`instructions` / `tools` 不是 item，字段不出现） */
  items?: number;
}

/** 请求的上下文构成（`budget/consumed.context`，internal 可见性——**不进她的上下文**） */
export interface ContextBreakdown {
  /** 渲染版本（`RENDER_VERSION`）：它一变，请求体整体就变了，不是某一段的事 */
  renderVersion: string;
  /**
   * 人格常驻层 = IDENTITY + CONSTITUTION + STYLE + SELF_BRIEF。
   * 它是请求的**最前面**：这里一变，整个请求从头失配。
   */
  instructions: ContextSegment;
  /** 工具清单（JSON 形态的 name/description/parameters） */
  tools: ContextSegment & { count: number };
  /** input[0] 长期记忆层：技能目录 + **记忆索引** + 早期摘要（压缩会改写它） */
  memory: ContextSegment;
  /** 事件流渲染出来的历史 items。
   *
   * `headHash` 是**前 {@link HISTORY_HEAD_ITEMS} 条**的哈希：历史每步都在追加尾巴（正常），
   * 只有**前段被改写**才是缓存破坏。单看整段哈希会把每次追加都算成破坏，那是刷屏不是哨兵；
   * 而"两边窗口长度不同"这件事由 `historyRewritten` 显式挡掉。
   */
  history: ContextSegment & { headHash: string; items: number };
  /**
   * 本轮固定块（B2）：`[当前状态]` + `[关系档案]` + 本轮选中的记忆正文。
   *
   * 它在历史之后、此刻层之前，**一轮之内逐字节不变**——正是"一步之内不必重新编码"的那一段。
   * **可选**：本次改动之前写下的 `budget/consumed` 里没有这一段（那时状态挤在此刻层里），
   * 读旧事件的一方必须按"没有"处理，而不是当成 0 token 的一段。
   */
  state?: ContextSegment;
  /** 此刻层（尾部那一条 developer 消息）：**逐 step** 变，本来就该变 */
  now: ContextSegment;
  /** 本轮新输入（turn 首个 step 才有；后续 step 为 0） */
  wake: ContextSegment;
  /** 尾部插播（软阈值提示 / 钩子注入）：本来就不落库、每次都可能不同 */
  hint: ContextSegment;
  /** input 整体：条数与 token 合计（便于对账，也是"这次请求有多大"的那一个数） */
  input: { items: number; tokens: number };
}

/** 计算历史前段哈希时取前几条：够早、够便宜，又能抓住"从头被改写" */
export const HISTORY_HEAD_ITEMS = 8;

/** 文本哈希（前 16 位十六进制）。纯函数：同字节永远同哈希 */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, SEGMENT_HASH_CHARS);
}

/** 一段文本 → 段落事实（`instructions` 这种纯文本段用它） */
export function segmentOfText(text: string): ContextSegment {
  return { tokens: estimateTokens(text), hash: hashOf(text) };
}

// ──────────────────────────────── 哨兵 ────────────────────────────────

/**
 * 破坏类别。取**最早失守的那一段**当主类别——它才是"为什么整段前缀没了"的答案：
 * 头部失守会连带后面全部失守，只报最后一段等于把原因藏起来。
 */
export type CacheBreakClass =
  /** 人格文件（IDENTITY / CONSTITUTION / STYLE）被改写 → 头部失守 */
  | 'persona'
  /** 工具清单变了（MCP 上下线、destructive 开关、描述改写） */
  | 'tools'
  /** 长期记忆层被改写（上下文压缩、技能目录变化）→ 从第 1 条 input 起失守 */
  | 'memory'
  /** 历史前段被重写（注入预警给旧消息补话、重排队…） */
  | 'history'
  /** `RENDER_VERSION` 变了：渲染口径换代，请求体整体不同 */
  | 'render'
  /** 空闲过期：隔太久 + 命中率塌陷（服务端把前缀回收了） */
  | 'idle';

/** 类别 → 一句话。人话在前，机制在后（界面直接贴，不加工） */
const CLASS_TEXT: Record<CacheBreakClass, string> = {
  persona: '人格文件被改写（IDENTITY / CONSTITUTION / STYLE）——常驻前缀从第一个字节起失守',
  tools: '工具清单变了——tools 段之后的所有内容都要重算',
  memory: '长期记忆层被改写（上下文压缩或技能目录变化）——从第 1 条 input 起失守',
  history: '历史前段被重写（例如给旧消息补了框架提示）——前缀从改写处断开',
  render: '渲染版本换代——请求体整体与上一版不同',
  idle: '空闲太久，服务端把前缀回收了——命中率塌陷',
};

/** 阈值（来自 `config.contextAudit`，默认保守；见 ContextAuditThresholds 的字段注释） */
export interface CacheBreakThresholds {
  /** 空闲多久之后才检查命中率塌陷（毫秒） */
  idleMs: number;
  /** 命中率**相对**跌幅门槛（0–1） */
  hitDrop: number;
}

/** 命中率塌陷还要看上次的底子：上次本来就没命中（< 这个值）时，跌无可跌，不报 */
export const IDLE_PREV_HIT_FLOOR = 0.5;

/** 默认阈值（config 缺失时的兜底，与 config.ts 内置默认同值） */
export const DEFAULT_CACHE_BREAK_THRESHOLDS: CacheBreakThresholds = {
  idleMs: 30 * 60 * 1000,
  hitDrop: 0.5,
};

/** 一次被审计的模型调用（从 `budget/consumed` 折出来） */
export interface AuditedCall {
  context: ContextBreakdown;
  /** 调用发生的时刻（事件自带 ts） */
  ts: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

/** 缓存破坏的结论（写进 `budget/consumed.cacheBreak`） */
export interface CacheBreak {
  /** 主类别：**最早**失守的那一段（正交判据 `render` / `idle` 只在没有段失守时当主类别） */
  class: CacheBreakClass;
  /** 本轮命中的全部类别，按"越靠前越早失守"排 */
  classes: CacheBreakClass[];
  /** 一句话人话摘要（界面原样贴） */
  reason: string;
  /** 距上一次被审计的调用隔了多久（毫秒）：`idle` 判据用它，排障也用它 */
  gapMs: number;
}

/**
 * 从日志里取**上一次被审计的调用**。
 *
 * 它刻意从事件读而不是从内存读：哨兵要的是"与上一次真实请求比对"，而那次请求的唯一
 * 可靠记录就是日志。重放时喂进同一段事件，`detectCacheBreak` 得到的结论与当时逐字段一致
 * ——这正是"重放保真"对哨兵的要求（不引入只有运行期才有的字段）。
 *
 * 没有 `context` 的老事件（本次改动之前写下的 `budget/consumed`）**跳过**：拿一个没有归因的
 * 调用当基准，只会得到"到处都变了"的假结论。
 */
export function lastAuditedCall(events: Iterable<AppEvent>): AuditedCall | null {
  let found: AuditedCall | null = null;
  for (const event of events) {
    if (event.type !== 'budget/consumed') continue;
    const context = event.data.context;
    if (context === undefined) continue;
    found = {
      context,
      ts: event.ts,
      cacheHitTokens: event.data.cacheHitTokens,
      cacheMissTokens: event.data.cacheMissTokens,
    };
  }
  return found;
}

/**
 * 相邻两次请求的前缀比对：**除此刻层尾巴以外的部分**变了就记一条，并注明类别。
 *
 * 判据（逐段按请求体里的顺序，越靠前越"早失守"）：
 *   ① `instructions.hash` 变了            → `persona`
 *   ② `tools.hash` 变了                   → `tools`
 *   ③ `memory.hash` 变了                  → `memory`
 *   ④ `history.headHash` 变了             → `history`
 *   ⑤ `renderVersion` 变了                → `render`（正交：它不是某一段的事）
 *   ⑥ `idle`：间隔 ≥ `idleMs` **且** 上次命中率 ≥ {@link IDLE_PREV_HIT_FLOOR}
 *      **且** 本次命中率相对跌掉 ≥ `hitDrop` → `idle`
 *
 * 允许自由变化、**不算破坏**的部分：`history` 的尾巴（追加是常态）、`now`（此刻层本来就每轮变）、
 * `wake`（本轮新输入）、`hint`（尾部插播，本来就不落库）。把它们算成破坏，等于每步都报一次。
 *
 * 第一次调用（`prev === null`）不报：没有可比的对象，"变化"无从谈起。
 */
export function detectCacheBreak(
  prev: AuditedCall | null,
  cur: AuditedCall,
  thresholds: CacheBreakThresholds = DEFAULT_CACHE_BREAK_THRESHOLDS,
): CacheBreak | null {
  if (prev === null) return null;

  const gapMs = Math.max(0, parseMs(cur.ts) - parseMs(prev.ts));
  const segments: CacheBreakClass[] = [];
  if (prev.context.instructions.hash !== cur.context.instructions.hash) segments.push('persona');
  if (prev.context.tools.hash !== cur.context.tools.hash) segments.push('tools');
  if (prev.context.memory.hash !== cur.context.memory.hash) segments.push('memory');
  if (historyRewritten(prev.context, cur.context)) segments.push('history');
  const versionChanged = prev.context.renderVersion !== cur.context.renderVersion;
  const idle = idleCollapse(prev, cur, gapMs, thresholds);
  if (segments.length === 0 && !versionChanged && !idle) return null;

  const primary: CacheBreakClass = segments[0] ?? (versionChanged ? 'render' : 'idle');
  const classes = [...segments];
  if (versionChanged) classes.push('render');
  if (idle) classes.push('idle');

  const detail: string[] = [CLASS_TEXT[primary]];
  for (const extra of classes) {
    if (extra !== primary) detail.push(CLASS_TEXT[extra]);
  }
  const hit = hitRate(cur);
  const reason = `缓存前缀失守（${classes.join(' + ')}）：${detail.join('；')}。`
    + `距上次调用 ${Math.round(gapMs / 60_000)} 分钟，本次 input ${cur.context.input.tokens} token`
    + `${hit === null ? '' : `，缓存命中 ${(hit * 100).toFixed(1)}%`}。`;
  return { class: primary, classes, reason, gapMs };
}

/**
 * 历史段有没有被**重写**（对比 `history.headHash` 与条数）。
 *
 * 三种情形不能混成一句"哈希不相等"：
 *   · **变短**（`items` 少了）→ 一定有东西被遮蔽或抹掉（压缩就是这一种）；
 *   · **两边都攒满了前 {@link HISTORY_HEAD_ITEMS} 条** → 两边窗口一样长，哈希直接可比，
 *     不一致就是前段被改写；
 *   · **条数一样但都没攒满** → 窗口是同一个（都是"整段"），同样可比。
 * 剩下的情形（尾巴变长，且至少一边还没攒满）**窗口长度本来就不同**，哈希当然不同——
 * 那是最常见的正常追加，绝不能在它身上报破坏（那会变成每步一条的刷屏）。
 */
function historyRewritten(prev: ContextBreakdown, cur: ContextBreakdown): boolean {
  const before = prev.history;
  const after = cur.history;
  if (after.items < before.items) return true;
  if (before.items >= HISTORY_HEAD_ITEMS && after.items >= HISTORY_HEAD_ITEMS) {
    return before.headHash !== after.headHash;
  }
  if (before.items === after.items) return before.headHash !== after.headHash;
  return false;
}

/**
 * 空闲过期判据：**久 + 命中率塌陷**，两个都要。
 *
 * 为什么不能只看"久"：她正常空闲时静默时长本来就会很长（心跳基线 30 分钟），
 * 把"久"当破坏等于把正常当异常——这正是 2026-10-03 那次告警刷屏的同一种错。
 * 命中率塌陷才是服务端真把前缀回收了的证据。
 */
function idleCollapse(
  prev: AuditedCall,
  cur: AuditedCall,
  gapMs: number,
  thresholds: CacheBreakThresholds,
): boolean {
  if (!(gapMs >= thresholds.idleMs)) return false;
  const before = hitRate(prev);
  const after = hitRate(cur);
  // 上次本来就没命中（输入很短时命中率天然为 0）：跌无可跌，不报
  if (before === null || after === null || before < IDLE_PREV_HIT_FLOOR) return false;
  return before - after >= before * thresholds.hitDrop;
}

/** 命中率；没有可用分母（这一笔没报 token）时给 null——不猜 */
function hitRate(call: AuditedCall): number | null {
  const total = call.cacheHitTokens + call.cacheMissTokens;
  if (!(total > 0)) return null;
  return call.cacheHitTokens / total;
}

function parseMs(ts: string): number {
  const at = Date.parse(ts);
  return Number.isFinite(at) ? at : 0;
}

// ──────────────────────────────── 界面措辞 ────────────────────────────────

/** 类别 → 徽章词（「框架提示」卡用；界面不自己维护第二份词表） */
export const CACHE_BREAK_LABEL = '缓存破坏';

/** 类别 → 短标签（一句话标题里用它，长解释在 `reason` 里） */
export const CACHE_BREAK_CLASS_LABEL: Record<CacheBreakClass, string> = {
  persona: '人格文件变更',
  tools: '工具清单变更',
  memory: '长期记忆层改写',
  history: '历史前段重写',
  render: '渲染版本变更',
  idle: '空闲过期',
};

/** 归因事实在「框架提示」卡里的徽章词 */
export const CONTEXT_LABEL = '上下文';

/**
 * 一行归因摘要（**分部与合计必须自洽**）。
 *
 * 2026-10-04 重写，两件事一起修：
 *   ① **旧版读起来是错的**：它这样印——`指令 0.4万 · 工具 0.4万×25 · 记忆 299 · 历史 959/9 条 ·
 *      此刻层 0.5万 · 合计 0.6万`。而 `input.tokens` 的口径是"只数 input 里的 item 段"
 *      （instructions 与 tools 是另外两个顶层字段，本来就不在里面，见 render.ts 的注释）。
 *      于是"合计"比前面几项的和还小，谁看都会觉得这张卡在瞎写——用户就是这么发现的。
 *   ② **单位太粗**：`万` 取一位小数 = 1000 token 的粒度，两千和三千都印成"0.2万"，
 *      想核对的人根本对不上账。
 *
 * 现在：**整条 = 指令 + 工具 + input 段**，每一项都给**精确整数**（千分位），
 * 等式两边按定义相等——想核对的人能自己加一遍，加出来一定对得上。
 * 措辞里仍然不许出现任何价格/货币字样（用户明确不要计价）。
 */
export function describeContext(context: ContextBreakdown): string {
  const segments = [
    `记忆 ${exact(context.memory.tokens)}`,
  ];
  // 固定块（B2）：旧记录里没有这一段（那时状态挤在此刻层里），没有就不印——
  // 印一个 0 会让人以为"当时这一段是空的"，而事实是"当时还没有这一段"。
  if (context.state !== undefined) segments.push(`固定块 ${exact(context.state.tokens)}`);
  segments.push(
    `历史 ${exact(context.history.tokens)}（${context.history.items} 条）`,
    `此刻层 ${exact(context.now.tokens)}`,
  );
  if (context.wake.tokens > 0) segments.push(`本轮输入 ${exact(context.wake.tokens)}`);
  if (context.hint.tokens > 0) segments.push(`尾部插播 ${exact(context.hint.tokens)}`);
  const whole = context.instructions.tokens + context.tools.tokens + context.input.tokens;
  return `整条 ${exact(whole)} = 指令 ${exact(context.instructions.tokens)}`
    + ` + 工具 ${exact(context.tools.tokens)}（${context.tools.count} 件）`
    + ` + input 段 ${exact(context.input.tokens)}（${segments.join(' · ')}）`;
}

/** 精确整数（千分位）：核对的人要能把这一行自己加一遍 */
function exact(tokens: number): string {
  return Math.max(0, Math.trunc(tokens)).toLocaleString('en-US');
}

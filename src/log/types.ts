/**
 * Irmia Agent — 事件类型全集
 * 与 docs/schema.md §1-§7 逐字对齐。修改事件形状必须先改 schema 文档。
 */

// ──────────────────────────────── 信封 ────────────────────────────────

/** 可见性：model 事件参与上下文渲染；internal 仅作簿记与审计，永不进模型请求 */
export type Visibility = 'model' | 'internal';

export interface EventEnvelope<T extends string = string, D = unknown> {
  /** 全局单调递增序号，允许空洞（崩溃留下的空位）。分配器单例，重启后从日志最大 seq + 1 继续 */
  seq: number;
  /** ISO 8601，带时区 */
  ts: string;
  /** 事件类型，格式为 `<域>/<名词>` */
  type: T;
  /** 事件负载 */
  data: D;
  /** 可见性 */
  visibility: Visibility;
  /** 可选：产生此事件的代码位置，便于排障 */
  origin?: string;
  /** 子代理 turn 链归属标记：指向父 turn 的 task 调用 */
  parentCallId?: string;
}

// ──────────────────────────────── 基础枚举 ────────────────────────────────

export type SideEffect = 'none' | 'idempotent' | 'destructive';

export type ToolResultStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'denied'
  | 'unknown'
  | 'aborted'
  /** 单步工具调用数超上限：本调用未派发（design.md §4.6 单 step 层） */
  | 'over-limit';

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked'; by: string }
  | { kind: 'aborted'; cause: 'user' | 'signal' | 'shutdown' }
  | { kind: 'interrupted' }
  | { kind: 'error'; message: string; code: string }
  | { kind: 'budget-exhausted'; layer: BudgetLayer }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'max-tokens'; outputTokens: number };

export type BudgetLayer = 'step' | 'turn' | 'task' | 'daily';

export type WakeSource = 'timer' | 'file' | 'webhook' | 'manual' | 'heartbeat' | 'intention' | 'job' | 'channel';

export type ModelLane = 'heavy' | 'light';

// ──────────────────────────────── 生命周期 ────────────────────────────────

export interface SessionStart extends EventEnvelope<'session/start', {
  pid: number; cwd: string; version: string;
  schemaVersion: string;
  configHash: string;
}> {}

export interface SessionEnd extends EventEnvelope<'session/end', {
  reason: 'shutdown' | 'error' | 'signal'; detail?: string;
}> {}

export interface TurnStart extends EventEnvelope<'turn/start', { turn: number }> {}

export interface TurnEnd extends EventEnvelope<'turn/end', {
  turn: number; reason: TurnEndReason; spoke: boolean;
}> {}

export interface StepStart extends EventEnvelope<'step/start', {
  turn: number; step: number; model: string;
  lane: ModelLane;
  renderVersion: string;
  personaHash: string;
}> {}

export interface StepEnd extends EventEnvelope<'step/end', {
  turn: number; step: number; toolCalls: number;
}> {}

// ──────────────────────────────── 消息 ────────────────────────────────

export interface UserMessage extends EventEnvelope<'message/user', {
  text: string; source: 'human' | 'timer' | 'webhook' | 'file' | 'intention' | 'job';
}> {}

export interface AssistantMessage extends EventEnvelope<'message/assistant', {
  text: string | null;
  toolCalls: Array<{ callId: string; name: string; arguments: string }>;
  interrupted?: boolean;
}> {}

/** 思维链留存（internal；只供复盘，渲染层剥离——缓存铁律 3） */
export interface ReasoningMessage extends EventEnvelope<'message/reasoning', {
  turn: number; step: number; text: string;
}> {}

export interface DeveloperMessage extends EventEnvelope<'developer/message', {
  added: string[]; removed: string[];
}> {}

// ──────────────────────────────── 工具调用 ────────────────────────────────

export interface ToolCall extends EventEnvelope<'tool/call', {
  turn: number; step: number; callId: string; name: string;
  arguments: string;
  sideEffect: SideEffect;
}> {}

export interface ToolResult extends EventEnvelope<'tool/result', {
  turn: number; step: number; callId: string;
  /** 引用对应 tool/call 事件的 seq，用于校验配对 */
  callSeq: number;
  status: ToolResultStatus;
  /** 结果全文；超过 blob 阈值时这里只存头部预览 */
  content: string;
  /** 大结果外置：全文在 data/blobs/（内容寻址 sha256 命名） */
  contentRef?: { blobId: string; bytes: number };
  durationMs?: number;
  error?: { message: string; code: string };
}> {}

// ──────────────────────────────── 唤醒与定时器 ────────────────────────────────

export interface WakeTimer extends EventEnvelope<'wake/timer', {
  timerId: string; scheduledAt: string; firedAt: string;
  /**
   * 到期时定时器上挂着的那个 payload，原样带过来。
   *
   * 为什么要放进事件：`at` 型定时器一触发就从表里删掉，认领方若只查表就再也拿不到它——
   * 于是"到点提醒我做什么"这类语义静默丢失（`/dream` 的唤醒也因此跑成了普通 turn）。
   * cron 型条目触发后保留，所以这个洞只在一次性定时器上现形。
   */
  payload?: unknown;
}> {}

export interface WakeFile extends EventEnvelope<'wake/file', {
  path: string; kind: 'created' | 'changed' | 'deleted';
  dedupeKey?: string;
}> {}

export interface WakeWebhook extends EventEnvelope<'wake/webhook', {
  path: string; body: string; headers: Record<string, string>;
  dedupeKey?: string;
}> {}

/**
 * **场景鉴权拒绝了一次工具调用**（2026-10-04，internal）。
 *
 * 为什么只落拒绝、不落放行：放行是常态，落下来会把日志淹掉；而"谁在什么时候试图让她
 * 做什么、被谁拦下"正是无人值守最需要的审计线索（与 injection/flagged 同一条理由：
 * 出了事得查得出框架当时做了什么）。
 */
export interface AuthzDenied extends EventEnvelope<'authz/denied', {
  turn: number;
  step: number;
  /** 被拒的工具名 */
  tool: string;
  /** 场合：owner = 自己家（GUI/用户会话/她自己）；guest = 软件里遇到的人 */
  scenario: 'owner' | 'guest';
  /** 拒绝理由（给她看的那句话，逐字与她收到的回执一致） */
  reason: string;
  code: string;
}> {}

export interface WakeManual extends EventEnvelope<'wake/manual', {
  note: string; dedupeKey?: string;
  /**
   * 带人唤醒：本机用户说话时带上 `config.persona.owner`，于是对应关系档案注入。
   * 缺省 = 不带人（子代理任务文本、外部脚本的裸注入）。
   */
  person?: string;
  /**
   * 这条唤醒是谁让它发生的（'dream' = 界面的 /dream 动作，不是用户打的话）。
   *
   * 为什么要这个字段：GUI 对 wake/manual 的既有口径是「有 note = 用户在输入框里打的字」
   * → 右侧气泡。而 /dream 的 note 是**框架写的指令**（该做梦了……），拿它当用户说的话
   * 就成了截图里那条蓝气泡（用户 2026-10-04：「同样应该包装成框架卡片」）。
   * 有了标记，界面就能按来源分：用户打的字走气泡，框架的动作用框架卡片。
   */
  via?: 'dream';
}> {}

export interface WakeHeartbeat extends EventEnvelope<'wake/heartbeat', {
  quietSeconds: number; idleTicks: number; pressure: number;
}> {}

export interface WakeIntention extends EventEnvelope<'wake/intention', {
  intentionId: string; content: string;
}> {}

export interface WakeJob extends EventEnvelope<'wake/job', {
  jobId: string;
}> {}

/** IM 通道消息（QQ/未来微信/Telegram 统一入口）：外部不可信数据，渲染时包边界标注 */
export interface WakeChannel extends EventEnvelope<'wake/channel', {
  /** 通道标识：'qq-official' | 'onebot' | ... */
  channel: string;
  /** 聊天形态：单聊 / 群聊@ / 群消息 / 频道 */
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  /** 发送者标识（QQ 的 member/user openid） */
  person: string;
  /** 平台给的**昵称/群名片**（只用于显示认人；**不是身份**——身份永远按 id 判） */
  nickname?: string;
  /** 会话标识（群 openid 或用户 openid——speak 回投目标） */
  chatId: string;
  text: string;
  /** 平台消息 id 与序号（被动回复 msg_id + msg_seq 语义） */
  messageId: string;
  msgSeq: number;
  /** 平台原始附件描述（图片/文件等，文本已剥离） */
  /** `text`：平台对这条附件的**转写**（目前只有语音的 `asr_refer_text`）；只作可读化，不是她"听到的" */
  attachments?: Array<{ type: string; url?: string; name?: string; text?: string }>;
  /**
   * 这条是不是 @/提到 了她（适配器给得出就填，给不出就不填）。
   *
   * **判据不看它**：唤醒语义绑在 `chatType === 'group-at'` 上，见 `channel/inbox.ts` 那段——
   * 按它分流会让同一个群里出现"被 @ 但不该醒"与"没被 @ 但该醒"两套说法。
   * 它只是留个线索（比如全量群消息模式下，content 里的 @ 前缀已被官方去掉，这是唯一还看得出指向的字段）。
   */
  mentionsMe?: boolean;
  dedupeKey?: string;
}> {}

/**
 * IM 通道的**普通消息**（不进上下文、不唤醒）：她"知晓"外面有人在说话，要不要看由她定。
 *
 * 与 `wake/channel` 的分工是这个仓库里最要紧的一条线：
 *   • `wake/channel` 是「**叫她**」——被 @、或她自己标记为关注/用户的会话；它进消息流、唤醒 turn；
 *   • `channel/message` 是「**手边那个软件在响**」——群里的普通发言、别人发来的私聊。
 *
 * 为什么后者要**显式写成一条事件**而不是干脆不落库：用户定的模型是"QQ 是她手边一个可以点开的
 * 软件，不是推给她的消息流"。既然她"可以选择看"，那"有多少条没看"就必须是一个**可以算出来的
 * 事实**——而日志是唯一真相源，没落库就没得算。落了它，未读计数、`read_channel` 的最近若干条、
 * 以及"不看也一条不丢"这三件事就有了同一个来源；不落它，未读只能是运行时内存里的一笔糊涂账。
 *
 * **可见性固定 internal**：它不进请求、不唤醒（`wake/channel` 保持原样，那才是"叫她"的那条路）。
 * 她想看就用 `read_channel` 现取——取回来的内容按外部不可信数据处理（见 render 的 external_event）。
 *
 * `msgSeq` 与未读的关系：折叠会话簿时 `readUpToSeq` / `unread` 都按这个字段比大小
 * （见 channel/sessions.ts）。平台给不出真序号时调用方填**事件 seq**（照样单调），契约不变。
 */
export interface ChannelMessage extends EventEnvelope<'channel/message', {
  /** 通道标识：'qq-official' | 'onebot' | ... */
  channel: string;
  /** 聊天形态：单聊 / 群聊@ / 群消息 / 频道 */
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  /** 发言者（平台 openid） */
  person: string;
  /** 平台给的**昵称/群名片**（只用于显示认人；**不是身份**——身份永远按 id 判） */
  nickname?: string;
  /** 会话 id（群 openid 或用户 openid） */
  chatId: string;
  text: string;
  messageId: string;
  msgSeq: number;
  attachments?: Array<{ type: string; url?: string; name?: string }>;
  /** 这条是不是 @/提到 了她。群里的 @ 与普通发言要能分开（适配器给得出就填） */
  mentionsMe?: boolean;
}> {}

/**
 * 已读到某个会话的哪一条（她自己调 `read_channel` 时写下的话）。
 *
 * 它是一条**独立事件**而不是给 `channel/message` 打标记：标记要改写已落库的事件（日志只追加，
 * 永远不改写），而"我读到哪了"本来就是随她动作变化的一件事，落在它自己的时刻上才对得上。
 */
export interface ChannelRead extends EventEnvelope<'channel/read', {
  sid: string;
  upToSeq: number;
}> {}

/**
 * 框架对某条外部消息给出的**注入预警**（internal）。
 *
 * 为什么预警要落成事件而不是渲染时现算：渲染层是纯函数（缓存铁律 1），它只能读事件；
 * 而且"当时提示过她什么"必须可复盘——她要是真被人绕进去了，得查得出框架有没有提醒过。
 *
 * **没迹象就不写这条事件**：她不需要知道"这条消息被判过、没问题"，那只是噪音。
 */
export interface InjectionFlagged extends EventEnvelope<'injection/flagged', {
  /** 被判定的是哪条外部消息（与 `channel/message.messageId` 同源，按它把预警贴回那一条） */
  messageId: string;
  sid: string;
  /** 判定来自哪一级：规则短路，还是问了模型 */
  by: 'rule' | 'model';
  /** 一句话理由（给她当材料，不是命令） */
  reason: string;
  /** 原文里最可疑的片段（规则给的是精确片段，模型给的是它自己引的） */
  quotes: string[];
  /** 这条消息是谁发的（预警里要说清"是谁在这么干"，她认人用） */
  person: string;
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
}> {}

/**
 * 框架把一句注入预警**摆到了她眼前**——"示警已发生"的凭据（internal）。
 *
 * 与 `injection/flagged` 是两件事，刻意分开：
 *   • `injection/flagged` 是**判定结论**（谁判的、凭什么、命中了什么）；
 *   • 这条是**示警事实**（框架对她说的那句原话、说的是哪条消息、什么时候说的）。
 *
 * 为什么非要有第二条：预警还有一条"没有判定结论"的路——规则层字面命中、判定超时没跑成、
 * 一批里超出判定上限的那些。那条路今天只在渲染时现拼一句话，"她到底看没看见"就查不出来；
 * 而且那句话是渲染层的文案，GUI 侧（Dart）算不出同一串字节，要**原样**贴出它就只能落成事件。
 */
export interface InjectionNoted extends EventEnvelope<'injection/noted', {
  /** 说的是哪条外部消息（与 `wake/channel` / `channel/message` 的 messageId 同源） */
  messageId: string;
  sid: string;
  /** 说话的人（`person`）与会话类型：预警里必须说清"是谁在这么干" */
  person: string;
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  /**
   * 会话显示名（宿主当时解析出来的名字；解析不出就写 sid 那串 id）。
   *
   * 为什么把名字落进事件而不是渲染时再解析：此刻层那段"最近 24 小时谁试探过"要按人列，
   * 而渲染层是纯函数（不查联系人表、不读别名表）。名字是当时的事实，落下来才对得上。
   */
  who: string;
  /** 框架对她说的那句话——**逐字**（GUI 卡片与此刻层历史都引用它，一个字都不改写） */
  note: string;
  /**
   * 判定结论与引文——**给人的那一半**（2026-10-02 用户要求）。
   *
   * 为什么与 `note` 分开：`note` 是**对她说的**，末尾那句"那是别人说的话…怎么看你、要不要理、
   * 要不要点破，都由你"是给她的授权，人不需要看；人要看的是"凭什么叫它有迹象"。
   * 拆开之后，界面上那张卡照运行情况页的样子渲染（结论 + 引文），她那边一个字不改。
   *
   * 规则命中的那一路没有判定结论：`reason` 用规则自己那句"在做什么"，`quotes` 是命中片段。
   */
  reason: string;
  quotes: string[];
  /** 判定来源（有判定时）：规则短路还是问了模型。没有判定结论时不出现 */
  by?: 'rule' | 'model';
}> {}

/**
 * 一个会话"正在聊什么"——信箱模型的中间那层。
 *
 * 三层是配套的：**未读条数**（那里有多少条）、**话题**（在聊什么，就是这条）、
 * **@ 附近的消息**（找我做什么）。只给条数她还得翻才知道值不值得看；有了话题，
 * 她扫一眼会话清单就能决定要不要翻——这才是"可以选择看不看"能落地的样子。
 *
 * 话题由 light 概括后**落成事件**而不是即算即用：渲染层是纯函数（只能读事件），
 * 而且落盘之后"她当时看到的话题是什么"可复盘——万一某个概括失真把她带偏了，查得出来。
 * `fromSeq`/`toSeq` 就是为这件事留的：概括覆盖了哪一段，过没过时一目了然。
 */
export interface ChannelTopic extends EventEnvelope<'channel/topic', {
  sid: string;
  /** 一句话话题 */
  topic: string;
  fromSeq: number;
  toSeq: number;
  count: number;
}> {}

/**
 * 把一张图片放进上下文（她自己要求"我要亲眼看"）。
 *
 * 与 `wake/channel` 的附件是两条来源、同一个出口：渲染层看到这两个事件都会注入
 * `input_image`（见 render.ts 的 imagesOf）。区别在触发者——前者是外部发来的，
 * 后者是她调 `vision_read` 时选了直通模式，明确表示"这张别转述，我要原图"。
 *
 * `key` 是宿主能解析的稳定标识（本地图片路径）。渲染层只负责把它交给注入的 loader，
 * 自己不读字节——render 是纯函数。
 */
export interface ImageAttached extends EventEnvelope<'image/attached', {
  /** 宿主可解析的图片标识（当前就是工作目录内的路径） */
  key: string;
  /** MIME：`image/png` / `image/jpeg` …，用于拼 data URL */
  mime: string;
  /** 原始文件名（只为可读，不参与取字节） */
  name?: string;
  /** 她自己写的一句注解（为什么把这张放进来看） */
  note?: string;
}> {}

export interface TimerSet extends EventEnvelope<'timer/set', {
  timerId: string;
  at?: string;
  /** 周期语义：与 at 互斥；触发后自动结算下一次 */
  cron?: string;
  payload: unknown;
}> {}

export interface TimerFired extends EventEnvelope<'timer/fired', { timerId: string }> {}
export interface TimerCancelled extends EventEnvelope<'timer/cancelled', { timerId: string }> {}

// ──────────────────────────────── 预算 ────────────────────────────────

export interface BudgetConsumed extends EventEnvelope<'budget/consumed', {
  turn: number; step: number;
  lane: ModelLane; model: string;
  inputTokens: number; outputTokens: number;
  cacheHitTokens: number; cacheMissTokens: number;
  durationMs: number; retryCount: number;
  finishReason: 'completed' | 'max_output_tokens' | 'failed' | 'aborted';
  tokensTodayAccum: number;
}> {}

export interface BudgetRollover extends EventEnvelope<'budget/rollover', { date: string }> {}

export interface BudgetExhausted extends EventEnvelope<'budget/exhausted', {
  layer: BudgetLayer; limit: number; actual: number;
  /** 暂停而不是失败；加预算后可以继续 */
  resumable: true;
}> {}

export interface BudgetToppedUp extends EventEnvelope<'budget/topped-up', {
  layer: BudgetLayer; addedTokens: number; by: string;
}> {}

// ──────────────────────────────── 策略与运维 ────────────────────────────────

export interface PolicyDenied extends EventEnvelope<'policy/denied', {
  tool: string;
  rule: 'path-allowlist' | 'command-denylist' | 'destructive-disabled' | 'hook';
  reason: string;
  callId: string;
}> {}

export interface LogRepaired extends EventEnvelope<'log/repaired', {
  truncatedBytes: number; lastGoodSeq: number;
}> {}

export interface InstanceTakeover extends EventEnvelope<'instance/takeover', {
  previousPid: number; previousHeartbeatAt: string;
  staleBecause: 'no-heartbeat' | 'pid-gone' | 'pid-reused';
}> {}

export interface InputClaimed extends EventEnvelope<'input/claimed', {
  turn: number; wakeSeqs: number[]; claimCounts: number[];
}> {}

export interface InputDeadLetter extends EventEnvelope<'input/dead-letter', {
  inputSeq: number; claimCount: number; lastError?: string;
}> {}

/** 输入退回队列：interrupted turn 认领过的输入重新入队（internal） */
export interface InputRequeued extends EventEnvelope<'input/requeued', {
  wakeSeqs: number[]; claimCounts: number[];
  /** 各输入的来源（恢复流程从原 wake 事件还原） */
  sources: WakeSource[];
  /**
   * 退回原因：`turn-interrupted`（崩溃/中断）、`startup-recovery`（恢复七步补投）、
   * `human-answered`（人审挂起的 turn 得到答复后重入，design §4.21）、
   * `turn-error`（整轮失败：模型/服务端拒了请求——输入不该就此消失，2026-10-02 补）。
   * 四者的共同语义是「这些输入回到队列里，还有一次完整机会」；差别只在记账。
   */
  reason: 'turn-interrupted' | 'startup-recovery' | 'human-answered' | 'turn-error';
}> {}

export interface ToolZombie extends EventEnvelope<'tool/zombie', {
  callId: string; name: string; note: string;
}> {}

export interface AlarmSent extends EventEnvelope<'alarm/sent', {
  fingerprint: string; level: 'info' | 'warn' | 'critical'; title: string;
}> {}

export interface ReviewResolved extends EventEnvelope<'review/resolved', {
  callId: string; outcome: 'succeeded' | 'failed' | 'partial'; note: string; by: string;
}> {}

export interface SnapshotCheckpoint extends EventEnvelope<'snapshot/checkpoint', {
  upToSeq: number; file: string;
}> {}

export interface CompactionSummary extends EventEnvelope<'compaction/summary', {
  coveredUpToSeq: number; summary: string;
}> {}

export interface PersonaUpdated extends EventEnvelope<'persona/updated', {
  file: string; diffHash: string; by: 'agent' | 'human';
}> {}

export interface ConfigChanged extends EventEnvelope<'config/changed', {
  fields: string[]; configHash: string;
}> {}

/**
 * 每日整理结果（design.md §4.17）。
 * 四操作枚举是写入路径与存储之间的稳定接口；计数与文件真实动作一一对应（internal，不进上下文）。
 */
export interface MemoryMaintained extends EventEnvelope<'memory/maintained', {
  /** 整理日期（YYYY-MM-DD，与 budget/rollover 同口径） */
  date: string;
  ops: { add: number; update: number; invalidate: number; noop: number };
  /** 被合并的 episode 份数 */
  mergedCount: number;
  /** 已移入 episodes/archive/ 的份数 */
  archivedCount: number;
  /** TTL 过期移入归档区的条目数 */
  expiredCount: number;
  /** 日记文件路径；写失败为 null */
  diaryFile: string | null;
  /** 本任务 light lane 消耗（input+output） */
  lightTokens: number;
}> {}

// ──────────────────────────────── 扩展面 ────────────────────────────────

export interface McpServerStarted extends EventEnvelope<'mcp/server-started', {
  name: string; pid: number; tools: string[];
}> {}

export interface McpServerStopped extends EventEnvelope<'mcp/server-stopped', {
  name: string; reason: 'idle-reclaim' | 'crashed' | 'shutdown';
}> {}

export interface SkillInstalled extends EventEnvelope<'skill/installed', {
  name: string; path: string; by: 'agent' | 'human';
  /**
   * SKILL.md 全文的内容哈希（信任门的变更检测凭据）：
   * 确认绑定内容，确认之后又被改动的目录自动退回待确认状态。旧事件可缺该字段。
   */
  contentHash?: string;
}> {}

export interface HookFired extends EventEnvelope<'hook/fired', {
  hook: 'PreToolUse' | 'PostToolUse' | 'Wake';
  outcome: 'ok' | 'timeout' | 'error';
}> {}

export interface SpeakSent extends EventEnvelope<'speak/sent', {
  channel: 'log' | 'notify' | 'reply-url'; chars: number;
  /**
   * 投递到了哪个会话（`log` 路不带：那是本机对话流，没有会话 id）。
   *
   * 与 `text` 一起构成 `read_channel` 认得的那一条凭据：`sid` 说"发到哪儿"、`text` 说"说了什么"。
   * 旧事件只有 `sid`（那时它只用于复盘"她跟谁说过话"）。
   */
  sid?: string;
  /**
   * 这一次发言的**完整文本**（2026-10-04；只有真的发进了某个会话的那一条回执带它）。
   *
   * 为什么非要落在事件里（`read_channel` 的"她自己说过什么"就靠这个字段）：切分是**投递**的
   * 属性，不是内容的属性——一次 `speak` 会被 `chat-split` 切成 N 条气泡，而每段的内容分别在
   * 各自的 `message/assistant` 里、**不带任何会话坐标**。没有这个字段，read_channel 就只能
   * 拿着"本机对话流里的一段话"去猜它发到了哪个会话（`to` 为空时从唤醒派生，逐段对不上）。
   *
   * 为什么挂在 `speak/sent` 上而不是新开一个事件类型：这条回执本来就是"这一跳投递成功了"的
   * 凭据，而它已经带 `sid`（跟谁说过话）——补上"说了什么"是把同一条回执说完整，不是新事实。
   * 新增事件类型要同时动 `AppEvent` 联合、可见性表、fold/重放与 schema 文档，代价大得多，
   * 而语义上并没有多出第二个事实（`sid` 与 `chars` 早在里面了）。
   *
   * **可选**：旧日志没有它——那些发言读不回来（read_channel 只能列"从现在起"的发言），
   * 这不是缺陷，是"日志只增不改"的必然：当年就没记的东西，今天推不出来。
   *
   * 为什么只有**投递成功**的那一条带文本：`channel='log'` 是逐段落的"本机对话流"回执，
   * 它不代表"这话真到了那个会话"（本机那条路永远可用）；`reply-url` 才代表 IM 那一路走通了。
   * 失败/被拒/没接线的发言**不写**它——那种时候"她说出去了"是假的（见 tools/admin.ts）。
   *
   * **待办（本次没做，留给用户定）**：本文件头一行写着"修改事件形状必须先改 schema 文档"，
   * 而 `docs/schema.md` 里 `SpeakSent` 仍停在旧形状——本次按纪律没有动 `docs/`，
   * 下一次碰 schema 文档时要把 `sid?` / `text?` / `spokenParts?` / `turn?` 一并补上。
   */
  text?: string;
  /**
   * 这条完整文本在 IM 上被切成了几条气泡（1 = 一次说完）。
   *
   * 它给 `read_channel` 用：她的发言在那边**不切分**（一行一条，省行数），所以行上必须能
   * 说清"这其实是 N 条"——否则她读回来会以为那三句是自己一口气打出来的。
   */
  spokenParts?: number;
  /**
   * 这是**哪一次工具调用**发的（`tool/call.callId`）。
   *
   * 为什么要有它：`read_channel` 要把"一次 speak = 一行"这条要求落准，而"同一 turn 里说了两段"
   * 与"一段被切成两条气泡"在事件上长得一样。仓库里"一次调用"的本征标识就是 `callId`
   * （与 `tool/call` / `tool/result` 同源），用它归并既准又不用另造一个概念。
   */
  callId?: string;
  /** 产生这次发言的 turn 号（复盘用；旧事件没有） */
  turn?: number;
}> {}

export interface IntentionRaised extends EventEnvelope<'intention/raised', {
  intentionId: string; content: string; triggerAt?: string; condition?: string;
}> {}

export interface IntentionActed extends EventEnvelope<'intention/acted', {
  intentionId: string; turn: number;
}> {}

export interface TodoUpdated extends EventEnvelope<'todo/updated', {
  items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}> {}

export interface JobStarted extends EventEnvelope<'job/started', {
  jobId: string; command: string; turn: number;
}> {}

export interface JobFinished extends EventEnvelope<'job/finished', {
  jobId: string; exitCode: number | null; outputRef?: string;
}> {}

/**
 * 谁在问（design §6「一张卡，三种来源」落在事件层的两种；第三种"引导"走向导，不落这条线）。
 *
 *   · `system` —— 框架自己问的：目前唯一写入方是计划模式的待批准（question 是固定常量）。
 *     它**挂起 turn**（`turn/end{blocked, by:'ask-human'}` → 答复后重入队）。
 *   · `agent` —— **她问的**（`ask_human` 工具）。它**不挂起**（design §6.5：旧实现错在"等"，
 *     不在"问"）：她写完这条就接着做自己的事，人的答复在下一拍的状态里看到。
 *
 * 缺省按 `system` 读——旧日志里唯一的写入方就是计划模式，重放必须还原成当时那个含义。
 */
export type HumanAskSource = 'system' | 'agent';

/** 来源判定（旧事件没有该字段 = 当时的计划模式）：fold / 渲染 / 挂起判定共用这一份，不各写一套 */
export function humanAskSourceOf(data: { source?: HumanAskSource }): HumanAskSource {
  return data.source === 'agent' ? 'agent' : 'system';
}

export interface HumanAsked extends EventEnvelope<'human/asked', {
  question: string; context: string; turn: number;
  /** 见 [HumanAskSource]；缺省 = 'system'（旧事件） */
  source?: HumanAskSource;
}> {}

export interface HumanAnswered extends EventEnvelope<'human/answered', {
  question: string; answer: string; by: string;
  /**
   * 答复的是哪一条 `human/asked`（那条事件的 seq）。
   *
   * 为什么要有它：台面上可能同时摆着她的提问与一条待批准的计划，FIFO 配对会把"人答的那条"
   * 认成另一条（提问文本也不可靠——计划审批的 question 是同一个常量）。给了它就按它精确配对；
   * 旧事件与 CLI 不带它，退回 FIFO（当时的唯一情形就是只有一条挂着）。
   */
  askSeq?: number;
}> {}

/**
 * 她问的人一直没答（design §6.1：**超时不产生决定，只产生事实**）。
 *
 * 这条事件说的是「**未批准、未拒绝**」——不是拒绝，更不是批准：没有任何一方替人做决定。
 * 她把这件事读成"人可能不在机器旁，或没注意到"，**要不要换个方式找人（例如走 QQ）是她自己的
 * 判断**，框架不替她降级成"那就算了"。卡片本身仍然有效：人回来照样能答（会落 human/answered）。
 *
 * 为什么单开一条类型而不是拿 `human/answered` 顶替：那等于往唯一真相源里写"人答过了"这句假话；
 * 也不能写成 `plan/resolved{expired}`——那条是计划审批的簿记（要 callId/指纹），与提问无关。
 */
export interface HumanExpired extends EventEnvelope<'human/expired', {
  /** 超时的是哪一条 human/asked（seq） */
  askSeq: number;
  question: string;
  turn: number;
  source: HumanAskSource;
  /** 从提问到落这条事实等了多久（毫秒）；timeoutMs 是当时的判定线 */
  waitedMs: number;
  timeoutMs: number;
}> {}

/**
 * 计划模式：一件 destructive 调用被挂起等人工批准（design.md §4.21「事前」人审）。
 *
 * 它**不写 tool/call 也不写 tool/result**（与 PreToolUse 钩子拒绝同一纪律：没执行的调用不进
 * 两阶段落库，写进去就是「日志说她试过了」）。项目里三条人审通道的分工：
 *   • `plan/pending` —— 事前：还没动手，等批准；
 *   • `tool/result{unknown}` —— 事后：动过手但结局不明，等定性（needsReview）；
 *   • `human/asked` —— 事中：正在做的过程中需要人给一个只有人知道的信息。
 */
export interface PlanPending extends EventEnvelope<'plan/pending', {
  callId: string;
  tool: string;
  /** 原始 arguments 文本：批准后模型按同一份参数重发，指纹匹配凭它 */
  arguments: string;
  turn: number;
  step: number;
}> {}

/**
 * 计划结案：批准 / 拒绝 / 超时。
 * `approved` 会把指纹写进投影的 planApproved（一次执行许可），该许可在对应工具调用真的
 * 落进 `tool/call` 时被消费掉——批准一次只放行一次，不会变成永久开关。
 */
export interface PlanResolved extends EventEnvelope<'plan/resolved', {
  callId: string;
  tool: string;
  /** 调用指纹（`planFingerprint(tool, arguments)`）：批准后的通行证凭它匹配重发的调用 */
  fingerprint: string;
  outcome: 'approved' | 'rejected' | 'expired';
  by: string;
  note?: string;
}> {}

/** 模型降级链状态变化（internal；投影 degraded 字段的事件源） */
export interface ModelDegraded extends EventEnvelope<'model/degraded', {
  lane: ModelLane; reason: string;
}> {}

export interface ModelRestored extends EventEnvelope<'model/restored', {
  lane: ModelLane;
}> {}

// ──────────────────────────────── 联合类型 ────────────────────────────────

export type AppEvent =
  | SessionStart | SessionEnd
  | TurnStart | TurnEnd | StepStart | StepEnd
  | UserMessage | AssistantMessage | ReasoningMessage | DeveloperMessage
  | ToolCall | ToolResult
  | WakeTimer | WakeFile | WakeWebhook | WakeManual | WakeHeartbeat | WakeIntention | WakeJob | WakeChannel
  | ChannelMessage | ChannelRead | ChannelTopic | InjectionFlagged | InjectionNoted
  | ImageAttached
  | TimerSet | TimerFired | TimerCancelled
  | BudgetConsumed | BudgetRollover | BudgetExhausted | BudgetToppedUp
  | PolicyDenied | AuthzDenied | LogRepaired | InstanceTakeover
  | InputClaimed | InputDeadLetter | InputRequeued | ToolZombie
  | AlarmSent | ReviewResolved | SnapshotCheckpoint | CompactionSummary
  | PersonaUpdated | ConfigChanged | MemoryMaintained
  | McpServerStarted | McpServerStopped | SkillInstalled | HookFired | SpeakSent
  | IntentionRaised | IntentionActed | TodoUpdated
  | JobStarted | JobFinished
  | HumanAsked | HumanAnswered | HumanExpired
  | PlanPending | PlanResolved
  | ModelDegraded | ModelRestored;

export type AppEventType = AppEvent['type'];

/** 事件类型 → 默认可见性（写入时必须显式落定，此表用于校验与渲染分类） */
export const EVENT_VISIBILITY: Record<string, Visibility> = {
  'session/start': 'internal', 'session/end': 'internal',
  'turn/start': 'internal', 'turn/end': 'internal',
  'step/start': 'internal', 'step/end': 'internal',
  'message/user': 'model', 'message/assistant': 'model', 'developer/message': 'model',
  'tool/call': 'model', 'tool/result': 'model',
  'wake/timer': 'model', 'wake/file': 'model', 'wake/webhook': 'model',
  'authz/denied': 'internal',
  'wake/manual': 'model', 'wake/heartbeat': 'model', 'wake/intention': 'model', 'wake/job': 'model',
  'wake/channel': 'model',
  // 通道普通消息与已读位**刻意不进上下文**：QQ 是"手边一个可以点开的软件"而不是推给她的消息流。
  // 它们不写在这里也走 defaultVisibility 的 internal，写出来是为了让"这条线是有意画的"看得见
  // ——她通过未读计数知晓它存在，想看就用 read_channel 现取（README/review v32 记了这次取舍）。
  'channel/message': 'internal', 'channel/read': 'internal', 'channel/topic': 'internal',
  // 注入预警同样 internal：它不是给她的输入，而是**贴在**那条外部消息旁边的一句框架话
  // （渲染时按 messageId 关联，见 model/render.ts 的 renderExternalEvent）
  'injection/flagged': 'internal',
  // 「示警已发生」同理：那句话贴在那条消息旁边，GUI 与此刻层历史只是引用它
  'injection/noted': 'internal',
  // 她自己要求放进来的图：与 wake/channel 的附件同一条出口（渲染层注入 input_image）
  'image/attached': 'model',
  'human/asked': 'model', 'human/answered': 'model',
  // 超时事实同样进上下文：她必须**得知**"人可能不在机器旁、或没注意到"才能自己决定下一步
  // （design §6.1：换个方式找人是她的判断）。写成 internal 等于让这件事只留在日志里，
  // 她下一拍还是以为自己在等人回话——那正是 §6.5 禁止的那种"等"。
  'human/expired': 'model',
  // 计划模式的两次落库都是簿记：可见语义由同批 human/asked（事前提问）与 human/answered
  // （人的答复）承载，plan/* 再进一遍上下文只是同一件事被渲染两次
  'plan/pending': 'internal', 'plan/resolved': 'internal',
  'review/resolved': 'model',
  'compaction/summary': 'model',
  'policy/denied': 'model',
  // 整理留痕只在日志与前端，不进上下文（记忆的秩序由机制保证，不必每轮提醒她一遍）
  'memory/maintained': 'internal',
  // 其余全部 internal
};

export function defaultVisibility(type: string): Visibility {
  return EVENT_VISIBILITY[type] ?? 'internal';
}

// ──────────────────────────────── 归属判定 ────────────────────────────────

/**
 * 顶层事件判定（design §4.21 隔离三件套之二/三）。
 *
 * 子代理链的事件带 `parentCallId`（指向父 turn 里那次 `task` 调用），它们是**另一条 turn 链**：
 * 父层的渲染、状态机与请求重建都不该看见它们——否则父模型会看到"自己"没说过的话、自己没发起的
 * 工具调用，上下文隔离就成了单向的（子代理看不见父，父却看得见子的内脏）。
 *
 * 反向的过滤（子代理只看自己链）由 `childEventFilter` 提供，两处共用这一份判定口径，
 * 避免"运行期一套、重建一套"的漂移。
 */
export function isTopLevelEvent(event: { parentCallId?: string }): boolean {
  return event.parentCallId === undefined;
}

/**
 * 调用指纹：`tool` + 规范化后的 arguments。计划模式的通行证用它匹配「重发的同一个调用」。
 *
 * 规范化 = 解析 JSON 后按键排序重新序列化，于是纯粹的空白/键序差异不会让同一件调用
 * 被认成两件。解析失败退回 trim 后的原文：**批准的判定不能因为参数格式而漂移**，
 * 而一份连 JSON 都解析不出的 arguments 照样要以原样文本参与匹配（它本来就执行不了，
 * 指纹只是把它与批准记录对上）。
 */
export function planFingerprint(tool: string, args: string): string {
  return `${tool} ${canonicalizeArgs(args)}`;
}

function canonicalizeArgs(args: string): string {
  const text = args.trim();
  if (text === '') return '{}';
  try {
    return JSON.stringify(sortKeys(JSON.parse(text) as unknown)) ?? text;
  } catch {
    return text;
  }
}

/** 递归按键排序：数组保序（顺序是语义），对象排序（键序不是语义） */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}

// ──────────────────────────────── 投影 ────────────────────────────────

export interface PendingInput {
  /** 产生它的 wake 事件 seq（内容从日志取） */
  wakeSeq: number;
  source: WakeSource;
  /** 认领次数，interrupted 退回时 +1，达到 3 进死信 */
  claimCount: number;
  dedupeKey?: string;
}

export interface OpenToolCall {
  callId: string; name: string; sideEffect: SideEffect; callSeq: number;
}

export interface ReviewItem { callId: string; name: string; at: string }

/** 计划模式待批准项（plan/pending 折叠；与 needsReview 并列的另一条人审队列） */
export interface PlanReviewItem {
  callId: string;
  tool: string;
  /** 原始 arguments 文本（批准后按它重算指纹） */
  arguments: string;
  turn: number;
  step: number;
  at: string;
}

/** 计划模式已批准、尚未落地的执行许可（plan/resolved{approved} 折叠，tool/call 消费） */
export interface PlanApproval {
  fingerprint: string;
  tool: string;
  callId: string;
  at: string;
}

/** 台面上一条没答复的人类提问（`human/asked` 折叠；出队只看 human/answered） */
export interface HumanAskEntry {
  /** 那条 `human/asked` 的 seq：答复与超时都按它配对，不靠 FIFO 猜 */
  seq: number;
  source: HumanAskSource;
  question: string;
  context: string;
  turn: number;
  at: string;
  /**
   * 落下「未批准、未拒绝」事实的时刻（`human/expired`）；null = 还没到超时线。
   *
   * 它**不把这条提问移出队列**：超时不是决定，人回来照样能答（§6.1）。
   */
  expiredAt: string | null;
}

export interface TimerEntry {
  timerId: string;
  at?: string;
  cron?: string;
  payload: unknown;
}

export interface Projection {
  lastSeq: number;
  /** 投递水位：连续已处理到的位置。推进时跳过空洞 */
  watermark: number;
  /** 待处理输入队列 */
  pending: PendingInput[];
  /** 当前打开的 turn，null 表示空闲 */
  openTurn: { turn: number; step: number } | null;
  /** 有 tool/call 无 tool/result 的调用 */
  openTools: OpenToolCall[];
  /** 待人工确认的调用（status: unknown） */
  needsReview: ReviewItem[];
  /**
   * 计划模式待批准的调用（design §4.21）。与 needsReview **刻意分开**：
   * 那条队列的语义是「动过手、结局不明」（不变量 I6 按 `tool/result{unknown}` 逐条校验），
   * 混进来会让「事前」与「事后」两种人审在同一队列里失去区分。
   */
  planPending: PlanReviewItem[];
  /** 已批准但尚未落地的执行许可（指纹匹配，tool/call 落库即消费） */
  planApproved: PlanApproval[];
  budget: {
    /**
     * 最近一次 `budget/rollover` 记的是哪一天（`YYYY-MM-DD`，没有则 null）。
     *
     * 存在的理由是一次实测事故：运行时原来只拿**进程内存**里的 `lastRolloverDate` 去重，
     * 而那个字段每次启动都是 null，于是**每启动一次就写一条 rollover**、把当日计数清零一次。
     * 表现是运行情况页的「今日 token」老是 0、缓存命中率显示 `-`（0/0），
     * 而同一页的 hourly 曲线（从事件重算）一切正常——重启三次就归零三次。
     * 记账边界是**事实**，事实以日志为准：折进投影里，运行时读它。
     */
    date: string | null;
    tokensToday: number;
    tokensTodayHeavy: number;
    tokensTodayLight: number;
    cacheHitToday: number;
    cacheMissToday: number;
    tokensTask: number;
    stepsThisTurn: number;
    toolCallsThisStep: number;
  };
  timers: TimerEntry[];
  /** turn → 该 turn 认领的 wakeSeq 列表（input/claimed 折叠；恢复流程据此退回输入） */
  claimedByTurn: Record<number, number[]>;
  /** 意图簿（INTENTIONS.md 的事件镜像；到期判定由调度器读时钟做，fold 只折叠） */
  intentions: Array<{ intentionId: string; content: string; triggerAt?: string; condition?: string }>;
  /** 任务内计划清单（todo/updated 折叠） */
  todoList: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** 运行中的后台任务 */
  jobs: Record<string, { command: string; turn: number; startedAt: string }>;
  /**
   * 台面上还没答复的人类提问，**FIFO**（design §6.3：一次只一张，其余排队）。
   *
   * 它同时装两种来源（见 [HumanAskSource]）：界面只弹队首那一张，答掉/超时之后下一张才浮上来。
   * 「答没答」「超没超时」都只认事件：`human/answered{askSeq}` 出队、`human/expired{askSeq}` 只做
   * 标记**不出队**（超时不产生决定，卡仍然有效——§6.1）。
   */
  humanAsks: HumanAskEntry[];
  /** 执行中挂起等待人答（`human/asked` 未 paired）——**只认系统来源**（计划批准那种挂起） */
  waitingHuman: { question: string; turn: number; at: string } | null;
  /** 各层最近一次 budget/exhausted（paused 派生：存在且无后续 topped-up） */
  lastExhausted: Partial<Record<BudgetLayer, { at: string; limit: number; actual: number }>>;
  /** dedupe 窗口：最近 1000 个 wake 幂等键（FIFO 淘汰） */
  dedupeKeys: string[];
  /** 最后一次成功的模型调用，用于判断水位是否停滞 */
  lastModelSuccessAt: string | null;
  /** 首事件时刻：总览页"已守护 N 天"的基准 */
  firstEventAt: string | null;
  /** 连续模型失败数 */
  failStreak: number;
  /** 模型降级链状态：非 null 表示正在降级运行 */
  degraded: { lane: ModelLane; since: string; reason: string } | null;
  /** 心跳连续空拍数 */
  idleTicks: number;
  /** 最近一次唤醒 */
  lastWake: { source: WakeSource; at: string } | null;
  /** 最近一条 assistant 发言截断（前 80 字符） */
  lastAssistantText: string | null;
  /** 最近一条 assistant 发言的时刻（压力计算用，取自事件 ts） */
  lastAssistantAt: string | null;
  /** 死信队列 */
  deadLetters: Array<{ inputSeq: number; claimCount: number; at: string }>;
  /** 最近一次日志归档/备份时刻 */
  lastArchiveAt: string | null;
  /** 压力值（0-1）：心跳退避调制 */
  pressure: number;
}

export function emptyProjection(): Projection {
  return {
    lastSeq: 0,
    watermark: 0,
    pending: [],
    openTurn: null,
    openTools: [],
    needsReview: [],
    planPending: [],
    planApproved: [],
    budget: {
      tokensToday: 0, tokensTodayHeavy: 0, tokensTodayLight: 0,
    date: null,
      cacheHitToday: 0, cacheMissToday: 0,
      tokensTask: 0, stepsThisTurn: 0, toolCallsThisStep: 0,
    },
    timers: [],
    claimedByTurn: {},
    intentions: [],
    todoList: [],
    jobs: {},
    humanAsks: [],
    waitingHuman: null,
    lastExhausted: {},
    dedupeKeys: [],
    lastModelSuccessAt: null,
    firstEventAt: null,
    failStreak: 0,
    degraded: null,
    idleTicks: 0,
    lastWake: null,
    lastAssistantText: null,
    lastAssistantAt: null,
    deadLetters: [],
    lastArchiveAt: null,
    pressure: 0.05,
  };
}

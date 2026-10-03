/**
 * Irmia Agent — 循环引擎（turn / step 双层，M2 核心整合件）
 *
 * 依据：docs/design.md §4.4（循环引擎伪码与 TurnEndReason 枚举）、§4.6（软/硬双阈值）、
 * §4.11（沉默是正常动作）、§4.13（render 协同与五条缓存铁律）、
 * docs/schema.md §2 / §3 / §6 / §12 / §13。
 *
 * 职责范围：从「一批已落库的唤醒输入」走到「一个结构化的 turn 结局」。它自己不做的事：
 * 调度（何时唤醒）、刹车（阈值判定）、工具实现、恢复补偿（runtime/recover.ts）。
 *
 * 三条必须守住的语义：
 * 1. **日志是唯一真相源**：本文件不持有任何权威状态。投影只是日志的折叠结果，
 *    写入一律「先 append（承诺类 fsync）→ 再 applyOne」，与 runtime/loop.ts 同一条纪律。
 * 2. **两条写入节奏**（§4.1）：承诺类（turn/start、input/claimed、message/*、tool/*、
 *    step/*、turn/end）逐条 fsync；观测类（budget/consumed、tool/zombie）进缓冲，
 *    在 step 边界 flush()。承诺类丢一条就是「现实变了但日志没有」。
 * 3. **请求可重建**（M2-2）：step 内 `now` 只取一次，step/start 的 ts 与渲染用的 now
 *    是同一个值。重建请求 = 取「seq < step/start.seq 的事件」+ 该 step 认领的首条 wake
 *    + step/start.ts 作为 now，交给 deriveRequest()——与运行期走同一份派生代码。
 *
 * 与 render 的两条协同契约（不写清就会踩缓存铁律）：
 * - `events` 参数**不含**本轮作为 `wakeEvent` 传入的那条事件。否则同一输入被渲染两次
 *   （事件流一次 + 尾部新输入一次），且相邻两步的请求不再构成前缀关系，KV cache 全 miss。
 * - `wakeEvent` 只在 turn 的首 step 传。后续 step 的 wake 事件已在事件流里按 seq 渲染。
 *
 * 一批多条唤醒输入的取舍：render 每轮只接受一个 `wakeEvent`，所以只有批内首条走参数通道，
 * 其余仍留在事件流里按 seq 渲染——信息不丢，代价是首步的输入顺序与日志顺序不完全一致。
 * 单条唤醒（定时器、CLI 注入、webhook 的主流形态）不受影响，前缀关系完好。
 *
 * 对给定接口的构造性补充（全部可选，默认值即安全默认）：
 * - `lane` / `modelVisibility` / `workspaceRoot` / `signal` / `isolation`：
 *   executeToolCalls 必须拿到 workspaceRoot 与（可选的）隔离配置，模型请求必须知道 lane，
 *   外部取消（shutdown）必须能从循环外传进来。缺了它们，本模块无法被真实宿主装配。
 *
 * M2 明确留到后续的边界（都在此声明，避免"看着像做完了"）：
 * - 软阈值提示（§4.6）只做尾部插播，**不落库**：因此带软提示的那一次请求不可逐字节重建。
 *   M3 落地预算时才有正式记录通道。不带软提示的请求（默认路径）严格可重建。
 *   Hook 的附加上下文（§4.19）走同一条尾部通道（两者合并成一条 developer 消息），
 *   因此同样属于「不可逐字节重建」的那一类：注入内容是执行期事实，不进日志正文。
 * - 撞刹车时本模块只返回结局，不写 `budget/exhausted`——limit/actual 属于预算实现，
 *   循环层凭空填数字就是伪造事实（M3 的 budget 钩子写它）。
 * - 大工具结果外置 blob（§4.12）已接：`blobOffload` 配上后，超阈值的结果先写
 *   `data/blobs/`（内容寻址），事件的 content 只留头部预览 + `contentRef`。
 *   不配则全文入日志（默认口径，M2 的最小宿主行为不变）。
 * - 事件快照按 render 的契约持有全量事件；长日志下的内存有界化（快照起点 + 分片）
 *   与上下文压缩（§4.13 遮蔽点）同批做，M2 不做。
 * - `budget/consumed.retryCount` 恒为 0：成功路径没有重试计数通道（DsClient 只把 attempts
 *   挂在外抛错误上），M3 接 onRetry 回填。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import type { DsClient, DsRequest, DsStreamResult } from '../model/ds-client.js';
import { isDsClientError } from '../model/ds-client.ts';
import type { MachineFacts, RenderImageRef, RenderPersona, RenderedRequest, UsageFacts } from '../model/render.js';
import { RENDER_VERSION, clipTaskTitle, render, renderWake, wakeTitle } from '../model/render.ts';
import type { ContactFacts } from '../model/self-brief.ts';
import { renderMentionNote } from '../model/self-brief.ts';
import { sidOf } from '../channel/sessions.ts';
import type { EventLog } from '../log/event-log.js';
import type {
  AppEvent, AppEventType, ModelLane, Projection, TurnEndReason, WakeSource,
} from '../log/types.js';
import { defaultVisibility } from '../log/types.ts';
import {
  DEFAULT_HANDOFF_BUDGET_TOKENS, DEFAULT_HANDOFF_FOLD_TOKENS,
  estimateHistoryTokens, renderHandoffNote, type HandoffOptions,
} from '../persona/handoff-note.ts';
import { applyOne, wakeSourceOf } from '../state/fold.ts';
// 毒消息保护的阈值与崩溃恢复共用一处：同一条输入反复认领仍没跑完就进死信
//（recover.ts 的 settleClaimedInputs 也用它）——两处各写一个数，迟早会分岔。
import { MAX_CLAIM_COUNT } from './recover.ts';
import { offloadIfLarge, type BlobOffloadOptions } from '../state/blob-store.ts';
import type {
  ExecutionContext, IsolationConfig, ToolCallRequest, ToolExecutionResult, ToolPlanGate,
} from '../tools/executor.js';
import { executeToolCalls } from '../tools/executor.ts';
import { notedWarningsOf } from '../channel/injection.ts';
import { ASK_HUMAN_BLOCKED_BY, hasPendingSystemAsk, pendingAgentAsks } from './plan-mode.ts';
import type { ListForModelOptions, ToolDefinition } from '../tools/registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookRunner } from '../hook/hooks.js';

// ──────────────────────────────── 常量 ────────────────────────────────

const ORIGIN = 'runtime/agent-loop';

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 人格资产：渲染需要的三常驻层 + 状态层，外加进 step/start 的指纹 */
export interface AgentLoopPersona {
  identity: string;
  constitution: string;
  style: string;
  state: string;
  /** 人格资产内容哈希（step/start 留档；重放时据此取对应版本） */
  personaHash: string;
  /** 情景档案：唤醒路由命中时注入 */
  relationship?: { who: string; content: string } | null;
}

/** 刹车钩子（M3 实现于 runtime/budget-guard.ts，循环层只调用） */
export interface AgentLoopBudget {
  /** step 边界判定：返回非 null 即结束本 turn（结局原样落 turn/end） */
  checkBeforeStep: (projection: Projection) => TurnEndReason | null;
  /** 软阈值提示（§4.6）：非空则作为尾部 developer 消息插播到本次请求末尾 */
  softHint?: (projection: Projection) => string | null;
  /** 单步工具调用数上限（§4.6 单 step 层）；不传即不限制 */
  stepCallLimit?: () => number;
  /**
   * 单步超限时的结局：预算实现写 budget/exhausted 并给出 reason。
   * 不传时循环层只做收束、返回 budget-exhausted(step)，不凭空写预算事件。
   */
  onStepOverflow?: (actual: number) => TurnEndReason;
}

export interface AgentLoopDeps {
  /** 事件写入：本模块所有落库都经它（承诺类 sync: true） */
  log: EventLog;
  /** 模型客户端 */
  ds: DsClient;
  /** 工具注册表：listForModel 供给请求，executionMode/sideEffect 供给执行器 */
  registry: ToolRegistry;
  /** 运行期投影：每条新事件写入后立即 applyOne 维护 */
  projection: Projection;
  persona: AgentLoopPersona;
  /** 时钟注入（运行期允许读时钟；fold 与 render 都不读） */
  now: () => string;
  /** 时区标识，进状态层时间上下文 */
  timezone: string;
  /** 刹车钩子；不传即无刹车（M2 的默认口径） */
  budget?: AgentLoopBudget;
  /**
   * 回复必要性门（§4.11 沉默是正常动作）。返回 false 则沉默收尾，不发起模型调用。
   *
   * 第二个参数是**本批唤醒事件**：门需要它来分类（只有心跳批次才值得过门，真实事件
   * 不该被规则层替她闭嘴）。它是一个**可选形参**，所以只声明一个形参的门实现
   * （nullary / unary）照常相容，历史装配点不需要改动。
   */
  necessityGate?: (wakeText: string, wakeEvents?: readonly AppEvent[]) => Promise<boolean>;
  /** 主循环 lane（§4.12 任务-模型两级路由），默认 heavy */
  lane?: ModelLane;
  /** 文件类工具的路径白名单根；默认 process.cwd() */
  workspaceRoot?: string;
  /** 外部取消（shutdown）：透传给模型请求与工具执行 */
  signal?: AbortSignal;
  /**
   * 「有人插话」计数读取器：返回一个**只增不减**的计数，本 turn 里人每开口一次加一。
   *
   * 为什么不是 AbortSignal：信号一旦触发就永远是触发态，而她一轮里可能说好几次话——
   * 实测后果是打断一次之后，这一轮剩下的每一次 speak 都被判成"又被打断"。
   * 计数让"重新组织语言再开口"成为可能：新的一次发言取新基准，只有基准之后**又来**了
   * 插话才算被打断。目前只有 `speak` 消费它。
   */
  interruptEpoch?: () => number;
  /** 进模型清单的工具口径；默认 {}，即 destructive 工具默认不列（§4.10 第三级门） */
  modelVisibility?: ListForModelOptions;
  /** 子进程隔离配置，原样透传给执行器（不响应中断的工具走隔离，超时即杀） */
  isolation?: IsolationConfig;
  /**
   * 大结果外置（design §4.12 磁盘经济学、schema §4 的 contentRef）：配上即开启，
   * 不配即全文入日志（M2 口径——最小宿主与单元测试不需要 blob 目录）。
   * 判定与写入在 state/blob-store.ts，这里只负责"先落 blob、再写事件"的顺序。
   */
  blobOffload?: BlobOffloadOptions;
  /** 压缩触发（M5 临时口径，persona.md §4 / design.md §4.13）；不传即不压缩 */
  compaction?: AgentLoopCompaction;
  /**
   * 技能 catalog 文本（design §4.19 渐进披露第 1 层）。缺省/null 表示没有可用技能，
   * 状态层该段整体不出现；SKILL.md 正文永不在此——模型按需自己 safe_read（M7-4）。
   */
  skillCatalog?: string | null;
  /**
   * 此刻的联络事实（design §4.13 状态层素材，见 model/self-brief.ts）：启用了哪些通道、
   * 告警出口在不在、本轮能不能把话发回唤醒来源。不配即该段整体不出现——
   * 子代理就属于这种情形：发言是主循环的事，它不需要知道往哪儿发。
   */
  contact?: ContactFacts | null;
  /**
   * 本机事实（此刻层 `本机：` 一行的素材，见 MachineFacts）：磁盘余量、进程已运行多久、工作根。
   *
   * 由**宿主**算好（real-loop 读 os/fs 一次），循环层只转手——渲染层不读环境值，这是与
   * `contact` / `skillCatalog` 同一条纪律。不配即该行写"未知"（子代理、重放、诊断都是这种情形）。
   */
  machine?: MachineFacts | null;
  /** 用度事实（此刻层 `用度：` 一行的素材，见 UsageFacts）：投影折叠结论 + 生效日上限。不配即"未知" */
  usage?: UsageFacts | null;
  /**
   * 图片取字节的能力（design §4.20 图片两条途径）：给了它，带图的消息才会把
   * `input_image` 放进请求——QQ 发来的图片因此"直接进上下文"，而不是只留一条地址。
   *
   * 由宿主注入（real-loop 用 channel/attachment-store 的 readAttachmentDataUrl）。
   * 不配 = 一条图片都不进上下文，只剩文字与 `vision_read` 的转述：子代理与重放就是这种情形。
   */
  loadImage?: ((ref: RenderImageRef) => string | null) | null;
  /** 最多几张图片进上下文（默认 IMAGE_INJECT_MAX = 2；0 = 关掉图片直通） */
  maxContextImages?: number;
  /**
   * 执行点钩子（design §4.19）：Wake 点在唤醒注入，PreToolUse/PostToolUse 由执行器调用。
   * 不配即无钩子，行为与 M2 完全一致。
   */
  hooks?: HookRunner;
  /**
   * 上下文隔离（design §4.21 子代理）：只有通过过滤的事件才进本 turn 的渲染快照。
   * 子代理用它把父历史与外部事件挡在请求之外——过滤之后事件流就是「从空事件序列起」的那一份，
   * 与「换一个 scoped 日志句柄」相比，它不动日志本身的语义（seq 分配与 append 仍是全局单一）。
   * 不传即全部可见：顶层 turn 的默认口径，与未引入子代理时逐字节一致。
   */
  eventFilter?: (event: AppEvent) => boolean;
  /**
   * 子代理 turn 链归属标记（schema §1 `parentCallId`）：本 TurnRunner 写下的每条事件都带上它。
   * 顶层不传 → 事件里不出现该字段（零成本保持既有事件形状与字节序）。
   */
  parentCallId?: string;
  /**
   * turn 号下限（schema §2 编号规则）。子代理在隔离的事件视图里跑，`maxTurn()` 看不见主日志里
   * 已有的 turn；不给下限，子代理就会从 1 重新开始编号，与主日志重号——而 `replay <turn>`、
   * 恢复期的认领退回都按 turn 定位。给了它，子代理的 turn 与主日志全局唯一。
   */
  turnBase?: number;
  /**
   * 事件落库观察口（每条事件 append 之后、折进投影之后调用一次）。
   * 子代理用它把「属于自己链的事件」同步折进父投影的记账口径（预算消耗必须立刻被父的刹车看见），
   * 与「重启后 fold 全量重建」的结论保持同一份事实。
   */
  onEvent?: (event: AppEvent) => void;
  /**
   * 计划模式门（design §4.21）：destructive 调用在两阶段落库之前被拦下等人工批准，
   * 被拦的调用没有 tool/call、没有 tool/result，只有 plan/pending 与 human/asked。
   * 不配即无计划模式，行为与没这个机制时完全一致。
   */
  planGate?: ToolPlanGate;
}

/**
 * 压缩触发配置：`thresholdTokens` 是可见历史估算阈值，其余字段原样交给交接笔记算法。
 * M5 的临时口径是「turn 结束 + 历史超过阈值」；真实的 token 计数与预算归账仍由预算层负责。
 */
export type AgentLoopCompaction = HandoffOptions & { thresholdTokens: number };

// ──────────────────────────────── 请求派生（M2-2） ────────────────────────────────

/**
 * 请求派生输入。全部字段都能从日志 + 人格资产取回：
 * `now` 取该 step 的 `step/start.ts`，`events` 取 seq 小于该 step/start 的日志快照，
 * `wakeEvent` 取该 turn 认领的首条输入（仅首 step）。
 */
export interface RequestDerivation {
  persona: AgentLoopPersona;
  /** 进模型清单的工具（registry.listForModel 的结果） */
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  timezone: string;
  lane: ModelLane;
  events: readonly AppEvent[];
  /** 本轮新输入；必须不在 events 里（见文件头协同契约） */
  wakeEvent: AppEvent | null;
  taskCard: { title: string; turn: number; step: number; todoOpen: readonly string[] } | null;
  now: string;
  model: string;
  /** 软阈值提示：尾部插播，不落库（见文件头 M2 边界） */
  softHint?: string | null;
  /** 技能 catalog（状态层素材，见 AgentLoopDeps.skillCatalog） */
  skillCatalog?: string | null;
  /** 联络事实（状态层素材，见 AgentLoopDeps.contact） */
  contact?: ContactFacts | null;
  /** 本机事实（此刻层 `本机：` 素材，见 AgentLoopDeps.machine）：宿主算好，循环层只转手 */
  machine?: MachineFacts | null;
  /** 用度事实（此刻层 `用度：` 素材，见 AgentLoopDeps.usage）：投影 + 生效上限，宿主算好 */
  usage?: UsageFacts | null;
  /**
   * 图片取字节的能力（宿主注入，见 AgentLoopDeps.loadImage）：给了它，带图的消息才会
   * 把 `input_image` 真的放进请求。缺省 = 只渲染文字（重放与诊断场景常常没有它）。
   */
  loadImage?: ((ref: RenderImageRef) => string | null) | null;
  /** 最多几张图片进上下文（见 RenderInput.maxContextImages） */
  maxContextImages?: number;
}

/**
 * 从「日志快照 + 位置」算出模型请求。运行期与事后重建走同一份代码，
 * 所以「同一批事件渲染出同一字节串」这件事是可执行的断言，而不是承诺。
 */
/**
 * 本轮输入是不是"群里有人提到了你"——是的话给出那句**框架通知**（正文不进她的上下文）。
 *
 * 用户 2026-10-02 的设计：「被卡片 wake，只知道群有人提及，不知道说了什么，然后点进去看了话题，
 * 才回话……这才是正确的设计」。所以：
 *   • 文案**复用 `renderMentionNote`**（此刻层「点名：」用的同一份）——一处措辞，两处出现
 *     会立刻分岔，而"谁在哪个群叫了你、那边在聊什么、不看也不会丢"这几句是设计口径；
 *   • 只在**群里**成立（私聊本来就该直接看到话），判据是 `contact.wakeMessage` 的
 *     `chatType !== 'c2c'` 加上"平台 @ 或关键词命中"（与此刻层一致）；
 *   • 判过注入的那条**不换**（`render` 侧按 note 判）：那种消息她必须亲眼看原话。
 */
function mentionNoticeOf(
  contact: ContactFacts | null,
  wakeEvent: AppEvent | null,
): { messageId: string; text: string } | null {
  if (contact === null || wakeEvent === null || wakeEvent.type !== 'wake/channel') return null;
  const text = (renderMentionNote(contact) ?? '').trim();
  if (text === '') return null;
  return { messageId: wakeEvent.data.messageId, text };
}

/**
 * 给联络事实补上"叫她的那一条是什么时候到的"（本机时间，'15:16'）。
 *
 * 渲染层不格式化时间（时区是配置事实），宿主这里算好；重放走同一条路，所以重建得回来。
 */
function contactWithWakeStamp(
  contact: ContactFacts | null,
  wakeEvent: AppEvent | null,
  timezone: string,
): ContactFacts | null {
  if (contact === null || contact.wakeMessage === undefined || contact.wakeMessage === null) return contact;
  if (wakeEvent === null || wakeEvent.type !== 'wake/channel') return contact;
  if (contact.wakeMessage.atLabel !== undefined && contact.wakeMessage.isNew !== undefined) return contact;
  // **叫她的这一条她自己看过没有**：未读只数 `channel/message`，而叫醒她的是 `wake/channel`
  // ——它压根不计入未读，所以"未读 0"绝不等于"没有新的叫"（2026-10-02 实测：她把新的提及当成
  // 了上一轮那条旧消息，选择不回复）。判据与未读同源：msgSeq 落在她已读位之后。
  const entry = (contact.sessions ?? []).find((item) =>
    item.sid === sidOf(wakeEvent.data.channel, wakeEvent.data.chatType, wakeEvent.data.chatId));
  const isNew = entry === undefined ? undefined : wakeEvent.data.msgSeq > entry.readUpToSeq;
  const ms = Date.parse(wakeEvent.ts);
  if (!Number.isFinite(ms)) {
    return isNew === undefined
      ? contact
      : { ...contact, wakeMessage: { ...contact.wakeMessage, isNew } };
  }
  let atLabel = '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    atLabel = `${get('hour')}:${get('minute')}`;
  } catch {
    return isNew === undefined
      ? contact
      : { ...contact, wakeMessage: { ...contact.wakeMessage, isNew } };
  }
  return { ...contact, wakeMessage: { ...contact.wakeMessage, atLabel, ...(isNew === undefined ? {} : { isNew }) } };
}

export function deriveRequest(input: RequestDerivation): RenderedRequest {  const persona: RenderPersona = {
    identity: input.persona.identity,
    constitution: input.persona.constitution,
    style: input.persona.style,
    state: input.persona.state,
    relationship: input.persona.relationship ?? null,
  };
  const rendered = render({
    events: [...input.events],
    persona,
    tools: input.tools,
    wakeEvent: input.wakeEvent,
    taskCard: input.taskCard === null
      ? null
      : {
        title: input.taskCard.title,
        turn: input.taskCard.turn,
        step: input.taskCard.step,
        todoOpen: [...input.taskCard.todoOpen],
      },
    now: input.now,
    timezone: input.timezone,
    model: input.model,
    lane: input.lane,
    // 技能索引：与 events/persona 并列的渲染输入，重放走同一份 deriveRequest 才不会漂移
    skillCatalog: input.skillCatalog ?? null,
    contact: contactWithWakeStamp(input.contact ?? null, input.wakeEvent, input.timezone),
    // 本机与用度：与 contact 同一条纪律——**渲染层不读环境值**，所以磁盘余量、进程已运行多久、
    // 今日用量这些只能由拿得到 os/fs/投影的调用方算好递进来；缺省（重放、子代理、诊断）时
    // 此刻层那两行写"未知"，不抛也不编。
    machine: input.machine ?? null,
    usage: input.usage ?? null,
    // 她问出去、还没答复的提问（design §6）：此刻层那段小结的素材。**在这里算**（不放进
    // render）：渲染层不扫日志，而"哪几条还没被 human/answered 配对"只有事件算得出来；
    // 放这里还让 replay 白拿同一份结论——重建与当时逐字节一致靠的就是这一点。
    asks: pendingAgentAsks(input.events).map(ask => ({
      question: ask.question,
      askedAt: ask.at,
      turn: ask.turn,
      expiredAt: ask.expiredAt,
    })),
    // 最近 24 小时被示过警的人（此刻层 `预警：` 那段历史）：同样在这里从事件算——渲染层不扫日志，
    // 而"框架提醒过她几次"是跨多轮的事实，只有拿得到事件的人算得出来。replay 走同一个函数，
    // 所以重建出来的这一段与当时逐字节一致（与 `machine`/`usage` 那种瞬时值不同）。
    injection: notedWarningsOf(input.events, Date.parse(input.now)),
    // 群里"有人提到了你"那一轮：本轮输入换成**框架通知**（正文她自己 read_channel 取）。
    // 在这里算，与 `asks`/`injection` 同一条纪律：渲染层不读 contact、也不扫日志，
    // 而"这一轮是不是被点名"只有拿得到 contact 的人知道——replay 走同一个函数，所以重建得回来。
    mentionNotice: mentionNoticeOf(contactWithWakeStamp(input.contact ?? null, input.wakeEvent, input.timezone), input.wakeEvent),
    // 图片：渲染层拿不到字节，靠注入的 loader 换 data URL（重放时常常没有 loader，
    // 那条历史就退化成文字——这是有意的：重放要的是"当时说了什么"，不是把图再传一遍）
    loadImage: input.loadImage ?? null,
    ...(input.maxContextImages === undefined ? {} : { maxContextImages: input.maxContextImages }),
  });

  // 铁律 2「只追加」：软提示是尾部新 developer 消息，绝不改动已渲染历史（否则摧毁 KV 前缀）
  const hint = input.softHint ?? null;
  if (hint !== null && hint !== '') {
    rendered.input.push({ type: 'message', role: 'developer', content: hint });
  }
  return rendered;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

/**
 * 跑一个 turn：认领一批输入 → step 循环（模型 → 工具）→ 返回结构化结局。
 *
 * 契约：`wakeEvents` 必须**已写入日志**（seq 有效）并由调用方折进投影——本模块不替调用方
 * 分配 seq，也不会重写它们。已在本 turn 之前被认领的输入不在队列里，认领次数按投影取。
 */
export async function runTurn(deps: AgentLoopDeps, wakeEvents: readonly AppEvent[]): Promise<TurnEndReason> {
  const runner = new TurnRunner(deps, wakeEvents);
  return runner.run();
}

// ──────────────────────────────── 实现 ────────────────────────────────

class TurnRunner {
  private readonly deps: AgentLoopDeps;
  private readonly wakeEvents: AppEvent[];
  private readonly log: EventLog;
  private readonly projection: Projection;
  private readonly lane: ModelLane;
  private readonly workspaceRoot: string;
  /** 日志快照：render 的唯一事件来源，每个 step 前与日志增量对齐 */
  private readonly events: AppEvent[] = [];
  private turn = 0;
  private step = 0;
  private spoke = false;
  /** 本 turn 的 turn/start 事件 seq：压缩事件（compaction/summary）的闸蔽点 */
  private turnStartSeq = 0;
  /**
   * 本 turn 认领过的输入 → **认领当时**的累计次数（`input/claimed.claimCounts[i]` 那个值）。
   *
   * 为什么要留一份：整轮失败时要把它们退回去，而退回要写"下一次的认领次数"——投影的 pending
   * 里已经没有它们了（认领即从 pending 删除），所以只能在认领那一刻记下来。
   */
  private readonly claimedCounts = new Map<number, number>();
  /** 本 turn 中途插进来、已经被送进某一份请求的唤醒 seq（避免重复落账，见 claimDeliveredInputs） */
  private readonly claimedMidTurn = new Set<number>();
  /**
   * 钩子产生、尚未注入的附加上下文（design §4.19 第 4 条）。
   * 与软阈值提示同一条尾部 developer 通道：只追加，不改已渲染历史。
   */
  private readonly hookContext: string[] = [];

  constructor(deps: AgentLoopDeps, wakeEvents: readonly AppEvent[]) {
    this.deps = deps;
    this.wakeEvents = dedupeBySeq(wakeEvents);
    this.log = deps.log;
    this.projection = deps.projection;
    this.lane = deps.lane ?? 'heavy';
    this.workspaceRoot = deps.workspaceRoot ?? process.cwd();
  }

  async run(): Promise<TurnEndReason> {
    const reason = await this.runInner();
    // 压缩点：本 turn 已结算，但可见历史仍然超过阈值——把交接笔记写成 compaction/summary，
    // 让它成为下一轮请求里的「早期历史」（闸蔽点后的事件逐字节保留）
    await this.maybeCompact();
    return reason;
  }

  private async runInner(): Promise<TurnEndReason> {
    await this.syncEvents();
    // turn 号 = 日志中已出现的最大 turn + 1（§2 编号规则），绝不回退复用旧号。
    // 子代理的事件视图是隔离的（看不见主日志已有的 turn），全局下限由 turnBase 给出。
    this.turn = Math.max(this.maxTurn(), this.deps.turnBase ?? 0) + 1;
    const start = this.write('turn/start', { turn: this.turn }, { sync: true });
    // 压缩的闸蔽点就用本 turn 的起始 seq（§4.13：闸蔽段由 coveredUpToSeq 唯一确定）
    this.turnStartSeq = start.seq;
    // 上一轮中途插入的唤醒记在集合里；新的一轮重新开始记（它只用来防同一轮重复落账）
    this.claimedMidTurn.clear();

    const claimed = this.claimInput();
    // 没有输入可认领：无事可做。仍写 turn/start + turn/end，让"空拍"在日志里有据可查
    if (claimed.wakeSeqs.length === 0) return this.endTurn({ kind: 'completed' });

    // 回复必要性门（§4.11 沉默是正常动作）。认领已完成，故本批输入不会被重复评估。
    // 静默路径的事件序列与 agent-loop 的其他收尾完全一致：
    //   turn/start → input/claimed → turn/end{completed, spoke:false}，零模型调用（M5-4）。
    const gate = this.deps.necessityGate ?? (() => Promise.resolve(true));
    // Wake 钩子（design §4.19）：唤醒时注入附加输入。它跟门看的是同一份文本——
    // 钩子说的东西也算「这次唤醒说了什么」，否则「紧急信息由钩子带进来」这条用法就废了。
    const wakeText = this.wakeText();
    const injected = await this.runWakeHooks(wakeText);
    const gateText = injected === null ? wakeText : `${wakeText}\n${injected}`;
    if (!(await gate(gateText, this.wakeEvents))) return this.endTurn({ kind: 'completed' });
    // 过了门才把注入文本排进尾部 developer 通道：要沉默就一并沉默，不留孤儿上下文
    if (injected !== null) this.hookContext.push(injected);

    let firstStep = true;
    for (;;) {
      // 刹车优先于智能：每 step 边界重新判定（§4.6）
      const verdict = this.deps.budget?.checkBeforeStep(this.projection) ?? null;
      if (verdict !== null) return this.endTurn(verdict);
      if (this.deps.signal?.aborted === true) return this.endTurn({ kind: 'aborted', cause: 'signal' });

      this.step += 1;
      const outcome = await this.runStep(firstStep);
      firstStep = false;
      if (outcome !== null) return this.endTurn(outcome);
    }
  }

  // ── 单步 ──

  /** 返回非 null 表示本 turn 到此结束；null 表示带上工具结果继续下一步 */
  private async runStep(firstStep: boolean): Promise<TurnEndReason | null> {
    // 重新对齐日志：本 step 的请求必须由日志派生（别人写进来的事件也要看得见）
    await this.syncEvents();
    // **送进这一份请求的输入＝她看见了**：中途插进来的唤醒在这里销账（见 claimDeliveredInputs）
    this.claimDeliveredInputs();
    const step = this.step;
    // now 只取一次：渲染用它，step/start 的 ts 也用它 —— 重建请求时读回这个值即可复现
    const now = this.deps.now();
    const model = this.deps.ds.modelFor(this.lane);
    const wakeEvent = firstStep ? (this.wakeEvents[0] ?? null) : null;
    const softHint = mergeHints(this.deps.budget?.softHint?.(this.projection) ?? null, this.drainHookContext());

    const request = this.deriveAt({ wakeEvent, step, now, model, softHint });
    this.write('step/start', {
      turn: this.turn,
      step,
      model,
      lane: this.lane,
      renderVersion: RENDER_VERSION,
      personaHash: this.deps.persona.personaHash,
    }, { sync: true, ts: now });

    let result: DsStreamResult;
    try {
      result = await this.deps.ds.stream(toDsRequest(request, this.lane, this.deps.signal));
    } catch (error) {
      return this.failStep(step, error);
    }

    // 中断只留「已推送的部分」（schema §3 / M2-9）：文本落库，toolCalls 一律丢弃——
    // 被截断的 arguments 拿去执行就是「拿着半个参数做有副作用的事」。
    const interrupted = result.interrupted === true;
    const text = result.text.length > 0 ? result.text : null;
    const calls: ToolCallRequest[] = interrupted ? [] : result.toolCalls.map(cloneCall);

    const assistant: Record<string, unknown> = {
      text,
      toolCalls: calls.map(call => ({ callId: call.callId, name: call.name, arguments: call.arguments })),
    };
    if (interrupted) assistant['interrupted'] = true;
    this.write('message/assistant', assistant, { sync: true });
    if (text !== null && text.trim() !== '') this.spoke = true;

    if (result.reasoning.length > 0) {
      // 思维链只供复盘（渲染层剥离，缓存铁律 3），丢了不影响正确性：按观测类写入
      this.write('message/reasoning', { turn: this.turn, step, text: result.reasoning }, { sync: false });
    }
    this.accountStep(step, result, interrupted, model);

    // 单步刹车（§4.6 单 step 层）：超出上限的调用不执行，返回值是被拦下的条数
    let overLimit = 0;
    if (calls.length > 0) overLimit = await this.executeCalls(step, calls);

    this.write('step/end', { turn: this.turn, step, toolCalls: calls.length }, { sync: true });
    // 观测类事件（budget/consumed、tool/zombie）在 step 边界统一落盘
    this.log.flush();

    // 人审挂起（design §4.21）：本 step 里落下了 human/asked（v27 之后只有计划模式拦截这一个写入方）——
    // turn 到此**挂起**而不是收尾。结局是 blocked：输入没丢、也没失败，它在等一个人说话。
    // 认领过的输入由 real-loop 在 human/answered 到达后写成 input/requeued 送回队列。
    // 判定读日志而不是投影：工具经注入的 emit 写事件，宿主折不折投影不由本模块决定。
    if (await this.humanSuspension()) return { kind: 'blocked', by: ASK_HUMAN_BLOCKED_BY };

    // 单步工具调用数超限（§4.6 单 step 层）：多余调用已记 over-limit，本 step 就地收束。
    // 结局由预算实现给出（它负责写 budget/exhausted）——循环层不写那个事件。
    if (overLimit > 0) {
      return this.deps.budget?.onStepOverflow?.(calls.length)
        ?? { kind: 'budget-exhausted', layer: 'step' };
    }

    if (interrupted) {
      const code = result.failure?.code ?? 'stream_interrupted';
      if (code === 'aborted') return { kind: 'aborted', cause: 'signal' };
      return {
        kind: 'error',
        message: result.failure?.message ?? '流式输出在完成前中断，本轮内容不完整',
        code,
      };
    }
    // 输出被截断与"说完了"是两件事（schema §2）：截断优先作为结局，即使本步还带着工具调用
    if (result.incompleteReason === 'max_output_tokens') {
      return { kind: 'max-tokens', outputTokens: result.usage.outputTokens };
    }
    return calls.length === 0 ? { kind: 'completed' } : null;
  }

  // ── 压缩（交接笔记 → compaction/summary） ──

  /**
   * 压缩触发（milestones.md M5-2、persona.md §4、design.md §4.13 铁律 5）：
   * turn 结束且可见历史 token 估算超过阈值时，把交接笔记写成 `compaction/summary`。
   *
   * 遮蔽点取**上一个已结束 turn 的 `turn/end`**（见 `lastClosedTurnEndSeq`：绝不能劈开
   * "他问的那句"与"她答的那段"）；本 turn 自己的事件（seq 更大）逐字节保留。历史只可闸蔽、
   * 不可改写：老摘要留在现场，渲染取最大的 coveredUpToSeq，于是新摘要把老摘要自己也闸蔽进去
   * （§13 遮蔽规则）。
   */
  private async maybeCompact(): Promise<void> {
    const cfg = this.deps.compaction;
    if (cfg === undefined) return;
    // 本 step 自己写下的事件（message/assistant、tool/result…）要先进快照：
    // 阈值判定与笔记内容都只认日志，不认内存态拼装
    await this.syncEvents();
    if (estimateHistoryTokens(this.events) <= cfg.thresholdTokens) return;

    const handoffOptions: HandoffOptions = { ...cfg };
    const note = renderHandoffNote(this.events, {
      ...handoffOptions,
      budgetTokens: cfg.budgetTokens ?? DEFAULT_HANDOFF_BUDGET_TOKENS,
      foldTokens: cfg.foldTokens ?? DEFAULT_HANDOFF_FOLD_TOKENS,
    });
    if (note.text.trim() === '') return;

    const covered = Math.max(this.coveredUpToSeq(), this.lastClosedTurnEndSeq());
    this.write('compaction/summary', { coveredUpToSeq: covered, summary: note.text }, { sync: true });
    this.log.flush();
  }

  /**
   * 遮蔽点：**上一个已经结束的 turn 的 `turn/end` seq**（没有就退回本 turn 起始 seq）。
   *
   * 为什么不能再用本 turn 的 `turn/start.seq`（2026-10-02 修）：**叫醒她的那条输入在
   * `turn/start` 之前**——`wake/channel` 先落盘，循环才开这一轮。于是"遮蔽到本 turn 起始"
   * 会把**他的那句话遮掉、把她对那句话的回答留在现场**（回答的 seq 更大）。留下的半段读起来
   * 像她在自言自语，而接下来的新消息看起来像"新的问题"——用户实测到的那句
   * "每次上下文压缩后她又把已经回复过的东西再回复一遍"就是这么来的（样本见 review.md）。
   *
   * 取上一个 `turn/end` 之后，"他问的那句"与"她答的那段"要么一起进笔记、要么一起留在现场，
   * 永远不会被劈开。代价是遮蔽得少一点（多留一轮），换来的是压缩之后对话仍然对得上。
   */
  private lastClosedTurnEndSeq(): number {
    let end = 0;
    for (const event of this.events) {
      if (event.type === 'turn/end' && event.seq < this.turnStartSeq && event.seq > end) end = event.seq;
    }
    return end === 0 ? this.turnStartSeq : end;
  }

  /** 已有摘要的最大 coveredUpToSeq（0 表示尚未压过） */
  private coveredUpToSeq(): number {
    let covered = 0;
    for (const event of this.events) {
      if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > covered) {
        covered = event.data.coveredUpToSeq;
      }
    }
    return covered;
  }

  // ── 工具执行 ──

  private async executeCalls(step: number, calls: readonly ToolCallRequest[]): Promise<number> {
    // 单步刹车：超限部分不执行（§4.6「停止本 step」）。返回值＝被拦下的调用数。
    const limitOf = this.deps.budget?.stepCallLimit;
    const limit = limitOf === undefined ? calls.length : Math.max(0, Math.trunc(limitOf()));
    const allowed = limit >= calls.length ? [...calls] : calls.slice(0, limit);
    const over = limit >= calls.length ? [] : calls.slice(limit);

    // 超限部分照样两阶段落库：只写 tool/call 不写 tool/result，恢复流程会把它当成
    // 「执行到一半崩溃」——那是伪造事实。over-limit 明说“未派发”。
    for (const call of over) {
      const callSeq = this.recordToolCall(step, call, this.deps.registry.get(call.name));
      this.write('tool/result', {
        turn: this.turn,
        step,
        callId: call.callId,
        callSeq,
        status: 'over-limit',
        content: `单步工具调用数超过上限（${limit} 次），本次调用未执行。把剩下的动作拆到后面的步骤里再发。`,
        durationMs: 0,
      }, { sync: true });
    }

    if (allowed.length === 0) return over.length;

    const ctx: ExecutionContext = {
      registry: this.deps.registry,
      turn: this.turn,
      step,
      workspaceRoot: this.workspaceRoot,
      // 两阶段落库：call 先拿 seq，result 引用它（§4.5）。两者都是承诺类。
      onToolCall: (call, def) => this.recordToolCall(step, call, def),
      onToolResult: (call, result, callSeq) => this.recordToolResult(step, call, result, callSeq),
      onToolZombie: (call, note) => { this.recordZombie(call, note); },
      // 钩子拒绝的落库通道：被拦的调用不进 tool/call，但「碰过一道门且被拒」必须留痕
      onPolicyDenied: (call, rule, reason) => { this.recordPolicyDenied(call, rule, reason); },
      // 钩子附加文本回流：与 Wake 注入同一条尾部 developer 通道
      onHookContext: (text) => { this.hookContext.push(text); },
    };
    if (this.deps.hooks !== undefined) ctx.hooks = this.deps.hooks;
    if (this.deps.planGate !== undefined) ctx.planGate = this.deps.planGate;
    if (this.deps.signal !== undefined) ctx.signal = this.deps.signal;
    // 有人插话的计数读取器：turn 级，整轮共用一条（speak 是唯一消费它的工具）
    // 销账口与它同门：没有计数器的装配（子代理链、单机调用）根本判不出"被打断"，
    // 也就没有"她已经看见了这条"这件事可记。
    if (this.deps.interruptEpoch !== undefined) {
      ctx.interruptEpoch = this.deps.interruptEpoch;
      ctx.claimInterruption = (wakeSeq) => { this.claimInterruption(wakeSeq); };
    }
    if (this.deps.modelVisibility !== undefined) ctx.modelVisibility = this.deps.modelVisibility;
    if (this.deps.isolation !== undefined) ctx.isolation = this.deps.isolation;
    await executeToolCalls(allowed, ctx);
    return over.length;
  }

  private recordToolCall(step: number, call: ToolCallRequest, def: ToolDefinition | null): number {
    const event = this.write('tool/call', {
      turn: this.turn,
      step,
      callId: call.callId,
      name: call.name,
      // 原始 JSON 文本照原样落库，解析失败也不例外（schema §4）
      arguments: call.arguments,
      // 未注册的名字不轻信：按 destructive 记账，恢复期就不会给它自动重试的待遇
      sideEffect: def?.sideEffect ?? 'destructive',
    }, { sync: true });
    return event.seq;
  }

  private async recordToolResult(
    step: number,
    call: ToolCallRequest,
    result: ToolExecutionResult,
    callSeq: number,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      turn: this.turn,
      step,
      callId: call.callId,
      callSeq,
      status: result.status,
      content: result.content,
      durationMs: result.durationMs,
    };
    if (result.error !== undefined) data['error'] = result.error;

    // 大结果外置（§4.12）：**先写 blob 再写事件**——事件里只有预览，blob 没落盘就等于丢全文。
    // 只对 status:'ok' 外置：渲染层仅在该分支消费 contentRef（见 model/render.ts 的
    // renderToolOutput），给别的状态挂 contentRef 会得到"看着完整、其实被截断"的假象。
    const offload = this.deps.blobOffload;
    if (offload !== undefined && result.status === 'ok' && result.content.length > 0) {
      const outcome = await offloadIfLarge(result.content, offload);
      data['content'] = outcome.content;
      if (outcome.contentRef !== undefined) data['contentRef'] = outcome.contentRef;
    }

    this.write('tool/result', data, { sync: true });
  }

  private recordZombie(call: ToolCallRequest, note: string): void {
    this.write('tool/zombie', { callId: call.callId, name: call.name, note }, { sync: false });
  }

  /**
   * PreToolUse 的拒绝落库（design §4.19 第 5 条 / schema §4）：`rule` 恒为 'hook'——
   * 枚举里没有「第几条钩子」这一档，具体命中哪条由执行器回给模型的文本带出。
   */
  private recordPolicyDenied(call: ToolCallRequest, rule: string, reason: string): void {
    const detail = rule === 'hook' ? reason : `${reason}（命中 ${rule}）`;
    this.write('policy/denied', {
      tool: call.name,
      rule: 'hook',
      reason: detail,
      callId: call.callId,
    }, { sync: true });
  }

  // ── 人审挂起（design §4.21） ──

  /**
   * 本 turn 是否留下了未被答复的**人审挂起**。
   *
   * 口径与 plan-mode 的 `scanSuspension` **共用同一份实现**（`hasPendingSystemAsk`：FIFO 配对、
   * `askSeq` 精确配对优先），但只看**本 turn 起点之后**的事件：上个 turn 的挂起是历史，
   * 不该让本 turn 替它买单。配对不按 question 文本——同一批里可能有多件计划各自提问，
   * 而提问文本是同一个界面常量。
   *
   * **她自己的提问不算挂起**（design §6.5：旧实现错在"等"，不在"问"）：`ask_human` 写下的
   * `human/asked{source:'agent'}` 与计划拦截那条是两种来源，前者写完这一轮照常往下走。
   * 少了这层过滤，"她说了一句需要人回答的话"就会把 turn 停在这里——那正是被否掉的旧形态。
   */
  private async humanSuspension(): Promise<boolean> {
    await this.syncEvents();
    return hasPendingSystemAsk(this.events, { afterSeq: this.turnStartSeq });
  }

  // ── 钩子（design §4.19） ──

  /**
   * Wake 点：唤醒到达时问一次钩子要不要注入附加输入。本方法**不抛**——
   * 钩子故障不能成为「醒不来」的理由；`HookRunner` 已把故障折成无决定，这里是双保险。
   */
  private async runWakeHooks(wakeText: string): Promise<string | null> {
    const hooks = this.deps.hooks;
    if (hooks === undefined) return null;
    try {
      const result = await hooks.wake({
        text: wakeText,
        sources: wakeSources(this.wakeEvents),
        turn: this.turn,
      });
      return result.context;
    } catch {
      return null;
    }
  }

  /** 取走待注入的钩子上下文（取走即清空：同一条文本只注入一次，重复注入只是噪音） */
  private drainHookContext(): string | null {
    if (this.hookContext.length === 0) return null;
    const text = this.hookContext.join('\n\n');
    this.hookContext.length = 0;
    return text;
  }

  // ── 记账 ──

  /** 模型调用成功返回后的预算归账（缓存命中拆分对齐 §4.13 观测闭环） */
  private accountStep(step: number, result: DsStreamResult, interrupted: boolean, fallbackModel: string): void {
    const usage = result.usage;
    const inputTokens = usage.inputTokens;
    const cacheHit = Math.max(0, Math.min(usage.cachedTokens, inputTokens));
    this.write('budget/consumed', {
      turn: this.turn,
      step,
      lane: this.lane,
      model: result.model ?? fallbackModel,
      inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitTokens: cacheHit,
      cacheMissTokens: Math.max(0, inputTokens - cacheHit),
      durationMs: result.durationMs,
      // 成功路径没有重试计数通道（DsClient 只把 attempts 挂在外抛错误上）；M3 接 onRetry 回填
      retryCount: 0,
      finishReason: finishReasonOf(result, interrupted),
      tokensTodayAccum: this.projection.budget.tokensToday + inputTokens + usage.outputTokens,
    }, { sync: false });
  }

  /** 模型调用抛错：分类 → 结局。失败也必须记账，否则 §4.6 的失败刹车永远看不到连续失败 */
  private failStep(step: number, error: unknown): TurnEndReason {
    const known = isDsClientError(error);
    const code = known ? error.code : 'UNKNOWN_MODEL_ERROR';
    // 服务端原话要带出来：400 的响应体里往往写着真正的原因（哪个字段不合法），
    // 只留一句「请求被拒绝」等于把唯一的线索丢掉——上一轮就是靠补上它才查得下去。
    const detail = known ? (error.detail ?? null) : null;
    const base = error instanceof Error ? error.message : String(error);
    const message = detail === null || detail === '' ? base : `${base}；服务端原话：${detail}`;
    this.write('budget/consumed', {
      turn: this.turn,
      step,
      lane: this.lane,
      model: this.deps.ds.modelFor(this.lane),
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      durationMs: 0,
      retryCount: known ? Math.max(0, error.attempts - 1) : 0,
      finishReason: 'failed',
      tokensTodayAccum: this.projection.budget.tokensToday,
    }, { sync: false });
    this.write('step/end', { turn: this.turn, step, toolCalls: 0 }, { sync: true });
    this.log.flush();

    if (known && error.kind === 'rate_limited') {
      return { kind: 'rate-limited', retryAfterMs: error.retryAfterMs ?? 0 };
    }
    if (known && error.kind === 'aborted') return { kind: 'aborted', cause: 'signal' };
    return { kind: 'error', message, code };
  }

  private endTurn(reason: TurnEndReason): TurnEndReason {
    // **整轮失败时把输入退回去**（2026-10-02 补，用户报的一处洞）：模型/服务端拒了请求
    //（例如缺配对的 tool_call 被 400 打回），这一轮认领的输入不该就此消失——她连"有人叫过我"
    // 都看不到第二次。退回去是"还有一次完整机会"，与崩溃恢复走同一条路（`input/requeued`），
    // 认领次数照样累计；到 MAX_CLAIM_COUNT 就进死信（毒消息保护：一条必然失败的输入
    // 不该把守护进程拖进"拉起→失败→拉起"的循环）。
    if (reason.kind === 'error') this.requeueOnTurnError();
    this.write('turn/end', { turn: this.turn, reason, spoke: this.spoke }, { sync: true });
    this.log.flush();
    return reason;
  }

  /**
   * 整轮失败 → 退回本轮认领过的输入（`input/requeued{reason:'turn-error'}`），
   * 到上限的进死信（`input/dead-letter`）。**认领次数照旧累计**，所以失败不会无限重试。
   */
  private requeueOnTurnError(): void {
    if (this.claimedCounts.size === 0) return;
    const wakeSeqs: number[] = [];
    const claimCounts: number[] = [];
    const sources: WakeSource[] = [];
    for (const [wakeSeq, countAtClaim] of this.claimedCounts) {
      const nextCount = countAtClaim + 1;
      if (nextCount >= MAX_CLAIM_COUNT) {
        this.write('input/dead-letter', {
          inputSeq: wakeSeq,
          claimCount: nextCount,
          lastError: '整轮失败（模型或服务端拒了请求）反复认领，不再自动重试',
        }, { sync: true });
        continue;
      }
      const event = this.log.get(wakeSeq);
      wakeSeqs.push(wakeSeq);
      claimCounts.push(nextCount);
      // `wakeSourceOf` 认不出类型时给 'manual'（它自己的兜底）——这里只是类型上要一个确定值
      sources.push(event === null ? 'manual' : wakeSourceOf(event.type));
    }
    if (wakeSeqs.length > 0) {
      this.write('input/requeued', { wakeSeqs, claimCounts, sources, reason: 'turn-error' }, { sync: true });
    }
  }

  // ── 输入认领 ──

  private claimInput(): { wakeSeqs: number[]; claimCounts: number[] } {
    const wakeSeqs: number[] = [];
    const claimCounts: number[] = [];
    for (const event of this.wakeEvents) {
      // 认领次数取自投影的 pending 项（interrupted 退回时 +1），首次为 0。
      // 投影里找不到也照常认领：认领是"这批输入归本 turn"，不该依赖投影的瞬时状态。
      const item = this.projection.pending.find(p => p.wakeSeq === event.seq);
      wakeSeqs.push(event.seq);
      claimCounts.push(item?.claimCount ?? 0);
    }
    if (wakeSeqs.length === 0) return { wakeSeqs, claimCounts };
    this.write('input/claimed', { turn: this.turn, wakeSeqs, claimCounts }, { sync: true });
    // 记下"认领当时的次数"：整轮失败时要按它算出退回时的次数（见 requeueOnTurnError）
    for (const [i, seq] of wakeSeqs.entries()) this.claimedCounts.set(seq, claimCounts[i] ?? 0);
    return { wakeSeqs, claimCounts };
  }

  /**
   * 中途插话的销账：她**看见**了一条打断她的输入，把它补记到本轮账上。
   *
   * 为什么账要能分批记：认领本来是 turn 开始时记一次（`claimInput`），而中途到的唤醒从没进过
   * 那一笔；她因为看见它才被打断，可它一直留在待办里——`turn/end` 只清账上的那些，
   * 于是它下一轮又被认领，同一个问题再答一遍（docs/review.md「未了结」的实测事故）。
   *
   * 为什么由 speak 的打断分支触发、而不是"有人开口"就销账：`noteUserSpoke` 在她没发言时
   * 同样会跑，在那里销账会把一条她根本没看见的消息整个吞掉——比重复回答严重得多。
   *
   * 前提（fold 侧）：`claimedByTurn[turn]` 已是**并集**。否则这条补记会抹掉本轮原有的账，
   * 而那份账是"turn 异常中断时据以退回输入"用的——抹掉它等于丢掉她真正消化过的输入。
   */
  private claimInterruption(wakeSeq: number): void {
    const item = this.projection.pending.find(p => p.wakeSeq === wakeSeq);
    const count = item?.claimCount ?? 0;
    this.claimCountsSeen(wakeSeq, count);
    this.write('input/claimed', {
      turn: this.turn,
      wakeSeqs: [wakeSeq],
      claimCounts: [count],
    }, { sync: true });
  }

  /** 记下这次认领的次数（整轮失败时按它算退回次数）——只增不改：同一 seq 反复认领时留最早那个 */
  private claimCountsSeen(wakeSeq: number, count: number): void {
    if (!this.claimedCounts.has(wakeSeq)) this.claimedCounts.set(wakeSeq, count);
  }

  /**
   * 中途插进来的唤醒：**进了这一份请求就销账**（2026-10-02 修）。
   *
   * 为什么不能只在 speak 的打断分支销账（那是原先的唯一入口）：那个分支要求"这条插话正好
   * 撞在她开口的那一下"。实测撞到的却是另一种：他说话时她正在想、正在跑工具，于是她
   * **先看到、再开口**——这一轮她答了，账却没销，下一轮那条唤醒又被认领一次，同一个问题
   * 再答一遍（样本：`wake/channel` seq 7969 在 turn 168 里已经答过，却在 turn 169 的
   * `input/claimed` 里又出现一次；见 docs/review.md）。
   *
   * 为什么用"进了请求"当判据，而不是"有人开口"就销账：`noteUserSpoke` 在她**没看见**那条消息时
   * 也会跑，在那里销账会把一条她根本没看到的话整个吞掉——比重复回答严重得多。而"这一份请求里
   * 有它"是确凿的看见：在那之后她才可能决定理不理、答不答，那正是账本该记的事。
   *
   * 只认本 turn 开始之后到的（`wakeSeq > turnStartSeq`）：开轮那一批已经由 `claimInput` 记过。
   * 也只在**没有被本 turn 记过**时写（`claimedMidTurn`），免得同一批重复落账。
   */
  private claimDeliveredInputs(): void {
    const latest = this.events[this.events.length - 1]?.seq ?? 0;
    const fresh = this.projection.pending
      .filter(item => item.wakeSeq > this.turnStartSeq
        && item.wakeSeq <= latest
        && !this.claimedMidTurn.has(item.wakeSeq));
    if (fresh.length === 0) return;
    for (const item of fresh) {
      this.claimedMidTurn.add(item.wakeSeq);
      this.claimCountsSeen(item.wakeSeq, item.claimCount);
    }
    this.write('input/claimed', {
      turn: this.turn,
      wakeSeqs: fresh.map(item => item.wakeSeq),
      claimCounts: fresh.map(item => item.claimCount),
    }, { sync: true });
  }

  /** 唤醒文本（必要性门与任务卡标题共用同一渲染口径） */
  private wakeText(): string {
    const payloads = this.timerPayloads();
    // 提及那一轮：门与请求体看到的必须是**同一份文本**（否则"紧急信息由钩子带进来"这类判断
    // 会按着一段她已经看不到的话来做）。所以这里也换成那句通知。
    const notice = mentionNoticeOf(this.deps.contact ?? null, this.wakeEvents[0] ?? null);
    return this.wakeEvents
      .map((event) => (notice !== null && event.type === 'wake/channel'
        && event.data.messageId === notice.messageId
        ? notice.text
        : renderWake(event, payloads)))
      .filter(text => text !== '')
      .join('\n');
  }

  private taskCard(step: number): { title: string; turn: number; step: number; todoOpen: string[] } {
    const first = this.wakeEvents[0];
    // 标题用 wakeTitle（人读摘要），不是 renderWake（给模型看的带来源标注版）：
    // 否则任务卡会写成「[界面消息] 看一眼日志」
    // 提及那一轮：标题用那句通知（人读得懂），而不是 wake/channel 的原始数据——
    // 实测它曾经在任务卡里写成 `{"channel":"qq-official","chatType":"group",…}`，
    // 那是给她看的当前任务，不该是一坨 JSON。
    const notice = mentionNoticeOf(this.deps.contact ?? null, first ?? null);
    const title = first === undefined
      ? ''
      : clipTaskTitle(notice?.text ?? wakeTitle(first, this.timerPayloads()));
    return {
      title,
      turn: this.turn,
      step,
      todoOpen: this.projection.todoList.filter(item => item.status !== 'completed').map(item => item.content),
    };
  }

  /** timerId → 最近一条 timer/set 的 payload（wake/timer 本身不带 payload，与渲染层同源） */
  private timerPayloads(): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const event of this.events) {
      if (event.type === 'timer/set') map.set(event.data.timerId, event.data.payload);
      if (event.type === 'timer/cancelled') map.delete(event.data.timerId);
    }
    return map;
  }

  // ── 日志快照 ──

  /** 把 lastSeq 之后的事件增量补进快照。render 的输入必须逐条来自日志，不接受内存态拼装。 */
  private async syncEvents(): Promise<void> {
    const last = this.events[this.events.length - 1];
    const from = last === undefined ? 1 : last.seq + 1;
    for await (const event of this.log.readRange(from)) {
      if (last !== undefined && event.seq <= last.seq) continue;
      // 隔离过滤（子代理）：被挡掉的事件不进快照，于是 render 看到的就是「从空事件序列起」那一份。
      // 它在 seq 上是跳跃的，但 render 只要求按 seq 升序（不要求连续）。
      if (this.deps.eventFilter !== undefined && !this.deps.eventFilter(event)) continue;
      this.events.push(event);
    }
  }

  private maxTurn(): number {
    let max = 0;
    for (const event of this.events) {
      if (event.type === 'turn/start' && event.data.turn > max) max = event.data.turn;
    }
    return max;
  }

  private deriveAt(args: {
    wakeEvent: AppEvent | null;
    step: number;
    now: string;
    model: string;
    softHint: string | null;
  }): RenderedRequest {
    // 本轮新输入走 wakeEvent 参数，就不能同时出现在事件流里（见文件头协同契约）
    const wakeSeq = args.wakeEvent?.seq;
    const events = wakeSeq === undefined ? this.events : this.events.filter(event => event.seq !== wakeSeq);
    return deriveRequest({
      persona: this.deps.persona,
      tools: this.deps.registry.listForModel(this.deps.modelVisibility ?? {}),
      timezone: this.deps.timezone,
      lane: this.lane,
      events,
      wakeEvent: args.wakeEvent,
      taskCard: this.taskCard(args.step),
      now: args.now,
      model: args.model,
      softHint: args.softHint,
      skillCatalog: this.deps.skillCatalog ?? null,
      contact: this.deps.contact ?? null,
      // 本机与用度：宿主在**每个 turn 装配 deps 时**算一次（与 contact 同节奏）——磁盘 statfs
      // 与进程 uptime 是会失败的 IO，不适合每个 step 都做一遍；用度是"今日累计"，一拍一算是够的。
      machine: this.deps.machine ?? null,
      usage: this.deps.usage ?? null,
      loadImage: this.deps.loadImage ?? null,
      ...(this.deps.maxContextImages === undefined
        ? {}
        : { maxContextImages: this.deps.maxContextImages }),
    });
  }

  /** 唯一写入点：分配 seq → append（承诺类 fsync）→ 立即折进投影 */
  private write(type: AppEventType, data: unknown, options: { sync: boolean; ts?: string }): AppEvent {
    const event = {
      seq: this.log.nextSeq(),
      ts: options.ts ?? this.deps.now(),
      type,
      data,
      // 可见性一律走 schema 表，不在写入点手填，避免两处口径漂移
      visibility: defaultVisibility(type),
      origin: ORIGIN,
      // 子代理链归属（§4.21 隔离三件套之三）：顶层不传 → 字段不出现，事件形状与之前完全一致
      ...(this.deps.parentCallId !== undefined ? { parentCallId: this.deps.parentCallId } : {}),
    } as unknown as AppEvent;
    this.log.append(event, { sync: options.sync });
    applyOne(this.projection, event);
    this.deps.onEvent?.(event);
    return event;
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

function toDsRequest(rendered: RenderedRequest, lane: ModelLane, signal: AbortSignal | undefined): DsRequest {
  const request: DsRequest = {
    lane,
    model: rendered.model,
    input: rendered.input,
    instructions: rendered.instructions,
    tools: rendered.tools,
  };
  if (signal !== undefined) request.signal = signal;
  return request;
}

function finishReasonOf(
  result: DsStreamResult,
  interrupted: boolean,
): 'completed' | 'max_output_tokens' | 'failed' | 'aborted' {
  if (result.incompleteReason === 'max_output_tokens') return 'max_output_tokens';
  if (result.failure !== null) return result.failure.code === 'aborted' ? 'aborted' : 'failed';
  if (interrupted) return 'aborted';
  if (result.status === 'failed') return 'failed';
  return 'completed';
}

function cloneCall(call: { callId: string; name: string; arguments: string }): ToolCallRequest {
  return { callId: call.callId, name: call.name, arguments: call.arguments };
}

/**
 * 两条尾部提示合并成一条 developer 消息（铁律 2「只追加」不变）：
 * 钩子注入在前（它是内容），软阈值提示在后（它是刹车警告，放最后一行才读得到）。
 * 两者都是「本次请求临时插播、不落库」的同一种性质，共用 softHint 通道是刻意的（design §4.19 第 4 条）。
 */
function mergeHints(budgetHint: string | null, hookHint: string | null): string | null {
  const hook = hookHint === null || hookHint === '' ? null : hookHint;
  const budget = budgetHint === null || budgetHint === '' ? null : budgetHint;
  if (hook === null) return budget;
  if (budget === null) return hook;
  return `${hook}\n\n${budget}`;
}

/** 本批唤醒的来源（`wake/<source>` 的 source 段）：Wake 钩子的 matcher 匹配的就是它 */
function wakeSources(events: readonly AppEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (!event.type.startsWith('wake/')) continue;
    const source = event.type.slice('wake/'.length);
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

function dedupeBySeq(events: readonly AppEvent[]): AppEvent[] {
  const seen = new Set<number>();
  const out: AppEvent[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  return out;
}

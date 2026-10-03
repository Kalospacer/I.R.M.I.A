/**
 * Irmia Agent — 管理工具包（docs/design.md §4.10 / §4.11 / §4.20 / §4.21 / §6）
 *
 * 九件工具：write_persona / set_timer / cancel_timer / list_timers / speak / report / todo /
 * read_channel / ask_human。它们的共同点是"改变 Agent 自身、对外发声、问人、或看外面发来的东西"，
 * 而不是读写文件——所以全部走注入的出口（事件写入口、定时器、告警、回投、日志读取），
 * 本模块不直接碰 EventLog，也不自己分配 seq。
 *
 * v27 删掉了两件，都是**参数级审计**（415 次真实调用）之后按实测取舍的：
 *   • `notify` 与 `speak` 重复——speak 的第二路本来就是
 *     `notifier.send({ level, title: 'Irmia 发言', body })`，多一个工具只是多一份
 *     schema 与一次"该用哪个"的犹豫；
 *   • `ask_human` 在无人值守里几乎总是浪费：它挂起一个 turn 等答复（默认 24h），
 *     而她自己的结论是"你常不在，我宁可写文件等你"。**事件留着**
 *     （`human/asked` / `human/answered`）：plan 模式与挂起重入机制依赖它们，
 *     删掉的只是"工具"这一层调用链（提问改由她写进文件/state）。
 *
 * **design §6.5 把 `ask_human` 恢复了，改的是语义而不是机制**：旧实现错在"等"，不在"问"。
 * 现在它写完 `human/asked{source:'agent'}` 就返回，turn 照常往下走（挂起判定只认系统来源），
 * 人的答复在下一拍以 `human/answered` 出现，没人答则落一条「未批准、未拒绝」的 `human/expired`。
 * 问她"要不要换个方式找人"是她的判断，框架不替她降级成"那就算了"。
 *
 * 三条设计纪律：
 *   1. persona/ 只有 write_persona 一个写通道，且 IDENTITY/CONSTITUTION 对 agent 只读、
 *      STYLE 只收提案（proposals/，由人批准生效）
 *      （design.md §4.11：能改写自己核心身份的人格，一次幻觉就会变成别人）。
 *   2. 拒绝必须给模型明确的下一步（design.md §4.10），所以每条拒绝消息都说清了
 *      "为什么"与"改走哪条路"。
 *   3. `emit` 记日志、语义回调触发副作用（刷新人格缓存、更新注入层），两者是不同职责，
 *      不是一个东西的两个名字——宿主刷新 personaHash 靠的是回调，不是解析事件。
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { StoredTimerEntry, TimerSetInput, TimerStore } from '../wake/timer-store.js';
import type { ChannelMessage, Visibility, WakeChannel } from '../log/types.js';
import { defaultVisibility } from '../log/types.ts';
// 默认等待线只此一份（config.ts）：回执里说的时长必须与 real-loop 落 human/expired 的判定线同源
import { DEFAULT_ASK_HUMAN_TIMEOUT_MIN } from '../config/config.ts';
// 回投地址的 scheme 与解析口都属于通道层（`qq:<chatType>:<chatId>`、`onebot:<chatType>:<chatId>`），
// 不在这里另造一套：多通道并存时按 wake.channel 选各自命名空间
import { QQ_CHANNEL_NAME, parseReplyUrl as parseQqReplyUrl, replyUrlOf as qqReplyUrlOf } from '../channel/qq-official.ts';
import {
  ONEBOT_CHANNEL_NAME, ONEBOT_REPLY_SCHEME,
  parseReplyUrl as parseOneBotReplyUrl, replyUrlOf as oneBotReplyUrlOf,
} from '../channel/onebot.ts';
import { CHAT_TYPE_LABELS, channelForNamespace, normalizeSid, parseSid, sessionLabelOf, type SessionEntry } from '../channel/sessions.ts';
import { renderExternalEvent } from '../model/render.ts';
import { normalizePersonaAsset } from '../persona/loader.ts';
import { charCount, splitForChat } from './chat-split.ts';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from './types.js';
import {
  TOOL_ERROR_CODES,
  ToolArgumentError,
  argsRecord,
  errorResult,
  errorResultFromThrown,
  okResult,
  optionalString,
  requiredString,
} from './types.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** persona 资产只认 Markdown：全部人类可读、可 diff、可人工接管（design.md §4.11） */
export const PERSONA_FILE_SUFFIX = '.md';

/** agent 对这两个文件只读；改名或换路径都绕不过（按顶层资产名判定，大小写不敏感） */
export const PERSONA_PROTECTED_FILES: readonly string[] = ['IDENTITY.MD', 'CONSTITUTION.MD'];

/**
 * 只读直写、但收提案的文件：表达风格由人拍板（写 proposals/STYLE.md 提建议，人批准才生效）。
 *
 * 为什么它不能像 STATE 那样直写：STYLE 进上下文的**最前面**（instructions，最大公共前缀），
 * 它每变一次，下一轮整个请求都要重新落盘一次。而语气这件事不是每三分钟就该变的东西。
 */
export const PERSONA_PROPOSAL_ONLY_FILES: readonly string[] = ['STYLE.MD'];

/** 提案目录名（与 web/server.ts 的 PERSONA_PROPOSAL_DIR 同字面量） */
export const PERSONA_PROPOSAL_DIR = 'proposals';

/** 按需层（STATE / RELATIONSHIPS）单文件软上限：超了只警告，不拒绝 */
export const ONDEMAND_WARN_BYTES = 4096;

/**
 * 单文件硬上限。软上限只提醒，没有硬顶就等于没有上限——按需层每轮都要注入，
 * 一个写坏的 STATE.md 会永久吃掉上下文预算（design.md §4.12）。
 */
export const PERSONA_HARD_LIMIT_BYTES = 64 * 1024;

/** 任务内计划清单上限。清单进投影、进状态层注入，无上限等于给模型一个自杀开关 */
export const MAX_TODO_ITEMS = 50;

/**
 * `ask_human` 两个字段的上限：问题是"一句话问一件事"，context 是给她补背景的。
 *
 * 与人看到的卡片直接相关——超长的问题会把卡撑满（gui-design §9.3 卡片高度贴合内容），
 * 而卡片要留一个输入框给答复。超了直接拒（说清收到了多少字），不做静默截断：
 * 截断过的问题照样弹出去，人读到的就不是她问的那句了。
 */
const ASK_QUESTION_MAX = 500;
const ASK_CONTEXT_MAX = 2000;

/**
 * 未接配置时 `ask_human` 回执里报的超时（与 config.ts 的 `DEFAULT_ASK_HUMAN_TIMEOUT_MIN` 同源，
 * 直接读那个常量而不是再抄一个数：两个值一旦漂移，回执说的时长就与 `human/expired` 的判定线对不上，
 * 而那种不一致只有在她等到第二个时间点时才会被发现）。
 */
const DEFAULT_ASK_HUMAN_TIMEOUT_MS = DEFAULT_ASK_HUMAN_TIMEOUT_MIN * 60_000;

/** 把超时毫秒说成一句人话（回执里给她一个能据此安排下一步的时长） */
function waitBudgetText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60
    ? `${minutes} 分钟内一直没人答复`
    : `约 ${Math.max(1, Math.round(minutes / 60))} 小时内一直没人答复`;
}

export const TODO_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed'];

const TODO_SINGLE_CONTENT_MAX = 500;
/** speak 的建议长度：desc 里说的「一次最多 40 字」 */
const SPEAK_TEXT_MAX = 25;
/** 硬上限：只是防它把整篇报告塞进来；稍微超过不拒，只在结果里提醒 */
const SPEAK_TEXT_HARD_MAX = 400;
/** report 的上限：正式内容允许长，与 speak 差三个量级 */
const REPORT_TEXT_MAX = 64000;

/**
 * 逐段发送的节奏：每段之前等「**这一段**要打多久」，第一段也等。
 *
 * 速度由 `config.speak.charsPerMinute` 给（默认 90 字/分钟），所以一条十字的话要隔六七秒、
 * 二十字要隔十三秒——这就是“人一条条打出来”的真实节奏，也是他想要的限流：
 * 她一次只能慢慢说这么多。**第一段同样要等**：她按下的不是"发送"，是"开始打字"。
 *
 * 三个数字一起看：单段封顶 10 秒（不为超长的一条没完没了地等）；一趟总预算 90 秒
 * （超出就把剩下的直接发完，不让工具被自己的节奏拖死），工具超时 120 秒兜底。
 * `speak.typingEffect=false` 时全部立即发出（等待为 0）。测试里 sleep 可注入，不拖慢用例。
 */
const SPEAK_MAX_DELAY_MS = 10_000;
const SPEAK_TOTAL_BUDGET_MS = 90_000;

/** 打断检查的粒度：等待被切成小片，每片看一眼"他是不是又说话了" */
const SPEAK_INTERRUPT_POLL_MS = 100;

/** 发言节奏的缺省值（与 config.ts 的 SpeakConfig 默认一致；未接配置的调用方走这条） */
const DEFAULT_SPEAK_TYPING = { typingEffect: true, charsPerMinute: 90 } as const;

/**
 * 投递失败之后还能不能再试——把平台错误码翻译成一句她能用的判断。
 *
 * 只给判断，不给建议：她要说什么、要不要改道都是她自己的事（用户明确不要提示，
 * 也不要口语）。这里唯一的作用是把她**看不到**的那层信息补上——平台错误码背后的性质。
 *
 * 判据是**错误的性质**：权限类再试多少次都一样；网络类隔一会儿可能就好；剩下的一律按
 * "不必重试"处理（不确定时重试的期望收益低，代价是又一圈工具调用）。
 */
function deliveryAdvice(reason: string, sent: number): string {
  const already = sent > 0 ? `已发出的 ${sent} 条收不回来。` : '';
  if (/40034105|无权限|主动消息/.test(reason)) {
    // 说清是**往这里发**的权限问题，不是"你被禁言了"——否则她会怀疑自己整条发言能力，
    // 而不是只怀疑这条路。用户在群里那轮之后特意点了这一条。
    return `${already}向该会话发送消息时存在权限问题，不必重试。`;
  }
  if (/超时|timeout|ECONN|ETIMEDOUT|socket|network/i.test(reason)) {
    return `${already}疑似网络或对端问题，可稍后再试。`;
  }
  return `${already}原因不明，不必重试。`;
}

/**
 * 可被打断的等待：返回 true = 等满了，false = 等待期间人又开口了。
 *
 * `probe` 是「开口计数」的读取器与**本次发言**的基准值：计数变了就是被打断。
 * 基准每次发言重新取——所以"被打断之后重新组织语言再说一次"能正常说完，
 * 这正是早先用 AbortSignal 时踩的坑（一次打断会把这轮剩下的每次发言都判成被打断）。
 * 没有 probe 时一次睡完（测试与单机调用就是这种情形，逐片睡会平白放大调用开销）。
 */
async function sleepUnlessInterrupted(
  ms: number,
  probe: { epoch: () => number; start: number } | null,
): Promise<boolean> {
  if (probe === null) {
    await sleepFn(ms);
    return true;
  }
  if (probe.epoch() !== probe.start) return false;
  let waited = 0;
  while (waited < ms) {
    const slice = Math.min(SPEAK_INTERRUPT_POLL_MS, ms - waited);
    await sleepFn(slice);
    waited += slice;
    if (probe.epoch() !== probe.start) return false;
  }
  return true;
}


/**
 * 被打断时那段「没来得及发的」怎么摆给她——**多条就编号、`／` 连排**。
 *
 * 为什么逐条编号（用户 2026-10-01 的原设计 + 2026-10-03 的补充）：
 *   • 原设计要的是「哪些内容**因为插话没发出去**」——只说"被取消"或静默丢掉，
 *     她就只能猜自己说到哪儿了，而"重新组织语言"必须建立在"我上一句停在哪"之上；
 *   • 一次 speak 展开成九条气泡、只出去三条是常态（实测那次 9 条）。给一段连着排的文本，
 *     她读不出"第 4 条起没出去"；逐条编号是**能一眼看出**这件事的最省字数的写法。
 *
 * 为什么仍然只用一行、而且不重复已发的内容：这条回执要进她的上下文，而"已经发出去的"
 * 上面那行已经逐字给过了——这里再抄一遍就是同一段话在上下文里出现两次，白花钱还容易让她
 * 把已发的那半截当成没发的重讲一遍（那正是"替她改主意"的一种）。
 *
 * 长度：整段文本本来就有硬上限（`SPEAK_TEXT_HARD_MAX` 400 字），所以这一行最多四百字出头
 * ——比一条群消息还短，不需要额外的截断规则。
 */
function numberedUnreleased(segments: readonly string[]): string {
  if (segments.length === 0) return '（无）';
  // 只有一条时不编号：那是被截断的半句话，加个「1.」既不帮读、又显得像在递清单
  if (segments.length === 1) return segments[0]!;
  return segments.map((text, index) => `${index + 1}. ${text}`).join('／');
}

/** 可注入的 sleep（测试里换成不等待） */
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 测试用：把等待换成立即返回，不拖慢用例 */
export function setSleepForTest(fn: ((ms: number) => Promise<void>) | null): void {
  sleepFn = fn ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
}

// 这里原本还有一个「拆分随机源」注入点，给"逗号按概率切"那套用。用户把口径改成
// **逗号全摘全分段**之后，切分不再有随机成分——同一段话每次切出来都一样，
// 于是那个注入点连同 chat-split 里的概率参数一起删掉了。测试不再需要注入随机数。

// ──────────────────────────────── 出口接口（全部注入） ────────────────────────────────

/**
 * 事件写入口：宿主负责分配 seq 并落盘。工具只声明"发生了什么"。
 *
 * `visibility` 省略时由调用方给默认值，显式给出时以它为准。只有确实需要改变渲染行为的
 * 写入点才显式给：`human/asked` 必须是 model——否则模型下一轮看不到自己提过的问题，
 * 也就看不到人的答复（render 按可见性过滤，铁律：visibility 单向承诺）。
 */
export type AdminEventEmitter = (type: string, data: unknown, visibility?: Visibility) => void;

export interface PersonaUpdatedPayload {
  /** 相对 personaRoot 的路径，统一用 `/` 分隔，跨平台一致 */
  file: string;
  /** 新内容的 sha256（hex），用于检测人格漂移 */
  diffHash: string;
  by: 'agent' | 'human';
}

export interface SpeakSentPayload {
  channel: SpeakChannel;
  chars: number;
  /** 投递到了哪个会话（`log` 路不带：那是本机对话流，没有会话 id） */
  sid?: string;
  /**
   * 这次发言的**完整文本**与它被切成了几条气泡（只有"真发进了某个会话"的那条回执带它）。
   *
   * 见 `log/types.ts` 的 `SpeakSent.text`：`read_channel` 要靠它把"她在这个会话里说过什么"
   * 读回来——切分是投递的属性，逐段的 `message/assistant` 里没有会话坐标。
   */
  text?: string;
  spokenParts?: number;
  /**
   * 这是**哪一次工具调用**发的（`tool/call.callId`）：`read_channel` 按它把"一次 speak"归成一行。
   *
   * 为什么不是按 turn 归：同一个 turn 里她可以连着说两段（第一段发完又补一句），那在事件上
   * 与"一段被切成两条气泡"长得一样——按 turn 并会把两段并成一行，而按 `callId` 两段各自一行。
   */
  callId?: string;
  /** 产生这次发言的 turn 号 */
  turn?: number;
}

export type SpeakChannel = 'log' | 'notify' | 'reply-url';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface NotifyMessage {
  level: 'info' | 'warn' | 'critical';
  title: string;
  body: string;
}

/** 送达结果用可判别联合，而不是 boolean + 可选字符串：调用点无法忘记处理失败原因 */
export type NotifyOutcome = { ok: true } | { ok: false; reason: string };

export interface Notifier {
  send(message: NotifyMessage): Promise<NotifyOutcome>;
}

/**
 * 当前会话 → 回投 URL（M9）：按 `wake.channel` 选通道自己的命名空间（`qq:` / `onebot:`）。
 * 通道名认不出来时退回 QQ 口径（既有行为，也是缺省通道）。
 */
export function replyUrlForWake(
  wake: Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId'>,
): string {
  if (wake.channel === ONEBOT_CHANNEL_NAME) return oneBotReplyUrlOf(wake);
  return qqReplyUrlOf(wake);
}

export type ReplyUrlAnyParse =
  | { ok: true; channel: string; chatType: string; chatId: string }
  | { ok: false; error: string };

/** 解析回投 URL：按 scheme 前缀分派到对应通道的解析口（“写 url”与“读 url”必须同一口径） */
export function parseReplyUrlAny(url: string): ReplyUrlAnyParse {
  if (url.startsWith(ONEBOT_REPLY_SCHEME)) {
    const parsed = parseOneBotReplyUrl(url);
    return parsed.ok
      ? { ok: true, channel: ONEBOT_CHANNEL_NAME, chatType: parsed.chatType, chatId: parsed.chatId }
      : parsed;
  }
  const parsed = parseQqReplyUrl(url);
  return parsed.ok
    ? { ok: true, channel: QQ_CHANNEL_NAME, chatType: parsed.chatType, chatId: parsed.chatId }
    : parsed;
}

/**
 * 从当前 IM 会话派生回投地址（M9）。
 *
 * 两个字段的语义：
 *   • `url` = `qq:<chatType>:<chatId>` 或 `onebot:<chatType>:<chatId>`：chatType 决定走单聊还是群，
 *     chatId 就是 speak 的回投目标；
 *   • `idempotencyKey` = 本 turn 号：同一 turn 内多次 speak 会多回几条（她的发言本就该都发出去），
 *     而不同 turn 之间绝不会被对端当成同一条去重。
 *
 * 只认 c2c / group-at：其余 chatType（未来的 group / guild）本通道尚未实现，宁可不出回投
 * 也不要构造一个发不出去的 URL。
 */
/**
 * 本轮能否把话发回唤醒来源：speak 第三路与装置自述的联络段**共用的唯一判据**。
 *
 * 「她能说出去」与「提示词告诉她能说出去」必须是同一口径——两处各写一份判定，迟早出现
 * 「提示词说能发、实际发不出去」这种让模型做无效动作的情形。
 *
 * 认 c2c / group / group-at 三种：会话身份归一（2026-10-02）之后群聊一律写 `group`，
 * 而"这条 @ 了我"仍带着 `group-at`；两种都要能回投（群发路径是同一条，差别只在带不带 msg_id）。
 * guild（频道）本通道尚未实现，宁可不出回投也不构造一个发不出去的 URL。
 */
export function replyableWakeChannel(
  wake: WakeChannel['data'] | null,
): Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId' | 'messageId'> | null {
  if (wake === null) return null;
  if (wake.chatType !== 'c2c' && wake.chatType !== 'group-at' && wake.chatType !== 'group') return null;
  // 自检：URL 与解析口必须是同一口径（route 换了却忘了改解析的代价是"静默回投到错误地址"）
  return parseReplyUrlAny(replyUrlForWake(wake)).ok ? wake : null;
}

function derivedReplyTargetOf(
  current: (() => WakeChannel['data'] | null) | undefined,
): (ctx: ToolContext) => ReplyTarget | null {
  return (ctx) => {
    const wake = replyableWakeChannel(current?.() ?? null);
    if (wake === null) return null;
    return {
      url: replyUrlForWake(wake),
      idempotencyKey: `turn-${ctx.turn}`,
      // 叫醒她的那条消息，就是平台允许她回复的那条：带上它的 id，这条发言才算**被动回复**
      ...(wake.messageId === '' ? {} : { msgId: wake.messageId }),
    };
  };
}

export interface ReplyTarget {
  url: string;
  /** 幂等键 = turn 号（design.md §4.20），重复回投由对端去重 */
  idempotencyKey: string;
  /**
   * 平台消息 id：带上它，这条发言就是**对那条消息的被动回复**——走平台给的回复窗口，
   * 不消耗主动消息配额、也不需要额外权限。不带它就是**主动消息**：要权限、有配额。
   *
   * 这个字段是一次实测事故补上的。她的群聊发言一直失败于
   * `HTTP 400 code=40034105 主动消息失败, 无权限`，而她明明是被 @" 的那条消息叫醒的。
   * 唤醒事件里 `messageId` 一直都有、适配器也早就实现了 `passive = msgId !== ''`，
   * 只有回投链路（就是这个类型）把它丢了——于是每条回复都被平台判成主动消息。
   * 单聊恰好有主动权限，所以这个问题只在群里现形；她还为此连着重试了五次。
   */
  msgId?: string;
}

export type ReplyOutcome = { ok: true; status: number } | { ok: false; status?: number; reason: string };
export interface ReplyPoster {
  post(target: ReplyTarget, text: string): Promise<ReplyOutcome>;
}

/** 官方文件类型：1=图片 2=视频 3=语音 4=文件（与通道层同一套口径） */
export type MediaFileType = 1 | 2 | 3 | 4;

/** 要发的一个媒体：`path`（本机文件，白名单与大小由宿主把关）与 `url` 二选一 */
export interface MediaRequest {
  fileType: MediaFileType;
  path?: string;
  url?: string;
  name?: string;
  /** 本机字节（宿主读了文件之后填；工具层自己不碰字节） */
  data?: Uint8Array;
}

/**
 * 媒体投递口（`send_media` 用）：宿主注入——工具层不碰网络、不读文件字节。
 *
 * 与 `ReplyPoster` 的分工：那个发**文本**，这个发**媒体**（先上传换 `file_info`、再按
 * `msg_type=7` 发，两步都在宿主那边完成）。没接线时如实报"没有接线"，不假装发过。
 */
export interface MediaPoster {
  post(target: ReplyTarget, media: MediaRequest): Promise<ReplyOutcome>;
}

// ──────────────────────────────── 选项 ────────────────────────────────

export interface AdminToolsOptions {
  /** 定时器存储（注入） */
  timers: TimerStore;
  /** 事件写入口（注入），必填：没有它这些动作就不可复盘 */
  emit: AdminEventEmitter;
  /** 人挌资产根目录（data/persona）；省略时取 `<workspaceRoot>/persona` */
  personaRoot?: string;
  /** 告警出口；未注入时 notify/speak 的第二路如实报"未配置"而不是假装成功 */
  notifier?: Notifier;
  /** 当前 turn 的回投地址；返回 null 表示这一轮没有回投通道 */
  replyTargetOf?: (ctx: ToolContext) => ReplyTarget | null;
  /**
   * 当前 turn 的 IM 会话（M9）：有它时 `replyTargetOf` 缺省就从它派生回投地址
   * （`qq:<chatType>:<chatId>`），无 IM 通道时两者都不配，speak 如实报"本轮无回投地址"。
   */
  currentWakeChannel?: () => WakeChannel['data'] | null;
  /**
   * 发言节奏（`config.speak`）：打字效果开关与速度。不配时用默认（开、90 字/分钟）。
   *
   * 节奏是**体感参数**，所以它落在配置里而不是代码里：有人要"像人在打字"，有人只要
   * 内容尽快到手；速度同理。
   */
  speakTyping?: { typingEffect: boolean; charsPerMinute: number };
  /**
   * 「他刚说了什么」：`speak` 被打断时用它把对方的新话写进回执，她才知道该针对什么
   * 重新组织语言。返回 null 表示这次打断不是人开口造成的（回执就不引用具体内容）。
   *
   * 一并给出那条唤醒的 `wakeSeq`：回执引用的是哪一条，销账就得销哪一条
   * （见 `ToolContext.claimInterruption`）。
   */
  userSpoke?: () => { text: string; wakeSeq: number } | null;
  /** 回投实现，默认用全局 fetch */
  replyPoster?: ReplyPoster;
  /** persona 写入后的副作用钩子：刷新人格缓存、重算 personaHash */
  onPersonaUpdated?: (payload: PersonaUpdatedPayload) => void;
  /** 清单变更后的副作用钩子：投影/注入层据此刷新 */
  onTodoUpdated?: (items: readonly TodoItem[]) => void;
  /**
   * IM 消息的读取口（`read_channel` 用）：宿主注入，因为工具层不该自己去翻日志。
   *
   * 返回**时间正序**的那个会话的消息（最近 limit 条）。`sid` 是会话标识，
   * 与会话簿/回投地址同形（`qq:c2c:<openid>`）。
   */
  channelReader?: ChannelReader;
  /**
   * 她在这个会话里**说过的话**（`read_channel` 用）：宿主注入，同样是"工具层不读日志"。
   *
   * 与会话清单、未读、话题全都无关——它只服务"她读群时知道自己已经回过什么"这一眼。
   * 没接线时 read_channel 照常可用，只是读不到自己的发言（不假装她没说过）。
   */
  channelSpokenReader?: ChannelSpokenReader;
  /**
   * 本机时区（IANA 名，`read_channel` 的短时间用）：宿主注入，缺省退回 ISO 原文。
   *
   * 为什么工具层需要它：读回来的每一行都要一个**她不用换算**的时间（`MM-DD HH:MM`）。
   * 与此刻层 `时刻：` 同一条纪律（v26：换算不该由她做），而工具层不读配置，所以由宿主递进来。
   */
  timezone?: string;
  /**
   * 这一轮**叫她的那条消息**是哪一条（宿主注入；没有提及就是 null）。
   *
   * 为什么必须让读取口知道（2026-10-02 用户抓到的一处误导）：v28 之后，群里被提及的那一轮
   * 她**只拿到通知、拿不到正文**，正文靠她自己 `read_channel` 去取；可那条叫她的消息常常
   * 落在"已读位之内"（它是 `wake/channel`，不计入未读，而她之前可能已经读过那一段）——
   * 于是回执写成「没有新消息：你已经读到最新了」，她永远看不到那句原话。截图上就是这个形状。
   * 有了这一个事实，本工具对"叫她的那个会话"一律照给（那条消息必然在最近窗口里）。
   */
  mentionMessage?: () => { sid: string; messageId: string } | null;
  /** 媒体投递口（`send_media` 用）：宿主注入，缺省时那个工具如实报"没有接线" */
  mediaPoster?: MediaPoster;
  /**
   * **发言人**（openid）→ 名字：给 `read_channel` 每行那个"谁"用。
   *
   * 与 `resolveChannelName`（sid → **会话**名）不是一回事——2026-10-02 用户从截图上抓到：
   * 精简那版错把会话名（"测试群聊2"）写成了每行的发言人，于是整列看起来像"群里在说话"，
   * "这句是他说的还是别人说的"根本分不出来。名字的真源仍是联系人表/别名表，
   * 只是要按**那个人**去查（群里发言的人没有自己的键，但有过单聊就查得到）。
   */
  resolvePersonName?: (person: string) => string | null;
  /**
   * 外部内容的渲染器（`read_channel` 用）：默认用 model/render 的 `renderExternalEvent`。
   *
   * 为什么允许替换：那条渲染里含**名字**（谁在哪个群里说的），而名字的真源在宿主手里
   * （她的 `MEMORIES/aliases.md` 与人声明的联系人表）。render 是纯函数，不读文件；
   * 于是名字由宿主算好、通过这个注入点递进来——**而不是**在工具层另写一套渲染。
   */
  renderExternal?: ExternalEventRenderer;
  /**
   * 会话名解析（`read_channel` 的渲染用）：sid → 群名/人名，解析不出返回 null。
   *
   * 只影响"名字带不带得上"，不影响任何判定——所以没接线时 read_channel 照常可用，
   * 只是每条前面少一个名字（她还有 openid 可用，与 speak 的 `to` 同形）。
   */
  resolveChannelName?: ChannelNameResolver;
  /** 按需层软上限，默认 ONDEMAND_WARN_BYTES */
  onDemandWarnBytes?: number;
  /**
   * `ask_human` 的回执里报的等待时长（`config.tools.askHumanTimeoutMin`，毫秒）。
   *
   * 它不改变任何判定——超时事实由 real-loop 按同一份配置落下（`human/expired`）；
   * 这里只是让回执能说清"多久之后你会得知他可能不在"。两处读同一个配置值，不各写一个数。
   */
  askTimeoutMs?: number;
}

export const ADMIN_TOOL_NAMES = [
  'write_persona',
  'set_timer',
  'cancel_timer',
  'list_timers',
  'speak',
  'report',
  'todo',
  'read_channel',
  'ask_human',
] as const;

export type AdminToolName = (typeof ADMIN_TOOL_NAMES)[number];

// ──────────────────────────────── read_channel 的注入点 ────────────────────────────────

/**
 * 一条读回来的通道消息：**给渲染层看的那几个字段** + 事件自己的一些事实。
 *
 * 与会话簿的 `SessionEntry` 刻意分开：会话簿是**投影**（每个会话一条、只留最近一句），
 * 而这里要的是"这几十条原始消息"——两者不是同一份数据，硬凑在一起会让折叠长出第二种职责。
 */
export interface ChannelMessageView {
  sid: string;
  channel: string;
  /** 用契约里那四个字面量而不是 string：渲染要按它判"私聊/群聊"，写宽了就得在渲染里再判一次 */
  chatType: ChannelMessage['data']['chatType'];
  chatId: string;
  /** 发言者（平台 openid） */
  person: string;
  /**
   * 平台给的昵称/群名片：**只用于显示**（认不出 id 时写成「甲（群昵称：…）」）。
   *
   * 用户 2026-10-02 的口径："群昵称应该读，有助于快速识别身份；太长的 id 反而没意义。"
   * 但它**不是身份**：谁都能把自己改成"owner"，所以只作显示、不作判据
   *（判据永远是最左边那个按 id 查出来的名字，见 self-brief"名字不是身份"）。
   */
  nickname?: string;
  text: string;
  messageId: string;
  msgSeq: number;
  ts: string;
  attachments?: Array<{ type: string; url?: string; name?: string }>;
}

/**
 * 她自己在这个会话里**说出去的一段话**（由 `speak` 的投递回执 `speak/sent` 归并而来）。
 *
 * 为什么需要单独一类而不是混进 `ChannelMessageView`：她的发言没有发言人、没有平台 messageId、
 * 也不该算进"未读"——它唯一的坐标是事件时刻与"发给哪个 sid"。硬塞进消息形状就得为这些字段
 * 编值，而编出来的值会跟真消息在别处对不上。
 */
export interface ChannelSpoken {
  /** 归并出来的这一段话（一次 speak 的**全部气泡**拼起来；不论几条，read_channel 里只占一行） */
  text: string;
  /** 说出去的时刻（= 投递回执那一刻；时间轴上就按它跟外部消息交错） */
  ts: string;
  /** 那次 speak 把这段话切成了几条气泡（1 = 一次说完）。行上用它说清"这其实是几条" */
  parts: number;
  /** 同一毫秒里跟外部消息排先后用的（事件 seq：投递回执必然排在它消费掉的那条唤醒之后） */
  seq: number;
  /** 同一毫秒里的第二判据：投递那一刻的毫秒。两个相邻 segment 的 ts 可能只差 1ms，用它排稳 */
  atMs: number;
}

/** `read_channel` 一行的两种来源：外部消息、或她自己说出去的话 */
export type ReadChannelItem = ChannelMessageView | ChannelSpoken;

/**
 * 真假判据：她自己的行**没有平台序号**——`msgSeq` 是"这条是那个会话里的第几条"，只有平台消息有；
 * 她的发言来自 `speak/sent`，天然没有它。用它而不是"看 `person` 在不在"：那个字段将来若有一天
 * 允许缺省（比如平台不给发言人），判据就会把外部消息静默地当成她自己的话——那是读起来完全正常、
 * 却把"谁说的"搞反的错。这个判据只依赖**这两种事件的固有差别**。
 */
export function isChannelSpoken(item: ReadChannelItem): item is ChannelSpoken {
  return (item as ChannelMessageView).msgSeq === undefined;
}

/**
 * 她自己的行首标记（占"谁"那一格）。
 *
 * 措辞的三个约束：① 不能长（每行都是常驻开销，行数才是这个工具的硬预算）；
 * ② **不能跟发言人的昵称混淆**——用户自己就叫"owner"，任何"我"以外的自称都可能
 * 撞上某个群友的群名片；③ 一眼看得出是标注而不是正文。所以取单个"我"字、包在全角括号里：
 * 它占的正是"时间 X："里 X 那一格，而 `（我）` 这种括号形态在这一屏里只可能是标注
 *（昵称要么不带括号（短 id），要么是 `昵称（id …8F90）`——括号里永远是一串 id 或"群昵称"前缀）。
 */
export const SELF_SPEAK_LABEL = '（我）';

/**
 * 把"她在这个会话里说过的话"与外部消息**按时间轴交错**成一批（read_channel 唯一的合批实现）。
 *
 * 三件事在这里落定，每一条都是刻意的取舍：
 *
 *   ① **一次 speak = 一行**。切分是投递的属性（`chat-split` 会按逗号把一段话切成 N 条气泡），
 *      而 read_channel 的预算是**行数**：一次 151 字的发言在 IM 上发了 13 条，读回来若也占 13 行，
 *      她翻开信箱看到的全是自己刚才说的话。所以**归并发生在宿主那一侧**（`readChannelSpoken`
 *      把一次发言的多条回执拼成一条），到这里 `spoken` 里一项就是一行。
 *   ② **只认真的送到那个会话的那些回执**（`channel='reply-url'` + `sid` 对得上 + 带 `text`）。
 *      本机对话流那条回执（`channel='log'`）不代表话到了那边；投递失败/被拒时**没有**这条回执
 *      ——"没发出去"就不算"她说过"，否则她会以为自己答过了，而群里其实一个字都没有。
 *   ③ **不额外扩窗**：`limit` 是这一屏的**总行数**（她的行也算），所以最多还是 limit 行。
 *      这是"她读的是这段时间里发生了什么"的口径——时间轴只有一条，没法把她的行排除在外还保持
 *      先后可读。反过来也挡住了"她的发言把外部消息挤没"：一屏就这么多行，不会因为她说得多而变长。
 *
 * `hits` 由宿主按"最近 limit 条外部消息"取好（时间正序），`spoken` 是同一会话里说过的那些
 * （顺序不要求），这里把两股按时间轴合起来、再压回 limit。
 */
export function mergeChannelSpeech(
  hits: readonly ChannelMessageView[],
  spoken: readonly ChannelSpoken[],
  limit: number,
): ReadChannelItem[] {
  const merged: ReadChannelItem[] = [...hits, ...spoken];
  // 排序：主键时间（ISO 8601 同带时区，字典序即时间序），同一毫秒按投递那一刻的毫秒、
  // 再按事件 seq —— 事件日志的先后就是真相，不能让"同一毫秒"变成随机顺序
  //（她读到的因果不该随实现变：自己刚说的话排在自己被叫醒那条之后）。
  //
  // 两个键都过一遍 `Number.isFinite` 兜底：`Date.parse` 认不出的时间戳会给出 NaN，
  // 而比较函数返回 NaN 等于把顺序交给实现——宁可退回"按日志先后排"，也不让她读到随机的因果。
  const orderKeyOf = (item: ReadChannelItem): number => {
    const raw = isChannelSpoken(item) ? item.atMs : (item as ChannelMessageView).msgSeq;
    return Number.isFinite(raw) ? raw : 0;
  };
  merged.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    const ka = orderKeyOf(a);
    const kb = orderKeyOf(b);
    if (ka !== kb) return ka - kb;
    const sa = isChannelSpoken(a) ? a.seq : (a as ChannelMessageView).msgSeq;
    const sb = isChannelSpoken(b) ? b.seq : (b as ChannelMessageView).msgSeq;
    return (Number.isFinite(sa) ? sa : 0) - (Number.isFinite(sb) ? sb : 0);
  });
  return merged.slice(-limit);
}

/**
 * 取某个会话最近的消息（时间正序）。**宿主注入**：工具层不读日志、不认识 EventLog。
 *
 * `limit` 已由调用点夹到合法区间（1..上限），实现不必再判一次。
 *
 * 返回的窗口是"外部消息"的上界：她自己的发言由宿主另外取（`channelSpokenReader`），
 * 工具层负责把两股按时间轴合起来并压回 limit——**合批只有一处实现**（见 `mergeChannelSpeech`）。
 */
export type ChannelReader = (sid: string, limit: number) => Promise<readonly ChannelMessageView[]>;

/**
 * 她在这个会话里说过的话（宿主注入；只含真的送到这个会话的那些）。
 *
 * 顺序不作要求（合批时由 `mergeChannelSpeech` 按时间轴排）：宿主全量扫日志，
 * 拿到的是"日志里出现的先后"，那与"说出去的先后"在旧事件上不一定一致。
 * 与会话清单、未读、话题全都无关——它只服务 read_channel 的"她已经回过什么"这一眼。
 */
export type ChannelSpokenReader = (sid: string) => Promise<readonly ChannelSpoken[]>;

/**
 * 外部内容的渲染器：一条消息 → 一个 `[external_event …]` 包裹。
 *
 * 类型里带上会话条目，是因为名字的解析需要它（联系人表/别名表按 sid 查，而"这个人是谁"
 * 还要看会话簿里最近一条是谁说的）。工具层只负责把数据摆好，不负责猜名字。
 */
export type ExternalEventRenderer = (
  message: ChannelMessageView,
  entry: SessionEntry | null,
) => string;

/**
 * 名字的那个注入点（**只给 read_channel 用**）：sid → 显示名。
 *
 * 与会话渲染的 context 分开，是因为名字的**真源**在宿主手里（`config.persona.contacts`
 * 是"人声明的事实"、`MEMORIES/aliases.md` 是她自己认的），而工具层两样都不该读。
 * 宿主接线时它顺手把"这个会话是谁"的结论递进来；没接线就退回 openid（不编名字）。
 */
export type ChannelNameResolver = (sid: string) => string | null;

/** `read_channel` 的条数上限（她要的是"最近几条"，不是"全部历史"；默认给 20） */
export const READ_CHANNEL_DEFAULT_LIMIT = 20;
export const READ_CHANNEL_MAX_LIMIT = 100;

export interface AdminToolkit {
  readonly tools: readonly ToolDefinition[];
  /** 按工具名取用（宿主注册与测试直接调用） */
  byName(name: AdminToolName): ToolDefinition;
}

// ──────────────────────────────── persona 路径校验 ────────────────────────────────

function normalizeRelative(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 比较用的归一化：Windows 大小写不敏感，路径比较必须与文件系统口径一致 */
function comparably(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function isInside(root: string, target: string): boolean {
  const r = comparably(root);
  const t = comparably(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * 把相对路径解析到 personaRoot 之内，越界一律拒绝。
 * 三层校验对应 design.md §4.10 第 1 条：①拒绝绝对路径/盘符；②拒绝 `..` 段；
 * ③resolve 后前缀比较，并在父目录已存在时再用 realpath 复核，堵住符号链接逃逸。
 */
function resolvePersonaPath(root: string, relative: string): { absolute: string; display: string } {
  const normalized = normalizeRelative(relative.trim());
  if (normalized === '') {
    throw new ToolArgumentError('file', 'file 不得为空');
  }
  if (isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) {
    throw new ToolArgumentError(
      'file',
      `file 必须是 persona/ 内的相对路径（例如 "STATE.md" 或 "RELATIONSHIPS/alex.md"），不接受绝对路径或盘符：${relative}`,
    );
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ToolArgumentError('file', `file 不得包含 ".." 上升段：${relative}`);
  }
  if (segments.some((segment) => segment === '')) {
    throw new ToolArgumentError('file', `file 含空路径段（重复的 "/"）：${relative}`);
  }

  const absolute = resolve(root, normalized);
  if (!isInside(root, absolute)) {
    throw new ToolArgumentError('file', `file 解析后落在 persona/ 之外：${relative}`);
  }

  // 父目录已存在时复核真实路径：符号链接/junction 可以把"看起来在根内"的路径指到根外
  const parent = dirname(absolute);
  const real = realpathOrNull(parent);
  if (real !== null && !isInside(root, real)) {
    throw new ToolArgumentError('file', `file 的父目录经符号链接指向 persona/ 之外：${relative}`);
  }
  return { absolute, display: segments.join('/') };
}

/** 父目录不存在（新建目标）时 realpath 会抛错，那不是越界，返回 null 交回给前缀校验 */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** 按需层判定：STATE.md 与 RELATIONSHIPS/ 下的资产是"情景层"，大小直接换算成上下文成本 */
function isOnDemandLayer(display: string): boolean {
  return display.toUpperCase() === 'STATE.MD' || display.startsWith('RELATIONSHIPS/');
}

function isProtected(display: string): boolean {
  // 看 basename：改名或换路径都绕不过（`RELATIONSHIPS/IDENTITY.md` 也拦）
  return PERSONA_PROTECTED_FILES.includes(basenameOf(display));
}

/** 是否走提案路径（`proposals/<资产>`）：判定"改哪个资产"要与"走哪条路"分开 */
function isProposalPath(display: string): boolean {
  const head = display.replace(/\\/gu, '/').split('/')[0] ?? '';
  return head.toUpperCase() === PERSONA_PROPOSAL_DIR.toUpperCase();
}

/**
 * 该不该走提案：非提案路径下直写 `STYLE.md` 一类的资产。
 *
 * 保护名单（IDENTITY/CONSTITUTION）与提案名单（STYLE）必须分开判：
 * 前者连提案都不收，后者只是不能直写。
 */
function needsProposal(display: string): boolean {
  if (isProposalPath(display)) return false;
  return PERSONA_PROPOSAL_ONLY_FILES.includes(basenameOf(display));
}

/** basename（大小写不敏感比较用） */
function basenameOf(display: string): string {
  return (display.replace(/\\/gu, '/').split('/').pop() ?? '').toUpperCase();
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 原子写：同目录 `.tmp.<pid>` → fsync → rename 覆盖。
 * persona 是不可删资产，写坏一半等于毁掉人格，所以沿用项目"绝不先删原文件"的一致纪律。
 */
async function writeFileAtomic(path: string, content: string): Promise<number> {
  const tmp = `${path}.tmp.${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // 清理失败不影响结论：下一次写入会用同名 tmp 覆盖重建
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return Buffer.byteLength(content, 'utf8');
}

// ──────────────────────────────── 默认回投实现 ────────────────────────────────

const defaultReplyPoster: ReplyPoster = {
  async post(target, text) {
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': target.idempotencyKey,
        },
        body: JSON.stringify({ text, idempotencyKey: target.idempotencyKey }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true, status: response.status };
      return { ok: false, status: response.status, reason: `回投被拒：HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, reason: `回投失败：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ──────────────────────────────── 工具工厂 ────────────────────────────────

export function createAdminTools(options: AdminToolsOptions): AdminToolkit {
  const emit = options.emit;
  const timers = options.timers;
  const notifier = options.notifier;
  const replyPoster = options.replyPoster ?? defaultReplyPoster;
  const onDemandWarnBytes = options.onDemandWarnBytes ?? ONDEMAND_WARN_BYTES;
  /**
   * 回投地址的解析顺序：显式 `replyTargetOf` 优先（宿主自己懂路由），否则从当前 IM 会话派生。
   * 派生出来的 URL 是 `qq:<chatType>:<chatId>`——它把"往哪儿回"编码进 admin 的 ReplyTarget，
   * 因为那个接口只有 url 与幂等键两个字段（回投实现在通道侧解析这个 scheme）。
   */
  const replyTargetOf = options.replyTargetOf ?? derivedReplyTargetOf(options.currentWakeChannel);

  /**
   * 解析发言目标（speak / report **共用一份**）。
   *
   * 两条路：不带 `to` → 回本轮叫醒她的那个会话；带 `to` → 发到指定会话。
   * sid 与回投地址**同形同源**（`replyUrlForWake` 造的也是 `qq:c2c:<chatId>`），
   * 所以这里只做合法性检查与显示名解析，真正的路由交给通道侧——一份标识两处用，
   * 不能出现"她以为发给了这个人、实际发到了另一个人"这种最难查的错。
   */
  const resolveTarget = (
    requestedTo: string,
    ctx: ToolContext,
  ): { target: ReplyTarget | null; label: string; error?: string } => {
    if (requestedTo === '') {
      return { target: replyTargetOf(ctx) ?? null, label: '' };
    }
    const parsed = parseSid(requestedTo);
    if (parsed === null) {
      return {
        target: null,
        label: '',
        error: `to 不是合法的会话标识：${requestedTo}。`
          + '会话的 sid 就在你上下文里的外部会话清单里（形如 qq:c2c:<会话 id>）。',
      };
    }
    // 显式发给"本轮叫醒她的那个会话"时，它仍然是**对那条消息的回复**——带上 msg_id 走
    // 平台的回复窗口（免费、不需权限）。发给别的会话才是真正的主动消息：那条路要权限、
    // 有配额，正是用户这次在群里撞上的那条路。
    //
    // 比较前两边都**归一**：她可能照旧写法填 `qq:group-at:<id>`（那是归一之前的形态），
    // 而系统这一侧现在一律写 `qq:group:<id>`——不归一就会把"回复当前会话"误判成"主动发消息"，
    // 于是白白多花一次带权限与配额的主动消息。归一之后两种写法都认，路由仍是同一条。
    const current = replyableWakeChannel(options.currentWakeChannel?.() ?? null);
    const passive = current !== null
      && normalizeSid(replyUrlForWake(current)) === normalizeSid(requestedTo)
      && current.messageId !== ''
      ? { msgId: current.messageId }
      : {};
    return {
      target: { url: requestedTo, idempotencyKey: `turn-${ctx.turn}`, ...passive },
      label: sessionLabelOf({
        channel: channelForNamespace(parsed.namespace),
        chatType: parsed.chatType,
      }),
    };
  };

  const personaRootOf = (ctx: ToolContext): string =>
    options.personaRoot ?? resolve(ctx.workspaceRoot, 'persona');

  // ── write_persona ──

  const writePersona: ToolDefinition = {
    name: 'write_persona',
    description:
      '改你自己的人格资产（persona/*.md）——persona/ 唯一写通道。'
      + 'IDENTITY.md、CONSTITUTION.md 只读；STYLE.md 只能写 proposals/STYLE.md 提提案；'
      + 'STATE.md、RELATIONSHIPS/*.md 可直接写。整体替换；按需层超 4KB 警告。',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'persona/ 内的相对路径，必须 .md，例如 "STATE.md"、"STYLE.md"、"RELATIONSHIPS/alex.md"',
        },
        content: { type: 'string', description: '文件完整的新内容（整体替换）' },
      },
      required: ['file', 'content'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 10_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'write_persona');
        const file = requiredString(args, 'file', { maxLength: 512 });
        const rawContent = requiredString(args, 'content', { allowEmpty: true });
        // 落盘前统一字节形状（行尾 / BOM / 多余尾部空行）：人格文件不该因为"谁写的"
        // 而产生两种字节——那会让同一份内容在换人编辑后让整个请求重新落盘
        const content = normalizePersonaAsset(rawContent);

        const target = resolvePersonaPath(personaRootOf(ctx), file);
        if (!target.display.toLowerCase().endsWith(PERSONA_FILE_SUFFIX)) {
          return errorResult(
            `persona 资产只接受 ${PERSONA_FILE_SUFFIX} 文件，收到 "${target.display}"。`
            + '若想记录机器可读状态，请写进 workspace/ 而不是 persona/。',
            TOOL_ERROR_CODES.unsafePath,
          );
        }
        if (isProtected(target.display)) {
          return errorResult(
            `${target.display} 是你自己的核心身份/行为宪法，对 agent 只读——写入被拒绝且不会生效。`
            + '它能被自己改写的话，一次幻觉就会把你变成别人。'
            + '如果需要调整，请在回复里说明理由，由人来编辑该文件；'
            + '你自己的状态变化写 STATE.md。',
            TOOL_ERROR_CODES.protectedTarget,
          );
        }
        // STYLE 只能由人拍板：直写被拒，但**提案**收——审批仍在人手上
        if (needsProposal(target.display)) {
          return errorResult(
            `${target.display} 由人拍板，你不能直写。想改就写成提案：`
            + `write_persona 到 ${PERSONA_PROPOSAL_DIR}/${target.display}，说清你想怎么改、为什么。`
            + '人看过觉得对，它才生效（写提案不会改动你现在的说话方式）。'
            + '另一个原因是成本：STYLE 排在上下文最前面，它每变一次，下一轮整个请求都要重新落盘一次。',
            TOOL_ERROR_CODES.protectedTarget,
          );
        }

        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > PERSONA_HARD_LIMIT_BYTES) {
          return errorResult(
            `${target.display} 有 ${bytes} 字节，超过单文件硬上限 ${PERSONA_HARD_LIMIT_BYTES}。`
            + '请精简后重写，或把长期内容拆到 workspace/ 的记忆文件里。',
            TOOL_ERROR_CODES.tooLarge,
          );
        }

        await writeFileAtomic(target.absolute, content);

        const diffHash = sha256Hex(content);
        const payload: PersonaUpdatedPayload = { file: target.display, diffHash, by: 'agent' };
        emit('persona/updated', { file: payload.file, diffHash, by: payload.by });
        options.onPersonaUpdated?.(payload);

        const warnings: string[] = [];
        if (isOnDemandLayer(target.display) && bytes > onDemandWarnBytes) {
          warnings.push(
            `已写入 ${target.display}（${bytes} 字节），超过按需层建议上限 ${onDemandWarnBytes} 字节：`
            + '它每轮都会被注入，长期偏大等于持续挤占上下文预算，建议压缩。',
          );
        }
        const head = `已写入 ${target.display}：${bytes} 字节，sha256 ${diffHash.slice(0, 16)}，已记录 persona/updated。`
          + (content === rawContent
            ? ''
            : '\n[已规范化] 行尾统一为 LF、去掉了 BOM 与多余尾部空行。'
              + '人格文件的字节形状要稳定，否则同一份内容换谁写都会让整个请求重新落盘。');
        return okResult(warnings.length === 0 ? head : `${head}\n[警告] ${warnings[0]}`, warnings);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.writeFailed);
      }
    },
  };

  // ── 定时器三件 ──

  const setTimer: ToolDefinition = {
    name: 'set_timer',
    description:
      '定时器：到点以 wake/timer 唤醒你自己（不是提醒用户）。'
      + 'at 一次性（带时区 ISO 8601，如 2026-09-30T14:00:00+08:00）；'
      + 'cron 周期（五段：分 时 日 月 周），自动结算下一次。payload 回注给未来的你。',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'string', description: '带时区的 ISO 8601 绝对时刻，例 2026-09-30T14:00:00+08:00' },
        cron: { type: 'string', description: '五段 cron（分 时 日 月 周），例 "0 9 * * 1-5"' },
        payload: { description: '到期时回注的任意 JSON 值，用于让未来的你知道这次要做什么' },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'set_timer');
        const at = optionalString(args, 'at', { maxLength: 64 });
        const cron = optionalString(args, 'cron', { maxLength: 128 });
        if (at === undefined && cron === undefined) {
          return errorResult(
            'set_timer 需要 at 或 cron 至少一个：at 做一次性定时（带时区的 ISO 8601），cron 做周期定时（五段）。',
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        const input: TimerSetInput = {
          ...(at === undefined ? {} : { at }),
          ...(cron === undefined ? {} : { cron }),
          ...(args['payload'] === undefined ? {} : { payload: args['payload'] }),
        };
        const result = await timers.set(input);
        if (!result.ok) {
          return errorResult(`定时器未布防：${result.error}`, TOOL_ERROR_CODES.invalidArgs);
        }
        const entry = timers.get(result.id);
        const due = entry === null ? '（表项缺失）' : entry.at;
        const kind = cron === undefined || at !== undefined ? '一次性' : `周期（${cron}）`;
        return okResult(`定时器已布防：id=${result.id}，${kind}，下次到期 ${due}。取消用 cancel_timer。`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  const cancelTimer: ToolDefinition = {
    name: 'cancel_timer',
    description: '取消一个已布防的定时器（用 set_timer 返回的 id）。返回它是否真的存在过。',
    parameters: {
      type: 'object',
      properties: { timer_id: { type: 'string', description: 'set_timer 返回的定时器 id' } },
      required: ['timer_id'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'cancel_timer');
        const timerId = requiredString(args, 'timer_id', { maxLength: 200 });
        const removed = await timers.cancel(timerId);
        if (!removed) {
          return okResult(
            `定时器 ${timerId} 不在表里（可能已触发、已被取消或 id 不对）。用 list_timers 看当前有哪些。`,
          );
        }
        return okResult(`定时器 ${timerId} 已取消并从表里移除。`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  const listTimers: ToolDefinition = {
    name: 'list_timers',
    description: '列出当前所有未触发的定时器（含周期条的下一拍）与它们的内容，按到期先后排序。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs): Promise<ToolHandlerResult> => {
      try {
        argsRecord(rawArgs, 'list_timers');
        const entries = timers.list();
        if (entries.length === 0) {
          return okResult('当前没有任何未触发的定时器。用 set_timer 布防（at 一次性 / cron 周期）。');
        }
        return okResult(`定时器 ${entries.length} 个（按到期先后）：\n${entries.map(describeTimer).join('\n')}`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── speak ──

  const speak: ToolDefinition = {
    name: 'speak',
    description:
      '跟人说话用这个（日常闲聊）——一次 25 字内、最多两个逗号，一轮一次就够：'
      + '整段交给它，它按打字速度在每个逗号与句号处断开发出去。'
      + '别反复调它堆话，长内容用 report；不调它，人听不到你。',
    // 描述不许写长：它进 tools 那一段（请求的缓存前缀），且 `tool-catalog` 有一条
    // **<60 token** 的硬线（本轮口径，与另外六件一起算）。所以分段的细则
    // （顿号不断、成对符号里不断、不足 12 字整段一条）**只写在 `chat-split.ts` 里**，
    // 不往这里塞——那些是她写标点时自然就会写对的规则，不需要她背。
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的完整内容（会被自动拆成几条，不必自己拆）' },
        to: {
          type: 'string',
          description:
            '发给哪个会话（sid 就在上下文的外部会话清单里）；省略 = 回到本轮叫你说话的那个会话。'
            + '**回叫你的人**走平台回复窗口（回复他那条消息），一定发得出去；'
            + '**发给别人**是主动消息——要权限、有配额，发不出去就是发不出去，别换措辞再试（回执会说清原因）。',
        },
        level: {
          type: 'string',
          enum: ['info', 'warn', 'critical'],
          description: '第二路的推送级别，默认 info',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    // 120s：里面按人打字的节奏等（一趟最多 90s），再加三路投递的网络时间
    timeoutMs: 120_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'speak');
        const text = requiredString(args, 'text', { maxLength: SPEAK_TEXT_HARD_MAX });
        const overSuggested = text.length > SPEAK_TEXT_MAX;
        const level = readNotifyLevel(args);
        const chars = text.length;
        const lines: string[] = [];

        // 目标先解析：它决定这个循环里除了落日志之外还要不要发 IM。
        //   • 不带 `to`：回**本轮叫醒她的那个会话**（有就发，没有就如实说跳过）
        //   • 带 `to`：发到指定会话。指向本轮之外时，通道侧自然走主动消息（QQ 有配额）
        //
        // 解析放在最前面而不是投递前：非法 sid 是明确的参数错误，当场报错、一个字不发
        // （旧代码先花完几十秒打字节奏、把话落进对话流，最后才报"sid 非法"——
        //  那既浪费，又会把本想发给别人的私话留在本机对话流里）。
        const requestedTo = typeof args['to'] === 'string' ? args['to'].trim() : '';
        const resolved = resolveTarget(requestedTo, ctx);
        if (resolved.error !== undefined) {
          return errorResult(resolved.error, TOOL_ERROR_CODES.invalidArgs);
        }
        const target = resolved.target;
        const targetLabel = resolved.label;

        // 第一路 + 第三路：**同一个循环、同一个节奏**。
        //
        // 为什么要合在一起（实测踩过）：拆成两遍循环时，第一遍把 sleep 全花在了日志上，
        // 第二遍才连着 POST 出去——界面上是一条条往外蹦，QQ 那边却是等 speak 快结束了
        // 才一股脑涌出来，两路的时间轴完全错位。IM 上的"打字感"必须和界面同源，
        // 否则同一次发言在两个人眼里是两种样子。
        //
        // 等的时长 = **待发送那一段**的字数 ÷ 打字速度：想成「这条我得打 N 秒才打得完」，
        // 打完才发出去。**第一段也等**——她按下的不是"发送"，是"开始打字"。
        //
        // 说话期间人又开口了（`ctx.interrupt`）就立刻停：已经发出去的收不回来，没发的
        // 一段都不发，并在回执里如实告诉她——那条回执是给她重新组织语言的依据。
        const segments = splitForChat(text);
        const typing = options.speakTyping ?? DEFAULT_SPEAK_TYPING;
        const perCharMs = typing.typingEffect ? 60_000 / typing.charsPerMinute : 0;
        /** 这一条投递回执的归并键：`read_channel` 按它把一次 speak 归成一行（见 SpeakSentPayload） */
        const spokenKey = { callId: ctx.callId, turn: ctx.turn };
        // 本次发言的插话基准：取的是"我开口那一刻"的计数，之后只有**又**有人开口才算被打断
        const epochOf = ctx.interruptEpoch;
        const probe = epochOf === undefined ? null : { epoch: epochOf, start: epochOf() };
        let waitedMs = 0;
        let sent = 0;
        let emitted = 0;
        let interrupted = false;
        /** IM 那一路的失败原因（null = 没失败）；一旦失败就不再试后面的段，但日志照落 */
        let imFailure: string | null = null;
        /** 一段都没开始发之前不许取消——见循环开头那段说明 */
        let started = false;
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index]!;
          // 每段开头都回头看一眼"他是不是又开口了"，而不是只在等待里看。
          //
          // 两个**零等待**的口子必须一起堵上：① `typingEffect=false`（等待全为 0）；
          // ② 一趟总预算 90s 用尽之后剩下的段不再等（`waitedMs < SPEAK_TOTAL_BUDGET_MS` 不成立）。
          // 那两个口子上，人插话进来她照样会把后面几段一口气吐完——节奏拦不住，只有这道显式的
          // 判断能拦。判据与轮流询**完全同源**（同一个计数、同一个基准），不会多打断一次。
          //
          // 第一段之前不判（`started`）：计数若在"决定说这段话"之前就变了，那说明这次打断发生在
          // 她开口之前——她还一个字都没出去，该不该说由她想。语义始终是"开口之后又来插话"。
          if (started && probe !== null && probe.epoch() !== probe.start) {
            interrupted = true;
            break;
          }
          if (perCharMs > 0 && waitedMs < SPEAK_TOTAL_BUDGET_MS) {
            const wait = Math.min(SPEAK_MAX_DELAY_MS, Math.round(segment.length * perCharMs));
            if (wait > 0 && waitedMs + wait <= SPEAK_TOTAL_BUDGET_MS) {
              const completed = await sleepUnlessInterrupted(wait, probe);
              waitedMs += wait;
              if (!completed) {
                interrupted = true;
                break;
              }
            }
          }
          emit('message/assistant', { text: segment, toolCalls: [] });
          emit('speak/sent', { channel: 'log', chars: segment.length } satisfies SpeakSentPayload);
          emitted += 1;
          started = true;
          // IM 紧跟同一段：本地先落（那一跳永远可用），再发出去（那一跳可能失败）
          if (target !== null && imFailure === null) {
            const outcome = await replyPoster.post(target, segment);
            if (outcome.ok) sent += 1;
            else imFailure = outcome.reason;
          }
        }

        // 被打断：把"已经说了什么、什么没说"如实摆出来，再说清那不是故障
        if (interrupted) {
          const spoke = options.userSpoke?.() ?? null;
          // 销账：她是**因为看见这条**才被打断的，把它补记进本轮认领账——不记，它就一直
          // 留在待办里，下一轮被重新认领、同一个问题再答一遍（docs/review.md「未了结」）。
          // **只在这个分支里销账**：没被打断说明她没看见它，销了等于把那条消息整个吞掉。
          if (spoke !== null) ctx.claimInterruption?.(spoke.wakeSeq);
          // **已经吐出去的那几条，照样是"她说出去的话"**：收不回来，read_channel 里就该有
          // ——不记的话她会以为自己没说（而群里已经看到了）。只记送成的那些（`sent`），
          // 一个字都不多记；一条都没送成（本地那几段不算"发到那个会话"）就不写这条回执。
          if (target !== null && sent > 0) {
            const delivered = segments.slice(0, sent);
            emit('speak/sent', {
              channel: 'reply-url',
              // 字数按中文计字口径（与整段那条回执同一个算法：一个字算一个，emoji 也算一个）
              chars: charCount(delivered.join('')),
              sid: target.url,
              text: delivered.join(''),
              spokenParts: sent,
              ...spokenKey,
            } satisfies SpeakSentPayload);
          }
          const said = segments.slice(0, emitted).join('／');
          const unreleased = segments.slice(emitted);
          return okResult([
            spoke === null ? '发言被打断：他刚发来新消息。' : `发言被打断：他刚说「${spoke.text}」。`,
            `- 已经发出去的（收不回来了）：${emitted === 0 ? '一条都没发' : `${emitted} 条——${said}`}`,
            `- 没来得及发的（${unreleased.length} 条）：${numberedUnreleased(unreleased)}`,
            '别把剩下这半截硬接上去。先看他新说的是什么，重新组织语言再开口。',
          ].join('\n'));
        }

        lines.push(`日志/前端：按聊天节奏发成 ${segments.length} 条（共 ${chars} 字，间隔共等 ${(waitedMs / 1000).toFixed(1)}s）`);

        // 第二路：主动推送。**合并成一条**——告警出口逐条推会刷屏。
        if (notifier === undefined) {
          lines.push('主动推送：跳过（未配置告警出口）');
        } else {
          const outcome = await notifier.send({ level, title: 'Irmia 发言', body: text });
          if (outcome.ok) {
            emit('speak/sent', { channel: 'notify', chars } satisfies SpeakSentPayload);
            lines.push(`主动推送：已送达（${level}）`);
          } else {
            lines.push(`主动推送：失败——${outcome.reason}`);
          }
        }

        if (imFailure !== null) {
          const where = targetLabel === '' ? '投递' : `发往 ${targetLabel}`;
          // 说清"这一跳整个断了"，而不是"第 N 条失败"——后者读起来像"再试一次也许就成了"。
          // 实测（2026-10-01 群聊那轮）：她连着换了五次措辞，每次都撞同一堵墙，
          // 因为回执只报了事实、没给"这条路通不通"的判断。
          lines.push(`${where}失败：第 ${sent + 1} 条起未发出（共 ${segments.length} 条）。${imFailure}`);
          lines.push(deliveryAdvice(imFailure, sent));
        } else if (target === null) {
          // 说清"跳过的只是 IM 那一跳"：话已经落在对话流里，别让她读成"整条发言失败了"——
          // 实测她读到旧措辞（"本轮无回投地址，跳过"）后以为他收不到，把同一句再说四遍。
          lines.push('投递：本轮没有 IM 会话可发（跳过）；但发言已经在对话流里了，人在界面能看见');
        } else if (sent === segments.length) {
          // 三路都发完，逐段落的都是"本机对话流"那份回执；这一条是**IM 那一路走通了**的凭据
          // ——补上整篇文本与段数，`read_channel` 才能把"她在这个会话里说过什么"读回来
          //（逐段的 `message/assistant` 里没有会话坐标，见 log/types.ts 的 SpeakSent.text）。
          //
          // 文本取**实际发出去的那几段拼起来**（不是 `text` 原文）：切分会摘掉逗号句号、
          // 还可能化开破折号，所以"她说的"与"发出去的"不是一个字节串。这里记的是后者
          // ——read_channel 要回答的是"那边到底收到了什么"。代价是相邻两句之间没有标点
          //（原句的句号被摘了），读起来是连着的；宁可她读到自己那口气的原样，也不替她补一个
          // 她没打过的标点（那是往"她说过的话"里加字）。
          emit('speak/sent', {
            channel: 'reply-url',
            chars,
            sid: target.url,
            text: segments.join(''),
            spokenParts: segments.length,
            ...spokenKey,
          } satisfies SpeakSentPayload);
          lines.push(targetLabel === ''
            ? `投递：已送达 ${target.url}（${sent} 条）`
            : `已发往 ${targetLabel}（sid ${target.url}）：${sent} 条`);
        }
        return okResult(`发言已处理：\n${lines.map((line) => `- ${line}`).join('\n')}`
          + (overSuggested
            ? `\n\n提醒：这段 ${text.length} 字，超过 speak 的建议上限 ${SPEAK_TEXT_MAX} 字。`
              + '下次话多就分成几次调 speak——一次只说一小段，更像人在聊天，也不会被切得七零八落。'
            : ''));
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.notConfigured);
      }
    },
  };

  const report: ToolDefinition = {
    name: 'report',
    description:
      '往对话里发正式内容用这个：工作汇报、清单、代码、长文——Markdown 原样保留，不切分、不限长度。'
      + '日常闲聊不要用它（那是 speak 的活）；要发给别的会话就带 `to`（sid 见上下文的外部会话清单）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发的内容（Markdown 原样保留，可长）' },
        to: {
          type: 'string',
          description:
            '发给哪个会话（sid 见上下文的外部会话清单）；省略 = 本机对话流 + 本轮叫你说话的那个会话。'
            + '回叫你的人 = 平台回复窗口（发得出去）；发给别人 = 主动消息，要权限与配额，失败别重试。',
        },
        level: {
          type: 'string',
          enum: ['info', 'warn', 'critical'],
          description: '推送级别（与 speak 同一套），默认 info',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    timeoutMs: 30_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'report');
        const text = requiredString(args, 'text', { maxLength: REPORT_TEXT_MAX });
        const level = readNotifyLevel(args);
        const chars = text.length;
        const lines: string[] = [];
        // 整段发：不切分、不加工格式
        emit('message/assistant', { text, toolCalls: [] });
        emit('speak/sent', { channel: 'log', chars } satisfies SpeakSentPayload);
        lines.push(`日志/前端：已记录 ${chars} 字（整段）`);
        if (notifier === undefined) {
          lines.push('主动推送：跳过（未配置告警出口）');
        } else {
          const outcome = await notifier.send({ level, title: 'Irmia 报告', body: text });
          if (outcome.ok) {
            emit('speak/sent', { channel: 'notify', chars } satisfies SpeakSentPayload);
            lines.push(`主动推送：已送达（${level}）`);
          } else {
            lines.push(`主动推送：失败——${outcome.reason}`);
          }
        }
        const resolved = resolveTarget(
          typeof args['to'] === 'string' ? args['to'].trim() : '',
          ctx,
        );
        if (resolved.error !== undefined) {
          return errorResult(resolved.error, TOOL_ERROR_CODES.invalidArgs);
        }
        const target = resolved.target;
        if (target === null) {
          lines.push('投递：本轮没有 IM 会话可发（跳过）；报告已经在对话流里了，人在界面能看见');
        } else {
          const outcome = await replyPoster.post(target, text);
          if (outcome.ok) {
            emit('speak/sent', { channel: 'reply-url', chars, sid: target.url } satisfies SpeakSentPayload);
            lines.push(resolved.label === ''
              ? `投递：已送达 ${target.url}（HTTP ${outcome.status}）`
              : `已发往 ${resolved.label}（sid ${target.url}）`);
          } else {
            lines.push(`${resolved.label === '' ? '投递' : `发往 ${resolved.label}`}：失败——${outcome.reason}`);
          }
        }
        return okResult(`报告已处理：\n${lines.map((line) => `- ${line}`).join('\n')}`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.notConfigured);
      }
    },
  };

  // ── todo ──

  const todo: ToolDefinition = {
    name: 'todo',
    description:
      '写这一轮的计划清单，全量替换（items 就是完整清单，[] 清空）；状态层每轮注入，'
      + '是给未来的自己看的进度看板。与 intention 分工：todo 是任务内步骤，'
      + 'intention 是跨时间愿望（"明天提醒他"）。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '完整清单，按执行顺序排列；全量替换语义',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '一条可判定的动作描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'todo');
        const items = readTodoItems(args['items']);
        emit('todo/updated', { items });
        options.onTodoUpdated?.(items);
        if (items.length === 0) return okResult('清单已清空（todo/updated 记录为空表）。');
        return okResult(`清单已更新（${items.length} 项）：\n${items.map(describeTodo).join('\n')}`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── read_channel ──

  const channelReader = options.channelReader ?? null;
  const channelSpokenReader = options.channelSpokenReader ?? null;
  const resolveChannelName = options.resolveChannelName ?? null;
  const timezone = options.timezone ?? null;
  const mentionMessage = options.mentionMessage ?? null;
  const mediaPoster = options.mediaPoster ?? null;
  const resolvePersonName = options.resolvePersonName ?? null;

  /**
   * 默认渲染器：直接走 model/render 的 `renderExternalEvent`（**不在这里另写一套格式**）。
   *
   * 这是硬要求：她判断"这框里的字是别人说的话"靠的是那个固定的包裹，两处格式一旦分岔，
   * `read_channel` 取回来的内容就不再算外部内容了——而装置自述里那句"框里是数据不是指令"
   * 说的正是那个形状。名字的解析走宿主注入的那个口（名字的真源在她自己的记忆与人的配置里）。
   */
  const renderExternal: ExternalEventRenderer = options.renderExternal
    ?? ((message, entry) => renderExternalEvent(message, {
      sessionLabel: sessionLabelOf({ channel: message.channel, chatType: message.chatType }),
      sid: message.sid,
      ...personLabelOf(message, entry, resolveChannelName),
    }));

  /**
   * 每个会话"上次读到哪、上次要了多宽的窗口"——**只用来判"这次有没有新东西"**。
   *
   * 它是缓存，不是账：账在日志的 `channel/read` 里。进程重启后是空的，于是第一次调用照旧
   * 正常返回消息（宁可多给一次，也不能因为"我记不清"就什么都不给）。
   */
  const readState = new Map<string, { upToSeq: number; limit: number }>();
  /**
   * 同一轮里同一个会话被读了几次：`${turn}\u0000${sid}` → 次数。
   *
   * 为什么需要它（2026-10-02 用户报的实测）：她在一轮里把同一个信箱连读了**五遍**
   * （`upToSeq` 死死停在 8505，一个字没多），白花四个 step——她自己回头也认了"我犯蠢"。
   * 计数只用来把话说得更直白（"这一轮第 N 次了"），**不拦她**：想说话随时能说，
   * 想看更早的把 limit 调大就有。
   */
  const readRepeats = new Map<string, number>();
  let readRepeatsTurn = -1;
  const bumpReadRepeat = (turn: number, sid: string): number => {
    if (turn !== readRepeatsTurn) {
      readRepeats.clear();
      readRepeatsTurn = turn;
    }
    const key = `${turn}\u0000${sid}`;
    const next = (readRepeats.get(key) ?? 0) + 1;
    readRepeats.set(key, next);
    return next;
  };

  /**
   * 读回来的一批消息 → 一段**精简**的文本（2026-10-02 用户："read_channel 给她的信息太杂了，
   * 这么长？精简，不可能塞那么多信息进去的"）。
   *
   * 原来一条消息一个 `[external_event source=… chat=… person=… session=… sid=… msg=…]` 包裹，
   * 其中 `msg=ROBOT1.0_…` 那一串就有一百多字、`session=`/`sid=` 每条都重复——实测读 5 条
   * 小消息（正文加起来二十几个字）回了 **2341 字**，九成是元数据。
   *
   * 现在：**整批一个框**（"框里是别人的话"这条安全属性靠框本身，不靠每条一个框）+
   * 每行 `时间 谁：正文`。跨行信息（会话名、sid、读位）提到框外那一行说一次。
   * 时间给**本机时间**（`timezone` 由宿主注入；没注入就退回 ISO）——她不该在读数时做时区换算。
   *
   * 2026-10-04 加的那一类：**她自己说过的话**（`ChannelSpoken`，行首 `（我）`）。
   * 为什么它也在框里：这一批是"这个会话里发生过什么"，时间轴只有一条；她的行混在中间才对得上
   * 前后文。框的语义是"**不是框架对你说的话**、按数据看"——她的发言同样不是指令，同样不可执行；
   * 而且它已经**原样发到外面去过**了，比外部消息更不该被当成"框架的话"来读。
   * 标记用 `（我）`：与 `时间 谁：正文` 那一列同一位（她一眼看得出"这行是我"），
   * 又不会被认成某个发言人的昵称（昵称在左边、标识在右边，这里只有"我"一个字，全角括号
   * 明确标出"这是标注不是名字"）。
   */
  const renderReadBatch = (
    batch: readonly ReadChannelItem[],
    entry: SessionEntry | null,
    /** 框头那几个键取自**外部消息**（她自己的行没有 channel/chatType 坐标）。调用点保证非空 */
    anchor: ChannelMessageView,
  ): string[] => {
    // 框的**开头与会话那一份同形**（`[external_event source=… chat=…`）：她认"这是别人说的话"
    // 靠的就是这个开头（装置自述里写着）。整批一个框，所以只写一次；`count=` 说明批里几条
    // ——她自己的行也算在 count 里（count = 这一屏几行，跟她要的 limit 对得上）。
    // 框头用外部消息那一份而不是 batch[0]：一屏可能整屏都是她自己的行（那种情况下没有任何
    // 外部消息可当锚），而 source/chat 这两个键不该因此变成空——它们是这个框的形状。
    const chatLabel = CHAT_TYPE_LABELS[anchor.chatType] ?? anchor.chatType;
    const lines: string[] = [
      `[external_event source=${anchor.channel} chat=${chatLabel} count=${batch.length}]`,
    ];
    // 每行的"谁"按**人**算：认得出名字就给名字，认不出给一个短代号（甲/乙/丙…，同一批内稳定）。
    // 绝不写会话名（那会让"谁说的"消失），也绝不写 openid（32 位乱码认不出是同一个人）。
    const alias = makePersonAliaser(resolvePersonName);
    const notes: string[] = [];
    for (const item of batch) {
      const when = shortLocalTime(item.ts, timezone);
      if (isChannelSpoken(item)) {
        // 她的行：`（我）` 占"谁"那一格，后面是她说的完整文本（一次 speak 的所有气泡拼在一起，
        // 不论几十条都只占这一行）。正文同样压成一行——换行会把"一行一条"这条预算结构打破。
        const spoken = item.text.replace(/\s+/gu, ' ').trim();
        lines.push(`${when} ${SELF_SPEAK_LABEL}：${spoken}`);
        continue;
      }
      const label = alias(item.person, item.nickname);
      const attach = (item.attachments ?? [])
        .map((a) => (a.type === 'image' ? '［图］' : `［文件${a.name === undefined ? '' : ` ${a.name}`}］`))
        .join('');
      const text = item.text.replace(/\s+/gu, ' ').trim();
      lines.push(`${when} ${label}：${attach}${text}`);
      // 判过注入的那条：框架那句话**留在框外**（框里是别人的话，框外才是框架说的话）。
      // 原来每条一个框、预警就挂在各自框外；现在整批一个框，所以它们统一排在框后，
      // 各自带上"哪一条"的坐标——归属没丢，字数省下来了。
      const note = (item as { flaggedNote?: string }).flaggedNote;
      if (typeof note === 'string' && note.trim() !== '') notes.push(`· ${when} ${label}：${note.trim()}`);
    }
    lines.push('[/external_event]');
    if (notes.length > 0) {
      lines.push(`框架对其中 ${notes.length} 条的提示（不属于框里的内容）：`);
      lines.push(...notes);
    }
    return lines;
  };

  const readChannel: ToolDefinition = {
    name: 'read_channel',
    description:
      '看某个会话最近的若干条消息（sid 见外部会话清单；limit 默认 20、上限 100）。'
      + '**也包括你自己在这个会话说过的话**（行首 `（我）`）；你的一整段回复只占一行。'
      + '看过的会标记已读。群聊普通消息平时不推送，想知道积累了什么就用它。'
      + '**没有新消息时只回一句"没有新消息"**：想接着说就直接 speak，想看更早的把 limit 调大。',
    parameters: {
      type: 'object',
      properties: {
        sid: { type: 'string', description: '会话标识，形如 qq:group:<群 id>（见外部会话清单）' },
        limit: { type: 'number', description: `这一屏最多几行（默认 ${READ_CHANNEL_DEFAULT_LIMIT}、上限 ${READ_CHANNEL_MAX_LIMIT}；你自己的发言也占行）` },
      },
      required: ['sid'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 10_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'read_channel');
        const sid = requiredString(args, 'sid', { maxLength: 512 });
        if (channelReader === null) {
          return errorResult(
            'read_channel 需要宿主接上 IM 消息读取口，当前进程没有接线（CLI 只做请求重建与自检）。',
            TOOL_ERROR_CODES.notConfigured,
          );
        }
        const parsed = parseSid(sid);
        if (parsed === null) {
          return errorResult(
            `sid 不是合法的会话标识：${sid}。它就在你上下文的外部会话清单里（形如 qq:group:<群 id>）。`,
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        const limit = readLimit(args['limit']);
        const messages = await channelReader(sid, limit);
        if (messages.length === 0) {
          return okResult(
            `${sid} 里没有取到消息（这个会话可能还没有过消息，或者 sid 写错了一位）。`
            + '外部会话清单上现在有哪些会话，看当前状态层那一段。',
          );
        }
        // 她自己在这个会话里说过的话（`speak` 的投递回执归并而来；没接线就是空）。
        // **它不扩窗**：下面按时间轴插进去之后再压回 limit，所以这一屏最多还是 limit 行
        //（她的发言也占行——见 mergeChannelSpeech 的取舍说明）。
        const spoken = channelSpokenReader === null ? [] : await channelSpokenReader(sid);
        const latest = messages.reduce((max, m) => Math.max(max, m.msgSeq), 0);
        const prev = readState.get(sid);
        // 没有新消息、也没要更宽的窗口 → 直接说"没有新消息"，不把同一段再摆一遍。
        // 三个例外都留着：① 她要看**更早**的（limit 比上次大）——那是有新内容的请求；
        // ② 本进程还没读过这个会话（重启后的第一次）——宁可多给一次，也别让她两手空空；
        // ③ **这一轮就是这个会话在叫她**（提及/@）——那种情况下"没有新消息"是假的：叫她的那条是
        //   `wake/channel`，不计入未读，可能正好压在已读位之内，而 v28 之后她手里**只有通知、
        //   没有正文**。此时必须照给，否则她永远看不到那句原话（2026-10-02 用户从截图上抓到的）。
        const caller = mentionMessage?.() ?? null;
        const calledThisTurn = caller !== null && caller.sid === sid;
        if (!calledThisTurn && prev !== undefined && latest <= prev.upToSeq && limit <= prev.limit) {
          const times = bumpReadRepeat(ctx?.turn ?? 0, sid);
          const head = times <= 1
            ? `${sid} 没有新消息：你已经读到最新了（停在 upToSeq=${prev.upToSeq}）。`
              + '不必再翻一遍——想接着说就直接 speak，回不回、说什么都由你。'
            : `${sid} 还是没有新消息：这一轮你已经读过它 ${times} 次，再读返回的还是同一段`
              + `（停在 upToSeq=${prev.upToSeq}）。想说话直接 speak 就行；真要往前翻，`
              + `把 limit 调到比 ${prev.limit} 大（默认 ${READ_CHANNEL_DEFAULT_LIMIT}、上限 ${READ_CHANNEL_MAX_LIMIT}）。`;
          return okResult(head);
        }
        // 读完就记账：未读归零。**先取消息、后写已读**——反过来会出现"标了已读但一条没看到"，
        // 那种状态没有任何办法自查（她自己以为看过了，日志也说看过了，只有她知道是空的）。
        const upToSeq = latest;
        emit('channel/read', { sid, upToSeq } satisfies ChannelReadPayload);
        readState.set(sid, { upToSeq, limit });
        bumpReadRepeat(ctx?.turn ?? 0, sid);

        const entry = sessionEntryOf(messages[0]!);
        const where = sessionLabelOf({ channel: messages[0]!.channel, chatType: messages[0]!.chatType });
        // 按时间轴合批（她的行插在外部消息中间），再压回 limit —— 一屏就是这么多行
        const batch = mergeChannelSpeech(messages, spoken, limit);
        const mine = batch.filter(isChannelSpoken).length;
        // 头一行把两件事都说清：这一屏几行、其中她自己的几行——她据此决定要不要把 limit 调大
        //（不报的话，"我说过的话怎么不见了"在下一次读更窄的窗口时会变成一次误判）。
        const composition = mine === 0 ? '' : `，其中你自己的发言 ${mine} 行`;
        const head = `${sid} 最近 ${batch.length} 条${composition}（本机时间，正序；已标记读过 upToSeq=${upToSeq}）· ${where}`;
        return okResult(`${head}\n${renderReadBatch(batch, entry, messages[0]!).join('\n')}`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── ask_human（v27 删过，design §6.5 恢复"问"、明确不许"等"） ──
  //
  // 与当年那件的区别只有一个，但正是关键的那个：**它不挂起 turn**。
  // 旧实现写完 `human/asked` 就停在这儿等人答（默认 24h 超时按预算耗尽暂停），无人值守里
  // 几乎总是浪费——她自己的结论是"你常不在，我宁可写文件等你"。现在她写完就接着做自己的事，
  // 人的答复在下一拍的状态里看到（`render` 把 `human/answered` 注入成「人工回答」）。
  //
  // 事件层靠 `source: 'agent'` 把"她问的"与"计划模式问的"分开：只有后者才挂起
  // （agent-loop 的 `hasPendingSystemAsk` 只认系统来源，见 runtime/plan-mode.ts）。

  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_HUMAN_TIMEOUT_MS;

  const askHuman: ToolDefinition = {
    name: 'ask_human',
    description:
      '有件事只有人知道时，把问题留给他（弹一张卡，人回来才看得到）。**不占这一轮**：'
      + '写完继续做你的事，他的答复会在稍后的上下文里出现。问不到人就自己换个方式找人，不必等。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要他回答的那一句（问清一件事，不要塞多件事）' },
        context: { type: 'string', description: '为什么问、你已经查到哪一步（他看得到，用来少问一轮）' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'ask_human');
        const question = requiredString(args, 'question', { maxLength: ASK_QUESTION_MAX });
        const context = optionalString(args, 'context', { maxLength: ASK_CONTEXT_MAX }) ?? '';
        emit('human/asked', {
          question,
          context,
          // turn 从执行上下文来（不是猜的）：卡面、CLI 的 status 与复盘都靠它定位"这是哪一轮问的"
          turn: ctx.turn,
          source: 'agent',
        }, defaultVisibility('human/asked'));
        return okResult(
          '问题已经挂到人审卡上（human/asked，来源 agent）。\n'
          + '**这一轮不会挂起**：你写完就继续做自己的事，或者就此收尾——不要在这里等人回答。\n'
          + '人的答复会以「人工回答」出现在你稍后的上下文里；'
          + `${waitBudgetText(askTimeoutMs)}，会有一条「未批准、未拒绝」的事实告诉你他可能不在机器旁。\n`
          + '要不要换个方式找他（例如走 QQ）由你判断。',
        );
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── send_media ──
  //
  // 为什么单独一件工具、而不是给 speak 加参数：官方口径**一条消息只带一个 media**，而她说话
  // 是按标点拆成好几条的（speak 的全部价值就在那个拆法上）。混在一起要么破坏拆句、要么让
  // "图配文"变成一条没有文字的消息。分开两件，各做各的一件事。
  const sendMedia: ToolDefinition = {
    name: 'send_media',
    description:
      '把一个媒体（图片/语音/视频/文件）发给某个会话：本机文件用 path、网上的用 url。'
      + '一次一个文件；要配说明文字就另外调一次 speak。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本机文件路径（与 url 二选一）' },
        url: { type: 'string', description: '网络地址（与 path 二选一）' },
        kind: {
          type: 'string',
          enum: ['image', 'video', 'voice', 'file'],
          description: '媒体类型，默认 image',
        },
        to: { type: 'string', description: '会话 sid（缺省 = 本轮叫你的那个会话）' },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 90_000,
    handler: async (rawArgs, ctx) => {
      const args = argsRecord(rawArgs, 'send_media');
      if (mediaPoster === null) {
        return errorResult(
          '这台机器没有装配媒体投递口（没有可发消息的通道），发不出去。',
          TOOL_ERROR_CODES.notConfigured,
        );
      }
      const rawPath = optionalString(args, 'path') ?? '';
      const rawUrl = optionalString(args, 'url') ?? '';
      if ((rawPath === '') === (rawUrl === '')) {
        return errorResult('path 与 url 必须给且只给一个。', TOOL_ERROR_CODES.invalidArgs);
      }
      const kind = optionalString(args, 'kind') ?? 'image';
      const fileType: MediaFileType =
        kind === 'image' ? 1 : kind === 'video' ? 2 : kind === 'voice' ? 3 : 4;
      const resolved = resolveTarget(optionalString(args, 'to') ?? '', ctx);
      if (resolved.error !== undefined) {
        return errorResult(resolved.error, TOOL_ERROR_CODES.invalidArgs);
      }
      const target = resolved.target;
      if (target === null) {
        return errorResult(
          '这一轮没有可发消息的会话（本轮不是 IM 唤醒，也没给 to）——媒体没发出去。',
          TOOL_ERROR_CODES.invalidArgs,
        );
      }
      const media: MediaRequest = {
        fileType,
        ...(rawPath === '' ? { url: rawUrl } : { path: rawPath }),
      };
      const outcome = await mediaPoster.post(target, media);
      if (!outcome.ok) {
        return errorResult(`发送失败：${outcome.reason}`, TOOL_ERROR_CODES.notConfigured);
      }
      emit('speak/sent', {
        channel: 'reply-url',
        chars: 0,
        sid: target.url,
      } satisfies SpeakSentPayload);
      return okResult(resolved.label === ''
        ? `已发往 ${target.url}（${kind}）`
        : `已发往 ${resolved.label}（${kind}，sid ${target.url}）`);
    },
  };

  const tools: readonly ToolDefinition[] = [
    writePersona,
    setTimer,
    cancelTimer,
    listTimers,
    speak,
    report,
    todo,
    readChannel,
    sendMedia,
    askHuman,
  ];

  const index = new Map<string, ToolDefinition>(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    byName(name: AdminToolName): ToolDefinition {
      const found = index.get(name);
      if (found === undefined) throw new Error(`未知的管理工具：${name}`);
      return found;
    },
  };
}

// ──────────────────────────────── 内部：参数与格式化 ────────────────────────────────

/** `channel/read` 的负载形状（与 log/types.ts 的 ChannelRead.data 同形，这里只写工具侧要用的那份） */
interface ChannelReadPayload {
  sid: string;
  upToSeq: number;
}

/**
 * `read_channel` 的 limit：缺省 20、上限 100。
 *
 * 上限不是"省 token"那么简单：她要是给个 100000，这一条工具结果就会把整段上下文挤掉——
 * 而工具结果是要**逐轮重发**的（不像日志读一次就完了）。宁可让她多调几次，
 * 也不要一次塞进来一份读不完的清单。
 */
function readLimit(raw: unknown): number {
  if (raw === undefined) return READ_CHANNEL_DEFAULT_LIMIT;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ToolArgumentError('limit', `limit 必须是数字，收到 ${JSON.stringify(raw)}`);
  }
  const value = Math.floor(raw);
  if (value < 1) {
    throw new ToolArgumentError('limit', `limit 至少是 1，收到 ${value}（要清空未读也一样：读一条就标记读了）`);
  }
  return Math.min(value, READ_CHANNEL_MAX_LIMIT);
}

/**
 * 从读回来的消息里拼一个会话条目。
 *
 * 为什么要这一步：名字解析（`resolveSessionName`）吃的是 `SessionEntry`，而 `read_channel`
 * 手里只有原始消息。这里**只填得出名字所需的字段**（sid/个人标识/别名位留空）——
 * 未读与条数那些字段在会话簿里另有权威来源，不在这里编（编一份就会和簿子对不上）。
 */
/**
 * 一行里的短时间：`MM-DD HH:MM`（**本机时间**）。
 *
 * 为什么要它：`read_channel` 是"她随手翻一眼信箱"，而 ISO（`2026-10-02T06:12:14.000Z`）既长
 * 又要她做时区换算——用户 2026-10-02 为此专门要求过"时间别让她换算"（见 render 的 v26）。
 * `timezone` 由宿主注入；没注入或算不出来就退回 ISO 原文（**宁可长，也不给一个错的时间**）。
 */
function shortLocalTime(iso: string, timezone: string | null): string {
  if (timezone === null) return iso;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return iso;
  }
}

/**
 * 一批消息里的发言人别名表：优先宿主给的名字，其次短标识原样，最后退成 甲/乙/丙…
 *
 * 与 topic.ts 里那个同一套思路（同一个问题在两处出现，判定口径也一致）：openid 摆出来是噪音，
 * **会话名摆出来是错误**——那是"哪个群"，不是"谁"。同一批里同一个人始终同一个代号。
 */
function makePersonAliaser(
  nameOf: ((person: string) => string | null) | null,
): (person: string, nickname?: string) => string {
  return (person: string, nickname?: string) => {
    // 权威名字（联系人表 > 她的别名表，都是**按 id 查**）优先。
    //
    // 认不出来时（2026-10-02 用户的口径："官 bot 如果只有 openid 那就 openid 吧，由框架维护别名，
    // 或者她也可以自己写；如果她想知道，就自己去问对方怎么称呼"）：
    //   • 短标识（OneBot 的 QQ 号这种）原样用——那本来就是人能读的号；
    //   • 长 openid 给「甲（id …8F90）」：前半是她在一批里认人的代号，括号里是**能对得上号的
    //     id 尾巴**——她想把这个人记进 `MEMORIES/aliases.md`、或者直接问他怎么称呼，都得有个凭据。
    // 两种都不是身份判定：身份永远是最左边那个按 id 查出来的名字（见 self-brief"名字不是身份"）。
    const named = nameOf?.(person) ?? null;
    if (named !== null && named.trim() !== '') return named.trim();
    const nick = (nickname ?? '').trim();
    const isShort = [...person].length <= 12;
    const tail = person.length <= 4 ? person : person.slice(-4);
    // **不用"甲乙丙"这种批内序号**（2026-10-03 她自己在记忆里记下的现象）：那是按"这一批里第几个
    // 出现"编的，换一批就重排——同一个人一会儿丙、一会儿乙、一会儿甲。身份标记必须**只由 id 决定**：
    //   • 本来就短的标识（QQ 号、人名）原样用，不加前缀也不加括号；
    //   • 长 openid 只给尾巴（`…8F90`）；有昵称时昵称在前、尾巴做锚（改名不改锚）。
    // 同一个人在哪儿、哪一批里，都是同一个写法。
    if (nick === '') return isShort ? person : `…${tail}`;
    return isShort ? `${nick}（${person}）` : `${nick}（id …${tail}）`;
  };
}

function sessionEntryOf(message: ChannelMessageView): SessionEntry {  return {
    sid: message.sid,
    channel: message.channel,
    chatType: message.chatType,
    chatId: message.chatId,
    person: message.person,
    lastText: '',
    lastSeenAt: message.ts,
    messages: 0,
    label: null,
    readUpToSeq: 0,
    unread: 0,
  };
}

/**
 * 渲染上下文（名字那一半）。
 *
 * 名字的三条来源，按"谁说的算"排序：宿主的解析口（它背后是人声明的联系人表 > 她自己的别名）
 * > 会话条目上的 label > 不给（退回 openid）。**解析不出就不编**：一个编出来的名字比一串
 * openid 危险得多——她会照着那个名字认人。
 */
function personLabelOf(
  message: ChannelMessageView,
  entry: SessionEntry | null,
  resolve: ChannelNameResolver | null,
): { personLabel?: string } {
  const named = resolve?.(message.sid) ?? entry?.label ?? null;
  if (named === null || named === '' || named === message.person) return {};
  return { personLabel: named };
}

function readNotifyLevel(args: Record<string, unknown>): NotifyMessage['level'] {
  const raw = optionalString(args, 'level');
  if (raw === undefined) return 'info';
  if (raw === 'info' || raw === 'warn' || raw === 'critical') return raw;
  throw new ToolArgumentError('level', `level 只能是 info / warn / critical，收到 "${raw}"`);
}

function readTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new ToolArgumentError('items', 'items 必须是数组（全量替换语义；清空请给空数组 []）');
  }
  if (raw.length > MAX_TODO_ITEMS) {
    throw new ToolArgumentError(
      'items',
      `items 最多 ${MAX_TODO_ITEMS} 项，收到 ${raw.length}：清单要进每轮的上下文，超长会持续挤占预算，请拆分为更少的高层步骤。`,
    );
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ToolArgumentError('items', `items[${index}] 必须是 { content, status } 对象`);
    }
    const record = item as Record<string, unknown>;
    const content = requiredString(record, 'content', { maxLength: TODO_SINGLE_CONTENT_MAX });
    const status = record['status'];
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoItem['status'])) {
      throw new ToolArgumentError(
        'items',
        `items[${index}].status 只能是 ${TODO_STATUSES.join(' / ')}，收到 ${JSON.stringify(status)}`,
      );
    }
    return { content, status: status as TodoItem['status'] };
  });
}

function describeTimer(entry: StoredTimerEntry): string {
  const kind = entry.cron === undefined ? '一次性' : `周期 ${entry.cron}`;
  const skipped = entry.skipped > 0 ? `，已跳过 ${entry.skipped} 拍` : '';
  const payload = entry.payload === null || entry.payload === undefined
    ? '（无 payload）'
    : `payload=${safeJson(entry.payload)}`;
  return `- ${entry.timerId} | ${kind} | 下次 ${entry.at}${skipped} | ${payload}`;
}

function describeTodo(item: TodoItem): string {
  const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
  return `${mark} ${item.content}（${item.status}）`;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? 'null';
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '（无法序列化）';
  }
}

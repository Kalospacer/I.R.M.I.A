/**
 * Irmia Agent — OneBot 11 通道适配器（NapCat / go-cqhttp 等协议端接入，M9）
 *
 * 与 `qq-official.ts` 的关系：**同一个 `ChannelAdapter` 接口、同一份 `wake/channel` 契约**，
 * 差别只在传输与语义：
 *   • QQ 官方走「HTTP 换 token + 官方网关 opcode 状态机 + REST 被动回复（msg_id/msg_seq 窗口）」；
 *   • OneBot 11 走「正向 WebSocket + JSON 动作/响应 + 无被动回复窗口」——连上 NapCat 的
 *     ws 端口即收事件，发消息是同一条连接上的 `{action, params, echo}` 请求/响应。
 *
 * 协议依据（OneBot 11 标准语义，NapCat 与 go-cqhttp 一致的部分）：
 *   • 事件：`post_type==='message'`，`message_type` 为 `private` / `group`；
 *     `raw_message` 是"原始消息（string 形态，含 CQ 码）"，`message` 是消息段数组
 *     （`message_post_format` 也可能是 string 形态的 CQ 码串）；每条事件都带 `self_id`。
 *   • 消息段：`{type:'text', data:{text}}` / `{type:'at', data:{qq}}` / `{type:'image', data:{file,url}}`
 *     / `{type:'file', data:{file,name,url}}`；CQ 码字符串是它的等价写法（`[CQ:at,qq=123]`）。
 *   • 动作：`{action:'send_private_msg', params:{user_id, message}, echo}` 与
 *     `{action:'send_group_msg', params:{group_id, message}, echo}`；响应同一条连接回
 *     `{status, retcode, data, echo}`，`echo` 是配对的唯一凭据，`retcode===0` 为成。
 *   • 鉴权：NapCat 的 access_token 校验在**握手**上（`Authorization: Bearer <token>` 或 query
 *     `?access_token=`）。本项目的 ws-client 刻意不留"自定义握手头"的口子（它逐字校验
 *     `Sec-WebSocket-Accept`，头部白名单越窄越好），所以这里一律用 query 形态，
 *     并把 token 从日志里打码（`maskAccessToken`）。
 *
 * 三块职责：
 *   ① 事件解析（纯函数）：事件体 → `wake/channel` 的 data，全部可独立断言；
 *   ② `OneBotClient`：连接状态机（连接 → 事件分发 → 动作/echo 配对 → 断线退避重连）；
 *   ③ `OneBotChannel`：对系统暴露的 `ChannelAdapter`（入站转 wake、出站接 speak 回投）。
 *
 * 两条硬纪律（与官方通道一致，理由相同）：
 *   • **退避计数只在链路真的活了之后清零**：一连上就清零会被"连上就被踢"的坏端口变成 1 秒锤击；
 *   • **发送失败按 retcode 分类**：`1404`（会话不存在）这类是"这条发不出去"而不是"链路坏了"，
 *     不许当成断线去重建连接——那只会把一条逻辑错误放大成一场重连风暴。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import { randomUUID } from 'node:crypto';

import type { WakeChannel } from '../log/types.js';
import {
  reconnectDelayMs,
  type ChannelAdapter,
  type QqChatType,
  type SendOutcome,
  type SendTextOptions,
} from './qq-official.ts';
import { connect as wsConnect, parseWsUrl, type WsClient, type WsConnectOptions } from './ws-client.ts';
import { sidKindOf } from './sessions.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 通道标识（wake/channel.channel 的取值，也是 dedupeKey 命名空间的前缀来源） */
export const ONEBOT_CHANNEL_NAME = 'onebot';

/** NapCat 正向 ws 的默认端口（协议端默认监听 3001；不写 wsUrl 时用它） */
export const DEFAULT_ONEBOT_WS_URL = 'ws://127.0.0.1:3001';
/** access_token 所在环境变量名（配置里只写变量名，值只在建连时从进程环境读） */
export const DEFAULT_ONEBOT_TOKEN_ENV = 'ONEBOT_ACCESS_TOKEN';
/** 握手 query 里的 token 参数名（NapCat 认这个键） */
export const ONEBOT_ACCESS_TOKEN_QUERY = 'access_token';

/** 指数退避起点：1 秒 */
export const DEFAULT_ONEBOT_RECONNECT_BASE_MS = 1_000;
/** 指数退避上限：60 秒（里程碑要求；比官方通道的 5 分钟更急，因为本地协议端通常就在同一台机器上） */
export const DEFAULT_ONEBOT_MAX_RECONNECT_DELAY_MS = 60_000;
/** 读超时兜底：协议端未下发 heartbeat 时的"链路是否还活着"判据 */
export const DEFAULT_ONEBOT_READ_TIMEOUT_MS = 60_000;
/** 动作等待响应的超时（NapCat 的 send_* 是同步返回的，正常在毫秒级） */
export const DEFAULT_ONEBOT_ACTION_TIMEOUT_MS = 15_000;

/** retcode：成功 */
export const ONEBOT_RETCODE_OK = 0;
/** retcode：异步调用已提交（协议端接受了，结果另行通知）——按成功计 */
export const ONEBOT_RETCODE_ASYNC = 1;

/**
 * 「这条发不出去，但链路是好的」的 retcode 集合（OneBot 11 标准错误码）：
 *   100 参数错 / 102 操作失败 / 103 凭证失效 / 104 权限不足 / 1400 无效参数 /
 *   1401 逻辑错误 / 1403 权限不足 / 1404 资源（会话/群）不存在。
 * 命中它们时**不重连、不重试**：重试同一个错误参数只会得到同一个错误，
 * 而"顺手重连"会把一条业务错误升级成链路抖动。
 */
export const ONEBOT_PERMANENT_RETCODES: readonly number[] = [100, 102, 103, 104, 1400, 1401, 1403, 1404];

/** retcode 三分类：成功 / 不可重试 / 可重试（含超时与链路故障） */
export type OneBotRetcodeClass = 'ok' | 'async' | 'permanent' | 'transient';

export function classifyRetcode(retcode: number): OneBotRetcodeClass {
  if (retcode === ONEBOT_RETCODE_OK) return 'ok';
  if (retcode === ONEBOT_RETCODE_ASYNC) return 'async';
  return ONEBOT_PERMANENT_RETCODES.includes(retcode) ? 'permanent' : 'transient';
}

/** 动作失败的原因分类（调用方据此决定"要不要重试/要不要重连"） */
export type OneBotFailureClass = 'permanent' | 'transient' | 'offline';

export interface OneBotLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
}

const SILENT_LOG: OneBotLogger = { info: () => {}, warn: () => {} };

// ──────────────────────────────── 值读取 ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 读一个「数字或数字字符串」标量并统一成字符串。
 *
 * OneBot 的 id 类字段（user_id / group_id / message_id / self_id）在不同实现里时而数字时而字符串，
 * 而且 int64 在 JS number 上有精度风险——所以**统一按字符串收**，只在出站参数里按需转回数字。
 */
function readScalar(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 消息段 data 的值同样"数字或字符串"混杂；统一成字符串，非标量直接丢掉（不猜测结构） */
function readStringMap(source: unknown): Record<string, string> {
  const record = asRecord(source);
  const out: Record<string, string> = {};
  if (record === null) return out;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    else if (typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ──────────────────────────────── CQ 码与消息段 ────────────────────────────────

export interface OneBotSegment {
  type: string;
  data: Record<string, string>;
}

/**
 * CQ 码的转义表（OneBot 11 标准）：编码顺序是 `&` → `[` → `]` → `,`，
 * 所以解码必须**逆序**做——先处理 `&#44;` 之类再收尾 `&amp;`，
 * 否则 `&amp;#91;`（字面量 "&#91;"）会被误解成左方括号。
 */
export function unescapeCqText(text: string): string {
  return text
    .replace(/&#91;/gu, '[')
    .replace(/&#93;/gu, ']')
    .replace(/&#44;/gu, ',')
    .replace(/&amp;/gu, '&');
}

/**
 * 解析 CQ 码字符串 → 消息段数组。
 *
 * 值里的逗号按规范必须写成 `&#44;`，所以按 `,` 切分参数是安全的；
 * 不为非标准写法做"尽力解析"的妥协（那会让"文本里到底有没有 CQ 码"变成不可判定的问题）。
 */
export function parseCqMessage(raw: string): OneBotSegment[] {
  const pattern = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/gu;
  const segments: OneBotSegment[] = [];
  let cursor = 0;
  for (;;) {
    const match = pattern.exec(raw);
    if (match === null) break;
    const index = match.index;
    if (index > cursor) {
      const text = unescapeCqText(raw.slice(cursor, index));
      if (text !== '') segments.push({ type: 'text', data: { text } });
    }
    const data: Record<string, string> = {};
    const params = (match[2] ?? '').replace(/^,/u, '');
    if (params !== '') {
      for (const pair of params.split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        data[pair.slice(0, eq).trim()] = unescapeCqText(pair.slice(eq + 1));
      }
    }
    segments.push({ type: (match[1] ?? '').toLowerCase(), data });
    cursor = index + match[0].length;
  }
  if (cursor < raw.length) {
    const text = unescapeCqText(raw.slice(cursor));
    if (text !== '') segments.push({ type: 'text', data: { text } });
  }
  return segments;
}

/**
 * 平台给的昵称/群名片 → `{ nickname }`（没有就一个字段都不给）。
 *
 * 用户 2026-10-02 的口径："群昵称我认为是应该读的，因为有助于快速识别身份。其他太长的 id
 * 反而没意义。" —— 所以昵称要读、要显示（`sender.card` 是这个群里的显示名，优先；
 * 退到 `sender.nickname`）；但它**只是显示**：谁都能把自己改成"owner"，
 * 身份判定永远按 id 走（契约里 `nickname` 的注释与 self-brief 那一段都写着这一条）。
 */
function nicknameOf(event: Record<string, unknown>): { nickname?: string } {
  const sender = asRecord(event['sender']);
  if (sender === null) return {};
  const card = readScalar(sender, 'card');
  const nick = readScalar(sender, 'nickname');
  const value = card !== '' ? card : nick;
  return value === '' ? {} : { nickname: value };
}


export function toSegments(message: unknown): OneBotSegment[] {
  if (typeof message === 'string') return parseCqMessage(message);
  if (!Array.isArray(message)) return [];
  const out: OneBotSegment[] = [];
  for (const item of message) {
    const record = asRecord(item);
    if (record === null) continue;
    const type = readString(record, 'type');
    if (type === '') continue;
    out.push({ type, data: readStringMap(record['data']) });
  }
  return out;
}

/** 消息段里的纯文本（只取 text 段：@、图片、表情都不属于"对我说的话"） */
export function textOfSegments(segments: readonly OneBotSegment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.type === 'text') out += segment.data['text'] ?? '';
  }
  return out;
}

/** CQ 码字符串 → 纯文本（剥掉所有码，只留文字） */
export function stripCqCodes(raw: string): string {
  return textOfSegments(parseCqMessage(raw));
}

/** 非文本类附件段（文本已剥离，它们是"平台上还带了什么"，供上层渲染与必要判断） */
const ATTACHMENT_SEGMENTS: readonly string[] = ['image', 'file', 'video', 'record'];

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//iu.test(text);
}

function attachmentsOf(segments: readonly OneBotSegment[]): WakeChannel['data']['attachments'] {
  const out: Array<{ type: string; url?: string; name?: string }> = [];
  for (const segment of segments) {
    if (!ATTACHMENT_SEGMENTS.includes(segment.type)) continue;
    const rawUrl = segment.data['url'] ?? '';
    const file = segment.data['file'] ?? '';
    // image 段的 url 常常缺席而 file 只是本地文件名：只把真正的 http(s) 地址当 URL 收下，
    // 不然模型会拿到一个点不开的假地址
    const url = rawUrl !== '' ? rawUrl : (isHttpUrl(file) ? file : '');
    const name = segment.data['name'] ?? file;
    out.push({
      type: segment.type,
      ...(url === '' ? {} : { url }),
      ...(name === '' ? {} : { name }),
    });
  }
  return out.length === 0 ? undefined : out;
}

/** 该消息是否 @ 了机器人（`qq=all` 的 @全体不算：它是发给所有人的，不是对她说的话） */
export function mentionsSelf(segments: readonly OneBotSegment[], selfId: string): boolean {
  if (selfId === '') return false;
  return segments.some((segment) => segment.type === 'at' && segment.data['qq'] === selfId);
}

// ──────────────────────────────── 事件 → wake/channel ────────────────────────────────

export interface OneBotEventContext {
  /** 机器人自身 QQ 号：事件里没有 self_id 时用缓存值补齐 */
  selfId?: string;
  /** 事件里写的通道名（默认 onebot；测试可用别名区分多实例） */
  channelName?: string;
}

/**
 * 事件体 → `wake/channel` 的 data（不适用的返回 null，调用方据此忽略）。
 *
 * 文本口径：`raw_message` 在 string 形态下是**含 CQ 码的原文**，直接透传会把协议码喂给模型，
 * 所以两条来源都先剥码再取用——`raw_message` 剥完非空就用它（它是协议的权威原文），
 * 否则退回消息段里的 text 拼接（对端没给 raw_message 时的等价来源）。
 *
 * 群消息必须是"@ 了机器人"才唤醒：没 @ 的群消息是别人的对话，把她拖进去等于噪声。
 * 拿不到 self_id 时**宁可丢**——"猜自己是不是被 @"必然猜错一部分。
 */
export function mapEventToWakeChannel(
  event: Record<string, unknown>,
  context: OneBotEventContext = {},
): WakeChannel['data'] | null {
  if (readString(event, 'post_type') !== 'message') return null;
  const messageType = readString(event, 'message_type');
  if (messageType !== 'private' && messageType !== 'group') return null;

  const messageId = readScalar(event, 'message_id');
  // 没有 message_id 就没有幂等键：宁可丢也不伪造（与官方通道同一条纪律）
  if (messageId === '') return null;
  const person = readScalar(event, 'user_id');
  if (person === '') return null;

  const segments = toSegments(event['message']);
  const rawMessage = readString(event, 'raw_message');
  const fromRaw = rawMessage === '' ? '' : stripCqCodes(rawMessage).trim();
  const text = fromRaw !== '' ? fromRaw : textOfSegments(segments).trim();
  const attachments = attachmentsOf(segments);
  const channelName = context.channelName ?? ONEBOT_CHANNEL_NAME;

  let chatType: WakeChannel['data']['chatType'];
  let chatId: string;
  if (messageType === 'private') {
    chatType = 'c2c';
    chatId = person;
  } else {
    chatId = readScalar(event, 'group_id');
    if (chatId === '') return null;
    /**
     * 群里的话分两种，**没 @ 她的那条不再丢掉**。
     *
     * 协议端（NapCat / Lagrange 这类走客户端协议的）**会推全量群消息**——群里谁说什么它都给。
     * （**2026-10-02 更正**：官方 Bot API 在平台侧开了「接收所有消息」之后同样推全量群消息——
     * `GROUP_MESSAGE_CREATE` 与 @ 消息是同一个订阅位，见 design.md §4.24。所以"只有协议端拿得到
     * 全量"这个旧说法是错的；这里以前对没 @ 的一律 `return null`，代价是把白送的能力扔掉，
     * 也让"信箱"（`channel/message`、未读、话题、`read_channel`）永远收不到东西。）
     *
     * 现在的分工与官方通道一致：**@ 她的**标 `group-at`（唤醒她），**其余**标 `group`
     * （进信箱：只记账、算未读，她想知道再翻）。分流在 `channel/inbox.ts` 里判。
     *
     * `self_id` 拿不到时**按"没 @ 她"处理**（不是丢弃）：判不出是不是叫她，那就当群里的一句闲话——
     * 少叫醒她一次，比把整条消息扔掉好；而且这条消息在会话清单里仍然看得到。
     */
    const selfId = readScalar(event, 'self_id') || (context.selfId ?? '');
    chatType = selfId !== '' && mentionsSelf(segments, selfId) ? 'group-at' : 'group';
  }

  return {
    channel: channelName,
    chatType,
    person,
    // 平台给的昵称/群名片（`sender.card` 优先——那是这个群里的显示名，最便于认人）。
    // **只用于显示**：身份永远按 id 判（见 self-brief"名字不是身份"那一段）。
    ...nicknameOf(event),
    chatId,
    text,
    messageId,
    // OneBot 没有官方那种"被动回复窗口"，msg_seq 是官方语义的字段：这里恒记 0
    msgSeq: 0,
    ...(attachments === undefined ? {} : { attachments }),
    dedupeKey: `${channelName}:${messageId}`,
  };
}

// ──────────────────────────────── 读超时与握手地址 ────────────────────────────────

/**
 * heartbeat 的 interval（毫秒）→ 读超时。
 *
 * 取 3 倍宽限：协议端的 heartbeat 本身可能晚一拍，读超时贴着 interval 会在网络抖动时误判断线
 * （误判的代价是一次完整重连，比晚几秒发现真断线的代价大）。下限 15 秒，避免对端配了个
 * 很小的 interval 就把读超时压到"每几秒重连一次"。
 */
export function heartbeatToReadTimeoutMs(intervalMs: number): number {
  return Math.max(15_000, Math.trunc(intervalMs) * 3);
}

/** 把 access_token 拼进握手 query（ws-client 不支持自定义握手头，见文件头说明） */
export function buildConnectUrl(wsUrl: string, accessToken: string): string {
  const parsed = parseWsUrl(wsUrl);
  if (!parsed.ok) throw new Error(`OneBot wsUrl 非法：${parsed.error}`);
  if (accessToken === '') return wsUrl;
  const url = new URL(wsUrl);
  url.searchParams.set(ONEBOT_ACCESS_TOKEN_QUERY, accessToken);
  return url.toString();
}

/** 日志里的地址：token 必须打码（它会随日志落盘，等于把网关凭据抄进文件） */
export function maskAccessToken(url: string): string {
  return url.replace(
    new RegExp(`([?&]${ONEBOT_ACCESS_TOKEN_QUERY}=)[^&]*`, 'u'),
    '$1***',
  );
}

/** chatId → 出站 id：纯数字且在安全整数内就给 number（NapCat 两种都收），其余原样发字符串 */
export function oneBotIdOf(chatId: string): number | string {
  if (!/^-?\d+$/u.test(chatId)) return chatId;
  const value = Number(chatId);
  return Number.isSafeInteger(value) ? value : chatId;
}

// ──────────────────────────────── 动作调用 ────────────────────────────────

export type OneBotActionResult =
  | { ok: true; retcode: number; data: Record<string, unknown> | null }
  | { ok: false; retcode: number | null; klass: OneBotFailureClass; reason: string };

interface PendingCall {
  action: string;
  resolve: (result: OneBotActionResult) => void;
  timer: unknown;
}

interface TimerHandle { id: unknown }

// ──────────────────────────────── 连接状态机 ────────────────────────────────

export interface OneBotClientOptions {
  /** 协议端正向 ws 地址（如 ws://127.0.0.1:3001） */
  wsUrl: string;
  /** access_token（空串表示协议端未开校验）；只进握手 query，不进日志 */
  accessToken?: string;
  /** 事件里写的通道名（默认 onebot） */
  channelName?: string;
  /** 连接工厂覆盖点（测试注入本地假协议端） */
  connect?: (url: string, options: WsConnectOptions) => Promise<WsClient>;
  /** 读超时（毫秒）：连续这么久没收到任何帧即判链路已死 */
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  actionTimeoutMs?: number;
  closeTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: OneBotLogger;
  /** 收到 `wake/channel` 数据（已转成事件形状）时的落地口 */
  onWake: (data: WakeChannel['data']) => void;
}

/**
 * OneBot 正向 ws 客户端：收事件、发动作、按 echo 配对、断线退避重连。
 *
 * 与 `QqGateway` 的关键差别只有一处：**没有 opcode 状态机**。OneBot 的动作与事件共用一条连接，
 * 配对靠 `echo`——所以每个动作发出去前先登记 echo，收到的 JSON 先查 echo 再当事件处理。
 */
export class OneBotClient {
  private readonly options: OneBotClientOptions;
  private readonly log: OneBotLogger;
  private readonly timeout: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeout: (handle: unknown) => void;
  private readonly connectFn: (url: string, options: WsConnectOptions) => Promise<WsClient>;

  private client: WsClient | null = null;
  private started = false;
  private stopping = false;
  private ready = false;

  private selfId = '';
  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempts = 0;
  private actionSeq = 0;
  private readTimeoutMs: number;

  private readonly pending = new Map<string, PendingCall>();
  private incomingCount = 0;
  private actionCount = 0;

  constructor(options: OneBotClientOptions) {
    this.options = options;
    this.log = options.log ?? SILENT_LOG;
    this.timeout = options.setTimeoutFn ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimeout = options.clearTimeoutFn ?? ((handle) => {
      if (handle !== null && handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
    });
    this.connectFn = options.connect ?? wsConnect;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_ONEBOT_READ_TIMEOUT_MS;
  }

  /** 可观测状态（测试与 CLI 状态页用；不含 token） */
  snapshot(): {
    connected: boolean; selfId: string; reconnectAttempts: number;
    pendingCalls: number; incomingCount: number; actionCount: number;
  } {
    return {
      connected: this.client !== null && this.client.isOpen,
      selfId: this.selfId,
      reconnectAttempts: this.reconnectAttempts,
      pendingCalls: this.pending.size,
      incomingCount: this.incomingCount,
      actionCount: this.actionCount,
    };
  }

  /** 机器人 QQ 号（群 @ 判定的前提） */
  get loginId(): string {
    return this.selfId;
  }

  /** 起连。幂等：重复调用不会建第二条连接 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    void this.openOnce();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer !== null) {
      this.clearTimeout(this.reconnectTimer.id);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.ready = false;
    this.failPending('OneBot 客户端已停止，动作未送达');
    if (client !== null) client.close(1000, 'agent stopping');
  }

  /**
   * 发一个动作并等它的响应。
   *
   * 不抛异常：发送路径的失败都是**预期内的事实**（未连接 / 超时 / retcode 非 0），
   * 用返回值表达比用异常更贴近调用方（sendText 要把 reason 报给模型，而不是让工具崩掉）。
   */
  async call(action: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<OneBotActionResult> {
    const client = this.client;
    if (client === null || !client.isOpen) {
      return { ok: false, retcode: null, klass: 'offline', reason: `OneBot 未连接，动作 ${action} 未发出` };
    }
    const echo = `irmia-${++this.actionSeq}-${randomUUID()}`;
    const timeout = timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_ONEBOT_ACTION_TIMEOUT_MS;
    this.actionCount += 1;
    const result = await new Promise<OneBotActionResult>((resolve) => {
      const timer = this.timeout(() => {
        // 超时必须把登记项摘掉：留着它只会让后续同 echo 的响应去唤醒一个已经结束的调用
        this.pending.delete(echo);
        resolve({
          ok: false, retcode: null, klass: 'transient',
          reason: `OneBot ${action} 等待响应超时（${timeout}ms）`,
        });
      }, timeout);
      this.pending.set(echo, { action, resolve, timer });
      client.sendJson({ action, params, echo });
    });
    if (result.ok) return result;
    if (result.klass === 'permanent') {
      // 协议端说过"这条不行"（1404 等）：链路没问题，绝不因此重连
      this.log.warn(`[OneBot] ${result.reason}（retcode 判定为不可重试，不触发重连）`);
    }
    return result;
  }

  // ── 连接 ──

  private async openOnce(): Promise<void> {
    if (this.stopping) return;
    let url: string;
    try {
      url = buildConnectUrl(this.options.wsUrl, this.options.accessToken ?? '');
    } catch (err) {
      this.log.warn(`[OneBot] 连接地址不可用：${messageOf(err)}`);
      this.scheduleReconnect();
      return;
    }
    let client: WsClient;
    try {
      client = await this.connectFn(url, {
        readTimeoutMs: this.readTimeoutMs,
        ...(this.options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.options.closeTimeoutMs }),
        onDebug: (line) => { this.log.info(`[OneBot/ws] ${line}`); },
      });
    } catch (err) {
      this.log.warn(`[OneBot] 连接失败（${maskAccessToken(url)}）：${messageOf(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.client = client;
    client.onMessage((message) => { this.handleIncoming(message.text); });
    client.onError((err) => { this.log.warn(`[OneBot] 传输层错误：${err.message}`); });
    client.onClose((info) => {
      if (this.client !== client) return; // 已被替换（重连/停止）的旧连接，忽略它的收尾
      this.client = null;
      this.ready = false;
      this.failPending('OneBot 连接已断开，动作未送达');
      if (this.stopping) return;
      this.log.warn(
        `[OneBot] 连接断开（code=${info.code ?? '无'}，${info.byLocal ? '本地发起' : '对端/超时'}`
        + `${info.reason === '' ? '' : `，${info.reason}`}），准备重连`,
      );
      this.scheduleReconnect();
    });
    this.log.info(`[OneBot] 已连上 ${maskAccessToken(url)}，等待协议端事件`);
    // 机器人 QQ 号是群 @ 判定的前提：事件通常自带 self_id，但生命周期事件流也可能先到，
    // 所以连上就问一次（失败只警告：事件自带的 self_id 依然够用）
    if (this.selfId === '') void this.fetchSelfId();
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    if (this.reconnectTimer !== null) return; // 已排定的一拍不许被重复排（否则断线风暴会把定时器堆起来）
    const base = this.options.reconnectBaseMs ?? DEFAULT_ONEBOT_RECONNECT_BASE_MS;
    const max = this.options.maxReconnectDelayMs ?? DEFAULT_ONEBOT_MAX_RECONNECT_DELAY_MS;
    const delay = reconnectDelayMs(this.reconnectAttempts, base, max);
    this.reconnectAttempts += 1;
    const human = delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`;
    const maxHuman = max < 1000 ? `${max}ms` : `${Math.round(max / 1000)}s`;
    this.log.warn(`[OneBot] ${human} 后重连（第 ${this.reconnectAttempts} 次，退避上限 ${maxHuman}）`);
    this.reconnectTimer = {
      id: this.timeout(() => {
        this.reconnectTimer = null;
        void this.openOnce();
      }, delay),
    };
  }

  // ── 收 ──

  private handleIncoming(raw: string): void {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(raw) as unknown);
    } catch {
      this.log.warn(`[OneBot] 收到非法 JSON（${raw.length} 字节），已忽略`);
      return;
    }
    if (payload === null) return;
    this.incomingCount += 1;
    // 任何一条入站消息都是"握手通过 + 链路活着"的证据：退避计数到这里才清零
    this.markReady();

    const echo = payload['echo'];
    if (echo !== undefined && echo !== null) {
      const key = String(echo);
      if (this.pending.has(key)) {
        this.settle(key, payload);
        return;
      }
      // echo 不认识：可能是上一轮超时后迟到的响应（也可能是对端乱发），不当事件处理
      this.log.info(`[OneBot] 忽略无法配对的动作响应：echo=${key.slice(0, 40)}`);
      return;
    }
    this.dispatch(payload);
  }

  private settle(key: string, payload: Record<string, unknown>): void {
    const call = this.pending.get(key);
    if (call === undefined) return;
    this.pending.delete(key);
    this.clearTimeout(call.timer);
    const retcode = readNumber(payload, 'retcode') ?? -1;
    const klass = classifyRetcode(retcode);
    if (klass === 'ok' || klass === 'async') {
      call.resolve({ ok: true, retcode, data: asRecord(payload['data']) });
      return;
    }
    const detail = readString(payload, 'wording') || readString(payload, 'msg') || readString(payload, 'status');
    call.resolve({
      ok: false,
      retcode,
      klass,
      reason: `OneBot ${call.action} 失败：retcode=${retcode}${detail === '' ? '' : ` ${detail}`}`,
    });
  }

  /** 断线/停止时把所有在途动作结清：挂着的 promise 比失败更难查 */
  private failPending(reason: string): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, call] of entries) {
      this.clearTimeout(call.timer);
      call.resolve({ ok: false, retcode: null, klass: 'offline', reason });
    }
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== null) {
      // 已排定的重连作废：链路已经活了（否则会在重连计时器到点时再连第二条）
      this.clearTimeout(this.reconnectTimer.id);
      this.reconnectTimer = null;
    }
    this.log.info('[OneBot] 链路就绪，退避计数清零');
  }

  private dispatch(payload: Record<string, unknown>): void {
    // 每条事件都带 self_id：收到就跟着更新（比只信一次 get_login_info 更贴近事实）
    const selfId = readScalar(payload, 'self_id');
    if (selfId !== '') this.selfId = selfId;

    const postType = readString(payload, 'post_type');
    if (postType === 'meta_event') {
      this.onMetaEvent(payload);
      return;
    }
    if (postType !== 'message') return; // notice / request 等不是"对我说的话"
    const wake = mapEventToWakeChannel(payload, {
      selfId: this.selfId,
      channelName: this.options.channelName ?? ONEBOT_CHANNEL_NAME,
    });
    if (wake === null) return;
    this.options.onWake(wake);
  }

  private onMetaEvent(payload: Record<string, unknown>): void {
    const metaType = readString(payload, 'meta_event_type');
    if (metaType === 'heartbeat') {
      const interval = readNumber(payload, 'interval');
      if (interval !== null && interval > 0) this.applyReadTimeout(heartbeatToReadTimeoutMs(interval));
      return;
    }
    if (metaType === 'lifecycle') {
      const subType = readString(payload, 'sub_type');
      this.log.info(`[OneBot] 生命周期事件：${subType === '' ? '未标注' : subType}（self_id=${this.selfId === '' ? '未知' : this.selfId}）`);
      if (subType === 'connect' && this.selfId === '') void this.fetchSelfId();
    }
  }

  /**
   * 读超时跟随协议端心跳节奏。注意 `setReadTimeoutMs(0)` 在 ws-client 里是"不改动"，
   * 所以这里只接受正数（对端关掉心跳时保持兜底值，而不是把链路判断彻底关掉）。
   */
  private applyReadTimeout(ms: number): void {
    if (ms <= 0 || ms === this.readTimeoutMs) return;
    this.readTimeoutMs = ms;
    this.client?.setReadTimeoutMs?.(ms);
  }

  private async fetchSelfId(): Promise<void> {
    const result = await this.call('get_login_info', {});
    if (!result.ok) {
      this.log.warn(`[OneBot] get_login_info 未拿到机器人 QQ 号：${result.reason}（群 @ 判定将依赖事件自带的 self_id）`);
      return;
    }
    const userId = readScalar(result.data, 'user_id');
    if (userId === '') {
      this.log.warn('[OneBot] get_login_info 响应里没有 user_id，已忽略');
      return;
    }
    this.selfId = userId;
    this.log.info(`[OneBot] 机器人 QQ 号：${userId}`);
  }
}

// ──────────────────────────────── 通道适配器 ────────────────────────────────

/** OneBot 出站的消息形态：**纯文本字符串**（不构造 CQ 码数组，文本原样发） */
export type OneBotChatType = QqChatType;

export interface OneBotChannelOptions {
  /** 协议端正向 ws 地址（如 ws://127.0.0.1:3001） */
  wsUrl: string;
  /** access_token；只进握手 query，不进日志 */
  accessToken?: string;
  channelName?: string;
  connect?: (url: string, options: WsConnectOptions) => Promise<WsClient>;
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  actionTimeoutMs?: number;
  closeTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: OneBotLogger;
  /** 命中器：本地 mock / 隐私（无用，保留扩展点） */
  onWake?: (data: WakeChannel['data']) => void;
}

/** OneBot 通道：客户端 + 发送封装的组合，对系统只暴露 `ChannelAdapter` 形状 */
export class OneBotChannel implements ChannelAdapter {
  readonly name = ONEBOT_CHANNEL_NAME;

  onMessage?: (event: WakeChannel['data']) => void;

  private readonly client: OneBotClient;
  private readonly log: OneBotLogger;
  /** 观测计数：收到并已投递的通道消息条数 */
  private delivered = 0;
  /**
   * 最近一条消息事件的时刻（毫秒），0 = 还没收到过。
   *
   * 与 `delivered` 是两个问题：那个答"一共来过多少"，这个答"上一次是什么时候"。
   * **后者才是能看出静默假活的那个数**（见 `snapshot()` 的注释）。
   */
  private lastEventAtMs = 0;

  constructor(options: OneBotChannelOptions) {
    this.log = options.log ?? SILENT_LOG;
    this.client = new OneBotClient({
      wsUrl: options.wsUrl,
      ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
      ...(options.channelName === undefined ? {} : { channelName: options.channelName }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
      ...(options.reconnectBaseMs === undefined ? {} : { reconnectBaseMs: options.reconnectBaseMs }),
      ...(options.maxReconnectDelayMs === undefined ? {} : { maxReconnectDelayMs: options.maxReconnectDelayMs }),
      ...(options.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: options.actionTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      ...(options.setTimeoutFn === undefined ? {} : { setTimeoutFn: options.setTimeoutFn }),
      ...(options.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: options.clearTimeoutFn }),
      log: this.log,
      onWake: (data) => {
        this.delivered += 1;
        // 记下"最近一条消息是什么时候来的"——见 lastEventAt 的注释：协议端有一种
        // **静默假活**（进程活着、端口在听、心跳照发，但下游一条事件都收不到），
        // 链路层看不见它，而"多久没消息"这个事实看得见。
        this.lastEventAtMs = Date.now();
        options.onWake?.(data);
        this.onMessage?.(data);
      },
    });
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  /**
   * 回投（speak 的第三路）。
   *
   * `options.msgId/msgSeq` 在 OneBot 语义下**一律忽略**：那是官方被动回复窗口的字段
   * （同一 msg_id 必须换 msg_seq，否则 40054005 去重失败），OneBot 没有这条限制——
   * 回复就是一条普通的 send_* 动作，重发也不会被去重拒绝。
   */
  async sendText(
    chatType: OneBotChatType,
    chatId: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    void options;
    const raw: string = chatType;
    const isGroup = raw === 'group-at' || raw === 'group';
    if (!isGroup && raw !== 'c2c') {
      return { ok: false, reason: `OneBot 不支持的 chatType：${raw}`, passive: false };
    }
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params: Record<string, unknown> = isGroup
      ? { group_id: oneBotIdOf(chatId), message: text }
      : { user_id: oneBotIdOf(chatId), message: text };
    const result = await this.client.call(action, params);
    if (!result.ok) return { ok: false, reason: result.reason, passive: false };
    return { ok: true, messageId: readScalar(result.data, 'message_id'), passive: false, msgSeq: 0 };
  }

  /** 状态快照（CLI/测试观测；token 值本身从不外露） */
  snapshot(): { delivered: number; lastEventAt: number | null } & ReturnType<OneBotClient['snapshot']> {
    return {
      delivered: this.delivered,
      // 最近一条消息事件的时刻（毫秒），还没收到过就是 null。
      //
      // 为什么要有它：协议端有一种**静默假活**——账号被悄悄踢了，但它不重登、不通知下游，
      // 而**进程活着、端口在听、TCP 已建立、心跳照发**。读超时因此永远不会触发（心跳一直在
      // 重置它），链路层看过去一切健康，实际下游可能几十小时收不到任何事件（NapCat #2071
      // 就是这么记的）。链路层测不出来，能测出来的只有"多久没有消息了"这一个事实。
      //
      // 所以这里**只报事实、不下判断**：是不是假活、该不该重启，留给看它的人（或上层策略）——
      // 对一个本来就冷清的群，"六小时没消息"完全正常。这与框架一贯的分寸一致：
      // 拿不准的事不替她决定。
      lastEventAt: this.lastEventAtMs === 0 ? null : this.lastEventAtMs,
      ...this.client.snapshot(),
    };
  }
}

// ──────────────────────────────── speak 回投接线 ────────────────────────────────

/** 回投地址的 scheme：`onebot:<chatType>:<chatId>`（与普通通道的 `qq:` 并行，各占自己的命名空间） */
export const ONEBOT_REPLY_SCHEME = 'onebot:';

/** 把 wake/channel 数据编成回投 URL（**归一形态**：群聊一律 `group`，与 sid 同一个口径） */
export function replyUrlOf(data: Pick<WakeChannel['data'], 'chatType' | 'chatId'>): string {
  return `${ONEBOT_REPLY_SCHEME}${sidKindOf(data.chatType)}:${data.chatId}`;
}

export type OneBotReplyUrlParse =
  | { ok: true; chatType: OneBotChatType; chatId: string }
  | { ok: false; error: string };

/** 解析回投 URL；认 `onebot:c2c:` / `onebot:group:`（旧记录里可能还是 `onebot:group-at:`） */
export function parseReplyUrl(url: string): OneBotReplyUrlParse {
  if (!url.startsWith(ONEBOT_REPLY_SCHEME)) {
    return { ok: false, error: `不是 OneBot 回投地址（${url.slice(0, 32)}）` };
  }
  const rest = url.slice(ONEBOT_REPLY_SCHEME.length);
  const index = rest.indexOf(':');
  if (index <= 0) return { ok: false, error: `回投地址缺少 chatId：${url}` };
  const chatType = rest.slice(0, index);
  if (chatType !== 'c2c' && chatType !== 'group' && chatType !== 'group-at') {
    return { ok: false, error: `不支持的 chatType：${chatType}` };
  }
  const chatId = rest.slice(index + 1);
  if (chatId === '') return { ok: false, error: `回投地址的 chatId 为空：${url}` };
  return { ok: true, chatType, chatId };
}

/**
 * 回投实现：把 admin 工具 `speak` 的第三路（replyPoster）接到本通道的 sendText 上。
 *
 * 与 `createChannelReplyPoster` 同形（同一个 `ReplyPoster` 形状、同样的超时竞速），
 * 差别只是"认哪张回投地址"——scheme 与通道名都取自本文件，所以这里不需要知道 QQ 通道存在。
 */
export function createOneBotReplyPoster(
  channels: ReadonlyMap<string, ChannelAdapter>,
  options: { timeoutMs?: number } = {},
): { post(target: { url: string; idempotencyKey: string }, text: string): Promise<{ ok: true; status: number } | { ok: false; reason: string }> } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ONEBOT_ACTION_TIMEOUT_MS;
  return {
    async post(target, text) {
      const parsed = parseReplyUrl(target.url);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      const channel = channels.get(ONEBOT_CHANNEL_NAME);
      if (channel === undefined) return { ok: false, reason: 'OneBot 通道未装配，回投跳过' };
      const timerRef: { handle: NodeJS.Timeout | null } = { handle: null };
      try {
        // 超时由调用方（工具超时预算）说了算：回投是"这一轮发言"的一部分
        const outcome = await Promise.race([
          channel.sendText(parsed.chatType, parsed.chatId, text),
          new Promise<never>((_resolve, reject) => {
            timerRef.handle = setTimeout(() => { reject(new Error(`回投超时（${timeoutMs}ms）`)); }, timeoutMs);
          }),
        ]);
        if (outcome.ok) return { ok: true, status: 200 };
        return { ok: false, reason: outcome.reason };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      } finally {
        if (timerRef.handle !== null) clearTimeout(timerRef.handle);
      }
    },
  };
}

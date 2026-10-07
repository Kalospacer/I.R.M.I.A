/**
 * Irmia Agent — DeepSeek Responses API 客户端与错误分类退避
 *
 * 依据：docs/design.md §4.13（cache 协同 → `usage.input_tokens_details.cached_tokens` 归账）、
 * §4.14（模型接入层：错误分类表、指数退避、流式与中断、降级链、连接纪律）。
 * 字段级语义取自官方文档实证（2026-09 核验）：
 *   - `POST {baseUrl}/responses` 无状态，多轮必须每次回传完整 `input`；
 *     请求字段 `model` / `input` / `instructions` / `tools` / `reasoning` / `max_output_tokens` /
 *     `text` / `user`；`input` 与 `instructions` 至少传一个。
 *   - 响应 `status` ∈ {in_progress, completed, incomplete, failed}；`output[]` 三类 item
 *     （message / reasoning / function_call）；用量在 `usage`，缓存命中数为
 *     `usage.input_tokens_details.cached_tokens`；截断原因在 `incomplete_details.reason`
 *     （max_output_tokens / content_filter）。
 *   - `stream: true` 返回语义化 SSE（response.output_text.delta / reasoning_text.delta /
 *     function_call_arguments.delta / output_item.* / completed / incomplete / failed），
 *     最后一个事件是终态且**没有** `data: [DONE]`。
 *   来源：https://api-docs.deepseek.com/zh-cn/api/create-response
 *         https://api-docs.deepseek.com/zh-cn/guides/responses_api/
 *
 * 刻意不做的两件事（边界写清，免得下沉职责）：
 *   1. lane 并发门（heavy 1 / light 2）与 keepalive 复用属于循环层连接纪律：默认 fetch(undici)
 *      已带连接池复用，并发门由 step 调度实现。
 *   2. 降级链状态机（heavy 连败 → 备用端点 → light 兜底）由循环层驱动：本文件只暴露
 *      `modelFor()` 与 `DsRequest.model` 覆盖点，以及可外抛的连续失败计数 `failStreak`。
 *
 * 约定：值导入写 `.ts`（--experimental-strip-types 只擦类型不改路径），类型导入写 `.js`。
 */

import type { ModelLane } from '../log/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_HEAVY_MODEL = 'deepseek-v4-pro';
export const DEFAULT_LIGHT_MODEL = 'deepseek-flash';
/** 单请求总超时上限（含思维链生成时间；§4.14「总超时上限」） */
export const DEFAULT_TIMEOUT_MS = 180_000;
/** 连续失败上限，与 §4.6 失败刹车的默认阈值 5 同源 */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** `empty` 的有限重试上限（§4.14 表：有限重试 3 次后走降级链） */
export const EMPTY_MAX_ATTEMPTS = 3;
/** 部署标识默认值：KVCache 调度亲和用；字符集限 [a-zA-Z0-9\-_]，≤512 */
export const DEFAULT_DEPLOYMENT_USER = 'irmia-agent';
/** 服务端错误信息截断：进日志也进告警，不把整页 HTML 带进去 */
const ERROR_DETAIL_LIMIT = 2_000;

// ──────────────────────────────── 请求形状 ────────────────────────────────

/** 输入 item：渲染层（§4.13）产出的字节稳定结构，此处只做透传，不做重排 */
export interface DsInputTextPart {
  type: 'input_text' | 'output_text';
  text: string;
}

/**
 * 图片块：DS Responses 原生支持，`image_url` 可以是 **data URL** 也可以是 http(s) 直链
 * （直链由服务端自己去取——实测拿一个取不到的地址会得到 400 `Failed to download image`，
 * 所以历史里塞过期直链等于把那条历史变成永久 400；进上下文的图片一律落到本地再转 data URL）。
 */
export interface DsInputImagePart {
  type: 'input_image';
  image_url: string;
}

export type DsInputContentPart = DsInputTextPart | DsInputImagePart;

export interface DsInputMessage {
  type?: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  /**
   * 纯文字时是 string（**保持字节稳定**：没有图片的历史渲染结果一个字节都不变），
   * 带图片时是 content 数组。
   */
  content: string | DsInputContentPart[];
}

export interface DsInputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface DsInputFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** 回传历史时**必须**携带 reasoning（§4.13 铁律 3，v3 修订）：带 tools 的请求若缺了历史轮次的 reasoning_text，下一次请求直接 400——保留类型不是"只为完整"，是规范要求 */
export interface DsInputReasoning {
  type: 'reasoning';
  content: Array<{ type: 'reasoning_text'; text: string }>;
}

export type DsInputItem =
  | DsInputMessage
  | DsInputFunctionCall
  | DsInputFunctionCallOutput
  | DsInputReasoning;

export interface DsTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 思考强度：`none` 关闭思考模式；其余开启（官方 effort 枚举） */
export type DsReasoningEffort = 'none' | 'low' | 'high' | 'max';

export type DsTextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown> };

export interface DsRequest {
  lane: ModelLane;
  /** 覆盖 lane 默认模型：降级链与 light 兜底走这里 */
  model?: string;
  input: string | DsInputItem[];
  instructions?: string;
  tools?: DsTool[];
  reasoning?: { effort: DsReasoningEffort };
  maxOutputTokens?: number;
  text?: DsTextFormat;
  /** 思考模式下不生效（官方说明），保留字段但不做静默改写 */
  temperature?: number;
  /** 仅思考模式生效且下限 0.95 */
  topP?: number;
  /** 调用方中断信号：中断不是错误，见 DsErrorKind 的 aborted */
  signal?: AbortSignal;
}

// ──────────────────────────────── 响应形状 ────────────────────────────────

export interface DsUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中上下文硬盘缓存的输入 token（§4.13 归账口径） */
  cachedTokens: number;
  /** 思维链 token（usage.output_tokens_details.reasoning_tokens）——**落库到 `budget/consumed.reasoningTokens`**（观测字段，已含在 outputTokens 里） */
  reasoningTokens: number;
}

export interface DsMessageOutput {
  type: 'message';
  id: string;
  text: string;
}

export interface DsReasoningOutput {
  type: 'reasoning';
  id: string;
  text: string;
}

export interface DsFunctionCallOutput {
  type: 'function_call';
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

export type DsOutputItem = DsMessageOutput | DsReasoningOutput | DsFunctionCallOutput;

/** 响应终态：`in_progress` 不是终态，非流式收到它按服务端异常处理 */
export type DsStatus = 'completed' | 'incomplete' | 'failed';

export type DsIncompleteReason = 'max_output_tokens' | 'content_filter';

export interface DsResponse {
  status: DsStatus;
  outputItems: DsOutputItem[];
  usage: DsUsage;
  incompleteReason: DsIncompleteReason | null;
  model: string;
  responseId: string | null;
  /** 本次 HTTP 往返总耗时，直接进 `budget/consumed.durationMs` */
  durationMs: number;
}

export interface DsStreamCallbacks {
  /** 可见文本增量：逐段落 `message/assistant` 与前端推送 */
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onFunctionCallDelta?: (delta: {
    callId: string;
    name: string;
    argumentsDelta: string;
  }) => void;
  /** 每个 SSE 事件（含 created/in_progress 等），用于观测与排障 */
  onEvent?: (event: { type: string; payload: unknown }) => void;
}

export interface DsStreamResult {
  status: DsStatus;
  /** 已推送的可见文本全文（中断时即"已收部分"，对齐 schema §3 的 interrupted 语义） */
  text: string;
  reasoning: string;
  toolCalls: Array<{ callId: string; name: string; arguments: string }>;
  outputItems: DsOutputItem[];
  usage: DsUsage;
  incompleteReason: DsIncompleteReason | null;
  model: string | null;
  responseId: string | null;
  durationMs: number;
  /** 未收到终态事件即为 true：网络断、超时、调用方中断都算 */
  interrupted: boolean;
  /** interrupted 或 failed 时的原因；正常完成恒为 null */
  failure: { code: string; message: string } | null;
}

// ──────────────────────────────── 错误分类 ────────────────────────────────

/** §4.14 错误分类表 + aborted（中断不是错误，但必须与 timeout 区分开） */
export type DsErrorKind =
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'empty'
  | 'invalid'
  | 'network'
  | 'aborted';

const RETRYABLE_KINDS: ReadonlySet<DsErrorKind> = new Set<DsErrorKind>([
  'rate_limited',
  'server',
  'timeout',
  'empty',
  'network',
]);

export interface DsErrorInit {
  kind: DsErrorKind;
  message: string;
  /** 稳定错误码，进日志与告警指纹 */
  code?: string;
  status?: number | null;
  /** 429 的 Retry-After 解析结果（毫秒） */
  retryAfterMs?: number | null;
  /** 已尝试次数（含本次），由重试层标注 */
  attempts?: number;
  /** 连续失败次数，由 DsClient 外抛 */
  consecutiveFailures?: number;
  /** 服务端响应体片段（截断后） */
  detail?: string | null;
  cause?: unknown;
}

export class DsClientError extends Error {
  readonly kind: DsErrorKind;
  readonly code: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
  readonly consecutiveFailures: number;
  readonly detail: string | null;
  readonly retryable: boolean;

  constructor(init: DsErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'DsClientError';
    this.kind = init.kind;
    this.code = init.code ?? init.kind;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.attempts = init.attempts ?? 0;
    this.consecutiveFailures = init.consecutiveFailures ?? 0;
    this.detail = init.detail ?? null;
    this.retryable = RETRYABLE_KINDS.has(init.kind);
  }

  /** 重试层与 DsClient 回填计数用：不改原对象，避免并发路径共享可变状态 */
  withContext(patch: { attempts?: number; consecutiveFailures?: number }): DsClientError {
    return new DsClientError({
      kind: this.kind,
      message: this.message,
      code: this.code,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      attempts: patch.attempts ?? this.attempts,
      consecutiveFailures: patch.consecutiveFailures ?? this.consecutiveFailures,
      detail: this.detail,
      cause: this.cause,
    });
  }
}

export function isDsClientError(value: unknown): value is DsClientError {
  return value instanceof DsClientError;
}

/**
 * `Retry-After` 解析：整数秒或 HTTP-date 两种形态，非法值返回 null。
 * 过去时间与 0 都归 0——服务端说"立即可重试"时不该被我们的指数退避覆盖。
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/** HTTP 状态 → 类别（§4.14 表；4xx 除 429 外一律不重试） */
export function classifyHttpStatus(
  status: number,
  extra: { retryAfterMs?: number | null; detail?: string | null } = {},
): DsClientError {
  const detail = extra.detail ?? null;
  const retryAfterMs = extra.retryAfterMs ?? null;
  const code = `http_${status}`;
  if (status === 429) {
    return new DsClientError({
      kind: 'rate_limited',
      code,
      message: `模型接口限流（429）${retryAfterMs === null ? '' : `，服务端建议等待 ${retryAfterMs}ms`}`,
      status,
      retryAfterMs,
      detail,
    });
  }
  if (status >= 500) {
    return new DsClientError({ kind: 'server', code, message: `模型接口服务端错误（${status}）`, status, retryAfterMs, detail });
  }
  return new DsClientError({
    kind: 'invalid',
    code,
    message: `请求被拒绝（${status}）：重试同样的请求必然同样失败`,
    status,
    retryAfterMs,
    detail,
  });
}

/**
 * 传输层失败 → 类别。判据顺序即优先级：先看是谁中止的（调用方 / 我们的超时），
 * 再看 socket 级错误码——连接被重置归 server，DNS 与连接失败归 network（§4.14 表）。
 */
export function classifyTransportError(
  error: unknown,
  flags: { timedOut: boolean; externalAborted: boolean },
): DsClientError {
  if (flags.externalAborted) {
    return new DsClientError({ kind: 'aborted', code: 'aborted', message: '调用方中断了请求', cause: error });
  }
  if (flags.timedOut) {
    return new DsClientError({ kind: 'timeout', code: 'timeout', message: '请求超时，未收到完整响应', cause: error });
  }
  const code = transportCodeOf(error);
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new DsClientError({ kind: 'server', code: code, message: `连接被重置（${code}）`, cause: error });
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new DsClientError({ kind: 'timeout', code, message: `连接层超时（${code}）`, cause: error });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    // 未命中任何标志的 AbortError：按超时处理，宁可退避也不无限重试
    return new DsClientError({ kind: 'timeout', code: 'aborted_unknown', message: '请求被中止（未区分来源）', cause: error });
  }
  return new DsClientError({
    kind: 'network',
    code: code === '' ? 'network' : code,
    message: `网络不可用（${code === '' ? 'unknown' : code}）：DNS 解析失败或连接无法建立`,
    cause: error,
  });
}

function transportCodeOf(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const own = (error as { code?: unknown }).code;
  return typeof own === 'string' ? own : '';
}

// ──────────────────────────────── 退避 ────────────────────────────────

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryInfo {
  /** 已失败次数（第 attempt 次失败后准备重试） */
  attempt: number;
  delayMs: number;
  kind: DsErrorKind | 'unknown';
  lane: ModelLane;
}

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 5 */
  maxAttempts?: number;
  lane?: ModelLane;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 中断信号：退避期间被中断即停止重试 */
  signal?: AbortSignal;
  sleep?: SleepFn;
  onRetry?: (info: RetryInfo) => void;
  /** 由调用方收紧重试策略（DsClient 用它把 empty 限到 3 次） */
  shouldRetry?: (error: unknown, attempt: number, lane: ModelLane) => boolean;
}

/** 默认 sleep：可被中断，中断按 aborted 抛出而不是静默返回 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DsClientError({ kind: 'aborted', code: 'aborted', message: '退避被中断' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DsClientError({ kind: 'aborted', code: 'aborted', message: '退避被中断' }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 指数退避封装。退避时长 = min(base · 2^(n-1), cap)，服务端给了 Retry-After 时以它为准
 * （尊重服务端提示优先于我们的曲线，因此不对它做 cap）。
 * 抛出的错误已回填 attempts；连续失败计数由调用方（DsClient）叠加后外抛。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const lane: ModelLane = options.lane ?? 'heavy';
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => error instanceof DsClientError && error.retryable);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error, attempt, lane)) {
        throw annotateAttempts(error, attempt);
      }
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, retryAfterOf(error));
      options.onRetry?.({ attempt, delayMs, kind: kindOf(error), lane });
      // sleep 自身的中断错误直接外抛：退避期间被取消就不该再打一次请求
      await sleep(delayMs, options.signal);
    }
  }
  throw annotateAttempts(lastError, maxAttempts);
}

export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | null,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (retryAfterMs !== null && retryAfterMs > exp) return retryAfterMs;
  return exp;
}

function retryAfterOf(error: unknown): number | null {
  return error instanceof DsClientError ? error.retryAfterMs : null;
}

function kindOf(error: unknown): DsErrorKind | 'unknown' {
  return error instanceof DsClientError ? error.kind : 'unknown';
}

function annotateAttempts(error: unknown, attempt: number): unknown {
  if (error instanceof DsClientError && error.attempts === 0) return error.withContext({ attempts: attempt });
  return error;
}

// ──────────────────────────────── SSE 解析 ────────────────────────────────

export interface SseFrame {
  /** `event:` 字段；DeepSeek 语义化流里与 data 内的 type 一致，取 data 为准 */
  event: string | null;
  data: string;
}

/**
 * SSE 分帧器。按空行切帧，容忍跨 chunk 断裂的行尾（孤立 CR 也当换行——
 * 规范允许 CR / LF / CRLF 三种行尾，Node 的 chunk 边界不会照顾我们）。
 * 空 data 帧（多切出来的空行）直接丢弃，不让它污染上层状态机。
 */
export class SseFrameDecoder {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const frames: SseFrame[] = [];
    for (;;) {
      const sep = this.buffer.indexOf('\n\n');
      if (sep < 0) break;
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = parseSseFrame(raw);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  /** 流结束时的残留帧：服务端最后一个事件后没补空行也能收干净 */
  flush(): SseFrame[] {
    const raw = this.buffer;
    this.buffer = '';
    const frame = parseSseFrame(raw);
    return frame === null ? [] : [frame];
  }
}

function parseSseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ──────────────────────────────── 响应体读取 ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readUsage(raw: unknown): DsUsage {
  const usage = asRecord(raw);
  const inputDetails = asRecord(usage?.['input_tokens_details']);
  const outputDetails = asRecord(usage?.['output_tokens_details']);
  return {
    inputTokens: num(usage?.['input_tokens']),
    outputTokens: num(usage?.['output_tokens']),
    cachedTokens: num(inputDetails?.['cached_tokens']),
    reasoningTokens: num(outputDetails?.['reasoning_tokens']),
  };
}

/** message / reasoning 的 content 是内容块数组；纯字符串形态一并兼容 */
function readContentText(raw: unknown, blockType: 'output_text' | 'reasoning_text'): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  let text = '';
  for (const part of raw) {
    const block = asRecord(part);
    if (block === null) continue;
    if (str(block['type']) !== blockType) continue;
    text += str(block['text']);
  }
  return text;
}

function readOutputItems(raw: unknown): DsOutputItem[] {
  if (!Array.isArray(raw)) return [];
  const items: DsOutputItem[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    if (item === null) continue;
    const id = str(item['id']);
    const type = str(item['type']);
    if (type === 'message') {
      items.push({ type: 'message', id, text: readContentText(item['content'], 'output_text') });
    } else if (type === 'reasoning') {
      items.push({ type: 'reasoning', id, text: readContentText(item['content'], 'reasoning_text') });
    } else if (type === 'function_call') {
      items.push({
        type: 'function_call',
        id,
        callId: str(item['call_id']),
        name: str(item['name']),
        arguments: str(item['arguments']),
      });
    }
  }
  return items;
}

function readIncompleteReason(raw: unknown): DsIncompleteReason | null {
  const details = asRecord(asRecord(raw)?.['incomplete_details']);
  const reason = str(details?.['reason']);
  if (reason === 'max_output_tokens' || reason === 'content_filter') return reason;
  return null;
}

/** 有效输出判据：有可见文本或函数调用。只有思维链不算产出（§4.14 的 empty 类） */
export function hasUsableOutput(items: readonly DsOutputItem[]): boolean {
  for (const item of items) {
    if (item.type === 'function_call') return true;
    if (item.text.trim() !== '') return true;
  }
  return false;
}

function parseResponseBody(text: string, model: string): Omit<DsResponse, 'durationMs'> {
  if (text.trim() === '') {
    throw new DsClientError({ kind: 'empty', code: 'empty_body', message: '响应体为空（200 但无内容）', status: 200 });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // 非空但非法 JSON：服务端瞬时损坏，可退避重试，不能当 invalid（不是我们的请求错）
    throw new DsClientError({
      kind: 'server',
      code: 'bad_json',
      message: '响应不是合法 JSON',
      status: 200,
      detail: text.slice(0, ERROR_DETAIL_LIMIT),
      cause: error,
    });
  }
  const body = asRecord(json);
  if (body === null) {
    throw new DsClientError({ kind: 'server', code: 'bad_shape', message: '响应不是 JSON 对象', status: 200 });
  }
  const statusRaw = str(body['status']);
  if (statusRaw === 'failed') {
    const err = asRecord(body['error']);
    const code = str(err?.['code']);
    const message = str(err?.['message']);
    throw new DsClientError({
      kind: 'server',
      code: code === '' ? 'response_failed' : code,
      message: message === '' ? '响应状态 failed' : `响应状态 failed：${message}`,
      status: 200,
    });
  }
  if (statusRaw !== 'completed' && statusRaw !== 'incomplete') {
    throw new DsClientError({
      kind: 'server',
      code: 'bad_status',
      message: `非终态响应状态：${statusRaw === '' ? '(缺失)' : statusRaw}`,
      status: 200,
    });
  }
  const outputItems = readOutputItems(body['output']);
  if (!hasUsableOutput(outputItems)) {
    throw new DsClientError({
      kind: 'empty',
      code: 'empty_output',
      message: '响应无可用输出（无文本、无函数调用）',
      status: 200,
    });
  }
  return {
    status: statusRaw,
    outputItems,
    usage: readUsage(body['usage']),
    incompleteReason: readIncompleteReason(body),
    model: str(body['model']) === '' ? model : str(body['model']),
    responseId: str(body['id']) === '' ? null : str(body['id']),
  };
}

// ──────────────────────────────── 流式累积 ────────────────────────────────

interface MutableItem {
  id: string;
  kind: 'message' | 'reasoning' | 'function_call';
  text: string;
  callId: string;
  name: string;
  args: string;
}

interface StreamAccumulator {
  apply(frame: SseFrame): void;
  finish(): DsStreamResult;
  /** 传输中断/超时：已有内容就交付已收部分，否则把错误抛出去交给重试层 */
  settleTransportFailure(error: DsClientError): DsStreamResult;
}

/**
 * 流式事件状态机。两类权威源：增量事件（delta，实时）与终态 response 对象（完整）。
 * 终态里带 output 列表时以它为准覆盖累积结果——终态是服务端的最终口径，
 * 增量只用于"边收边推"与终态缺失时的兜底（对齐 M2-9：中断后保留已推送部分）。
 */
function createStreamAccumulator(
  fallbackModel: string,
  callbacks: DsStreamCallbacks,
  startedAt: number,
  now: () => number,
): StreamAccumulator {
  const items = new Map<string, MutableItem>();
  let order: string[] = [];
  let status: DsStatus = 'incomplete';
  let usage: DsUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
  let incompleteReason: DsIncompleteReason | null = null;
  let model: string | null = null;
  let responseId: string | null = null;
  let terminal = false;
  let failure: { code: string; message: string } | null = null;

  function ensure(key: string, kind: MutableItem['kind'], seed: Record<string, unknown> | null): MutableItem {
    let item = items.get(key);
    if (item === undefined) {
      item = {
        id: str(seed?.['id']) === '' ? key : str(seed?.['id']),
        kind,
        text: '',
        callId: str(seed?.['call_id']),
        name: str(seed?.['name']),
        args: '',
      };
      items.set(key, item);
      order.push(key);
    }
    return item;
  }

  /** 事件里定位条目：优先 item_id，其次 output_index 兜底（两者都缺时按类别并入单条） */
  function keyOf(payload: Record<string, unknown>, kind: MutableItem['kind']): string {
    const itemId = str(payload['item_id']);
    if (itemId !== '') return itemId;
    const outputIndex = payload['output_index'];
    if (typeof outputIndex === 'number') return `#${outputIndex}`;
    const callId = str(payload['call_id']);
    if (callId !== '') return callId;
    return `#${kind}`;
  }

  function absorbItem(raw: unknown, authoritative: boolean): void {
    const item = asRecord(raw);
    if (item === null) return;
    const kindRaw = str(item['type']);
    if (kindRaw !== 'message' && kindRaw !== 'reasoning' && kindRaw !== 'function_call') return;
    const key = str(item['id']) === '' ? `#${kindRaw}` : str(item['id']);
    const target = ensure(key, kindRaw, item);
    if (kindRaw === 'function_call') {
      const callId = str(item['call_id']);
      const name = str(item['name']);
      const args = str(item['arguments']);
      if (callId !== '') target.callId = callId;
      if (name !== '') target.name = name;
      if (args !== '' || authoritative) target.args = args;
      return;
    }
    const blockType = kindRaw === 'message' ? 'output_text' : 'reasoning_text';
    const text = readContentText(item['content'], blockType);
    if (text !== '' || authoritative) target.text = text;
  }

  function replaceFromItems(list: readonly DsOutputItem[]): void {
    items.clear();
    order = [];
    for (const item of list) {
      const key = item.id === '' ? `#${item.type}` : item.id;
      if (item.type === 'function_call') {
        items.set(key, { id: key, kind: 'function_call', text: '', callId: item.callId, name: item.name, args: item.arguments });
      } else {
        items.set(key, {
          id: key,
          kind: item.type,
          text: item.text,
          callId: '',
          name: '',
          args: '',
        });
      }
      order.push(key);
    }
  }

  function apply(frame: SseFrame): void {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(frame.data));
    } catch {
      payload = null; // 单帧坏死不该打断整条流
    }
    if (payload === null) return;
    const type = str(payload['type']) === '' ? (frame.event ?? '') : str(payload['type']);
    callbacks.onEvent?.({ type, payload });

    switch (type) {
      case 'response.output_item.added':
        absorbItem(payload['item'], false);
        return;
      case 'response.output_item.done':
        absorbItem(payload['item'], true);
        return;
      case 'response.output_text.delta': {
        const item = ensure(keyOf(payload, 'message'), 'message', payload);
        const delta = str(payload['delta']);
        item.text += delta;
        if (delta !== '') callbacks.onTextDelta?.(delta);
        return;
      }
      case 'response.output_text.done': {
        const item = ensure(keyOf(payload, 'message'), 'message', payload);
        const text = str(payload['text']);
        if (text !== '') item.text = text;
        return;
      }
      case 'response.reasoning_text.delta': {
        const item = ensure(keyOf(payload, 'reasoning'), 'reasoning', payload);
        const delta = str(payload['delta']);
        item.text += delta;
        if (delta !== '') callbacks.onReasoningDelta?.(delta);
        return;
      }
      case 'response.reasoning_text.done': {
        const item = ensure(keyOf(payload, 'reasoning'), 'reasoning', payload);
        const text = str(payload['text']);
        if (text !== '') item.text = text;
        return;
      }
      case 'response.function_call_arguments.delta': {
        const item = ensure(keyOf(payload, 'function_call'), 'function_call', payload);
        const delta = str(payload['delta']);
        item.args += delta;
        const callId = str(payload['call_id']);
        if (callId !== '') item.callId = callId;
        const name = str(payload['name']);
        if (name !== '') item.name = name;
        callbacks.onFunctionCallDelta?.({ callId: item.callId, name: item.name, argumentsDelta: delta });
        return;
      }
      case 'response.function_call_arguments.done': {
        const item = ensure(keyOf(payload, 'function_call'), 'function_call', payload);
        const args = str(payload['arguments']);
        if (args !== '') item.args = args;
        return;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const response = asRecord(payload['response']);
        if (response !== null) {
          const statusRaw = str(response['status']);
          if (statusRaw === 'completed' || statusRaw === 'incomplete' || statusRaw === 'failed') status = statusRaw;
          usage = readUsage(response['usage']);
          incompleteReason = readIncompleteReason(response);
          model = str(response['model']) === '' ? null : str(response['model']);
          responseId = str(response['id']) === '' ? null : str(response['id']);
          const list = readOutputItems(response['output']);
          if (list.length > 0) replaceFromItems(list);
          const err = asRecord(response['error']);
          if (err !== null) {
            failure = {
              code: str(err['code']) === '' ? 'response_failed' : str(err['code']),
              message: str(err['message']),
            };
          }
        }
        if (type === 'response.incomplete' && status === 'completed') status = 'incomplete';
        if (type === 'response.failed' && status !== 'failed') status = 'failed';
        if (status === 'completed' && !hasUsableOutput(collectOutputItems())) status = 'incomplete';
        terminal = true;
        return;
      }
      default:
        return;
    }
  }

  function collectOutputItems(): DsOutputItem[] {
    const list: DsOutputItem[] = [];
    for (const key of order) {
      const item = items.get(key);
      if (item === undefined) continue;
      if (item.kind === 'function_call') {
        list.push({ type: 'function_call', id: item.id, callId: item.callId, name: item.name, arguments: item.args });
      } else {
        list.push({ type: item.kind, id: item.id, text: item.text });
      }
    }
    return list;
  }

  function build(interrupted: boolean): DsStreamResult {
    const outputItems = collectOutputItems();
    let text = '';
    let reasoning = '';
    const toolCalls: Array<{ callId: string; name: string; arguments: string }> = [];
    for (const item of outputItems) {
      if (item.type === 'message') text += item.text;
      else if (item.type === 'reasoning') reasoning += item.text;
      else toolCalls.push({ callId: item.callId, name: item.name, arguments: item.arguments });
    }
    return {
      status,
      text,
      reasoning,
      toolCalls,
      outputItems,
      usage,
      incompleteReason,
      model: model ?? (fallbackModel === '' ? null : fallbackModel),
      responseId,
      durationMs: now() - startedAt,
      interrupted,
      failure,
    };
  }

  return {
    apply,
    finish: () => build(!terminal),
    settleTransportFailure: (error: DsClientError): DsStreamResult => {
      if (hasUsableOutput(collectOutputItems())) {
        status = error.kind === 'aborted' ? 'incomplete' : 'failed';
        failure = { code: error.code, message: error.message };
        return build(true);
      }
      throw error;
    },
  };
}

// ──────────────────────────────── 客户端 ────────────────────────────────

export interface DsClientOptions {
  baseUrl?: string;
  apiKey: string;
  heavyModel?: string;
  lightModel?: string;
  timeoutMs?: number;
  /** 部署标识，固定写进请求 `user`：KVCache 调度亲和（§4.13 观测闭环） */
  user?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 注入点：测试用 mock server 时无需替换；需要统计或代理时替换 */
  fetchImpl?: typeof fetch;
  sleep?: SleepFn;
  now?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

/**
 * 配置热更补丁（`models.*` 在 operations.md §1 白名单内）：
 * 模型与端点是请求级输入，下一拍请求即生效；仅显式给出的字段被覆盖。
 * 密钥值不落配置文件，`apiKey` 由调用方从环境变量重读后传进来（密钥教义）。
 */
export interface DsConfigPatch {
  baseUrl?: string;
  apiKey?: string;
  heavyModel?: string;
  lightModel?: string;
}

interface RequestHandle {
  signal: AbortSignal;
  timedOut(): boolean;
  externalAborted(): boolean;
  dispose(): void;
}

export class DsClient {
  /** 以下四项是配置热更点（models.* 在白名单内）：非 readonly，走 applyConfig */
  baseUrl: string;
  heavyModel: string;
  lightModel: string;
  readonly timeoutMs: number;
  readonly user: string;

  private apiKey: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly onRetry: ((info: RetryInfo) => void) | null;
  /** 连续失败计数：成功即清零；随错误外抛供 §4.6 失败刹车使用 */
  private streak = 0;

  constructor(options: DsClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.heavyModel = options.heavyModel ?? DEFAULT_HEAVY_MODEL;
    this.lightModel = options.lightModel ?? DEFAULT_LIGHT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.user = options.user ?? DEFAULT_DEPLOYMENT_USER;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.onRetry = options.onRetry ?? null;
  }

  /**
   * 配置热更（operations.md §1 白名单里的 light/heavy 模型与端点）：
   * 只覆盖显式给出的字段；在途请求不受影响（它的 model/url 在发起时已定），下一拍生效。
   * 连续失败计数**不重置**——换端点不等于故障已恢复，清零它会把失败刹车骗过去。
   */
  applyConfig(patch: DsConfigPatch): void {
    if (patch.baseUrl !== undefined) this.baseUrl = stripTrailingSlash(patch.baseUrl);
    if (patch.apiKey !== undefined && patch.apiKey.trim() !== '') this.apiKey = patch.apiKey;
    if (patch.heavyModel !== undefined && patch.heavyModel.trim() !== '') this.heavyModel = patch.heavyModel;
    if (patch.lightModel !== undefined && patch.lightModel.trim() !== '') this.lightModel = patch.lightModel;
  }

  /** lane → 端点模型；降级链用 `DsRequest.model` 覆盖 */
  modelFor(lane: ModelLane): string {
    return lane === 'light' ? this.lightModel : this.heavyModel;
  }

  get failStreak(): number {
    return this.streak;
  }

  resetFailStreak(): void {
    this.streak = 0;
  }

  /**
   * 非流式生成：带错误分类与指数退避。刻意不重试的两类——invalid（重试必然同样失败）
   * 与 aborted（调用方要求停）；empty 收紧到 3 次后外抛，由调用方走降级链。
   */
  async generate(request: DsRequest): Promise<DsResponse> {
    const lane = request.lane;
    const model = request.model ?? this.modelFor(lane);
    const url = `${this.baseUrl}/responses`;
    const startedAt = this.now();
    const retry = this.retryOptions(lane, request.signal);

    try {
      const core = await withRetry(async () => {
        const handle = this.createHandle(request.signal);
        try {
          const res = await this.send(url, buildRequestBody(request, model, this.user, false), false, handle);
          if (!res.ok) throw await httpErrorOf(res);
          const text = await this.readBody(res, handle);
          return parseResponseBody(text, model);
        } finally {
          handle.dispose();
        }
      }, retry);
      this.streak = 0;
      return { ...core, durationMs: this.now() - startedAt };
    } catch (error) {
      throw this.trackFailure(error);
    }
  }

  /**
   * SSE 流式。已推送的内容不可重放，因此这里不做整条流的重试（重试决策属于调用方）：
   * 收到过内容后发生中断/超时/网络断，返回已收部分（`interrupted: true`）；
   * 一个字都没收到就失败，则当作可重试错误抛出，与 generate 的错误语义一致。
   */
  async stream(request: DsRequest, callbacks: DsStreamCallbacks = {}): Promise<DsStreamResult> {
    const lane = request.lane;
    const model = request.model ?? this.modelFor(lane);
    const url = `${this.baseUrl}/responses`;
    const startedAt = this.now();
    const handle = this.createHandle(request.signal);
    const accumulator = createStreamAccumulator(model, callbacks, startedAt, this.now);

    try {
      const res = await this.send(url, buildRequestBody(request, model, this.user, true), true, handle);
      if (!res.ok) throw await httpErrorOf(res);
      if (res.body === null) {
        throw new DsClientError({ kind: 'server', code: 'no_body', message: '流式响应缺少 body' });
      }
      this.streak = 0;
      return await this.pump(res.body, accumulator, handle);
    } catch (error) {
      throw this.trackFailure(error);
    } finally {
      handle.dispose();
    }
  }

  /** 读流：字节 → 文本 → SSE 帧 → 状态机。中断在帧循环内结算，不外抛（除非一个字都没收到） */
  private async pump(
    body: ReadableStream<Uint8Array>,
    accumulator: StreamAccumulator,
    handle: RequestHandle,
  ): Promise<DsStreamResult> {
    const decoder = new TextDecoder('utf-8');
    const sse = new SseFrameDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          for (const frame of sse.push(decoder.decode(value, { stream: true }))) accumulator.apply(frame);
        }
      }
      for (const frame of sse.push(decoder.decode())) accumulator.apply(frame);
      for (const frame of sse.flush()) accumulator.apply(frame);
      return accumulator.finish();
    } catch (error) {
      const classified = classifyTransportError(error, {
        timedOut: handle.timedOut(),
        externalAborted: handle.externalAborted(),
      });
      return accumulator.settleTransportFailure(classified);
    }
  }

  private retryOptions(lane: ModelLane, signal?: AbortSignal): RetryOptions {
    const options: RetryOptions = {
      maxAttempts: this.maxAttempts,
      lane,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      sleep: this.sleep,
      shouldRetry: (error: unknown, attempt: number) => shouldRetryAttempt(error, attempt),
    };
    if (signal !== undefined) options.signal = signal;
    if (this.onRetry !== null) options.onRetry = this.onRetry;
    return options;
  }

  /** 超时与调用方中断共用一条 AbortController，但保留来源标志以便分类 */
  private createHandle(external?: AbortSignal): RequestHandle {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('DsClient 请求超时'));
    }, this.timeoutMs);
    const onExternalAbort = (): void => controller.abort(new Error('调用方中断'));
    if (external !== undefined) {
      if (external.aborted) onExternalAbort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      externalAborted: () => external?.aborted === true,
      dispose: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  private async send(
    url: string,
    body: Record<string, unknown>,
    stream: boolean,
    handle: RequestHandle,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: handle.signal,
      });
    } catch (error) {
      // fetch 只在传输层失败时抛：DNS/连接/中断都从这里出去并分类
      throw classifyTransportError(error, {
        timedOut: handle.timedOut(),
        externalAborted: handle.externalAborted(),
      });
    }
  }

  private async readBody(res: Response, handle: RequestHandle): Promise<string> {
    try {
      return await res.text();
    } catch (error) {
      throw classifyTransportError(error, {
        timedOut: handle.timedOut(),
        externalAborted: handle.externalAborted(),
      });
    }
  }

  /** 连续失败计数外抛：只统计模型侧失败，中断不算失败 */
  private trackFailure(error: unknown): unknown {
    if (error instanceof DsClientError && error.kind !== 'aborted') {
      this.streak += 1;
      return error.withContext({ consecutiveFailures: this.streak });
    }
    return error;
  }
}

/** URL 收尾统一口径：项目里 baseUrl 不含 /responses 后缀，也不留尾斜杠 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '');
}

/** empty 走有限重试（3 次），invalid/aborted 一次都不重试，其余按 §4.14 表退避 */
function shouldRetryAttempt(error: unknown, attempt: number): boolean {
  if (!(error instanceof DsClientError)) return false;
  if (!error.retryable) return false;
  if (error.kind === 'empty') return attempt < EMPTY_MAX_ATTEMPTS;
  return true;
}

async function httpErrorOf(res: Response): Promise<DsClientError> {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  let detail: string | null = null;
  try {
    const text = await res.text();
    detail = text === '' ? null : text.slice(0, ERROR_DETAIL_LIMIT);
  } catch {
    detail = null;
  }
  return classifyHttpStatus(res.status, { retryAfterMs, detail });
}

function buildRequestBody(
  request: DsRequest,
  model: string,
  user: string,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: request.input,
    user,
    stream,
  };
  if (request.instructions !== undefined) body['instructions'] = request.instructions;
  if (request.tools !== undefined && request.tools.length > 0) body['tools'] = request.tools;
  if (request.reasoning !== undefined) body['reasoning'] = { effort: request.reasoning.effort };
  if (request.maxOutputTokens !== undefined) body['max_output_tokens'] = request.maxOutputTokens;
  if (request.text !== undefined) body['text'] = { format: request.text };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  return body;
}

/**
 * Irmia Agent — MCP stdio 客户端池（docs/design.md §4.19 MCP 段、docs/milestones.md M7-1/2/3/8）
 *
 * 第一版只支持本地子进程（远程 SSE/HTTP 明确不做：那是面向独立进程多客户端场景的方案，
 * 对"随用随起"的子进程是过度设计）。协议实现是**官方规范的最小子集**：
 *
 *   initialize 握手（protocolVersion + capabilities + clientInfo，回包逐项校验）
 *     → notifications/initialized
 *     → tools/list（进程启动时一次并缓存，notifications/tools/list_changed 触发刷新）
 *     → tools/call → notifications/cancelled
 *     → 每请求超时（progress 通知可重置时钟，但有硬上限）
 *
 * roots / sampling / elicitation **一律不声明**：不声明则 server 不会发对应请求。
 * server 若仍然发来未声明能力的请求，一律回 -32601 method not found（规范要求的兜底）。
 *
 * 四条纪律（全部来自规范原文与设计文档）：
 *
 * 1. **默认不信任**：MCP 工具默认 `sideEffect: 'destructive'`，配置里显式降级才改。
 *    **annotations（readOnlyHint 等）一律不可信**——三属性以我方注册表为准，
 *    annotations 只作参考提示收着看。理由很直白："server 说自己是只读的"，
 *    恰好是崩溃恢复时最不该采信的一句话；而 sideEffect 决定的是"崩溃后能不能自动重试"，
 *    猜错一次就是副作用重复执行。
 *
 * 2. **随用随起、空闲回收**：首次调用拉起子进程，空闲 5 分钟回收。回收按官方关机序列
 *    执行：关 stdin → 等待退出 → 超时 SIGTERM → 再超时 SIGKILL（两级超时可配）。
 *    协议错误重启走的也是同一条序列——关停路径只有一条，才不会有第二条没人测过的路径。
 *
 * 3. **stdout 纯净**：server 的 stdout 只允许写合法 JSON-RPC（日志必须走 stderr）。
 *    收到非 JSON-RPC 行 → 记协议错误并重启该 server 进程；stderr 一律捕获为日志。
 *    消息按换行分隔，绝不内嵌换行（JSON.stringify 天然把 \n 转义，另有断言兜底）。
 *
 * 4. **超时即杀、崩溃不传染**：所有失败都折算成工具结果（isError），绝不抛穿主循环。
 *    `isError: true` → status 'error'（由执行器的 completedResult 映射）；
 *    `content[]` 超阈值走 blob 外置（§4.12 磁盘经济学，复用 state/blob-store.ts）。
 *
 * 生命周期事件经注入的 emit 落 `mcp/server-started` / `mcp/server-stopped`（internal）。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`（Node 的类型剥离只擦类型、不改写路径解析）。
 * 零外部依赖：只用 node: 标准库。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { killProcessTree } from '../process/kill-tree.ts';
import type { SideEffect } from '../log/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolExecutionMode, ToolHandlerResult } from '../tools/types.js';
import { MAX_DESCRIPTION_TOKENS, estimateTokens } from '../tools/registry.ts';
import { errorResult, okResult } from '../tools/types.ts';
// 外置指针文案的**唯一实现**（与工具结果那条路共用；两处各拼一遍必然漂移）
import { blobPointerText } from '../model/render.ts';
import {
  DEFAULT_BLOB_PREVIEW_CHARS, DEFAULT_BLOB_THRESHOLD_TOKENS, offloadIfLarge,
} from '../state/blob-store.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 工具名命名空间前缀（design §4.18 原则 2：MCP 工具自带 mcp__{server}__ 前缀） */
export const MCP_NAME_PREFIX = 'mcp__';
/** 合成名上限：与 src/tools/registry.ts 的 NAME_MAX_LENGTH 对齐（超限的注册会被拒） */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;
/** 规范允许的服务器名与工具名字符集（其余字符合成出来的名字毫无可读性，宁可拒绝） */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** 缺省协议版本与可接受的回包版本（回包版本不在列表里即判定不兼容） */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** clientInfo（握手时上报；server 侧日志靠它辨认调用方）。version 与 main.ts 的 AGENT_VERSION 同步 */
export const DEFAULT_CLIENT_INFO: { readonly name: string; readonly version: string } = {
  name: 'irmia-agent',
  version: '0.1.0-beta.5',
};

/** 每请求软超时：progress 通知可重置这个时钟 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** 每请求硬上限：progress 再多也不能把请求续到天荒地老 */
export const DEFAULT_PROGRESS_HARD_CAP_MS = 600_000;
/** 单件 MCP 工具交给执行器的 timeoutMs（执行器级超时先到，得到 status 'timeout'） */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;
/** 空闲回收窗口（design §4.19 纪律 2：5 分钟） */
export const DEFAULT_IDLE_RECLAIM_MS = 5 * 60 * 1000;
/** 关机序列的第一级等待：关 stdin 之后等它自己走 */
export const DEFAULT_SHUTDOWN_STDIN_WAIT_MS = 2_000;
/** 关机序列的第二级等待：SIGTERM 之后等它走 */
export const DEFAULT_SHUTDOWN_TERM_WAIT_MS = 5_000;
/** SIGKILL 之后仍留一点观察窗口（用于如实记录"没退出"这件事） */
export const DEFAULT_SHUTDOWN_KILL_GRACE_MS = 500;
/** 取消宽限：发出 notifications/cancelled 后等 server 收敛的时间，逾期判定连接失效 */
export const DEFAULT_CANCEL_GRACE_MS = 500;
/** 单行字符上限：超长且不见换行即判定 stdout 不是"换行分隔的 JSON-RPC" */
export const MAX_STDOUT_LINE_CHARS = 1_048_576;

// ──────────────────────────────── 错误 ────────────────────────────────

/** 工具层错误码（与 tools/types.ts 的 TOOL_ERROR_CODES 同风格，供宿主判定） */
export const MCP_ERROR_CODES = {
  notConfigured: 'E_MCP_NOT_CONFIGURED',
  disabled: 'E_MCP_DISABLED',
  spawnFailed: 'E_MCP_SPAWN_FAILED',
  handshakeFailed: 'E_MCP_HANDSHAKE_FAILED',
  protocol: 'E_MCP_PROTOCOL',
  rpc: 'E_MCP_RPC_ERROR',
  timeout: 'E_MCP_TIMEOUT',
  aborted: 'E_MCP_ABORTED',
  stopped: 'E_MCP_SERVER_STOPPED',
  toolError: 'E_MCP_TOOL_ERROR',
  badContent: 'E_MCP_BAD_CONTENT',
} as const;

/** stdout 不是合法 JSON-RPC（或违背换行分隔纪律）：这条错误必然导致该 server 进程被重启 */
export class McpProtocolError extends Error {
  readonly server: string;
  readonly detail: string;

  constructor(server: string, detail: string) {
    super(`MCP server ${server} 协议错误：${detail}`);
    this.name = 'McpProtocolError';
    this.server = server;
    this.detail = detail;
  }
}

/** 每请求超时（软超时或硬上限到达）；两种情形都要发 notifications/cancelled */
export class McpRequestTimeoutError extends Error {
  readonly server: string;
  readonly method: string;
  readonly timeoutMs: number;
  /** true = 撞到 progress 硬上限（progress 已经救不回这个请求） */
  readonly hardCap: boolean;

  constructor(server: string, method: string, timeoutMs: number, hardCap: boolean) {
    super(
      hardCap
        ? `MCP server ${server} 的 ${method} 请求撞到硬上限（progress 通知已无法续期）：${timeoutMs}ms`
        : `MCP server ${server} 的 ${method} 请求超时：${timeoutMs}ms`,
    );
    this.name = 'McpRequestTimeoutError';
    this.server = server;
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.hardCap = hardCap;
  }
}

/** 调用被取消（执行器超时或宿主关停把 AbortSignal 打过来） */
export class McpAbortedError extends Error {
  readonly server: string;
  readonly method: string;

  constructor(server: string, method: string, detail: string) {
    super(`MCP server ${server} 的 ${method} 调用被取消：${detail}`);
    this.name = 'McpAbortedError';
    this.server = server;
    this.method = method;
  }
}

/** server 用 JSON-RPC error 回的失败（协议层错误，不是工具层 isError） */
export class McpRpcError extends Error {
  readonly server: string;
  readonly code: number;
  readonly data: unknown;

  constructor(server: string, method: string, code: number, message: string, data: unknown) {
    super(`MCP server ${server} 的 ${method} 返回 JSON-RPC 错误 ${code}：${message}`);
    this.name = 'McpRpcError';
    this.server = server;
    this.code = code;
    this.data = data;
  }
}

/** server 进程已退出（在途请求全部作废） */
export class McpServerExitedError extends Error {
  readonly server: string;
  readonly code: number | null;
  readonly signal: string | null;

  constructor(server: string, code: number | null, signal: string | null) {
    super(`MCP server ${server} 的进程已退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）`);
    this.name = 'McpServerExitedError';
    this.server = server;
    this.code = code;
    this.signal = signal;
  }
}

/** 连接被主动关停（回收/关停/重启），在途请求随之作废 */
export class McpServerStoppedError extends Error {
  readonly server: string;
  readonly reason: McpStopReason;

  constructor(server: string, reason: McpStopReason) {
    super(`MCP server ${server} 已停止（${reason}），在途请求作废`);
    this.name = 'McpServerStoppedError';
    this.server = server;
    this.reason = reason;
  }
}

/** 配置层错误：解析 mcp.servers[] 时的问题一律带定位信息，不做"尽力而为"的猜测修正 */
export class McpConfigError extends Error {
  readonly where: string;

  constructor(message: string, where: string) {
    super(message);
    this.name = 'McpConfigError';
    this.where = where;
  }
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** MCP 工具的三属性显式声明（未声明即取默认：destructive / exclusive / DEFAULT_MCP_TOOL_TIMEOUT_MS） */
export interface McpToolAttributes {
  sideEffect?: SideEffect;
  executionMode?: ToolExecutionMode;
  timeoutMs?: number;
}

/** 一个 stdio MCP server 的配置（对齐 design §4.19：mcp.servers[] = { name, command, args }） */
export interface McpServerEntry {
  name: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** true = 配置里保留条目但不起进程（临时停用一个 server 不必删配置） */
  disabled?: boolean;
  /** 该 server 全部工具的默认三属性（缺省 destructive / exclusive / 60s） */
  toolDefaults?: McpToolAttributes;
  /** 逐工具显式声明（键：工具短名或 mcp__{server}__{tool} 全名）——显式降级走这里 */
  tools?: Record<string, McpToolAttributes>;
  /** 逐 server 覆盖每请求软超时 */
  requestTimeoutMs?: number;
  /** 逐 server 覆盖空闲回收窗口 */
  idleReclaimMs?: number;
}

export type McpStopReason = 'idle-reclaim' | 'crashed' | 'shutdown';

/** 关机序列的阶段（顺序即事实，测试与排障都靠它） */
export type McpShutdownStage = 'stdin-closed' | 'exited' | 'sigterm' | 'sigkill';

export interface McpShutdownReport {
  name: string;
  reason: McpStopReason;
  stages: McpShutdownStage[];
}

export interface McpServerStartedData {
  name: string;
  pid: number;
  tools: string[];
}

export interface McpServerStoppedData {
  name: string;
  reason: McpStopReason;
}

/** 生命周期事件出口（宿主把它接到事件日志上；mcp/* 是 internal） */
export type McpEventEmitter = (
  type: 'mcp/server-started' | 'mcp/server-stopped',
  data: McpServerStartedData | McpServerStoppedData,
) => void;

/** 单个 server 的运行期快照（CLI/前端观测用；不暴露内部句柄） */
export interface McpServerStatus {
  name: string;
  running: boolean;
  pid: number | null;
  ready: boolean;
  protocolVersion: string | null;
  tools: string[];
  /** 在途请求数 */
  inFlight: number;
  /** tools/list 次数：>1 说明发生过 list_changed 刷新或进程重启 */
  listCount: number;
  protocolErrors: number;
  /** 曾经成功启动过几次（随用随起 + 空闲回收会把它加上去） */
  starts: number;
  lastUsedAtMs: number | null;
}

/** 子进程句柄抽象：默认真用 node:child_process，测试可注入替身做确定性关机序列断言 */
export interface McpProcess {
  readonly pid: number | undefined;
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** 写一行（含结尾换行）；stdin 已关闭时抛错 */
  write(line: string): void;
  closeStdin(): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type McpProcessSpawner = (entry: McpServerEntry) => McpProcess;

export interface McpClientPoolOptions {
  servers: readonly McpServerEntry[];
  emit: McpEventEmitter;
  /** 数据目录：blob 外置落 <dataDir>/blobs/ */
  dataDir: string;
  /** 工具注册目标；不传则只维护内部清单（CLI 重建场景不落注册表） */
  registry?: ToolRegistry;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
  /** 每请求软超时（progress 通知可重置），默认 120s */
  requestTimeoutMs?: number;
  /** 每请求硬上限，默认 10 分钟 */
  progressHardCapMs?: number;
  /** 空闲回收窗口，默认 5 分钟 */
  idleReclaimMs?: number;
  /** 关 stdin 之后的等待，默认 2s */
  shutdownStdinWaitMs?: number;
  /** SIGTERM 之后的等待，默认 5s */
  shutdownTermWaitMs?: number;
  /** SIGKILL 之后的观察窗口，默认 500ms */
  shutdownKillGraceMs?: number;
  /** 取消宽限，默认 500ms */
  cancelGraceMs?: number;
  /** blob 外置阈值（估算 token），默认 8000 */
  blobThresholdTokens?: number;
  /** blob 预览字符数，默认 2000 */
  blobPreviewChars?: number;
  /** MCP 工具进注册表的默认 timeoutMs（执行器级），默认 60s */
  toolTimeoutMs?: number;
  /** 起进程的方式，默认 defaultMcpProcessSpawner */
  spawner?: McpProcessSpawner;
  /** 日志出口（stderr、协议错误、注册问题）；默认丢弃，绝不写 stdout */
  onLog?: (line: string) => void;
  now?: () => number;
}

// ──────────────────────────────── JSON-RPC 线格式 ────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 解析一行 stdout。三种形态各有归属：请求（server → client）、通知、响应。
 * 返回失败即"非 JSON-RPC 行"——那正是 design §4.19 纪律 3 要重启 server 的情形。
 */
function parseJsonRpcLine(line: string): { ok: true; message: JsonRpcMessage } | { ok: false; detail: string } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (err) {
    return { ok: false, detail: `不是合法 JSON（${errorText(err)}）：${clip(line, 120)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, detail: `不是 JSON-RPC 对象：${clip(line, 120)}` };
  }
  const record = value as Record<string, unknown>;
  if (record['jsonrpc'] !== '2.0') {
    return { ok: false, detail: `缺少 jsonrpc:"2.0"：${clip(line, 120)}` };
  }
  const hasMethod = typeof record['method'] === 'string';
  const hasId = typeof record['id'] === 'number' || typeof record['id'] === 'string';
  if (!hasMethod && !hasId) {
    return { ok: false, detail: `既不是请求/通知也不是响应（无 method 也无 id）：${clip(line, 120)}` };
  }
  return { ok: true, message: record as unknown as JsonRpcMessage };
}

/** initialize 回包校验结果 */
interface InitializeOutcome {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

/**
 * 校验 initialize 回包（design §4.19："initialize 握手（protocolVersion+capabilities+clientInfo → 校验回包）"）。
 * 校验不通过即判定该 server 不可用——宁可这个 server 不上线，也不带着半懂的协议状态发请求。
 */
function validateInitializeResult(result: unknown, requested: string, server: string): InitializeOutcome {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new McpProtocolError(server, 'initialize 的 result 不是对象');
  }
  const record = result as Record<string, unknown>;
  const version = record['protocolVersion'];
  if (typeof version !== 'string') {
    throw new McpProtocolError(server, 'initialize 回包缺少 protocolVersion');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new McpProtocolError(
      server,
      `initialize 回包协议版本 ${version} 不在支持列表（${SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}）；`
      + `本次请求的是 ${requested}`,
    );
  }
  const serverInfo = asRecord(record['serverInfo']);
  const serverName = serverInfo['name'];
  if (typeof serverName !== 'string' || serverName === '') {
    throw new McpProtocolError(server, 'initialize 回包缺少 serverInfo.name');
  }
  const versionText = serverInfo['version'];
  return {
    protocolVersion: version,
    serverInfo: { name: serverName, version: typeof versionText === 'string' ? versionText : 'unknown' },
    capabilities: asRecord(record['capabilities']),
  };
}

/** tools/list 里的单件工具（只取我们真会用的字段） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/**
 * 校验 tools/list 回包。列表里不合法（名字不符合规范字符集）的条目跳过并记日志：
 * 一件坏工具不该让整个 server 的其它工具都上不了线。
 */
function validateToolsList(
  result: unknown,
  server: string,
  log: (line: string) => void,
): McpToolInfo[] {
  const record = asRecord(result);
  const raw = record['tools'];
  if (!Array.isArray(raw)) {
    throw new McpProtocolError(server, 'tools/list 回包缺少 tools 数组');
  }
  const tools: McpToolInfo[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const name = entry['name'];
    if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) {
      log(`MCP server ${server} 的 tools/list 里有工具名不合法（${JSON.stringify(name)}）：已跳过该工具`);
      continue;
    }
    const info: McpToolInfo = { name };
    const description = entry['description'];
    if (typeof description === 'string') info.description = description;
    if (entry['inputSchema'] !== undefined) info.inputSchema = entry['inputSchema'];
    if (entry['outputSchema'] !== undefined) info.outputSchema = entry['outputSchema'];
    if (entry['annotations'] !== undefined) info.annotations = entry['annotations'];
    tools.push(info);
  }
  return tools;
}

// ──────────────────────────────── 描述预算 ────────────────────────────────

/**
 * 把描述裁进单件预算（registry 的 MAX_DESCRIPTION_TOKENS）。
 * 工具清单是随每次请求发送的常驻开销（design §4.18），MCP 工具的描述由外部 server 提供，
 * 我们对它没有编辑权——裁断比拒绝注册更合理：能力可用，代价受限。
 */
export function fitDescription(text: string, limit: number = MAX_DESCRIPTION_TOKENS): string {
  if (estimateTokens(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(`${text.slice(0, mid)}…`) <= limit) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

/** 合成注册表里的工具名（唯一定义点，测试与排障都按它算名字） */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_NAME_PREFIX}${server}__${tool}`;
}

// ──────────────────────────────── 子进程默认实现 ────────────────────────────────

/** 默认起进程：stdio 三管道，不继承任何标准流（stdout 只属于协议） */
export const defaultMcpProcessSpawner: McpProcessSpawner = (entry) => {
  const child = spawn(entry.command, [...(entry.args ?? [])], {
    cwd: entry.cwd ?? process.cwd(),
    env: entry.env === undefined ? process.env : { ...process.env, ...entry.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return wrapChildProcess(child);
};

function wrapChildProcess(child: ChildProcess): McpProcess {
  const stdoutHandlers: Array<(chunk: string) => void> = [];
  const stderrHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  let settled = false;
  /**
   * stdin 是否已经不可写。
   *
   * 为什么必须自己记这个位：server 进程先退出时，往它的 stdin 写会**异步**触发
   * `EPIPE` / `ERR_STREAM_WRITE_AFTER_END`——那是 `stdin` 上的 'error' 事件，
   * 而 EventEmitter 的 'error' 没有监听者就是**未捕获异常**，直接把宿主进程掀翻。
   * 实测踩到过：`mcp-test` 打一个"起来就退"的 server（比如命令不存在），
   * 结果整台机器陪它一起挂——这与 §4.19 纪律 4「失败绝不抛穿主循环」是直接的冲突。
   *
   * 所以：给 stdin 挂一个吞掉错误的监听者，并把失败折算成"写不进去"→ 由调用方
   * 按 McpServerExitedError 收尾（`request()` 的 catch 已经处理这条路）。
   */
  let stdinClosed = false;

  /** 退出只上报一次：'exit' 与 'error' 谁先到都算数，后到的忽略 */
  const emitExit = (code: number | null, signal: string | null): void => {
    if (settled) return;
    settled = true;
    for (const handler of exitHandlers) handler(code, signal);
  };

  child.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const handler of stdoutHandlers) handler(text);
  });
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const handler of stderrHandlers) handler(text);
  });
  child.stdin?.on('error', () => {
    stdinClosed = true;
  });
  child.once('exit', (code, signal) => emitExit(code, signal));
  // 起不来（命令不存在等）只发 error 不发 exit：统一折算成"退出码未知"
  child.once('error', () => emitExit(null, null));

  return {
    pid: child.pid,
    onStdout(handler) {
      stdoutHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    write(line) {
      const stdin = child.stdin;
      if (stdinClosed || stdin === null || stdin.destroyed) throw new Error('stdin 已关闭，无法写入');
      // 写失败（对端已退出）会异步触发 stdin 的 'error'：那个监听者只置位，
      // 这里不做别的——把失败折算成异常是下一行的事，绝不让 stream 的错误跑成未捕获异常
      stdin.write(line, 'utf8');
    },
    closeStdin() {
      try {
        child.stdin?.end();
      } catch {
        // 已经关了：关机序列继续往下一步走
      }
    },
    kill(signal) {
      // Windows 上 `child.kill('SIGTERM')` 对不响应信号的进程无效（实测：一个忽略 stdin
      // 关闭的 server 在 SIGTERM 之后照旧活着），所以 SIGKILL 那一级必须走进程树终止
      // ——与钩子执行器共用同一份实现（src/process/kill-tree.ts）。
      if (signal === 'SIGKILL') {
        killProcessTree(child);
        return;
      }
      try {
        child.kill(signal);
      } catch {
        // 已经退出：关机序列的下一步会读到 exited
      }
    },
  };
}

// ──────────────────────────────── 连接 ────────────────────────────────

interface PendingRequest {
  id: number;
  method: string;
  startedAt: number;
  /** 硬上限的绝对时刻（progress 重置也不能越过它） */
  hardDeadline: number;
  timeoutMs: number;
  progressToken: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  detachAbort: (() => void) | null;
  done: boolean;
}

/**
 * 连接与池的协作面。连接需要"记录日志、同步注册表、上报异常退出"三种能力，
 * 但不需要池的全部公开 API——窄接口让连接类不依赖池的具体实现。
 *
 * **导出**给 web 层的 `mcp-test` 复用：那条命令要单独拉起一个进程做握手探测、
 * 又**不能**把生命周期写进事件日志（那会让扩展页此后显示"已运行"），
 * 于是它实现这个接口的一个"不落事件"版本，而不是复刻一遍连接逻辑。
 */
export interface McpConnectionHost {
  readonly clientInfo: { name: string; version: string };
  readonly protocolVersion: string;
  readonly progressHardCapMs: number;
  readonly defaultRequestTimeoutMs: number;
  now(): number;
  log(line: string): void;
  syncServerTools(conn: McpConnection): void;
  onListChangedRefresh(conn: McpConnection): void;
  onConnectionExit(conn: McpConnection, code: number | null, signal: string | null): void;
  onProtocolViolation(conn: McpConnection, detail: string): void;
  gracefulCancel(conn: McpConnection, requestId: number, reason: string): void;
}

/**
 * 一个 server 进程的连接：握手、请求表、超时时钟、stdout 行解析、关机序列。
 * 生命周期由池持有；连接自己不知道"空闲多久"这类池级策略。
 */
export class McpConnection {
  readonly entry: McpServerEntry;
  private readonly host: McpConnectionHost;
  private readonly process: McpProcess;

  private nextRequestId = 1;
  private stdoutBuffer = '';
  private stderrLines: string[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  /** 已作废请求的迟到响应 id：不当作协议错误，只当作"这个 server 不配合取消"的证据 */
  private readonly lateResponses = new Set<number>();

  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private exitWaiters: Array<() => void> = [];
  private shuttingDown = false;
  private shutdownTask: Promise<McpShutdownReport> | null = null;
  private stopReported = false;

  private readyFlag = false;
  private toolsCache: McpToolInfo[] = [];
  private capabilitiesCache: Record<string, unknown> = {};
  private protocolVersionValue: string | null = null;
  private serverInfoValue: { name: string; version: string } | null = null;
  private annotationsCache = new Map<string, unknown>();
  private listCountValue = 0;
  private protocolErrorCount = 0;
  private progressCount = 0;
  private lastUsedAtMs: number;

  constructor(entry: McpServerEntry, process: McpProcess, host: McpConnectionHost) {
    this.entry = entry;
    this.process = process;
    this.host = host;
    this.lastUsedAtMs = host.now();
  }

  // ── 只读视图 ──

  get serverName(): string {
    return this.entry.name;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get ready(): boolean {
    return this.readyFlag && !this.exited && !this.shuttingDown;
  }

  /**
   * 连接不再可用：协议已不可信（stdout 违规），或某个请求已失控（进了取消宽限）。
   * 这两种情形下继续复用会把请求-响应时序搞脏，而"脏时序"是查不出来的。
   * 置位后后续调用会重新拉起进程，旧进程由关机序列收掉。
   */
  markUnusable(): void {
    this.readyFlag = false;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  get listCount(): number {
    return this.listCountValue;
  }

  get protocolErrors(): number {
    return this.protocolErrorCount;
  }

  get annotations(): ReadonlyMap<string, unknown> {
    return this.annotationsCache;
  }

  get tools(): readonly McpToolInfo[] {
    return this.toolsCache;
  }

  get lastUsed(): number {
    return this.lastUsedAtMs;
  }

  get capabilities(): Record<string, unknown> {
    return this.capabilitiesCache;
  }

  /** 握手后协商出来的协议版本（未握手为 null） */
  get negotiatedProtocolVersion(): string | null {
    return this.protocolVersionValue;
  }

  /**
   * 握手时 server 自报的身份（未握手为 null）。
   * 与配置里的 `name` 是**两个不同的东西**：那个是"我们怎么叫它"，这个是"它怎么称呼自己"。
   * 排查"配错了 command"时后者的价值更大——它证明对面确实是我们以为的那个 server。
   */
  get serverInfo(): { name: string; version: string } | null {
    return this.serverInfoValue;
  }

  effectiveRequestTimeoutMs(fallback: number): number {
    return Math.max(1, this.entry.requestTimeoutMs ?? fallback);
  }

  effectiveIdleReclaimMs(fallback: number): number {
    return Math.max(1, this.entry.idleReclaimMs ?? fallback);
  }

  /** 记一次使用：空闲回收只看它 */
  touch(): void {
    this.lastUsedAtMs = this.host.now();
  }

  get shutdownStarted(): boolean {
    return this.shuttingDown;
  }

  get shutdownReport(): Promise<McpShutdownReport> | null {
    return this.shutdownTask;
  }

  attachShutdown(task: Promise<McpShutdownReport>): void {
    this.shutdownTask = task;
  }

  hasRespondedLate(requestId: number): boolean {
    return this.lateResponses.has(requestId);
  }

  /** 关机开始的统一入口：后续到达的退出事件不再重复上报 */
  beginShutdown(cause: Error): void {
    this.shuttingDown = true;
    this.failAllPending(cause);
  }

  markStopReported(): boolean {
    if (this.stopReported) return false;
    this.stopReported = true;
    return true;
  }

  stderrTail(maxChars = 300): string {
    const text = this.stderrLines.join('\n').trim();
    return text === '' ? '' : clip(text, maxChars);
  }

  // ── 进程事件 ──

  onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n');
      if (index < 0) break;
      const raw = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim() === '') continue;
      this.onStdoutLine(line);
      if (this.exited) return;
    }
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
      const sample = clip(this.stdoutBuffer.slice(0, 160), 160);
      this.stdoutBuffer = '';
      this.protocolViolation(
        `单行超过 ${MAX_STDOUT_LINE_CHARS} 字符仍未见换行（消息必须按行分隔）：${sample}`,
      );
    }
  }

  onStderrChunk(chunk: string): void {
    // stderr 是 server 的日志通道：捕获为日志，不参与协议
    for (const line of chunk.split(/\r?\n/u)) {
      const text = line.trim();
      if (text === '') continue;
      this.stderrLines.push(text);
      if (this.stderrLines.length > 50) this.stderrLines = this.stderrLines.slice(-50);
      this.host.log(`[mcp:${this.serverName}] ${text}`);
    }
  }

  onProcessExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    const waiters = [...this.exitWaiters];
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();

    const cause = new McpServerExitedError(this.serverName, code, signal);
    this.failAllPending(cause);
    if (this.shuttingDown) return;
    const tail = this.stderrTail();
    this.host.log(
      `MCP server ${this.serverName} 进程退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）`
      + `${tail === '' ? '' : `；stderr 尾部：${tail}`}`,
    );
    this.host.onConnectionExit(this, code, signal);
  }

  // ── stdout 派发 ──

  private onStdoutLine(line: string): void {
    const parsed = parseJsonRpcLine(line);
    if (!parsed.ok) {
      this.protocolViolation(parsed.detail);
      return;
    }
    const message = parsed.message;

    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        this.onNotification(message.method, message.params);
        return;
      }
      // server → client 的请求：我们不声明 roots/sampling/elicitation，所以不该来（§4.19）
      this.host.log(
        `MCP server ${this.serverName} 发来未声明能力的请求 ${message.method}：`
        + 'roots/sampling/elicitation 一律不声明，已回 method not found',
      );
      this.writePayload({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}（客户端未声明该能力）` },
      });
      return;
    }

    if (typeof message.id !== 'number') {
      this.protocolViolation(`响应 id 不是数字（客户端只用数字 id）：${clip(line, 120)}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      // 迟到/重复响应：不是协议错误（我们的取消语义允许它出现），记下来当"server 守约"的证据
      this.lateResponses.add(message.id);
      this.host.log(`MCP server ${this.serverName} 的响应 id ${message.id} 没有在途请求（迟到或重复）：已丢弃`);
      return;
    }
    if (message.error !== undefined && message.error !== null) {
      const err = asRecord(message.error);
      const code = typeof err['code'] === 'number' ? err['code'] : -32000;
      const text = typeof err['message'] === 'string' ? err['message'] : 'server 未给出错误消息';
      this.settle(pending, {
        kind: 'error',
        error: new McpRpcError(this.serverName, pending.method, code, text, err['data']),
      });
      return;
    }
    this.settle(pending, { kind: 'result', value: message.result });
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case 'notifications/tools/list_changed':
        this.host.log(`MCP server ${this.serverName} 通知 tools/list_changed：刷新工具清单`);
        this.host.onListChangedRefresh(this);
        return;
      case 'notifications/progress':
        this.onProgress(params);
        return;
      case 'notifications/cancelled':
        // server 侧取消：我们不主动向 server 发请求（roots/sampling 都没声明），这里只记日志
        this.host.log(`MCP server ${this.serverName} 发来 notifications/cancelled：已忽略（客户端未发起可取消的请求）`);
        return;
      default:
        this.host.log(`MCP server ${this.serverName} 的通知 ${method} 在最小子集之外：已忽略`);
    }
  }

  /** progress 重置软超时时钟，但绝不允许越过硬上限 */
  private onProgress(params: unknown): void {
    const record = asRecord(params);
    const rawToken = record['progressToken'] ?? asRecord(record['_meta'])['progressToken'];
    const token = typeof rawToken === 'string'
      ? rawToken
      : typeof rawToken === 'number' ? String(rawToken) : null;
    if (token === null) return;
    let target: PendingRequest | undefined;
    for (const pending of this.pending.values()) {
      if (pending.progressToken === token) {
        target = pending;
        break;
      }
    }
    if (target === undefined) return;
    this.progressCount += 1;
    if (this.host.now() >= target.hardDeadline) {
      // 硬上限已到：progress 不再续命，立刻按超时收尾
      this.timeoutPending(target);
      return;
    }
    if (target.timer !== null) clearTimeout(target.timer);
    this.armTimeout(target);
  }

  private protocolViolation(detail: string): void {
    this.protocolErrorCount += 1;
    // 协议不可信：立刻不许再被复用，否则下一次调用会在这个坏连接上继续发请求
    this.markUnusable();
    this.failAllPending(new McpProtocolError(this.serverName, detail));
    this.host.onProtocolViolation(this, detail);
  }

  // ── 握手 ──

  /**
   * 握手：initialize → 校验回包 → notifications/initialized → tools/list（一次并缓存）。
   * 失败会抛出，由池负责关掉这个进程并把失败如实告诉调用方。
   */
  async handshake(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: this.host.protocolVersion,
      // 刻意声明空能力：roots/sampling/elicitation 不声明，server 就不会发对应请求
      capabilities: {},
      clientInfo: { name: this.host.clientInfo.name, version: this.host.clientInfo.version },
    }, { timeoutMs: this.effectiveRequestTimeoutMs(this.host.defaultRequestTimeoutMs) });

    const outcome = validateInitializeResult(result, this.host.protocolVersion, this.serverName);
    this.protocolVersionValue = outcome.protocolVersion;
    this.serverInfoValue = outcome.serverInfo;
    this.capabilitiesCache = outcome.capabilities;

    this.writeNotification('notifications/initialized', {});
    this.readyFlag = true;

    if (outcome.capabilities['tools'] === undefined) {
      this.host.log(`MCP server ${this.serverName} 未声明 tools 能力：按规范不发 tools/list，该 server 无工具`);
      this.toolsCache = [];
      return;
    }
    await this.refreshTools();
  }

  /** 拉一次 tools/list 并刷新缓存（启动时一次；list_changed 与重连后再来一次） */
  async refreshTools(): Promise<void> {
    const result = await this.request('tools/list', {}, {
      timeoutMs: this.effectiveRequestTimeoutMs(this.host.defaultRequestTimeoutMs),
    });
    const tools = validateToolsList(result, this.serverName, (line) => this.host.log(line));
    this.toolsCache = tools;
    this.listCountValue += 1;
    this.annotationsCache = new Map<string, unknown>();
    for (const info of tools) {
      if (info.annotations !== undefined) this.annotationsCache.set(info.name, info.annotations);
    }
    this.host.syncServerTools(this);
  }

  // ── 请求 ──

  /**
   * 调用一个工具：request 包一层，带上 progress token。
   * token 直接取请求 id 的字符串形式——一个请求一个 token，progress 通知才能精确对上是哪个请求。
   */
  async callToolInternal(
    toolName: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    this.touch();
    return await this.request('tools/call', { name: toolName, arguments: args }, {
      timeoutMs: options.timeoutMs,
      // 带上 progressToken：server 才会发 notifications/progress，时钟重置才有依据
      useProgress: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    options: { timeoutMs?: number; hardCapMs?: number; signal?: AbortSignal; useProgress?: boolean },
  ): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new McpServerExitedError(this.serverName, this.exitInfo?.code ?? null, this.exitInfo?.signal ?? null));
    }
    if (this.shuttingDown) {
      return Promise.reject(new McpServerStoppedError(this.serverName, 'shutdown'));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const startedAt = this.host.now();
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.effectiveRequestTimeoutMs(this.host.defaultRequestTimeoutMs));
    // 硬上限不低于软超时：否则时钟永远到不了软超时，"progress 可重置"就没有意义
    const hardCapMs = Math.max(timeoutMs, options.hardCapMs ?? this.host.progressHardCapMs);
    const progressToken = options.useProgress === true ? String(id) : null;
    const body: Record<string, unknown> = { ...(params ?? {}) };
    if (progressToken !== null) body['_meta'] = { progressToken };

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        startedAt,
        hardDeadline: startedAt + hardCapMs,
        timeoutMs,
        progressToken,
        timer: null,
        resolve,
        reject,
        detachAbort: null,
        done: false,
      };
      this.pending.set(id, pending);
      this.armTimeout(pending);

      const signal = options.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          this.settle(pending, {
            kind: 'error',
            error: new McpAbortedError(this.serverName, method, '信号在派发前已置位'),
          });
          return;
        }
        const onAbort = (): void => {
          this.writeNotification('notifications/cancelled', { requestId: id, reason: 'aborted' });
          this.settle(pending, {
            kind: 'error',
            error: new McpAbortedError(this.serverName, method, '调用方取消了这次请求'),
          });
          this.host.gracefulCancel(this, id, 'aborted');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      try {
        this.writePayload({ jsonrpc: '2.0', id, method, params: body });
      } catch (err) {
        this.settle(pending, {
          kind: 'error',
          error: new McpServerExitedError(this.serverName, this.exitInfo?.code ?? null, this.exitInfo?.signal ?? null),
        });
        this.host.log(`MCP server ${this.serverName} 的 ${method} 写入失败：${errorText(err)}`);
      }
    });
  }

  private armTimeout(pending: PendingRequest): void {
    const now = this.host.now();
    const nextAt = Math.min(now + pending.timeoutMs, pending.hardDeadline);
    const delay = Math.max(0, nextAt - now);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (pending.done) return;
      this.timeoutPending(pending);
    }, delay);
  }

  private timeoutPending(pending: PendingRequest): void {
    const hardCapHit = this.host.now() >= pending.hardDeadline;
    this.settle(pending, {
      kind: 'error',
      error: new McpRequestTimeoutError(this.serverName, pending.method, pending.timeoutMs, hardCapHit),
    });
    // 超时即杀的第一半：先把取消告诉 server（规范要求的通知）
    this.writeNotification('notifications/cancelled', {
      requestId: pending.id,
      reason: hardCapHit ? 'hard-timeout' : 'timeout',
    });
    // 第二半在池里：宽限内不配合取消的连接判定失效，走关机序列换掉它
    this.host.gracefulCancel(this, pending.id, hardCapHit ? 'hard-timeout' : 'timeout');
  }

  private settle(pending: PendingRequest, outcome: { kind: 'result'; value: unknown } | { kind: 'error'; error: Error }): void {
    if (pending.done) return;
    pending.done = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.detachAbort?.();
    pending.detachAbort = null;
    this.pending.delete(pending.id);
    if (outcome.kind === 'result') pending.resolve(outcome.value);
    else pending.reject(outcome.error);
  }

  private failAllPending(cause: Error): void {
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, { kind: 'error', error: cause });
    }
  }

  private writeNotification(method: string, params: Record<string, unknown>): void {
    try {
      this.writePayload({ jsonrpc: '2.0', method, params });
    } catch (err) {
      this.host.log(`MCP server ${this.serverName} 的 ${method} 通知写入失败：${errorText(err)}`);
    }
  }

  /** 一条消息一行，绝不内嵌换行（design §4.19 stdio 纪律） */
  private writePayload(payload: Record<string, unknown>): void {
    const line = JSON.stringify(payload);
    if (line.includes('\n')) {
      throw new McpProtocolError(this.serverName, 'JSON-RPC 消息里出现了未转义的换行');
    }
    this.process.write(`${line}\n`);
  }

  // ── 关机序列 ──

  closeStdin(): void {
    this.process.closeStdin();
  }

  killProcess(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.process.kill(signal);
  }

  /** 等退出：已退出立刻返回 true；否则等事件或超时 */
  waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    const ms = Math.max(0, timeoutMs);
    return new Promise<boolean>((resolve) => {
      const remove = (): void => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
      };
      const waiter = (): void => {
        clearTimeout(timer);
        remove();
        resolve(true);
      };
      const timer = setTimeout(() => {
        remove();
        resolve(this.exited);
      }, ms);
      this.exitWaiters.push(waiter);
    });
  }
}

// ──────────────────────────────── 池 ────────────────────────────────

/**
 * MCP 客户端池：配置里注册若干 stdio server，按需拉起、缓存工具清单、空闲回收、统一关机。
 *
 * 池对外的三条使用路径：`registerAll()`（宿主启动期枚举并注册工具）、
 * `callTool()`（工具 handler 的唯一入口）、`shutdown()`（宿主关停）。
 * 任何失败都折算成结果或日志，绝不抛穿主循环——这是"崩溃不传染"的落点。
 */
export class McpClientPool implements McpConnectionHost {
  readonly clientInfo: { name: string; version: string };
  readonly protocolVersion: string;
  readonly progressHardCapMs: number;
  readonly defaultRequestTimeoutMs: number;

  private readonly entries = new Map<string, McpServerEntry>();
  private readonly connections = new Map<string, McpConnection>();
  private readonly starting = new Map<string, Promise<McpConnection>>();
  private readonly registeredByServer = new Map<string, string[]>();
  private readonly startCounts = new Map<string, number>();
  private readonly registryRef: ToolRegistry | undefined;
  private readonly emitEvent: McpEventEmitter;
  private readonly dataDir: string;
  private readonly defaultIdleReclaimMs: number;
  private readonly shutdownStdinWaitMs: number;
  private readonly shutdownTermWaitMs: number;
  private readonly shutdownKillGraceMs: number;
  private readonly cancelGraceMs: number;
  private readonly blobThresholdTokens: number;
  private readonly blobPreviewChars: number;
  private readonly toolTimeoutMs: number;
  private readonly spawnProcess: McpProcessSpawner;
  private readonly logLine: (line: string) => void;
  private readonly nowFn: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(options: McpClientPoolOptions) {
    this.clientInfo = options.clientInfo ?? { ...DEFAULT_CLIENT_INFO };
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.progressHardCapMs = Math.max(1, options.progressHardCapMs ?? DEFAULT_PROGRESS_HARD_CAP_MS);
    this.defaultRequestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.defaultIdleReclaimMs = Math.max(1, options.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS);
    this.shutdownStdinWaitMs = Math.max(0, options.shutdownStdinWaitMs ?? DEFAULT_SHUTDOWN_STDIN_WAIT_MS);
    this.shutdownTermWaitMs = Math.max(0, options.shutdownTermWaitMs ?? DEFAULT_SHUTDOWN_TERM_WAIT_MS);
    this.shutdownKillGraceMs = Math.max(0, options.shutdownKillGraceMs ?? DEFAULT_SHUTDOWN_KILL_GRACE_MS);
    this.cancelGraceMs = Math.max(0, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    this.blobThresholdTokens = Math.max(0, options.blobThresholdTokens ?? DEFAULT_BLOB_THRESHOLD_TOKENS);
    this.blobPreviewChars = Math.max(0, options.blobPreviewChars ?? DEFAULT_BLOB_PREVIEW_CHARS);
    this.toolTimeoutMs = Math.max(1, options.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS);
    this.spawnProcess = options.spawner ?? defaultMcpProcessSpawner;
    this.logLine = options.onLog ?? (() => undefined);
    this.nowFn = options.now ?? (() => Date.now());
    this.emitEvent = options.emit;
    this.dataDir = options.dataDir;
    this.registryRef = options.registry;

    for (const entry of options.servers) {
      const issue = validateEntry(entry);
      if (issue !== null) {
        this.logLine(`MCP 配置问题（已跳过该 server）：${issue}`);
        continue;
      }
      if (this.entries.has(entry.name)) {
        this.logLine(`MCP 配置里 server 名 ${entry.name} 重复：只保留第一条`);
        continue;
      }
      this.entries.set(entry.name, entry);
    }
  }

  // ── 对外 API ──

  /**
   * 启动期枚举：把每个 server 拉起一次、拉清单、注册工具，然后交给空闲回收管。
   * 单个 server 起不来只记日志并跳过——一个坏扩展不该让整机起不来。
   */
  async registerAll(): Promise<McpServerStatus[]> {
    for (const entry of this.entries.values()) {
      if (entry.disabled === true) continue;
      try {
        await this.ensureReady(entry.name);
      } catch (err) {
        this.logLine(
          `MCP server ${entry.name} 启动失败：${errorText(err)}`
          + '（该 server 的工具未注册，其余 server 不受影响）',
        );
      }
    }
    return this.status();
  }

  /** 运行期快照（CLI/前端观测） */
  status(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const entry of this.entries.values()) {
      const conn = this.connections.get(entry.name);
      out.push({
        name: entry.name,
        running: conn !== undefined && !conn.hasExited,
        pid: conn?.pid ?? null,
        ready: conn?.ready ?? false,
        protocolVersion: conn === undefined ? null : conn.negotiatedProtocolVersion,
        tools: conn === undefined ? [] : conn.tools.map((tool) => tool.name),
        inFlight: conn?.inFlight ?? 0,
        listCount: conn?.listCount ?? 0,
        protocolErrors: conn?.protocolErrors ?? 0,
        starts: this.startCounts.get(entry.name) ?? 0,
        lastUsedAtMs: conn === undefined ? null : conn.lastUsed,
      });
    }
    return out;
  }

  /** 已注册进注册表的 MCP 工具全名（含对外不可见的 destructive） */
  toolNames(): string[] {
    const names: string[] = [];
    for (const list of this.registeredByServer.values()) names.push(...list);
    return names;
  }

  /**
   * 调用一个 MCP 工具。**永不抛出**：所有失败都折算成给模型看的结果文本 +
   * 稳定的错误码（宿主据此判定，模型据此改道）。
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ToolHandlerResult> {
    const entry = this.entries.get(serverName);
    if (entry === undefined) {
      return errorResult(
        `MCP server ${serverName} 不在配置里（mcp.servers[]）：先确认名字拼写，或把它加进配置再重试。`,
        MCP_ERROR_CODES.notConfigured,
      );
    }
    if (entry.disabled === true) {
      return errorResult(
        `MCP server ${serverName} 在配置里被标为 disabled：要调用它请先在配置里启用。`,
        MCP_ERROR_CODES.disabled,
      );
    }

    let conn: McpConnection;
    try {
      conn = await this.ensureReady(serverName);
    } catch (err) {
      return errorResult(
        `MCP server ${serverName} 未能启动：${errorText(err)}。`
        + '检查 command/args 是否可执行、stderr 里有没有报错；修好后重试即可（工具调用会重新拉起它）。',
        MCP_ERROR_CODES.spawnFailed,
      );
    }

    const timeoutMs = options.timeoutMs ?? conn.effectiveRequestTimeoutMs(this.defaultRequestTimeoutMs);
    const argumentsValue = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
    try {
      const result = await conn.callToolInternal(toolName, argumentsValue, {
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return await this.renderToolResult(conn, toolName, result);
    } catch (err) {
      return this.mapCallError(conn, toolName, err, timeoutMs);
    }
  }

  /** 主动扫一次空闲回收（测试与宿主手动触发都走它；定时器只是它的调用者） */
  async reclaimIdle(): Promise<McpShutdownReport[]> {
    const reports: McpShutdownReport[] = [];
    const now = this.nowFn();
    for (const conn of [...this.connections.values()]) {
      if (conn.hasExited || conn.inFlight > 0) continue;
      if (now - conn.lastUsed < conn.effectiveIdleReclaimMs(this.defaultIdleReclaimMs)) continue;
      reports.push(await this.reap(conn, 'idle-reclaim'));
    }
    return reports;
  }

  /** 宿主关停：停掉扫描定时器，按关机序列逐个收掉子进程 */
  async shutdown(): Promise<McpShutdownReport[]> {
    this.shuttingDown = true;
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const reports: McpShutdownReport[] = [];
    for (const conn of [...this.connections.values()]) {
      reports.push(await this.reap(conn, 'shutdown'));
    }
    this.connections.clear();
    return reports;
  }

  // ── 连接建立 ──

  private async ensureReady(name: string): Promise<McpConnection> {
    const entry = this.entries.get(name);
    if (entry === undefined) throw new Error(`MCP server ${name} 未配置`);
    if (entry.disabled === true) throw new Error(`MCP server ${name} 已被禁用`);

    const live = this.connections.get(name);
    if (live !== undefined && live.ready) {
      live.touch();
      return live;
    }
    const inFlight = this.starting.get(name);
    if (inFlight !== undefined) {
      const conn = await inFlight;
      conn.touch();
      return conn;
    }
    const task = this.startConnection(entry);
    this.starting.set(name, task);
    try {
      const conn = await task;
      conn.touch();
      return conn;
    } finally {
      this.starting.delete(name);
    }
  }

  private async startConnection(entry: McpServerEntry): Promise<McpConnection> {
    let process: McpProcess;
    try {
      process = this.spawnProcess(entry);
    } catch (err) {
      throw new Error(`进程未能启动（${entry.command}）：${errorText(err)}`);
    }

    const conn = new McpConnection(entry, process, this);
    this.connections.set(entry.name, conn);
    process.onStdout((chunk) => conn.onStdoutChunk(chunk));
    process.onStderr((chunk) => conn.onStderrChunk(chunk));
    process.onExit((code, signal) => conn.onProcessExit(code, signal));

    try {
      await conn.handshake();
    } catch (err) {
      // 握手失败 = 这个进程不可用：按关机序列收掉，不留半开的连接
      await this.reap(conn, 'crashed').catch(() => undefined);
      throw err;
    }

    this.startCounts.set(entry.name, (this.startCounts.get(entry.name) ?? 0) + 1);
    this.syncServerTools(conn);
    this.emitEvent('mcp/server-started', {
      name: entry.name,
      pid: process.pid ?? 0,
      tools: conn.tools.map((tool) => tool.name),
    });
    this.ensureSweeper();
    return conn;
  }

  private ensureSweeper(): void {
    if (this.sweeper !== null || this.shuttingDown) return;
    // 扫描周期取回收窗口的 1/4（夹在 10ms..5s 之间）：窗口越短越要勤扫，但别扫成忙等
    const period = Math.max(10, Math.min(5_000, Math.floor(this.defaultIdleReclaimMs / 4)));
    this.sweeper = setInterval(() => {
      void this.reclaimIdle().catch((err) => {
        this.logLine(`MCP 空闲回收扫描异常：${errorText(err)}`);
      });
    }, period);
    // 不阻止进程退出：扫描器是维护性任务，不该成为"进程退不掉"的理由
    this.sweeper.unref?.();
  }

  // ── 工具注册 ──

  /** 把一个 server 的清单同步进注册表（新增注册、变更替换、消失卸载） */
  syncServerTools(conn: McpConnection): void {
    this.registeredByServer.set(conn.serverName, this.registerToolsOf(conn));
  }

  private registerToolsOf(conn: McpConnection): string[] {
    const registry = this.registryRef;
    const names: string[] = [];
    for (const info of conn.tools) {
      const def = this.buildToolDefinition(conn, info);
      if (def === null) continue;
      names.push(def.name);
      if (registry === undefined) continue;
      try {
        registry.register(def, { replace: true });
      } catch (err) {
        this.logLine(`MCP 工具 ${def.name} 注册失败：${errorText(err)}`);
      }
    }
    // 刷新后消失的工具必须卸载：清单是模型的输入，残留条目会让它去调一个不存在的工具
    const previous = this.registeredByServer.get(conn.serverName) ?? [];
    for (const name of previous) {
      if (names.includes(name)) continue;
      if (registry === undefined) continue;
      if (registry.unregister(name)) {
        this.logLine(`MCP server ${conn.serverName} 的工具 ${name} 已从注册表卸载（清单刷新后消失）`);
      }
    }
    return names;
  }

  /**
   * 由 MCP 清单构造我方工具定义。**annotation 只作参考**：
   * readOnlyHint 之类的自我声明不参与三属性判定（server 说只读，不等于崩溃后可以自动重试）。
   */
  private buildToolDefinition(conn: McpConnection, info: McpToolInfo): ToolDefinition | null {
    const entry = conn.entry;
    const name = mcpToolName(entry.name, info.name);
    if (name.length > MCP_TOOL_NAME_MAX_LENGTH) {
      this.logLine(
        `MCP 工具 ${name} 名字超长（${name.length} > ${MCP_TOOL_NAME_MAX_LENGTH}）：已跳过该工具`,
      );
      return null;
    }
    const attributes = resolveToolAttributes(entry, info.name, this.toolTimeoutMs);
    const rawDescription = info.description ?? `MCP server ${entry.name} 提供的工具 ${info.name}`;
    const def: ToolDefinition = {
      name,
      description: fitDescription(`${rawDescription}（MCP:${entry.name}）`),
      parameters: asSchema(info.inputSchema),
      executionMode: attributes.executionMode,
      // 不信任即默认关：未显式声明的 MCP 工具一律 destructive（design §4.19 纪律 1）
      sideEffect: attributes.sideEffect,
      timeoutMs: attributes.timeoutMs,
      handler: (args, ctx) => this.callTool(entry.name, info.name, args, { signal: ctx.signal }),
    };
    if (info.outputSchema !== undefined && typeof info.outputSchema === 'object' && info.outputSchema !== null) {
      def.outputSchema = asSchema(info.outputSchema);
    }
    return def;
  }

  // ── 结果渲染 ──

  private async renderToolResult(conn: McpConnection, toolName: string, result: unknown): Promise<ToolHandlerResult> {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return errorResult(
        `MCP 工具 ${toolName} 的返回不是对象（不符合规范）：原始值 ${clip(JSON.stringify(result) ?? 'undefined', 200)}`,
        MCP_ERROR_CODES.badContent,
      );
    }
    const record = result as Record<string, unknown>;
    const parts = Array.isArray(record['content']) ? record['content'] : [];
    let text = parts.map(renderContentPart).filter((part) => part !== '').join('\n\n');
    if (text === '' && record['structuredContent'] !== undefined) {
      text = safeJson(record['structuredContent']);
    }
    if (text === '') {
      text = record['isError'] === true
        ? '（MCP 工具报告失败，但没有给出内容）'
        : '（MCP 工具没有返回内容）';
    }

    // 大结果外置（design §4.12）：MCP 的 content[] 可能是一整篇文档，不能直接塞进上下文。
    // 上限（估算 21k token / 64 KiB 取小）与父循环**同一份**（blob-store 的默认值）。
    // 指针文案引 `blobPointerText`（唯一实现）——以前这里自己拼了一遍，改口径时两处必然漂移。
    const offloaded = await offloadIfLarge(text, {
      dataDir: this.dataDir,
      thresholdTokens: this.blobThresholdTokens,
      previewChars: this.blobPreviewChars,
    });
    const body = offloaded.contentRef === undefined
      ? offloaded.content
      : `${offloaded.content}\n${blobPointerText(offloaded.contentRef)}`;

    if (record['isError'] === true) {
      return errorResult(body, MCP_ERROR_CODES.toolError);
    }
    return okResult(body);
  }

  private mapCallError(conn: McpConnection, toolName: string, err: unknown, timeoutMs: number): ToolHandlerResult {
    const name = conn.serverName;
    if (err instanceof McpRequestTimeoutError) {
      return errorResult(
        `MCP 工具 ${toolName}（server ${name}）${err.hardCap ? '撞到 progress 硬上限' : `超过 ${timeoutMs}ms 未返回`}：`
        + '已发出 notifications/cancelled，并在逾期的取消宽限后回收该 server 进程。'
        + '重试会重新拉起 server；若反复超时，请缩小参数范围或检查这个 server 自身的日志。',
        MCP_ERROR_CODES.timeout,
      );
    }
    if (err instanceof McpAbortedError) {
      return errorResult(
        `MCP 工具 ${toolName}（server ${name}）的调用被取消：已发出 notifications/cancelled，没有产出结论，需要时请重新发起。`,
        MCP_ERROR_CODES.aborted,
      );
    }
    if (err instanceof McpRpcError) {
      return errorResult(
        `MCP 工具 ${toolName}（server ${name}）返回 JSON-RPC 错误 ${err.code}：${err.message}`,
        MCP_ERROR_CODES.rpc,
      );
    }
    if (err instanceof McpProtocolError) {
      return errorResult(
        `MCP server ${name} 违反 stdio 纪律（${err.detail}）：该进程已被重启。`
        + 'server 的 stdout 只允许写合法 JSON-RPC，日志必须走 stderr。',
        MCP_ERROR_CODES.protocol,
      );
    }
    if (err instanceof McpServerExitedError) {
      return errorResult(
        `MCP server ${name} 的进程已退出（code=${err.code ?? 'null'}）：这次调用没有结论。`
        + '下次调用会自动重新拉起它；若反复退出，请看它的 stderr 日志。',
        MCP_ERROR_CODES.stopped,
      );
    }
    if (err instanceof McpServerStoppedError) {
      return errorResult(
        `MCP server ${name} 已停止（${err.reason}）：这次调用没有结论，重试会重新拉起它。`,
        MCP_ERROR_CODES.stopped,
      );
    }
    return errorResult(
      `MCP 工具 ${toolName}（server ${name}）调用失败：${errorText(err)}`,
      MCP_ERROR_CODES.rpc,
    );
  }

  // ── 协作面（McpConnectionHost）──

  now(): number {
    return this.nowFn();
  }

  log(line: string): void {
    this.logLine(line);
  }

  /** 收到 tools/list_changed：刷新清单（调用路径上不做重复 list，刷新只在这里发生） */
  onListChangedRefresh(conn: McpConnection): void {
    void conn.refreshTools().catch((err) => {
      this.logLine(`MCP server ${conn.serverName} 刷新工具清单失败：${errorText(err)}`);
    });
  }

  /** 连接异常退出（非主动关停）：从池里摘掉并如实上报 crashed */
  onConnectionExit(conn: McpConnection, code: number | null, signal: string | null): void {
    this.detach(conn);
    if (conn.shutdownStarted) return;
    if (!conn.markStopReported()) return;
    this.emitEvent('mcp/server-stopped', { name: conn.serverName, reason: 'crashed' });
    this.logLine(
      `MCP server ${conn.serverName} 异常退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）后已从池中摘除：`
      + '下次调用会自动重新拉起它',
    );
  }

  /** stdout 协议违规：先让在途请求失败，再按关机序列重启这个进程（§4.19 纪律 3） */
  onProtocolViolation(conn: McpConnection, detail: string): void {
    this.logLine(
      `MCP server ${conn.serverName} 协议错误：${detail}。`
      + 'server 的 stdout 只允许写合法 JSON-RPC（日志走 stderr）；按纪律重启该进程。',
    );
    void this.reap(conn, 'crashed').catch(() => undefined);
  }

  /**
   * 取消宽限：发出 cancelled 之后给 server 一点收敛时间。宽限内没有回应（也不退出）的连接
   * 判定失效——这就是"超时即杀"的落点：不配合取消的 server 不能留在池里继续接调用。
   */
  gracefulCancel(conn: McpConnection, requestId: number, reason: string): void {
    void this.runGracefulCancel(conn, requestId, reason);
  }

  private async runGracefulCancel(conn: McpConnection, requestId: number, reason: string): Promise<void> {
    // 一旦发出取消，这个连接就不再接新调用：它的时序已经不是"每个请求都有响应"的干净状态
    conn.markUnusable();
    const deadline = this.nowFn() + this.cancelGraceMs;
    for (;;) {
      if (conn.hasExited || conn.hasRespondedLate(requestId)) return;
      const remaining = deadline - this.nowFn();
      if (remaining <= 0) break;
      await sleep(Math.min(25, remaining));
    }
    if (conn.hasExited || conn.hasRespondedLate(requestId)) return;
    this.logLine(
      `MCP server ${conn.serverName} 在取消宽限 ${this.cancelGraceMs}ms 内既未回应 id ${requestId} 的取消也未退出`
      + `（${reason}）：判定该连接失效，按关机序列回收`,
    );
    await this.reap(conn, 'crashed').catch(() => undefined);
  }

  // ── 关机序列 ──

  /**
   * 从池里摘掉这个连接。**只在表里仍然是它时才删**：旧连接的关机序列可能还在跑，
   * 而期间同名的新连接已经建立（协议违规重启、超时回收后重试都走这条），
   * 无条件 delete 会把刚起来的新连接一起抹掉。
   */
  private detach(conn: McpConnection): void {
    if (this.connections.get(conn.serverName) === conn) {
      this.connections.delete(conn.serverName);
    }
  }

  /**
   * 官方关机序列（唯一一条关停路径）：
   * 关 stdin → 等待退出 → 超时 SIGTERM → 再等待 → 超时 SIGKILL。
   * 两级等待都可配；返回的 stages 是顺序事实，测试与排障直接断言它。
   */
  async reap(conn: McpConnection, reason: McpStopReason): Promise<McpShutdownReport> {
    const existing = conn.shutdownReport;
    if (existing !== null) return existing;

    const task = (async (): Promise<McpShutdownReport> => {
      const stages: McpShutdownStage[] = [];
      conn.beginShutdown(new McpServerStoppedError(conn.serverName, reason));

      conn.closeStdin();
      stages.push('stdin-closed');

      if (await conn.waitExit(this.shutdownStdinWaitMs)) {
        stages.push('exited');
      } else {
        conn.killProcess('SIGTERM');
        stages.push('sigterm');
        if (await conn.waitExit(this.shutdownTermWaitMs)) {
          stages.push('exited');
        } else {
          conn.killProcess('SIGKILL');
          stages.push('sigkill');
          if (await conn.waitExit(this.shutdownKillGraceMs)) stages.push('exited');
          else {
            this.logLine(
              `MCP server ${conn.serverName} 在 SIGKILL 之后仍未退出：可能免疫终止，请人工确认它有没有遗留副作用`,
            );
          }
        }
      }

      this.detach(conn);
      if (conn.markStopReported()) {
        this.emitEvent('mcp/server-stopped', { name: conn.serverName, reason });
      }
      return { name: conn.serverName, reason, stages };
    })();

    conn.attachShutdown(task);
    return task;
  }
}

// ──────────────────────────────── 纯函数辅助 ────────────────────────────────

/** 三属性解析：显式声明优先，其次 server 默认，最后是不信任的兜底 */
export function resolveToolAttributes(
  entry: McpServerEntry,
  toolName: string,
  defaultTimeoutMs: number,
): Required<McpToolAttributes> {
  const explicit = entry.tools?.[toolName] ?? entry.tools?.[mcpToolName(entry.name, toolName)] ?? {};
  const defaults = entry.toolDefaults ?? {};
  const merged: Required<McpToolAttributes> = {
    sideEffect: explicit.sideEffect ?? defaults.sideEffect ?? 'destructive',
    executionMode: explicit.executionMode ?? defaults.executionMode ?? 'exclusive',
    timeoutMs: explicit.timeoutMs ?? defaults.timeoutMs ?? defaultTimeoutMs,
  };
  if (merged.timeoutMs <= 0) merged.timeoutMs = defaultTimeoutMs;
  return merged;
}

function asSchema(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return Object.keys(record).length === 0 ? { type: 'object', properties: {} } : record;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把 content[] 的一段渲染成给模型看的文本（图片/资源只给定位信息，不塞 base64） */
function renderContentPart(part: unknown): string {
  if (typeof part !== 'object' || part === null) return safeJson(part);
  const record = part as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  switch (type) {
    case 'text': {
      const text = record['text'];
      return typeof text === 'string' ? text : safeJson(record);
    }
    case 'image':
    case 'audio': {
      const mime = typeof record['mimeType'] === 'string' ? record['mimeType'] : 'unknown';
      const data = typeof record['data'] === 'string' ? record['data'].length : 0;
      return `[${type} 内容：mimeType=${mime}，base64 长度 ${data}（本版不落盘二进制）]`;
    }
    case 'resource': {
      const resource = asRecord(record['resource']);
      const uri = typeof resource['uri'] === 'string' ? resource['uri'] : 'unknown';
      const mime = typeof resource['mimeType'] === 'string' ? ` mimeType=${resource['mimeType']}` : '';
      const text = typeof resource['text'] === 'string' ? `\n${resource['text']}` : '';
      return `[内嵌资源：${uri}${mime}]${text}`;
    }
    case 'resource_link': {
      const uri = typeof record['uri'] === 'string' ? record['uri'] : 'unknown';
      return `[资源链接：${uri}]`;
    }
    default:
      return safeJson(record);
  }
}

function validateEntry(entry: McpServerEntry): string | null {
  if (typeof entry.name !== 'string' || !MCP_NAME_PATTERN.test(entry.name)) {
    return `server 名 ${JSON.stringify(entry.name)} 不合法（只允许字母数字与 _-，长度 1-128）`;
  }
  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    return `server ${entry.name} 的 command 必须是非空字符串`;
  }
  if (entry.args !== undefined && !Array.isArray(entry.args)) {
    return `server ${entry.name} 的 args 必须是字符串数组`;
  }
  return null;
}

// ──────────────────────────────── 配置解析 ────────────────────────────────

function describeValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 解析 `mcp.servers[]`（design §4.19：`{ name, command, args }` 起，其余为可选）。
 * 与 config.ts 同一条纪律：类型不对就抛，绝不静默回退默认——
 * 手误静默成默认值，等于"配置看起来生效了但其实没生效"。
 */
export function parseMcpServers(raw: unknown, where = 'mcp.servers'): McpServerEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new McpConfigError(`${where} 必须是数组，收到 ${describeValue(raw)}`, where);
  }
  const out: McpServerEntry[] = [];
  raw.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new McpConfigError(`${itemWhere} 必须是对象，收到 ${describeValue(item)}`, itemWhere);
    }
    const record = item as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) {
      throw new McpConfigError(
        `${itemWhere}.name 必须匹配 ^[A-Za-z0-9_-]{1,128}$（工具名会合成 mcp__{name}__{tool}），收到 ${describeValue(name)}`,
        `${itemWhere}.name`,
      );
    }
    const command = record['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      throw new McpConfigError(`${itemWhere}.command 必须是非空字符串`, `${itemWhere}.command`);
    }
    const entry: McpServerEntry = { name, command };
    const args = record['args'];
    if (args !== undefined && args !== null) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new McpConfigError(`${itemWhere}.args 必须是字符串数组`, `${itemWhere}.args`);
      }
      entry.args = args as string[];
    }
    const cwd = record['cwd'];
    if (typeof cwd === 'string' && cwd !== '') entry.cwd = cwd;
    const env = record['env'];
    if (env !== undefined && env !== null) {
      if (typeof env !== 'object' || Array.isArray(env)) {
        throw new McpConfigError(`${itemWhere}.env 必须是字符串到字符串的对象`, `${itemWhere}.env`);
      }
      const envRecord: Record<string, string> = {};
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new McpConfigError(`${itemWhere}.env.${key} 必须是字符串`, `${itemWhere}.env.${key}`);
        }
        envRecord[key] = value;
      }
      entry.env = envRecord;
    }
    if (record['disabled'] === true) entry.disabled = true;
    const requestTimeoutMs = record['requestTimeoutMs'];
    if (typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
      entry.requestTimeoutMs = Math.trunc(requestTimeoutMs);
    }
    const idleReclaimMs = record['idleReclaimMs'];
    if (typeof idleReclaimMs === 'number' && Number.isFinite(idleReclaimMs) && idleReclaimMs > 0) {
      entry.idleReclaimMs = Math.trunc(idleReclaimMs);
    }
    const toolDefaults = parseToolAttributes(record['toolDefaults'], `${itemWhere}.toolDefaults`);
    if (toolDefaults !== null) entry.toolDefaults = toolDefaults;
    const tools = record['tools'];
    if (tools !== undefined && tools !== null) {
      if (typeof tools !== 'object' || Array.isArray(tools)) {
        throw new McpConfigError(`${itemWhere}.tools 必须是"工具名 → 三属性"的对象`, `${itemWhere}.tools`);
      }
      const map: Record<string, McpToolAttributes> = {};
      for (const [tool, value] of Object.entries(tools as Record<string, unknown>)) {
        const parsed = parseToolAttributes(value, `${itemWhere}.tools.${tool}`);
        if (parsed !== null) map[tool] = parsed;
      }
      entry.tools = map;
    }
    out.push(entry);
  });
  return out;
}

function parseToolAttributes(raw: unknown, where: string): McpToolAttributes | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpConfigError(`${where} 必须是对象`, where);
  }
  const record = raw as Record<string, unknown>;
  const attrs: McpToolAttributes = {};
  const sideEffect = record['sideEffect'];
  if (sideEffect !== undefined && sideEffect !== null) {
    if (sideEffect !== 'none' && sideEffect !== 'idempotent' && sideEffect !== 'destructive') {
      throw new McpConfigError(`${where}.sideEffect 只能是 none/idempotent/destructive`, `${where}.sideEffect`);
    }
    attrs.sideEffect = sideEffect;
  }
  const executionMode = record['executionMode'];
  if (executionMode !== undefined && executionMode !== null) {
    if (executionMode !== 'parallel' && executionMode !== 'exclusive') {
      throw new McpConfigError(`${where}.executionMode 只能是 parallel/exclusive`, `${where}.executionMode`);
    }
    attrs.executionMode = executionMode;
  }
  const timeoutMs = record['timeoutMs'];
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new McpConfigError(`${where}.timeoutMs 必须是正整数毫秒`, `${where}.timeoutMs`);
    }
    attrs.timeoutMs = timeoutMs;
  }
  return attrs;
}

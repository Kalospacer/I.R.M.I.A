/**
 * MCP stdio 客户端池测试（docs/milestones.md M7-1 / M7-2 / M7-3 / M7-8；docs/design.md §4.19 MCP 段）
 *
 * 覆盖面：
 *   M7-1  MCP 全链路   握手（protocolVersion + 空 capabilities + clientInfo）→ notifications/initialized
 *                      → tools/list → tools/call；工具以 mcp__{server}__{tool} 进注册表；
 *                      执行器级超时落 tool/result{status:'timeout'} 并杀 server 进程
 *   M7-2  空闲回收     窗口到期写 mcp/server-stopped{idle-reclaim}，下次调用自动重启（pid 变化）
 *   M7-3  默认不信任   未显式声明的 MCP 工具以 destructive 注册且不在默认模型清单里；
 *                      annotations（readOnlyHint）不参与三属性判定
 *   M7-8  关机序列     关 stdin → 等待 → SIGTERM → 再等待 → SIGKILL（两态各自断言）；
 *                      stdout 非 JSON-RPC 行 → 记协议错误并重启该进程
 *
 * 另有：tools/list 只拉一次（缓存）+ list_changed 刷新、progress 重置软超时但硬上限不可越、
 * 大 content[] 走 blob 外置、mcp.servers[] 配置解析。
 *
 * 两条测试纪律：
 *   1. 全链路口径用**真子进程**（node 版假 MCP server 夹具 test/fixtures/fake-mcp-server.mjs），
 *      "它到底发了什么、进程有没有被杀"从子进程写下的标记与父进程日志两边对账；
 *   2. 关机序列的三条分支用**可编程假进程**（Pool 的 spawner 注入点）——
 *      真进程在 Windows 上无法观测 SIGTERM/SIGKILL 的区分（kill 直接终止，进程捕不到信号），
 *      靠真进程断言这三条分支只会得到一个平台相关的假绿。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, ToolResult } from '../src/log/types.js';
import { defaultVisibility } from '../src/log/types.ts';
import {
  MCP_ERROR_CODES, McpClientPool, mcpToolName, parseMcpServers, resolveToolAttributes,
  type McpProcess, type McpProcessSpawner, type McpServerEntry,
  type McpServerStartedData, type McpServerStoppedData,
} from '../src/mcp/client.ts';
import { readBlob } from '../src/state/blob-store.ts';
import { executeToolCalls } from '../src/tools/executor.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.js';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
/** 测试里的关机等待一律配小：真实默认值（2s/5s）是给生产留的余量，不是给测试摆的姿势 */
const FAST_SHUTDOWN = { shutdownStdinWaitMs: 60, shutdownTermWaitMs: 60, shutdownKillGraceMs: 30 } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Mark {
  t: string;
  [key: string]: unknown;
}

interface Harness {
  pool: McpClientPool;
  registry: ToolRegistry;
  markerDir: string;
  dataDir: string;
  events: Array<{ type: string; data: unknown }>;
  logs: string[];
  marks: () => Mark[];
  started: () => McpServerStartedData[];
  stopped: () => McpServerStoppedData[];
}

interface HarnessOptions {
  /** 传给假 server 的环境变量 */
  env?: Record<string, string>;
  /** 该 server 的逐工具三属性显式声明 */
  tools?: McpServerEntry['tools'];
  toolDefaults?: McpServerEntry['toolDefaults'];
  serverName?: string;
  idleReclaimMs?: number;
  requestTimeoutMs?: number;
  progressHardCapMs?: number;
  cancelGraceMs?: number;
  spawner?: McpProcessSpawner;
  /** 覆盖 pool 选项（例如 blob 阈值） */
  pool?: Record<string, unknown>;
}

function createHarness(t: TestContext, options: HarnessOptions = {}): Harness {
  const markerDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-mark-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-data-'));
  const registry = new ToolRegistry();
  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const serverName = options.serverName ?? 'fake';

  const entry: McpServerEntry = {
    name: serverName,
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { FAKE_MCP_MARKER_DIR: markerDir, ...(options.env ?? {}) },
  };
  if (options.tools !== undefined) entry.tools = options.tools;
  if (options.toolDefaults !== undefined) entry.toolDefaults = options.toolDefaults;

  const poolOptions: Record<string, unknown> = {
    servers: [entry],
    emit: (type: string, data: unknown) => {
      events.push({ type, data });
    },
    dataDir,
    registry,
    onLog: (line: string) => {
      logs.push(line);
    },
    idleReclaimMs: options.idleReclaimMs ?? 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    cancelGraceMs: options.cancelGraceMs ?? 150,
    ...FAST_SHUTDOWN,
    ...(options.progressHardCapMs === undefined ? {} : { progressHardCapMs: options.progressHardCapMs }),
    ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
    ...(options.pool ?? {}),
  };

  const pool = new McpClientPool(poolOptions as never);

  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(markerDir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const marks = (): Mark[] => {
    const path = join(markerDir, 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Mark);
  };

  return {
    pool,
    registry,
    markerDir,
    dataDir,
    events,
    logs,
    marks,
    started: () => events.filter((e) => e.type === 'mcp/server-started').map((e) => e.data as McpServerStartedData),
    stopped: () => events.filter((e) => e.type === 'mcp/server-stopped').map((e) => e.data as McpServerStoppedData),
  };
}

function toolCtx(signal?: AbortSignal): ToolContext {
  return {
    callId: 'call_mcp_test',
    turn: 1,
    step: 1,
    signal: signal ?? new AbortController().signal,
    workspaceRoot: process.cwd(),
  };
}

// ──────────────────────────────── M7-1 全链路 ────────────────────────────────

test('M7-1 全链路：握手 → initialized → tools/list → tools/call，工具进注册表', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();

  assert.deepEqual(
    h.registry.names(),
    ['mcp__fake__echo', 'mcp__fake__big', 'mcp__fake__fail', 'mcp__fake__slow'],
    '工具按清单顺序以 mcp__{server}__{tool} 命名注册',
  );

  const def = h.registry.get('mcp__fake__echo');
  assert.ok(def !== null);
  assert.equal(def.name, mcpToolName('fake', 'echo'));
  assert.equal(def.timeoutMs, 60_000, '缺省执行器级超时是 60s');

  const result = await def.handler({ text: '你好' }, toolCtx());
  assert.equal(result.isError ?? false, false);
  assert.equal(result.content, 'echo:你好');

  const started = h.started();
  assert.equal(started.length, 1);
  assert.equal(started[0]?.name, 'fake');
  assert.ok((started[0]?.pid ?? 0) > 0, 'server-started 带真实 pid');
  assert.deepEqual(h.stopped(), [], '还在跑的时候没有 server-stopped');
  assert.ok((started[0]?.tools ?? []).includes('echo'));
  assert.ok(started[0]?.tools.includes('slow'));

  const marks = h.marks();
  const initialize = marks.find((m) => m.t === 'initialize');
  assert.ok(initialize !== undefined, '夹具收到了 initialize');
  // 不声明 roots/sampling/elicitation：capabilities 就是空对象
  assert.deepEqual(initialize.capabilities, {});
  assert.deepEqual(initialize.clientInfo, { name: 'irmia-agent', version: '0.1.0-beta.3' });
  assert.ok(marks.some((m) => m.t === 'initialized'), '握手第二步发了 notifications/initialized');
  assert.equal(marks.filter((m) => m.t === 'list').length, 1, 'tools/list 在进程启动时拉一次');
  assert.equal(marks.find((m) => m.t === 'call')?.name, 'echo');

  // 再调一次：清单有缓存，调用路径上不做重复 list
  await def.handler({ text: '第二次' }, toolCtx());
  assert.equal(h.marks().filter((m) => m.t === 'list').length, 1, '调用路径不重复 tools/list');

  // isError → status 'error' 的映射（内容透传，错误码稳定）
  const failed = await h.registry.get('mcp__fake__fail')?.handler({}, toolCtx());
  assert.ok(failed !== undefined);
  assert.equal(failed.isError, true);
  assert.equal(failed.error?.code, MCP_ERROR_CODES.toolError);
  assert.match(failed.content, /夹具主动报告的工具失败/);
});

test('M7-3 默认不信任：MCP 工具 destructive 注册，annotations 不参与三属性判定', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();

  const echo = h.registry.get('mcp__fake__echo');
  assert.ok(echo !== null);
  // 夹具自己声明了 annotations.readOnlyHint = true，但我们不采信它
  assert.equal(echo.sideEffect, 'destructive', 'readOnlyHint 不改变 sideEffect');
  assert.equal(echo.executionMode, 'exclusive');
  assert.deepEqual(h.registry.listForModel({}).map((s) => s.name), [], 'destructive 默认不进模型清单');
  assert.ok(h.registry.listForModel({ includeDestructive: true }).some((s) => s.name === echo.name));

  // 另一条：显式声明才降级（配置里显式写 sideEffect 是唯一合法路径）
  const h2 = createHarness(t, { tools: { echo: { sideEffect: 'none', executionMode: 'parallel' } } });
  await h2.pool.registerAll();
  const echo2 = h2.registry.get('mcp__fake__echo');
  assert.ok(echo2 !== null);
  assert.equal(echo2.sideEffect, 'none');
  assert.equal(echo2.executionMode, 'parallel');
  assert.ok(h2.registry.listForModel({}).some((s) => s.name === echo2.name), '显式降级后进默认清单');
  // 未显式声明的同类工具仍然 destructive
  assert.equal(h2.registry.get('mcp__fake__big')?.sideEffect, 'destructive');
});

test('tools/list 缓存 + notifications/tools/list_changed 触发刷新（新增与卸载）', async (t) => {
  const h = createHarness(t, { env: { FAKE_MCP_LIST_CHANGED: '1' } });
  await h.pool.registerAll();

  assert.equal(h.marks().filter((m) => m.t === 'list').length, 1);
  assert.equal(h.registry.has('mcp__fake__late'), false, '首次清单里没有 late 工具');

  await h.registry.get('mcp__fake__echo')?.handler({ text: '触发 list_changed' }, toolCtx());
  await waitFor(() => h.registry.has('mcp__fake__late'), 3000, 'list_changed 刷新');

  assert.equal(h.marks().filter((m) => m.t === 'list').length, 2, 'list_changed 之后重新拉清单');
  assert.ok(h.registry.get('mcp__fake__late')?.sideEffect === 'destructive', '刷新出来的工具同样默认不信任');
});

// ──────────────────────────────── M7-1 超时与取消 ────────────────────────────────

test('每请求超时：发 notifications/cancelled，并回收不配合取消的 server 进程', async (t) => {
  const h = createHarness(t, { idleReclaimMs: 60_000 });
  await h.pool.registerAll();
  const pid = h.started()[0]?.pid ?? 0;
  assert.ok(pidAlive(pid));

  const result = await h.pool.callTool('fake', 'slow', { ms: 5_000 }, { timeoutMs: 200 });
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, MCP_ERROR_CODES.timeout);
  assert.match(result.content, /超过 200ms 未返回/);
  assert.match(result.content, /notifications\/cancelled/);

  // 取消通知是写给子进程的，夹具落盘要等它读到那一行；这里等它出现，不用固定 sleep 赌时序
  await waitFor(() => h.marks().some((m) => m.t === 'cancelled'), 2000, '夹具收到取消通知');
  assert.equal(h.marks().find((m) => m.t === 'cancelled')?.reason, 'timeout');
  await waitFor(
    () => h.logs.some((line) => line.includes('取消宽限')),
    3000,
    '取消宽限判定（server 不配合取消 → 连接失效）',
  );
  await waitFor(() => h.stopped().some((s) => s.reason === 'crashed'), 3000, '超时后回收进程');
  assert.equal(pidAlive(pid), false, '进程被真的杀掉了（超时即杀）');

  // 下次调用自动重新拉起（随用随起）
  const again = await h.pool.callTool('fake', 'echo', { text: '重启后' });
  assert.equal(again.isError ?? false, false);
  assert.equal(again.content, 'echo:重启后');
  assert.equal(h.started().length, 2);
});

test('M7-1 执行器级超时：落 tool/result{status:"timeout"} 且 server 进程被杀', async (t) => {
  const h = createHarness(t, { tools: { slow: { timeoutMs: 250 } } });
  await h.pool.registerAll();
  const pid = h.started()[0]?.pid ?? 0;

  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-log-'));
  const log = await EventLog.open(join(dataDir, 'events'));
  const events: AppEvent[] = [];
  t.after(() => {
    try {
      log.close();
    } catch {
      // 已关闭
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: new Date(1_780_000_000_000 + events.length).toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/mcp',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    events.push(event);
    return event;
  };

  await executeToolCalls([{ callId: 'call_slow', name: 'mcp__fake__slow', arguments: '{"ms":5000}' }], {
    registry: h.registry,
    turn: 1,
    step: 1,
    workspaceRoot: dataDir,
    onToolCall: (call) => append('tool/call', {
      turn: 1,
      step: 1,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      sideEffect: h.registry.get(call.name)?.sideEffect ?? 'destructive',
    }).seq,
    onToolResult: (call, result, callSeq) => {
      append('tool/result', {
        turn: 1,
        step: 1,
        callId: call.callId,
        callSeq,
        status: result.status,
        content: result.content,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    },
  });

  const results = events.filter((e): e is ToolResult => e.type === 'tool/result');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.data.status, 'timeout', '执行器级超时写 status timeout');

  assert.ok(h.marks().some((m) => m.t === 'cancelled'), '超时同时把取消告诉了 server');
  await waitFor(() => h.stopped().some((s) => s.reason === 'crashed'), 3000, '超时后回收进程');
  assert.equal(pidAlive(pid), false, '超过执行器超时的 server 进程被回收');
});

// ──────────────────────────────── M7-2 空闲回收 ────────────────────────────────

test('M7-2 空闲回收：窗口到期写 server-stopped{idle-reclaim}，下次调用自动重启', async (t) => {
  const h = createHarness(t, { idleReclaimMs: 150 });
  await h.pool.registerAll();
  const firstPid = h.started()[0]?.pid ?? 0;
  assert.ok(pidAlive(firstPid));
  assert.equal(h.marks().some((m) => m.t === 'exit'), false);

  await waitFor(() => h.stopped().length >= 1, 4000, '空闲回收');
  const stopped = h.stopped()[0];
  assert.equal(stopped?.name, 'fake');
  assert.equal(stopped?.reason, 'idle-reclaim', '回收原因如实记 idle-reclaim');
  await waitFor(() => !pidAlive(firstPid), 2000, '回收后进程退出');

  const result = await h.pool.callTool('fake', 'echo', { text: '唤醒' });
  assert.equal(result.isError ?? false, false);
  const starts = h.started();
  assert.equal(starts.length, 2, '随用随起：下次调用重新拉起');
  assert.notEqual(starts[1]?.pid, firstPid, '是新进程');
});

// ──────────────────────────────── M7-8 stdout 纪律 ────────────────────────────────

test('M7-8 stdout 污染：记协议错误并重启该 server 进程，重启后恢复可用', async (t) => {
  const h = createHarness(t, { env: { FAKE_MCP_POLLUTE: '1' } });

  // 第一次启动就被污染行打断：握手失败，工具没有注册（但不抛穿调用方）
  await h.pool.registerAll();
  assert.equal(h.registry.names().length, 0, '协议错误的 server 不上线工具');
  assert.ok(
    h.logs.some((line) => line.includes('协议错误')),
    '记协议错误',
  );
  assert.equal(h.stopped()[0]?.reason, 'crashed', '被污染的进程按 crashed 收掉');

  // 下一次调用自动重新拉起（夹具只在首次启动污染）
  const result = await h.pool.callTool('fake', 'echo', { text: '重启之后' });
  assert.equal(result.isError ?? false, false);
  assert.equal(result.content, 'echo:重启之后');
  assert.equal(h.registry.has('mcp__fake__echo'), true, '重启后工具进入注册表');
  assert.ok(h.started().length >= 1, '重启过程有 server-started');
  assert.equal(h.marks().filter((m) => m.t === 'initialize').length, 2, '第二次启动完成了握手');
});

test('M7-8 关机序列（真进程）：关 stdin 即退出的 server 不走 SIGTERM', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();
  const pid = h.started()[0]?.pid ?? 0;

  const reports = await h.pool.shutdown();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.reason, 'shutdown');
  assert.deepEqual(reports[0]?.stages, ['stdin-closed', 'exited'], '关 stdin 之后它自己走了，不必动信号');
  assert.ok(h.marks().some((m) => m.t === 'stdin-end'), '夹具确认收到了 stdin 关闭');
  assert.equal(pidAlive(pid), false);
  assert.equal(h.stopped()[0]?.reason, 'shutdown');
});

test('M7-8 关机序列（真进程）：忽略 stdin 关闭的 server 走 SIGTERM', async (t) => {
  const h = createHarness(t, { env: { FAKE_MCP_IGNORE_STDIN_END: '1' } });
  await h.pool.registerAll();

  const reports = await h.pool.shutdown();
  const stages = reports[0]?.stages ?? [];
  assert.deepEqual(stages.slice(0, 2), ['stdin-closed', 'sigterm'], '先关 stdin，等待无果后再 SIGTERM');
  assert.ok(stages.includes('exited'), '被终止后进程消失');
  assert.ok(!stages.includes('sigkill'), '没有走到 SIGKILL');
});

// ──────────────────────────────── M7-8 关机序列（可编程假进程） ────────────────────────────────

interface FakeProcessOptions {
  /** 关 stdin 之后是否自行退出 */
  exitOnStdinEnd: boolean;
  /** 收到 SIGTERM 之后是否退出 */
  exitOnTerm?: boolean;
  /** 收到 SIGKILL 之后是否退出（默认 false：模拟免疫终止） */
  exitOnKill?: boolean;
}

interface FakeProcessHandle {
  process: McpProcess;
  /** 调用顺序事实：closeStdin / kill:SIGTERM / kill:SIGKILL */
  calls: string[];
}

/**
 * 可编程假进程：应答 initialize 与 tools/list 让握手通过，关机行为由测试编排。
 * 真进程无法在 Windows 上区分 SIGTERM 与 SIGKILL（kill 直接终止，进程捕不到信号），
 * 所以"两级超时都用到了"这条只能靠它在跨平台上被确定性地断言。
 */
function makeFakeProcess(options: FakeProcessOptions): FakeProcessHandle {
  const stdoutHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  const calls: string[] = [];
  let exited = false;

  const push = (text: string): void => {
    for (const handler of stdoutHandlers) handler(text);
  };
  const emitExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler(code, null);
  };
  const reply = (id: unknown, result: unknown): void => {
    push(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const handle = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = message['method'];
    if (method === 'initialize') {
      reply(message['id'], {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-memory', version: '1.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      reply(message['id'], {
        tools: [{ name: 'echo', description: '内存假工具', inputSchema: { type: 'object', properties: {} } }],
      });
      return;
    }
    if (method === 'tools/call') {
      reply(message['id'], { content: [{ type: 'text', text: 'ok' }] });
    }
  };

  const process: McpProcess = {
    pid: 4242,
    onStdout(handler) {
      stdoutHandlers.push(handler);
    },
    onStderr() {
      // 假进程没有 stderr
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    write(line) {
      calls.push('write');
      handle(line);
    },
    closeStdin() {
      calls.push('closeStdin');
      if (options.exitOnStdinEnd) setTimeout(() => emitExit(0), 0);
    },
    kill(signal) {
      calls.push(`kill:${signal}`);
      if (signal === 'SIGTERM' && options.exitOnTerm === true) {
        setTimeout(() => emitExit(0), 0);
        return;
      }
      if (signal === 'SIGKILL' && options.exitOnKill === true) {
        setTimeout(() => emitExit(null), 0);
      }
    },
  };
  return { process, calls };
}

function fakeSpawner(handle: FakeProcessHandle): McpProcessSpawner {
  return () => handle.process;
}

test('M7-8 关机序列三分支：stdin → SIGTERM → SIGKILL 的顺序与用法', async (t) => {
  // ① 关 stdin 就退出：不动任何信号
  const a = makeFakeProcess({ exitOnStdinEnd: true });
  const ha = createHarness(t, { spawner: fakeSpawner(a) });
  await ha.pool.registerAll();
  const reportA = (await ha.pool.shutdown())[0];
  assert.deepEqual(reportA?.stages, ['stdin-closed', 'exited']);
  assert.deepEqual(a.calls, ['write', 'write', 'write', 'closeStdin'], '只有 write/closeStdin，没有 kill');

  // ② 忽略 stdin 关闭、响应 SIGTERM
  const b = makeFakeProcess({ exitOnStdinEnd: false, exitOnTerm: true });
  const hb = createHarness(t, { spawner: fakeSpawner(b) });
  await hb.pool.registerAll();
  const reportB = (await hb.pool.shutdown())[0];
  assert.deepEqual(reportB?.stages, ['stdin-closed', 'sigterm', 'exited']);
  assert.ok(b.calls.includes('kill:SIGTERM'));
  assert.ok(!b.calls.includes('kill:SIGKILL'), 'SIGTERM 之后退出，不该再升级');

  // ③ 免疫 stdin 关闭与 SIGTERM：必须升级到 SIGKILL，且如实报告"没退出"
  const c = makeFakeProcess({ exitOnStdinEnd: false, exitOnTerm: false, exitOnKill: false });
  const hc = createHarness(t, { spawner: fakeSpawner(c) });
  await hc.pool.registerAll();
  const reportC = (await hc.pool.shutdown())[0];
  assert.deepEqual(reportC?.stages, ['stdin-closed', 'sigterm', 'sigkill'], '两级超时都用到了');
  assert.deepEqual(c.calls.filter((call) => call.startsWith('kill:')), ['kill:SIGTERM', 'kill:SIGKILL']);
  assert.ok(
    hc.logs.some((line) => line.includes('SIGKILL 之后仍未退出')),
    '没退出这件事必须留痕，不能假装收干净了',
  );
});

// ──────────────────────────────── 超时时钟：progress 与硬上限 ────────────────────────────────

test('progress 通知重置软超时时钟，但硬上限不可越过', async (t) => {
  // ① 响应比软超时慢，但 progress 一直续命 → 成功
  const slowButAlive = createHarness(t, {
    env: { FAKE_MCP_PROGRESS_MS: '60', FAKE_MCP_RESPOND_AFTER_MS: '600' },
    progressHardCapMs: 4_000,
  });
  await slowButAlive.pool.registerAll();
  const ok = await slowButAlive.pool.callTool('fake', 'echo', { text: '续命成功' }, { timeoutMs: 250 });
  assert.equal(ok.isError ?? false, false, 'progress 把 600ms 的请求从 250ms 软超时里救回来了');
  assert.equal(ok.content, 'echo:续命成功');

  // ② progress 一直发，但撞到硬上限 → 仍然超时（这是"有硬上限"的意义）
  const hardCapped = createHarness(t, {
    env: { FAKE_MCP_PROGRESS_MS: '40', FAKE_MCP_RESPOND_AFTER_MS: '1500' },
    progressHardCapMs: 350,
  });
  await hardCapped.pool.registerAll();
  const timedOut = await hardCapped.pool.callTool('fake', 'echo', { text: '硬上限' }, { timeoutMs: 200 });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.error?.code, MCP_ERROR_CODES.timeout);
  assert.match(timedOut.content, /硬上限/);
  await waitFor(
    () => hardCapped.marks().some((m) => m.t === 'cancelled' && m.reason === 'hard-timeout'),
    2000,
    '硬上限取消通知到达夹具',
  );
});

// ──────────────────────────────── 大结果外置 ────────────────────────────────

test('MCP content[] 超阈值走 blob 外置，全文可用 read_blob 取回', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();

  const result = await h.registry.get('mcp__fake__big')?.handler({ chars: 20_000 }, toolCtx());
  assert.ok(result !== undefined);
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /完整结果 \d+ 字节，可用 read_blob 取：[0-9a-f]{64}/);
  assert.ok(result.content.length < 3_000, '预览控制在头部切片量级');

  const blobId = /read_blob 取：([0-9a-f]{64})/u.exec(result.content)?.[1];
  assert.ok(blobId !== undefined);
  const full = await readBlob(h.dataDir, blobId);
  assert.equal(full.toString('utf8').length, 20_000, 'blob 里是完整全文');
});

// ──────────────────────────────── 配置解析 ────────────────────────────────

test('mcp.servers[] 配置解析：合法项逐字段落地，非法项当场报错不回退默认', () => {
  const parsed = parseMcpServers([
    {
      name: 'fs',
      command: 'node',
      args: ['server.mjs', '--root', '.'],
      env: { LOG: 'debug' },
      tools: { read: { sideEffect: 'none', executionMode: 'parallel' } },
      disabled: true,
    },
    { name: 'git_2', command: 'git-mcp' },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.name, 'fs');
  assert.deepEqual(parsed[0]?.args, ['server.mjs', '--root', '.']);
  assert.deepEqual(parsed[0]?.env, { LOG: 'debug' });
  assert.equal(parsed[0]?.disabled, true);
  assert.equal(parsed[0]?.tools?.['read']?.sideEffect, 'none');
  assert.deepEqual(parsed[1], { name: 'git_2', command: 'git-mcp' });

  assert.deepEqual(parseMcpServers(undefined), [], '没配就是空数组');

  const bad: Array<[unknown, string]> = [
    [[{ name: 'a b', command: 'node' }], 'name'],
    [[{ name: 'ok' }], 'command'],
    [[{ name: 'ok', command: 'node', args: 'x' }], 'args'],
    [[{ name: 'ok', command: 'node', env: { A: 1 } }], 'env'],
    [[{ name: 'ok', command: 'node', tools: { t: { sideEffect: 'safe' } } }], 'sideEffect'],
    [[{ name: 'ok', command: 'node', tools: { t: { timeoutMs: 0 } } }], 'timeoutMs'],
    ['not-an-array', '必须是数组'],
  ];
  for (const [raw, needle] of bad) {
    assert.throws(() => parseMcpServers(raw), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(needle));
      return true;
    }, `非法配置必须报错：${JSON.stringify(raw)}`);
  }

  // 三属性缺省口径：不声明即 destructive / exclusive / 传入的默认超时
  assert.deepEqual(resolveToolAttributes({ name: 's', command: 'c' }, 'x', 1234), {
    sideEffect: 'destructive', executionMode: 'exclusive', timeoutMs: 1234,
  });
  // 逐工具声明优先于 server 默认；全名与短名都认
  const entry: McpServerEntry = {
    name: 's',
    command: 'c',
    toolDefaults: { sideEffect: 'idempotent', timeoutMs: 500 },
    tools: { x: { sideEffect: 'none' }, 'mcp__s__y': { executionMode: 'parallel' } },
  };
  assert.deepEqual(resolveToolAttributes(entry, 'x', 10), {
    sideEffect: 'none', executionMode: 'exclusive', timeoutMs: 500,
  });
  assert.deepEqual(resolveToolAttributes(entry, 'y', 10), {
    sideEffect: 'idempotent', executionMode: 'parallel', timeoutMs: 500,
  });
});

test('未配置或已禁用的 server：调用得到可读结果，不抛不崩', async (t) => {
  const h = createHarness(t, { serverName: 'fake' });
  const missing = await h.pool.callTool('nosuch', 'echo', {});
  assert.equal(missing.error?.code, MCP_ERROR_CODES.notConfigured);
  assert.match(missing.content, /不在配置里/);

  const disabled = createHarness(t, { serverName: 'off' });
  const off = new McpClientPool({
    servers: [{
      name: 'off', command: process.execPath, args: [FAKE_SERVER],
      env: { FAKE_MCP_MARKER_DIR: disabled.markerDir }, disabled: true,
    }],
    emit: () => undefined,
    dataDir: disabled.dataDir,
    registry: disabled.registry,
    ...FAST_SHUTDOWN,
  });
  t.after(async () => {
    await off.shutdown();
  });
  const result = await off.callTool('off', 'echo', {});
  assert.equal(result.error?.code, MCP_ERROR_CODES.disabled);
  assert.deepEqual(off.status()[0]?.tools, []);
  assert.equal(off.status()[0]?.running, false);
});

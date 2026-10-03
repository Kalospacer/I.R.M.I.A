#!/usr/bin/env node
/**
 * Irmia Agent 测试夹具 — 最小 MCP stdio server（纯 JS，子进程直接跑，不需要类型剥离）
 *
 * 它只实现被 MCP 客户端池用到的那一小截协议：initialize / notifications/initialized /
 * tools/list / tools/call / notifications/cancelled。行为由环境变量编排，覆盖：
 *
 *   FAKE_MCP_MARKER_DIR       标记目录（events.jsonl 逐条记录生命周期事实）
 *   FAKE_MCP_POLLUTE=1        首次启动往 stdout 写一行非 JSON-RPC（测协议违规重启）
 *   FAKE_MCP_IGNORE_STDIN_END=1  关 stdin 之后不退出（逼客户端走 SIGTERM）
 *   FAKE_MCP_LIST_CHANGED=1   第二次 tools/list 多一个 late 工具；首次 tools/call 后发
 *                             notifications/tools/list_changed
 *   FAKE_MCP_RESPOND_AFTER_MS=tools/call 统一延迟 t 毫秒再回应（测超时与取消）
 *   FAKE_MCP_PROGRESS_MS=t    tools/call 期间每 t 毫秒发一次 notifications/progress
 *
 * 纪律：stdout 只写合法 JSON-RPC（唯一例外是刻意打开的污染开关），日志一律走 stderr。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const markerDir = process.env.FAKE_MCP_MARKER_DIR ?? '';
if (markerDir !== '') {
  try {
    mkdirSync(markerDir, { recursive: true });
  } catch {
    // 目录已存在：忽略
  }
}

function mark(label, extra = {}) {
  if (markerDir === '') return;
  try {
    appendFileSync(join(markerDir, 'events.jsonl'), `${JSON.stringify({ t: label, ts: Date.now(), ...extra })}\n`);
  } catch {
    // 标记失败不影响被测行为
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const SCHEMA_TEXT = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const SCHEMA_EMPTY = { type: 'object', properties: {} };
const SCHEMA_CHARS = { type: 'object', properties: { chars: { type: 'number' } } };
const SCHEMA_MS = { type: 'object', properties: { ms: { type: 'number' } } };

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本（夹具工具）',
    inputSchema: SCHEMA_TEXT,
    annotations: { readOnlyHint: true },
  },
  { name: 'big', description: '返回一大段文本（测 blob 外置）', inputSchema: SCHEMA_CHARS },
  { name: 'fail', description: '总是返回 isError', inputSchema: SCHEMA_EMPTY },
  { name: 'slow', description: '延迟很久才回应（测超时与取消）', inputSchema: SCHEMA_MS },
];

const LATE_TOOL = { name: 'late', description: 'list_changed 之后才出现的工具', inputSchema: SCHEMA_EMPTY };

let listCount = 0;
let listChangeSent = false;

function handleCall(message) {
  const params = message.params ?? {};
  const name = params.name;
  const args = params.arguments ?? {};
  const token = params._meta?.progressToken;
  mark('call', { name, args, id: message.id, meta: params._meta });

  const envDelay = Number(process.env.FAKE_MCP_RESPOND_AFTER_MS ?? '0');
  const delay = Number.isFinite(envDelay) && envDelay > 0
    ? envDelay
    : (name === 'slow' ? Number(args.ms ?? 5000) : 0);
  const progressEvery = Number(process.env.FAKE_MCP_PROGRESS_MS ?? '0');
  let progressTimer = null;
  if (progressEvery > 0 && token !== undefined) {
    let n = 0;
    progressTimer = setInterval(() => {
      n += 1;
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: n } });
    }, progressEvery);
  }

  const finish = () => {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: '夹具主动报告的工具失败' }], isError: true },
      });
      return;
    }
    if (name === 'big') {
      const chars = Number(args.chars ?? 20000);
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: '大'.repeat(chars) }] },
      });
      return;
    }
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }] },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `unknown tool ${String(name)}` }], isError: true },
      });
    }
    if (process.env.FAKE_MCP_LIST_CHANGED === '1' && !listChangeSent) {
      listChangeSent = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      mark('list-changed');
    }
  };

  if (delay > 0) setTimeout(finish, delay);
  else finish();
}

function handle(message) {
  if (message.method === 'initialize') {
    const params = message.params ?? {};
    mark('initialize', {
      protocolVersion: params.protocolVersion,
      capabilities: params.capabilities,
      clientInfo: params.clientInfo,
    });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') {
    mark('initialized');
    return;
  }
  if (message.method === 'tools/list') {
    listCount += 1;
    mark('list', { n: listCount });
    const tools = process.env.FAKE_MCP_LIST_CHANGED === '1' && listCount >= 2
      ? [...TOOLS, LATE_TOOL]
      : TOOLS;
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }
  if (message.method === 'tools/call') {
    handleCall(message);
    return;
  }
  if (message.method === 'notifications/cancelled') {
    mark('cancelled', { requestId: message.params?.requestId, reason: message.params?.reason });
    return;
  }
  mark('unknown-method', { method: message.method });
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
}

// 污染：只发生一次（重启后恢复正常），用来验证"协议错误 → 重启该进程"
if (process.env.FAKE_MCP_POLLUTE === '1') {
  const flag = markerDir === '' ? '' : join(markerDir, 'polluted.flag');
  const alreadyPolluted = flag !== '' && existsSync(flag);
  if (!alreadyPolluted) {
    if (flag !== '') {
      try {
        writeFileSync(flag, '1');
      } catch {
        // 标记失败：下面照样污染一次
      }
    }
    process.stdout.write('fake mcp server 启动中（这一行不是 JSON-RPC）\n');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      mark('bad-input', { line });
      continue;
    }
    handle(message);
  }
});

process.stdin.on('end', () => {
  mark('stdin-end');
  if (process.env.FAKE_MCP_IGNORE_STDIN_END === '1') {
    // 刻意不退出：同时要留住事件循环，否则 Node 在无 pending 工作时会自行结束，
    // "忽略 stdin 关闭"就无从测起（这条正是 SIGTERM/SIGKILL 分支的前提）
    setInterval(() => {}, 1000);
    return;
  }
  setTimeout(() => process.exit(0), 10);
});

process.on('SIGTERM', () => {
  mark('sigterm');
  if (process.env.FAKE_MCP_IGNORE_SIGTERM === '1') return;
  process.exit(0);
});

process.on('SIGINT', () => {
  mark('sigint');
  process.exit(0);
});

process.on('exit', (code) => {
  mark('exit', { code });
});

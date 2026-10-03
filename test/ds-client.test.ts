/**
 * DeepSeek Responses API 客户端测试（src/model/ds-client.ts）
 *
 * 全部走本地 node:http mock server：不发真实网络请求、不需要 API key。
 * 覆盖：正常响应解析（含 cached_tokens）、SSE 增量与终态、429 尊重 Retry-After 的退避、
 * 400 不重试、200 空内容计 empty（有限 3 次）、超时分类、连接失败计 network、
 * 流中断保留已收部分（对齐 milestones M2-9）、withRetry 退避曲线与 attempts 标注。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';

import {
  DsClient,
  DsClientError,
  SseFrameDecoder,
  backoffDelayMs,
  parseRetryAfter,
  withRetry,
  type SleepFn,
} from '../src/model/ds-client.ts';

// ──────────────────────────────── mock server ────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, unknown> | null;
}

interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** 起一个只服务当前测试的 mock server；listen(0) 拿随机端口，避免测试间打架 */
async function startMock(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        json = null;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json });
      // 客户端超时/中断后连接已毁，处理器里迟到的 write 会抛错：吞掉它，别把测试进程带崩
      void Promise.resolve()
        .then(() => handler(req, res, body))
        .catch(() => {});
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server 未能绑定端口');

  const mock: MockServer = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  t.after(() => mock.close());
  return mock;
}

function jsonBody(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** 记录退避时长但立即返回：测试不该真的等指数退避 */
function recordingSleep(sleeps: number[]): SleepFn {
  return async (ms: number) => {
    sleeps.push(ms);
  };
}

function sseFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const COMPLETE_RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1_770_000_000,
  status: 'completed',
  model: 'deepseek-v4-pro',
  output: [
    {
      type: 'reasoning',
      id: 'rs_1',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: '先看一眼日志。' }],
    },
    {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '我在。' }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      status: 'completed',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"file_path":"a.txt"}',
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 88,
    output_tokens_details: { reasoning_tokens: 40 },
  },
};

// ──────────────────────────────── 正常响应 ────────────────────────────────

test('generate 解析响应：三类 output item、usage 与 cached_tokens、请求字段与 Bearer 头', async (t) => {
  const mock = await startMock(t, (_req, res) => jsonBody(res, 200, COMPLETE_RESPONSE));

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', user: 'irmia-deploy-01' });
  const response = await client.generate({
    lane: 'heavy',
    instructions: '你是 Irmia。',
    input: [{ role: 'user', content: '在吗' }],
    tools: [{ type: 'function', name: 'read_file', description: '只读文件', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    maxOutputTokens: 4096,
    text: { type: 'json_object' },
  });

  assert.equal(response.status, 'completed');
  assert.equal(response.incompleteReason, null);
  assert.equal(response.responseId, 'resp_1');
  assert.equal(response.model, 'deepseek-v4-pro');
  assert.deepEqual(
    response.outputItems.map((item) => item.type),
    ['reasoning', 'message', 'function_call'],
  );

  const message = response.outputItems[1];
  assert.ok(message?.type === 'message');
  assert.equal(message.text, '我在。');
  const call = response.outputItems[2];
  assert.ok(call?.type === 'function_call');
  assert.equal(call.callId, 'call_1');
  assert.equal(call.name, 'read_file');
  assert.equal(call.arguments, '{"file_path":"a.txt"}');

  // cached_tokens 必须从 input_tokens_details 里精确取到，而不是被当成未知字段丢掉
  assert.deepEqual(response.usage, {
    inputTokens: 1200,
    outputTokens: 88,
    cachedTokens: 1024,
    reasoningTokens: 40,
  });
  assert.ok(response.durationMs >= 0);

  const sent = mock.requests[0];
  assert.equal(sent?.method, 'POST');
  assert.equal(sent?.url, '/responses');
  assert.equal(sent?.headers['authorization'], 'Bearer sk-test');
  assert.equal(sent?.json?.['model'], 'deepseek-v4-pro');
  assert.equal(sent?.json?.['user'], 'irmia-deploy-01');
  assert.equal(sent?.json?.['stream'], false);
  assert.equal(sent?.json?.['max_output_tokens'], 4096);
  assert.deepEqual(sent?.json?.['reasoning'], { effort: 'high' });
  assert.deepEqual(sent?.json?.['text'], { format: { type: 'json_object' } });
  assert.equal(sent?.json?.['instructions'], '你是 Irmia。');
  assert.deepEqual(sent?.json?.['input'], [{ role: 'user', content: '在吗' }]);
});

// ──────────────────────────────── SSE 流式 ────────────────────────────────

test('stream 增量回调与终态：分块到达的 delta 也能正确拼接', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // 故意把第一个 delta 切在 JSON 中间，验证跨 chunk 分帧
    const first = sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '你' });
    res.write(first.slice(0, 12));
    res.write(first.slice(12));
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '好' }));
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '，世界' }));
    res.write(sseFrame('response.output_text.done', { item_id: 'msg_1', text: '你好，世界' }));
    res.write(
      sseFrame('response.output_item.added', {
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_9', name: 'pwsh', arguments: '' },
      }),
    );
    res.write(sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"command":' }));
    res.write(sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '"date"}' }));
    res.write(
      sseFrame('response.completed', {
        response: {
          id: 'resp_stream',
          status: 'completed',
          model: 'deepseek-flash',
          output: [
            { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '你好，世界' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' },
          ],
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 8 }, output_tokens: 5 },
        },
      }),
    );
    res.end();
  });

  const deltas: string[] = [];
  const seen: string[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', lightModel: 'deepseek-flash' });
  const result = await client.stream(
    { lane: 'light', instructions: '短答', input: '几点' },
    { onTextDelta: (delta) => deltas.push(delta), onEvent: (event) => seen.push(event.type) },
  );

  assert.deepEqual(deltas, ['你', '好', '，世界']);
  assert.equal(result.text, '你好，世界');
  assert.equal(result.status, 'completed');
  assert.equal(result.interrupted, false);
  assert.equal(result.failure, null);
  assert.equal(result.responseId, 'resp_stream');
  assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 8, reasoningTokens: 0 });
  assert.deepEqual(result.toolCalls, [{ callId: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' }]);
  assert.ok(seen.includes('response.output_text.delta'));
  assert.ok(seen.includes('response.completed'));
  assert.equal(mock.requests[0]?.json?.['stream'], true);
  assert.equal(mock.requests[0]?.headers['accept'], 'text/event-stream');
});

test('SSE 分帧器：容忍孤立 CR 与缺尾空行的最后一帧', () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push('data: {"a":1}\r\n\r\n'), [{ event: null, data: '{"a":1}' }]);
  assert.deepEqual(decoder.push('data: {"b":2}\r\r'), [{ event: null, data: '{"b":2}' }]);
  assert.deepEqual(decoder.push('event: x\ndata: {"c":3}'), []);
  assert.deepEqual(decoder.flush(), [{ event: 'x', data: '{"c":3}' }]);
  assert.deepEqual(decoder.flush(), []);
});

test('流中断：保留已收部分并标 interrupted，不抛错（M2-9）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', delta: '前半' }));
    // 把已写的两帧推出去再砸连接：模拟模型侧到一半断流
    setTimeout(() => res.socket?.destroy(), 30);
  });

  const deltas: string[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', timeoutMs: 5_000 });
  const result = await client.stream(
    { lane: 'heavy', input: '说点什么' },
    { onTextDelta: (delta) => deltas.push(delta) },
  );

  assert.deepEqual(deltas, ['前半']);
  assert.equal(result.text, '前半');
  assert.equal(result.interrupted, true);
  assert.notEqual(result.status, 'completed');
  assert.ok(result.failure !== null);
});

// ──────────────────────────────── 错误分类 ────────────────────────────────

test('429 尊重 Retry-After：退避取服务端提示，第三次成功', async (t) => {
  let attempt = 0;
  const mock = await startMock(t, (_req, res) => {
    attempt += 1;
    if (attempt <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    jsonBody(res, 200, COMPLETE_RESPONSE);
  });

  const sleeps: number[] = [];
  const retries: number[] = [];
  const client = new DsClient({
    baseUrl: mock.url,
    apiKey: 'sk-test',
    maxAttempts: 5,
    sleep: recordingSleep(sleeps),
    onRetry: (info) => retries.push(info.delayMs),
  });
  const response = await client.generate({ lane: 'heavy', input: '在吗' });

  assert.equal(response.status, 'completed');
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(sleeps, [1_000, 1_000], 'Retry-After 优先于 base·2^(n-1)=500ms');
  assert.deepEqual(retries, [1_000, 1_000]);
  assert.equal(client.failStreak, 0, '成功即清零连续失败计数');
});

test('400 不重试：直接抛 invalid 并带 consecutiveFailures', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"input is too long"}}');
  });

  const sleeps: number[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', sleep: recordingSleep(sleeps) });

  await assert.rejects(
    () => client.generate({ lane: 'heavy', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'invalid');
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(error.consecutiveFailures, 1);
      assert.match(error.detail ?? '', /input is too long/);
      return true;
    },
  );

  assert.equal(mock.requests.length, 1, '同样的请求重试必然同样失败');
  assert.deepEqual(sleeps, []);
  assert.equal(client.failStreak, 1);
});

test('200 空内容计 empty：有限重试 3 次后外抛', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    jsonBody(res, 200, {
      id: 'resp_empty',
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 },
    });
  });

  const sleeps: number[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', sleep: recordingSleep(sleeps) });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'empty');
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 3, 'empty 收紧到 3 次，之后走降级链');
      return true;
    },
  );

  assert.equal(mock.requests.length, 3);
  assert.equal(sleeps.length, 2);
});

test('超时分类为 timeout 并按 maxAttempts 退避', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    const timer = setTimeout(() => {
      jsonBody(res, 200, COMPLETE_RESPONSE);
    }, 300);
    timer.unref();
  });

  const sleeps: number[] = [];
  const client = new DsClient({
    baseUrl: mock.url,
    apiKey: 'sk-test',
    timeoutMs: 60,
    maxAttempts: 2,
    sleep: recordingSleep(sleeps),
  });

  await assert.rejects(
    () => client.generate({ lane: 'heavy', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 2);
      return true;
    },
  );

  assert.equal(mock.requests.length, 2);
  assert.equal(sleeps.length, 1);
});

test('连接失败分类为 network（不空烧重试）', async (t) => {
  const probe = await startMock(t, (_req, res) => jsonBody(res, 200, {}));
  const port = Number(new URL(probe.url).port);
  await probe.close(); // 端口就此空着：连接必然被拒

  const sleeps: number[] = [];
  const client = new DsClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test',
    maxAttempts: 1,
    timeoutMs: 2_000,
    sleep: recordingSleep(sleeps),
  });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'network');
      assert.equal(error.retryable, true, 'network 可退避，但需上层触发网络可用性探测');
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.deepEqual(sleeps, []);
});

test('调用方中断分类为 aborted，不计入连续失败', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    const timer = setTimeout(() => jsonBody(res, 200, COMPLETE_RESPONSE), 300);
    timer.unref();
  });

  const controller = new AbortController();
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', timeoutMs: 5_000 });
  setTimeout(() => controller.abort(), 20).unref();

  await assert.rejects(
    () => client.generate({ lane: 'heavy', input: 'x', signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'aborted');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(client.failStreak, 0, '中断不是模型失败');
});

// ──────────────────────────────── 退避封装 ────────────────────────────────

test('withRetry 按 2 倍指数退避并在耗尽时标注 attempts', async () => {
  const sleeps: number[] = [];
  let calls = 0;

  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new DsClientError({ kind: 'server', message: '500', status: 500 });
        },
        { maxAttempts: 3, baseDelayMs: 1_000, sleep: recordingSleep(sleeps), lane: 'heavy' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'server');
      assert.equal(error.attempts, 3);
      return true;
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test('退避曲线与 Retry-After 解析的边界', () => {
  assert.equal(backoffDelayMs(1, 500, 30_000, null), 500);
  assert.equal(backoffDelayMs(3, 500, 30_000, null), 2_000);
  assert.equal(backoffDelayMs(9, 500, 30_000, null), 30_000, '指数部分必须封顶');
  assert.equal(backoffDelayMs(1, 500, 30_000, 8_000), 8_000, '服务端提示优先');
  assert.equal(backoffDelayMs(5, 500, 30_000, 1_000), 8_000, '提示短于曲线时取曲线');

  assert.equal(parseRetryAfter('3'), 3_000);
  assert.equal(parseRetryAfter(' 12 '), 12_000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(new Date(Date.now() - 5_000).toUTCString()), 0, '过去时间归 0');
});

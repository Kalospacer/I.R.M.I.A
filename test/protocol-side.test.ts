/**
 * 内置协议端的 web 端点测试 —— src/web/server.ts 的 `/api/protocol-side*`（v34）
 *
 * 服务层自己（探测入口 → 拉起 → 探端口 → 读它的配置 → ready → 收尸）由
 * `test/managed-service.test.ts` 的 7 条覆盖；这里锁的是"把它接到界面上"这一段：
 *
 *   · **形状自包含**：一次 GET 够界面画完整张卡（配置 + 运行期 + 装没装 + 要不要重启）；
 *   · **幂等**：已经在跑再点 start、没跑点 stop 都不报错，且如实说"什么都没发生"；
 *   · **写配置**：归一化成绝对路径、保住手写注释、走 loadConfig 复核、回执里明确"要重启"；
 *   · **红线**：`accessToken` 在任何一条响应里都不出现——它是协议端的凭据，界面只需要知道"有没有"。
 *
 * 三条纪律（与 test/web-server.test.ts 同源）：一个用例一个临时目录（写命令会真写配置文件与事件日志）；
 * 假实例必须**照着真实现的语义**写（服务在 stop 之后仍留着上一次的 endpoint——这一点直接决定了
 * 视图里 `endpoint.source` 的取值）；时间钉在假时钟上。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { CONFIG_FILE_NAME, defaultConfig, loadConfig, type AppConfig, type JsonObject } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { AppEvent, Projection } from '../src/log/types.js';
import type { ManagedServiceState, ManagedServiceStatus } from '../src/services/snowluma.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type ProtocolSideHost, type WebServer } from '../src/web/server.ts';

const T0 = new Date('2026-02-14T10:00:00.000Z');
const TEST_TOKEN = 'protocol-side-token-0123456789ab';
/** 假协议端里那份**绝不能外泄**的凭据：断言时在整段响应文本里搜它 */
const SECRET_TOKEN = 'tok-snowluma-secret-must-not-leak';
/** 假实例报出来的入口路径：**必须落在临时目录里的那个安装目录下**（否则视图会说"不知道"，
 *  因为它的三态判定认的就是"入口在不在盘上那个目录里"） */
function entryOf(serviceDir: string): string {
  return join(serviceDir, 'index.mjs');
}

// ──────────────────────────────── 假实例 ────────────────────────────────

/**
 * 协议端实例的假实现。**它必须照着 `ManagedProtocolService` 的语义写**——
 * 尤其是 `stop()` **不清 endpoint**（真实现就是这样：main.ts 只在启动时取一次，
 * 所以它留着不影响对接；而视图要据此把"活着的对接点"与"它配置里写的"分开）。
 */
class FakeHost implements ProtocolSideHost {
  state: ManagedServiceState = 'stopped';
  detail = '';
  endpoint: { wsUrl: string; accessToken: string } | undefined;
  webuiUrl: string | undefined = 'http://localhost:5099';
  entry: string | null = null;
  startCalls = 0;
  stopCalls = 0;
  /** start() 的预设结局（默认 success：状态转 ready 并把对接点填上） */
  startOutcome: 'ready' | 'not-installed' | 'failed' | 'throw' = 'ready';

  status(): ManagedServiceStatus {
    const out: ManagedServiceStatus = { state: this.state, detail: this.detail };
    // 两处**照抄真实现**的语义（假的注入点自己也要守被注入接口的语义，见 review v30）：
    //   · endpoint 在 stop 之后**仍留着**上一次的（main.ts 只在启动时取一次，不受影响）；
    //   · webuiUrl 只在 ready / starting 时给（"那个页面此刻打不开"就不摆它）。
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    if (this.state === 'ready' || this.state === 'starting') out.webuiUrl = this.webuiUrl;
    return out;
  }

  async start(): Promise<ManagedServiceStatus> {
    this.startCalls += 1;
    if (this.startOutcome === 'throw') throw new Error('spawn 失败（假实例故意抛的）');
    if (this.startOutcome === 'not-installed') {
      this.state = 'not-installed';
      this.detail = '没找到可执行入口（找过 dist/index.mjs / launcher.bat / launcher.sh）——请先下载协议端发行包并解压';
      return this.status();
    }
    if (this.startOutcome === 'failed') {
      this.state = 'failed';
      this.detail = '等 30 秒仍没等到 OneBot 端口——它可能还没登录，或者启动失败了（日志见服务日志）';
      return this.status();
    }
    this.state = 'ready';
    this.detail = '已就绪，OneBot 在 ws://127.0.0.1:3001/';
    this.endpoint = { wsUrl: 'ws://127.0.0.1:3001/', accessToken: SECRET_TOKEN };
    this.webuiUrl = 'http://localhost:5099';
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.state = 'stopped';
    this.detail = '已停止';
  }

  entryPath(): string | null {
    return this.entry;
  }
}

// ──────────────────────────────── 脚手架 ────────────────────────────────

interface Fixture {
  dir: string;
  dataDir: string;
  /** 假协议端的"安装目录"：**在临时目录里**（绝不碰真机上的任何路径） */
  serviceDir: string;
  configPath: string;
  log: EventLog;
  projection: Projection;
  server: WebServer;
  base: string;
  host: FakeHost | null;
  readAll(): Promise<AppEvent[]>;
  readConfig(): JsonObject;
}

async function setup(
  t: TestContext,
  options: {
    /**
     * 盘上 config.json 里的 `channels.onebot`（不传 = 这个文件里没有这一段）。
     * 收一个函数而不是值：管理目录必须是**临时目录里的那个**，调用的地方才拿得到它。
     */
    diskOnebot?: (serviceDir: string) => unknown;
    /** 本进程"启动时"读到的那份：'disk' = 与盘上一致（真启动就是这样），默认 = 默认配置（没有 managed） */
    boot?: 'disk' | 'defaults';
    /** 是否注入协议端实例（默认注入；false = 本进程启动时没装配它） */
    withHost?: boolean;
  } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-side-'));
  const dataDir = join(dir, 'data');
  const personaRoot = join(dataDir, 'persona');
  const webRoot = join(dir, 'web');
  const serviceDir = join(dir, 'snowluma');
  const configPath = join(dir, CONFIG_FILE_NAME);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  mkdirSync(serviceDir, { recursive: true });

  const doc: JsonObject = {
    $comment: ['手写注释：写配置必须保住它'],
    schemaVersion: 1,
    ...(options.diskOnebot === undefined
      ? {}
      : { channels: { onebot: options.diskOnebot(serviceDir) as never } }),
  };
  writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const now = (): Date => T0;
  // 启动时那份：'disk' 走真的 loadConfig（连 managed 一起读），默认走默认配置
  const config: AppConfig = options.boot === 'disk' ? (await loadConfig(dir)).config : defaultConfig(dir);
  const timers = new TimerStore(join(dataDir, 'timers.json'), { now });
  const host = options.withHost === false ? null : new FakeHost();
  if (host !== null) host.entry = entryOf(serviceDir);

  const server = await startWebServer({
    log,
    projection,
    config,
    personaRoot,
    dataDir,
    timers,
    now,
    uiToken: TEST_TOKEN,
    webRoot,
    configPath,
    port: 0,
    out: () => undefined,
    ...(host === null ? {} : { protocolSide: host }),
  });

  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  return {
    dir,
    dataDir,
    serviceDir,
    configPath,
    log,
    projection,
    server,
    base: server.url(),
    host,
    readAll: async () => {
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as JsonObject,
  };
}

interface Res {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function call(
  fx: Fixture,
  path: string,
  input: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (input.token !== null) headers['authorization'] = `Bearer ${input.token ?? TEST_TOKEN}`;
  const text = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (text !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${fx.base}${path}`, {
    method: input.method ?? 'GET',
    headers,
    ...(text === undefined ? {} : { body: text }),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  assert.ok(body !== null && typeof body === 'object', `${path} 的响应必须是 JSON 对象，收到：${raw.slice(0, 200)}`);
  // 红线在这里就查一遍：任何一条响应的**原文**里都不许出现凭据
  assert.equal(raw.includes(SECRET_TOKEN), false, `${path} 的响应里出现了 accessToken：${raw.slice(0, 400)}`);
  return { status: response.status, body: body as Record<string, unknown>, text: raw };
}

function errorOf(res: Res): { code: string; message: string } {
  const error = res.body['error'] as { code?: unknown; message?: unknown } | undefined;
  assert.ok(error !== undefined, '错误响应必须带 error 字段');
  return { code: String(error.code), message: String(error.message) };
}

/** 盘上那段 `channels.onebot`：目录用**临时目录里**的那个（不碰真机上的任何路径） */
function onebotOnDisk(serviceDir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, managed: { kind: 'snowluma', dir: serviceDir, autoStart: true }, ...extra };
}

// ──────────────────────────────── GET：状态 ────────────────────────────────

test('没配置 managed 时是 configured:false + 安全空值，**不是 404**', async (t) => {
  const fx = await setup(t, { withHost: false });
  const res = await call(fx, '/api/protocol-side');

  assert.equal(res.status, 200, '没配置是常态，不是"接口不存在"');
  assert.equal(res.body['configured'], false);
  assert.equal(res.body['enabled'], false);
  assert.equal(res.body['kind'], null);
  assert.equal(res.body['dir'], '');
  assert.equal(res.body['autoStart'], false);
  assert.equal(res.body['endpoint'], null);
  assert.equal(res.body['webuiUrl'], null);
  assert.equal(res.body['installed'], false);
  assert.equal(res.body['entryPath'], null);
  assert.equal(res.body['attached'], false, '没装配实例也要如实说');
  assert.equal(res.body['restartRequired'], false, '盘上与启动时都没有它：不需要重启');
  assert.equal(res.body['stateText'], '已停止');
  // detail 必须非空：界面靠它解释"为什么什么都没有"
  assert.match(String(res.body['detail']), /未配置/u);
});

test('配置齐备且真跑起来时：一次 GET 就够画完整张卡', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  assert.ok(fx.host !== null);
  fx.host.entry = entryOf(fx.serviceDir);
  await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });

  const res = await call(fx, '/api/protocol-side');
  assert.equal(res.status, 200);
  assert.equal(res.body['configured'], true);
  assert.equal(res.body['enabled'], true);
  assert.equal(res.body['kind'], 'snowluma');
  assert.equal(res.body['dir'], fx.serviceDir);
  assert.equal(res.body['autoStart'], true);
  assert.equal(res.body['configSource'], 'disk');
  assert.equal(res.body['attached'], true);
  assert.equal(res.body['state'], 'ready');
  assert.equal(res.body['stateText'], '已就绪');
  assert.equal(res.body['detail'], '已就绪，OneBot 在 ws://127.0.0.1:3001/');
  assert.equal(res.body['webuiUrl'], 'http://localhost:5099');
  assert.equal(res.body['installed'], true);
  assert.equal(res.body['entryPath'], entryOf(fx.serviceDir));
  assert.equal(res.body['restartRequired'], false, '盘上与启动时一致：不该喊重启');

  // 对接点只给"在哪儿 + 有没有凭据"，值永不出门（红线已由 call() 全文查过一遍）
  const endpoint = res.body['endpoint'] as Record<string, unknown>;
  assert.deepEqual(endpoint, { wsUrl: 'ws://127.0.0.1:3001/', hasToken: true, source: 'live' });
});

test('没在跑时对接点回落到它自己配置里写的那个（source: config），不猜端口', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  // 它自己的 OneBot 配置：wsServer 在 3001，token 也在那份文件里
  mkdirSync(join(fx.serviceDir, 'config'), { recursive: true });
  writeFileSync(
    join(fx.serviceDir, 'config', 'onebot.json'),
    JSON.stringify({ networks: { wsServers: [{ host: '127.0.0.1', port: 3001, path: '/', accessToken: SECRET_TOKEN }] } }),
    'utf8',
  );

  const res = await call(fx, '/api/protocol-side');
  assert.equal(res.body['state'], 'stopped');
  const endpoint = res.body['endpoint'] as Record<string, unknown>;
  assert.equal(endpoint['source'], 'config', '没在跑时给的是"它配置里写的"，不是"活的那个"');
  assert.equal(endpoint['wsUrl'], 'ws://127.0.0.1:3001/');
  assert.equal(endpoint['hasToken'], true, '只给有没有，不给值');
});

test('stop 之后不再把上一次的对接点说成"活的"（服务自己会留着它）', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  const running = await call(fx, '/api/protocol-side');
  assert.equal((running.body['endpoint'] as Record<string, unknown>)['source'], 'live');

  await call(fx, '/api/protocol-side/stop', { method: 'POST', body: {} });
  assert.equal(fx.host?.state, 'stopped');
  // 真实现 stop() 之后仍留着 endpoint（它不清理）；视图必须据此把它降级成"它配置里写的"
  assert.equal(fx.host?.status().endpoint?.wsUrl, 'ws://127.0.0.1:3001/');
  const stopped = await call(fx, '/api/protocol-side');
  assert.equal(stopped.body['endpoint'], null, '既没在跑、目录里也没有它的配置：不给对接点');
  assert.equal(stopped.body['webuiUrl'], null, '没在跑时不给 WebUI 地址——那个页面此刻打不开');
});

test('本进程启动时没装配它：attached:false + 说清"要重启"', async (t) => {
  // 盘上有、启动时没有 = "人刚在界面上填完，还没重启"
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), withHost: false });
  const res = await call(fx, '/api/protocol-side');

  assert.equal(res.status, 200);
  assert.equal(res.body['configured'], true);
  assert.equal(res.body['attached'], false);
  assert.equal(res.body['restartRequired'], true);
  assert.equal(res.body['state'], 'stopped');
  assert.match(String(res.body['detail']), /重启/u);
  // v35：没有实例时**不许**把"实例没给出入口"说成"这个目录里没有入口"。
  // 一键安装刚把 index.mjs 放进那个目录（安装器复检过），而框架此刻还没看过它——
  // 报 false 会让界面写出一句当场自相矛盾的话（"已装好"下面紧跟"目录里没有可执行入口"），
  // 足以让人把装好的东西再下一遍。没看过就说不知道
  assert.equal(res.body['installed'], null, '没看过那个目录 → null，不给一个错的 false');
  assert.equal(res.body['entryPath'], null);
});

test('配置是启动之后改的（与内存那份不一致）→ restartRequired:true', async (t) => {
  // 启动时读到的是"没配"，盘上现在是"配了"
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), withHost: false });
  const res = await call(fx, '/api/protocol-side');
  assert.equal(res.body['restartRequired'], true);
  assert.equal(res.body['enabled'], true, '盘上那份是给人看的那份');
});

test('installed 是三态：目录刚改过时**不拿旧目录的入口冒充**新目录的答案', async (t) => {
  // 实例在跑、入口在临时目录 A；盘上那份配置已经改成另一个目录 B（还没重启）
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  const ok = await call(fx, '/api/protocol-side');
  assert.equal(ok.body['installed'], true);
  assert.ok(String(ok.body['entryPath']).includes('index.mjs'));

  // 把盘上的目录改成 B（模拟"人在界面上换了个目录、还没重启"）
  const other = join(fx.dir, 'SnowLuma-2');
  mkdirSync(other, { recursive: true });
  const res = await call(fx, '/api/protocol-side/config', {
    method: 'PUT',
    body: { dir: other },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body['restartRequired'], true);
  assert.equal(res.body['installed'], null, '不知道就说不知道——不给一个错的 true');
  assert.equal(res.body['entryPath'], null);
  // 目录本身如实给出新值，让界面能解释"重启后才核对"
  assert.equal(res.body['dir'], other);
});

// ──────────────────────────────── POST：启停 ────────────────────────────────

test('start：拉起后返回操作后的状态，changed:true，且**不写事件**', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  const before = (await fx.readAll()).length;
  const res = await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });

  assert.equal(res.status, 200);
  assert.equal(fx.host?.startCalls, 1);
  assert.equal(res.body['ok'], true);
  assert.equal(res.body['action'], 'start');
  assert.equal(res.body['changed'], true);
  assert.equal(res.body['state'], 'ready');
  assert.match(String(res.body['note']), /已拉起/u);
  assert.equal((await fx.readAll()).length, before, '启停外部进程不是 agent 的状态：事件日志里不该多一条');
});

test('start 幂等：已经在跑再点一次不报错，且如实说"什么都没发生"', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  const again = await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });

  assert.equal(again.status, 200);
  assert.equal(again.body['changed'], false, '状态没变就要说没变：弹一个绿 toast 等于骗人');
  assert.match(String(again.body['note']), /已经在跑/u);
  assert.equal(again.body['state'], 'ready');
});

test('stop 幂等：没在跑点 stop 也不报错', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  const res = await call(fx, '/api/protocol-side/stop', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.equal(fx.host?.stopCalls, 0, '本来就没在跑：连 stop 都不必真调（真调也行，但这里锁的是"没有多余动作"）');
  assert.equal(res.body['changed'], false);
  assert.match(String(res.body['note']), /本来就没在跑/u);
});

test('stop：真的在跑时停掉它，并说清适配器会自己重连（不是故障）', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  const res = await call(fx, '/api/protocol-side/stop', { method: 'POST', body: {} });

  assert.equal(fx.host?.stopCalls, 1);
  assert.equal(res.body['changed'], true);
  assert.equal(res.body['state'], 'stopped');
  assert.equal(res.body['stateText'], '已停止');
  // 只停协议端、**不动 OneBot 适配器**：适配器自己会重连，日志里会出现连不上（预期）
  assert.match(String(res.body['note']), /适配器没有被停|自己重连/u);
});

test('start 遇到"没装"与"起不来"：detail 原样带出来，交由界面说全', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  fx.host!.startOutcome = 'not-installed';
  const notInstalled = await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  assert.equal(notInstalled.body['state'], 'not-installed');
  assert.equal(notInstalled.body['stateText'], '未安装');
  assert.match(String(notInstalled.body['detail']), /下载/u, '失败原因就是给人看的，原样带出来');
  assert.match(String(notInstalled.body['note']), /Releases|下载/u);

  fx.host!.startOutcome = 'failed';
  const failed = await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  assert.equal(failed.body['stateText'], '启动失败');
  assert.match(String(failed.body['detail']), /没等到 OneBot 端口/u);
});

test('start 抛异常：回 200 而不是 500（原因是给人看的一段话，不是 HTTP 错误码）', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  fx.host!.startOutcome = 'throw';
  const res = await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body['changed'], false);
  assert.match(String(res.body['note']), /spawn 失败/u);
});

test('没有实例时点 start：不假装成功，说清"要重启才接管"', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), withHost: false });
  const res = await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body['changed'], false);
  assert.equal(res.body['restartRequired'], true);
  assert.equal(res.body['state'], 'stopped');
  assert.match(String(res.body['note']), /重启/u);
});

// ──────────────────────────────── PUT：写配置 ────────────────────────────────

test('PUT 写 dir：归一化成绝对路径落盘，保住手写注释，回执里明说"要重启"', async (t) => {
  const fx = await setup(t, { withHost: false });
  const relative = join('vendor', 'snowluma');
  const res = await call(fx, '/api/protocol-side/config', {
    method: 'PUT',
    body: { dir: relative, enabled: true, autoStart: false },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body['ok'], true);
  assert.deepEqual(res.body['fields'], [
    'channels.onebot.enabled', 'channels.onebot.managed.dir', 'channels.onebot.managed.autoStart',
  ]);
  assert.equal(res.body['restartRequired'], true, '运行中的实例是按启动时的配置建的：必须说这句');
  assert.match(String(res.body['note']), /重启/u);

  // 盘上：相对路径已归一化（相对 dataDir），kind 写出来，注释还在
  const onDisk = fx.readConfig();
  assert.deepEqual(onDisk['$comment'], ['手写注释：写配置必须保住它']);
  const onebot = (onDisk['channels'] as JsonObject)['onebot'] as JsonObject;
  assert.equal(onebot['enabled'], true);
  assert.deepEqual(onebot['managed'], {
    kind: 'snowluma',
    dir: join(fx.dataDir, relative),
    autoStart: false,
  });

  // 回读：GET 看到的已经是新值（不必重启界面就能看到自己刚存的东西）
  const after = await call(fx, '/api/protocol-side');
  assert.equal(after.body['dir'], join(fx.dataDir, relative));
  assert.equal(after.body['autoStart'], false);
  assert.equal(after.body['enabled'], true);

  // 写配置照旧留痕（config/changed），否则事后复盘"协议端什么时候被打开的"无处可查
  const events = await fx.readAll();
  const changed = events.filter((event) => event.type === 'config/changed');
  assert.equal(changed.length, 1);
  assert.deepEqual((changed[0]!.data as { fields: string[] }).fields, ['channels.onebot']);
});

test('PUT：只改 enabled 不动 managed；只改 autoStart 要求 managed 已存在', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc, { enabled: false }), boot: 'disk' });

  const toggled = await call(fx, '/api/protocol-side/config', { method: 'PUT', body: { enabled: true } });
  assert.deepEqual(toggled.body['fields'], ['channels.onebot.enabled']);
  const onebot = (fx.readConfig()['channels'] as JsonObject)['onebot'] as JsonObject;
  assert.deepEqual(onebot['managed'], onebotOnDisk(fx.serviceDir)['managed'], '没点到的字段一个都不许动');

  // 还没有 managed 就谈 autoStart：当场 400，而不是建一个没有目录的空壳
  const fresh = await setup(t, { withHost: false });
  const rejected = await call(fresh, '/api/protocol-side/config', { method: 'PUT', body: { autoStart: false } });
  assert.equal(rejected.status, 400);
  assert.match(errorOf(rejected).message, /先给 dir|managed/u);
});

test('PUT 的入参校验：空 dir / 拼错的字段名 / 非布尔，一律当场拒绝', async (t) => {
  const fx = await setup(t, { withHost: false });

  const emptyDir = await call(fx, '/api/protocol-side/config', { method: 'PUT', body: { dir: '   ' } });
  assert.equal(emptyDir.status, 400);
  assert.match(errorOf(emptyDir).message, /dir/u);

  // 拼错的名字（auto_start）宽松处理会静默什么都不做，而界面会显示"已保存"
  const typo = await call(fx, '/api/protocol-side/config', { method: 'PUT', body: { auto_start: true } });
  assert.equal(typo.status, 400);
  assert.equal(errorOf(typo).code, 'unknown-field');

  const notBool = await call(fx, '/api/protocol-side/config', { method: 'PUT', body: { dir: 'C:/x', autoStart: 'yes' } });
  assert.equal(notBool.status, 400);

  const empty = await call(fx, '/api/protocol-side/config', { method: 'PUT', body: {} });
  assert.equal(empty.status, 400);
  // 一条都不该落盘
  assert.equal(fx.readConfig()['channels'], undefined);
});

test('PUT：写出非法配置要回滚原文件（复核不通过就不许留在盘上）', async (t) => {
  const fx = await setup(t, { withHost: false });
  // 空串已经在端点层被拦了；这里造一个**只有解析层能发现**的坏值：
  // channels 已存在但不是对象——写进去以后 loadConfig 复核必须失败并回滚
  const broken = `${JSON.stringify({ channels: 'not-an-object' }, null, 2)}\n`;
  writeFileSync(fx.configPath, broken, 'utf8');

  const res = await call(fx, '/api/protocol-side/config', { method: 'PUT', body: { dir: 'C:/x' } });
  assert.equal(res.status, 400);
  assert.match(errorOf(res).message, /不是对象/u);
  assert.equal(readFileSync(fx.configPath, 'utf8'), broken, '失败时盘上那份要一个字节都不动');
});

// ──────────────────────────────── 边界 ────────────────────────────────

test('**红线**：accessToken 任何情况下都不出现在响应里，只给 hasToken', async (t) => {
  // 它是协议端的凭据：界面既不需要也不该拿到（与"外部会话卡不给 openid 之外的凭据"同一条纪律）。
  // 这条用例把四条端点全走一遍，并在**原文**上搜那串值——只查字段名挡不住"顺手塞进 detail"
  // 或者"把整个 endpoint 对象透传出去"这两种写法。
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} });
  assert.equal(fx.host?.status().endpoint?.accessToken, SECRET_TOKEN, '假实例确实拿着那串凭据（否则这条用例什么都没验）');

  const responses = [
    await call(fx, '/api/protocol-side'),
    await call(fx, '/api/protocol-side/start', { method: 'POST', body: {} }),
    await call(fx, '/api/protocol-side/stop', { method: 'POST', body: {} }),
    await call(fx, '/api/protocol-side/config', { method: 'PUT', body: { enabled: true } }),
  ];
  for (const res of responses) {
    assert.equal(res.text.includes(SECRET_TOKEN), false, `响应里出现了 accessToken：${res.text.slice(0, 300)}`);
    assert.equal(res.text.includes('accessToken'), false, '连字段名都不该出现——出现了说明有人在透传那个对象');
  }
  // "有没有"仍然给得出来：界面靠它判断"这次连不上是不是因为没带 token"
  const endpoint = responses[0]!.body['endpoint'] as Record<string, unknown>;
  assert.equal(endpoint['hasToken'], true);
});

test('没有 token：三条端点一样 401（门槛在路由之前）', async (t) => {
  const fx = await setup(t, { diskOnebot: (svc) => onebotOnDisk(svc), boot: 'disk' });
  assert.equal((await call(fx, '/api/protocol-side', { token: null })).status, 401);
  assert.equal((await call(fx, '/api/protocol-side/start', { method: 'POST', body: {}, token: null })).status, 401);
  assert.equal((await call(fx, '/api/protocol-side/config', { method: 'PUT', body: {}, token: null })).status, 401);
});

test('方法不对是 405 而不是 404（"存在但不是这个用法"与"没这个地址"是两件事）', async (t) => {
  const fx = await setup(t, { withHost: false });
  assert.equal((await call(fx, '/api/protocol-side', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call(fx, '/api/protocol-side/start')).status, 405);
  assert.equal((await call(fx, '/api/protocol-side/config', { method: 'POST', body: {} })).status, 405);
  // 真不存在的路径仍是 404
  assert.equal((await call(fx, '/api/protocol-side/nope')).status, 404);
});

/**
 * 运维台信息架构测试 —— 按 AstrBot WebUI 的收纳逻辑重排之后，结构本身要被断言住：
 *   ① 侧边栏只放一级入口（聊天 / 配置文件 / 插件 / 数据与日志 / 人格 / 更多功能），设置沉在左下角；
 *   ② 二级全部收在页内 tab（下划线指示器）：配置文件 3 · 插件 4 · 数据与日志 4 · 设置 3；
 *   ③ 三件套仍然零外链、总体积 <150KB；
 *   ④ 真实服务上 `/` 与 `/ops.html` 两条都 200（聊天版与运维台各有各的入口）。
 *
 * 与 test/web-assets.test.ts 的分工：那份验视觉纪律与前后端契约字面量，这份只验「收纳结构」。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const ASSETS = ['ops.html', 'app.js', 'app.css'] as const;
const TEST_TOKEN = 'test-token-ops-ia-0123456789';
const MAX_BYTES = 150 * 1024;

/** 六个一级入口（顺序即侧边栏顺序） */
const NAV_ITEMS: ReadonlyArray<readonly [string, string]> = [
  ['nav-chat', '聊天'],
  ['nav-config', '配置文件'],
  ['nav-plugins', '插件'],
  ['nav-data', '数据与日志'],
  ['nav-persona', '人格'],
  ['nav-more', '更多功能'],
];

/** 页内二级 tab（AstrBot 的收纳方式：入口少的放侧栏，其余收进页内 tab） */
const TAB_ITEMS: ReadonlyArray<readonly [string, string]> = [
  ['ai', 'AI 配置'],
  ['platform', '平台配置'],
  ['plugins', '插件配置'],
  ['skills', '技能'],
  ['mcp', 'MCP'],
  ['hooks', 'Hook'],
  ['tools', '工具行为'],
  ['stats', '统计'],
  ['events', '事件'],
  ['logs', '日志'],
  ['trace', '追踪'],
  ['ui', '界面'],
  ['system', '系统'],
  ['about', '关于'],
];

const bodies = new Map<string, string>();
let server: WebServer | undefined;
let log: EventLog | undefined;
let tmpDir = '';
let base = '';

before(async () => {
  for (const name of ASSETS) bodies.set(name, readFileSync(join(WEB_DIR, name), 'utf8'));

  tmpDir = mkdtempSync(join(tmpdir(), 'irmia-ops-ia-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  ensurePersonaSeeds(dataDir);
  log = await EventLog.open(join(dataDir, 'events'));
  // 技能根指向临时目录：扫描结果可控，不受仓库里已有技能影响
  const skillDir = join(tmpDir, 'skills', 'demo-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示技能：用来验证信任门与 catalog 的端到端路径。\n---\n\n正文\n',
    'utf8',
  );
  const now = (): Date => new Date();
  server = await startWebServer({
    log,
    projection: emptyProjection(),
    config: defaultConfig(tmpDir),
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now }),
    now,
    uiToken: TEST_TOKEN,
    webRoot: WEB_DIR,
    port: 0,
    configPath: join(tmpDir, 'config.json'),
    skillsRoot: tmpDir,
    out: () => undefined,
  });
  base = server.url();
});

after(async () => {
  await server?.close();
  log?.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
  }
});

function body(name: (typeof ASSETS)[number]): string {
  const text = bodies.get(name);
  assert.ok(text !== undefined, `${name} 尚未读取`);
  return text;
}

// ──────────────────────────────── ① 侧边栏：一级入口 + 设置沉底 ────────────────────────────────

test('侧边栏只放六个一级入口，设置沉在左下角', () => {
  const html = body('ops.html');
  const railStart = html.indexOf('id="rail"');
  const rail = html.slice(railStart, html.indexOf('</aside>', railStart));
  assert.ok(railStart >= 0 && rail.includes('id="rail-bottom"'), '侧边栏应有沉底区');

  const main = rail.slice(rail.indexOf('id="rail-main"'), rail.indexOf('id="rail-bottom"'));
  const bottom = rail.slice(rail.indexOf('id="rail-bottom"'));

  for (const [id, label] of NAV_ITEMS) {
    assert.ok(main.includes(`id="${id}"`), `一级入口缺 ${id}`);
    assert.ok(main.includes(`<span>${label}</span>`), `${id} 的文字应是「${label}」`);
  }
  assert.equal((main.match(/class="rail-item"/gu) ?? []).length, NAV_ITEMS.length, '一级入口恰好六个');
  assert.ok(bottom.includes('id="nav-settings"'), '设置应沉在 rail-bottom');
  assert.ok(!main.includes('nav-settings'), '设置不该混进六个一级入口');
  assert.ok(main.includes('id="rail-badge-plugins"') && main.includes('id="rail-badge-data"'), '一级入口带徽章位');
  assert.ok(html.includes('href="/"') && main.includes('id="nav-chat"'), '聊天是一级入口，且链接回独立 ChatUI');
});

test('侧边栏是 200px 宽栏（带文字），不是 64px 图标栏', () => {
  const css = body('app.css');
  assert.ok(css.includes('--rail-w: 200px'), '侧边栏宽度 token 应是 200px');
  assert.ok(css.includes('.rail-item > span { display: none; }'), '只在窄屏才收起文字');
});

// ──────────────────────────────── ② 页内 tab：二级收纳 ────────────────────────────────

test('页内 tab：配置文件 3 个 · 插件 4 个 · 数据与日志 4 个 · 设置 3 个', () => {
  const js = body('app.js');
  for (const [id, label] of TAB_ITEMS) {
    assert.ok(js.includes(`{ id: '${id}', label: '${label}' }`), `缺少页内 tab ${id} / ${label}`);
  }
  const pluginsBlock = js.slice(js.indexOf("id: 'plugins'"), js.indexOf("id: 'data'"));
  assert.equal((pluginsBlock.match(/\{ id: '/gu) ?? []).length, 4, '插件页应恰好四个 tab');
  const dataBlock = js.slice(js.indexOf("id: 'data'"), js.indexOf("id: 'persona'"));
  assert.equal((dataBlock.match(/\{ id: '/gu) ?? []).length, 4, '数据与日志页应恰好四个 tab');
});

test('tab 是下划线指示器（非药丸），且二级进 hash', () => {
  const css = body('app.css');
  assert.ok(css.includes('.tabs {') && css.includes('.tab {'), '应有 tab 条与 tab 项样式');
  assert.ok(css.includes('.tab[data-on="true"]'), '选中态应写在 data-on 上');
  assert.ok(css.includes('border-bottom-color: var(--primary)'), '选中态应是下划线指示器');

  const js = body('app.js');
  for (const route of ["'#/config'", "'#/plugins/skills'", "'#/data/stats'", "'#/data/events'", "'#/settings/ui'"]) {
    assert.ok(js.includes(route), `缺少 hash 路由 ${route}`);
  }
  assert.ok(js.includes('function hashOf(pageId, tabId)'), '应有 一级/二级 → hash 的组装函数');
  assert.ok(js.includes('data-act="go-tab"'), 'tab 点击应走 go-tab');
});

test('配置文件页与数据页的关键格位齐全（功能换家不丢）', () => {
  const js = body('app.js');
  const anchors = [
    'cfg-path-card', 'cfg-panel', 'cfg-toolset',
    'sk-list-block', 'mcp-list', 'hk-list', 'tl-list',
    'stat-budget', 'stat-tiles', 'ev-list-block', 'ev-banner', 'log-alarms', 'log-doctor', 'tr-result',
    'set-ui', 'set-system', 'set-about', 'more-grid',
  ];
  const missing = anchors.filter((anchor) => !js.includes(anchor));
  assert.deepEqual(missing, [], 'app.js 缺少这些格位锚点');
});

test('新增的四类只读端点与技能信任门写命令都在前端接上', () => {
  const js = body('app.js');
  for (const endpoint of ['/api/skills', '/api/mcp', '/api/hooks', '/api/alarms', '/api/tools']) {
    assert.ok(js.includes(`'${endpoint}'`), `缺少读端点 ${endpoint}`);
  }
  assert.ok(js.includes("'skill-confirm'"), '技能确认应走写命令 skill-confirm');
  assert.ok(js.includes('skill/rejected') || js.includes('skill-ignore'), '技能「忽略」应有本地兜底入口');
});

// ──────────────────────────────── ③ 体积与零外链 ────────────────────────────────

test('三件套总体积 <150KB 且零外链', () => {
  let total = 0;
  for (const name of ASSETS) {
    const text = body(name);
    total += Buffer.byteLength(text, 'utf8');
    const external = [...text.matchAll(/https?:\/\/[^\s"'`)<>]*/gu)]
      .map((match) => match[0])
      .filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/u.test(url));
    assert.deepEqual(external, [], `${name} 出现了外部 URL`);
  }
  assert.ok(total < MAX_BYTES, `三件套总计 ${total} 字节，应小于 150KB`);
});

// ──────────────────────────────── ④ 两个入口 ────────────────────────────────

test('真实服务：/ 给主壳、/ops.html 给运维台，两条都 200', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200, '/ 应可访问');
  assert.ok((await home.text()).includes('/shell.js'), '/ 应是主壳');

  const ops = await fetch(`${base}/ops.html`);
  assert.equal(ops.status, 200, '/ops.html 应可访问');
  assert.ok((await ops.text()).includes('/app.js'), '/ops.html 应是运维台');
});

// ──────────────────────────────── ⑤ 新格位的端点（同一 token 认证、同一错误体） ────────────────────────────────

interface Res {
  status: number;
  body: unknown;
}

async function get(path: string, token: string | null = TEST_TOKEN): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function post(path: string, payload: unknown, token: string | null = TEST_TOKEN): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { authorization: `Bearer ${token}` }),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, '响应应是对象');
  return value as Record<string, unknown>;
}

test('插件页与日志格的端点：无 token 一律 401（同一套认证与错误体）', async () => {
  for (const path of ['/api/skills', '/api/mcp', '/api/hooks', '/api/alarms', '/api/tools']) {
    const res = await get(path, null);
    assert.equal(res.status, 401, `${path} 应要求 token`);
    const error = record(record(res.body)['error']);
    assert.equal(error['code'], 'unauthorized', `${path} 的错误体应是 {error:{code,message}}`);
  }
});

test('数据与日志 · 日志格：告警目录没建就是空清单（不是错误）', async () => {
  const list = await get('/api/alarms');
  assert.equal(list.status, 200);
  const body = record(list.body);
  assert.deepEqual(body['files'], [], '还没发过告警时应是空清单');
  assert.equal(body['relative'], 'alarms', '目录名应如实报出');

  const missing = await get('/api/alarms?file=nope.jsonl');
  assert.equal(missing.status, 404, '读不存在的告警文件应 404');
  assert.equal(record(record(missing.body)['error'])['code'], 'alarm-not-found');

  const traversal = await get('/api/alarms?file=..%2Fconfig.json');
  assert.equal(traversal.status, 400, '目录分隔符一律拒掉');
});

test('插件页 · Hook 格：没配钩子时如实说「文件不存在」', async () => {
  const res = await get('/api/hooks');
  assert.equal(res.status, 200);
  const body = record(res.body);
  assert.equal(body['exists'], false, '没配钩子 = 正常态');
  assert.deepEqual(body['entries'], []);
  assert.ok(String(body['relative']).endsWith('hooks.json'), '应给出配置文件位置');
  assert.ok(Array.isArray(body['readOnlyForAgent']) && body['readOnlyForAgent'].length > 0, '钩子文件对 agent 只读');
});

test('插件页 · MCP / 工具格：没有声明就是空清单，工具数如实为零', async () => {
  const mcp = await get('/api/mcp');
  assert.equal(mcp.status, 200);
  assert.deepEqual(record(mcp.body)['servers'], []);

  const tools = await get('/api/tools');
  assert.equal(tools.status, 200);
  const body = record(tools.body);
  assert.equal(body['count'], 0, '本进程没注入注册表时就是 0 件');
  assert.deepEqual(body['tools'], []);
  assert.equal(body['destructivePolicy'], false, '生效配置里的 destructive 默认全关');
});

test('插件页 · 技能格：信任门放行要写事件，写不出来的技能一律报错', async () => {
  const before = record((await get('/api/skills')).body);
  const items = before['items'] as Array<Record<string, unknown>>;
  assert.equal(items.length, 1, '临时技能根里应扫到刚写的那个技能');
  assert.equal(items[0]?.['name'], 'demo-skill');
  assert.equal(items[0]?.['trust'], 'never-confirmed', '没确认过就是 never-confirmed');
  assert.equal(items[0]?.['inCatalog'], false, '没确认就不进 catalog');

  const unknown = await post('/api/commands/skill-confirm', { name: 'nope' });
  assert.equal(unknown.status, 404, '确认不存在的技能应 404，不写假事件');
  assert.equal(record(record(unknown.body)['error'])['code'], 'skill-not-found');

  const ok = await post('/api/commands/skill-confirm', { name: 'demo-skill' });
  assert.equal(ok.status, 200);
  const payload = record(ok.body);
  assert.equal(payload['type'], 'skill/installed', '确认 = 写一条 skill/installed');
  assert.ok(typeof payload['seq'] === 'number' && payload['seq'] > 0, '应带回事件 seq');

  const after = record((await get('/api/skills')).body);
  const afterItems = after['items'] as Array<Record<string, unknown>>;
  assert.equal(afterItems[0]?.['trust'], 'trusted', '确认后信任门放行');
  assert.equal(afterItems[0]?.['inCatalog'], true, '确认后才进 catalog');
  assert.ok(Array.isArray(after['entries']) && after['entries'].length === 1, 'catalog 里应有它');
});

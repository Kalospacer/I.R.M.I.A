/**
 * 前端静态资源测试 — web/ops.html + web/app.js + web/app.css
 *
 * 注：运维台住在 `web/ops.html`（`/ops.html`），首页让给了聊天版（那份在 test/chat-assets.test.ts 里测）；
 * 收纳结构（侧边栏一级入口 + 页内 tab + 设置沉底）另有一份 test/ops-ia.test.ts 专门断言。
 *
 * 覆盖 docs/frontend.md §5 复刻验收清单里可自动化的部分，全部断言都打在"浏览器真正拿到的字节"上：
 * 起一个只服务 web/ 的本地 HTTP 服务，用 fetch 取回三份资源再逐条检查。这样测的不只是磁盘上
 * 有文件，而是"进程内嵌静态资源 + 单 HTML + 单 JS + 单 CSS"这条交付路径真的通。
 *
 * 六类断言：
 *   ① 可服务性：三文件 200 + 正确 Content-Type + 非空；
 *   ② 零外部请求：总字节 <150KB，且不出现任何非 localhost 的 http(s) 引用；
 *   ③ 关键 ID 锚点齐全（布局壳 / 六个一级入口 / 页内 tab 容器 / 确认框 / token 门 / 四态）；
 *   ④ 视觉纪律：颜色只出自 token 块、禁 shadow/gradient/毛玻璃、间距六档、圆角两档、只动白名单属性；
 *   ⑤ 动效四处时长（180/150/240/300ms）、单断点 768px、四态选择器齐全；
 *   ⑥ 契约对接：读端点、写命令、X-Confirm 短语、Bearer 与 Last-Event-ID、SSE 帧字段。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const ASSETS = ['ops.html', 'app.js', 'app.css'] as const;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function contentTypeOf(path: string): string | null {
  return CONTENT_TYPES[extname(path)] ?? null;
}

/** 已取回的资源正文（浏览器视角的字节） */
const bodies = new Map<string, string>();
const sizes = new Map<string, number>();

let server: Server | undefined;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 运维台的深链（hash 路由）落到 ops.html：与 src/web/server.ts 的 `/` → index.html
    // 不是一回事，这一份测试只服务运维台三件套
    const name = url.pathname === '/' ? '/ops.html' : url.pathname;
    const target = join(WEB_DIR, normalize(name).replace(/^[/\\]+/u, ''));
    const type = contentTypeOf(target);
    if (!target.startsWith(WEB_DIR) || type === null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    readFile(target, 'utf8').then(
      (body) => {
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end('not found');
      },
    );
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server?.address();
  assert.ok(address !== null && typeof address === 'object', '本地服务应已监听在 127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;

  for (const name of ASSETS) {
    const res = await fetch(`${base}/${name}`);
    assert.equal(res.status, 200, `${name} 应能由本地服务取出`);
    const body = await res.text();
    assert.ok(body.length > 0, `${name} 不应为空`);
    bodies.set(name, body);
    sizes.set(name, Buffer.byteLength(body, 'utf8'));
    const type = contentTypeOf(name);
    if (type !== null) {
      assert.ok(
        (res.headers.get('content-type') ?? '').startsWith(type.split(';')[0] ?? ''),
        `${name} 的 Content-Type 应是 ${type}`,
      );
    }
  }
});

after(() => {
  server?.close();
});

function body(name: (typeof ASSETS)[number]): string {
  const text = bodies.get(name);
  assert.ok(text !== undefined, `${name} 尚未取回`);
  return text;
}

/** 提取 id="x" 集合 */
function idsOf(html: string): Set<string> {
  const out = new Set<string>();
  for (const match of html.matchAll(/\bid="([^"]+)"/gu)) {
    if (match[1] !== undefined) out.add(match[1]);
  }
  return out;
}

/** 提取所有 CSS 声明（行号用于定位 token 块） */
function declarations(css: string): { line: number; prop: string; value: string }[] {
  const out: { line: number; prop: string; value: string }[] = [];
  css.split('\n').forEach((text, index) => {
    const match = /^\s*(--?[\w-]+|\w[\w-]*)\s*:\s*(.+?);?\s*$/u.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      out.push({ line: index + 1, prop: match[1], value: match[2] });
    }
  });
  return out;
}

function pxValues(value: string): number[] {
  return [...value.matchAll(/(\d+(?:\.\d+)?)px/gu)].map((match) => Number(match[1]));
}

// ──────────────────────────────── ① 可服务性与体积 ────────────────────────────────

test('三个资源可由本地服务取出，且总体积 <150KB', () => {
  let total = 0;
  for (const name of ASSETS) {
    const size = sizes.get(name);
    assert.ok(size !== undefined && size > 0, `${name} 应有内容`);
    total += size;
  }
  assert.ok(total < 150 * 1024, `三文件总计 ${total} 字节，应小于 150KB`);
});

// ──────────────────────────────── ② 零外部请求 ────────────────────────────────

test('不引用任何外部 URL（零 CDN、零字体文件）', () => {
  for (const name of ASSETS) {
    const text = body(name);
    const matches = [...text.matchAll(/https?:\/\/[^\s"'`)<>]*/gu)].map((match) => match[0]);
    const external = matches.filter(
      (url) => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/u.test(url),
    );
    assert.deepEqual(external, [], `${name} 出现了外部 URL`);
  }
});

test('ops.html 只引用同源的 app.css 与 app.js', () => {
  const html = body('ops.html');
  assert.match(html, /<link rel="stylesheet" href="\/app\.css">/u);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/u);
  assert.ok(!/<(script|link)[^>]+(?:src|href)="(?:https?:)?\/\//u.test(html), '不应有外链资源');
});

// ──────────────────────────────── ③ 关键 ID 锚点 ────────────────────────────────

test('布局壳 / 一级入口 / 页内 tab / 确认框 / token 门的 ID 锚点齐全', () => {
  const ids = idsOf(body('ops.html'));
  const required = [
    'app', 'rail', 'conn-dot', 'rail-main', 'rail-bottom',
    'nav-chat', 'nav-config', 'nav-plugins', 'nav-data', 'nav-persona', 'nav-more', 'nav-settings',
    'rail-badge-config', 'rail-badge-plugins', 'rail-badge-data', 'rail-badge-persona', 'rail-badge-more',
    'page-title', 'page-subtitle', 'page-root', 'page-tabs', 'tab-root', 'cfg-save',
    'token-gate', 'token-input', 'token-submit', 'token-error',
    'confirm-dialog', 'confirm-title', 'confirm-body', 'confirm-phrase', 'confirm-phrase-input', 'confirm-ok', 'confirm-cancel',
    'toast-host',
  ];
  const missing = required.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'ops.html 缺少这些 ID 锚点');
});

test('JS 渲染的页面区块锚点齐全（含四态容器）', () => {
  const js = body('app.js');
  const anchors = [
    'stat-head', 'stat-tiles', 'stat-budget', 'stat-recent', 'stat-quick', 'stat-suggest',
    'ev-filter', 'ev-list', 'ev-list-block', 'ev-spacer', 'ev-newbar-wrap', 'ev-replay', 'ev-banner',
    'ps-tree', 'ps-content', 'ps-timeline', 'ps-proposal',
    'sk-list-block', 'sk-pending', 'sk-active', 'mcp-list', 'hk-list', 'tl-list',
    'log-alarms', 'log-doctor', 'tr-form', 'tr-result', 'cfg-path-card', 'cfg-panel', 'cfg-toolset',
    'set-ui', 'set-system', 'set-about', 'more-grid',
  ];
  const missing = anchors.filter((anchor) => !js.includes(anchor));
  assert.deepEqual(missing, [], 'app.js 缺少这些区块锚点');
});

// ──────────────────────────────── ④ 视觉纪律 ────────────────────────────────

test('颜色只出自 token 块：块外不出现任何字面色值', () => {
  const css = body('app.css');
  const start = css.indexOf('/* == tokens:start == */');
  const end = css.indexOf('/* == tokens:end == */');
  assert.ok(start >= 0 && end > start, 'token 块标记应存在');
  const endLine = css.slice(0, end).split('\n').length;

  const offenders: string[] = [];
  css.split('\n').forEach((text, index) => {
    if (index + 1 <= endLine) return;
    for (const match of text.matchAll(/#[0-9a-fA-F]{3,6}\b/gu)) offenders.push(`${index + 1}: ${match[0]}`);
  });
  assert.deepEqual(offenders, [], 'token 块之外出现了硬编码色值');
});

test('明暗双模：两份 token 表齐备且暗色覆盖关键项', () => {
  const css = body('app.css');
  for (const token of ['--surface', '--surface-container', '--surface-highest', '--on-surface', '--on-surface-variant', '--primary', '--on-primary', '--outline-variant', '--ok', '--warn', '--danger', '--sleep']) {
    assert.ok(css.includes(`${token}:`), `缺少 token ${token}`);
  }
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'), css.indexOf('/* == tokens:end == */'));
  for (const token of ['--surface:', '--surface-container:', '--surface-highest:', '--on-surface:', '--primary:', '--outline-variant:']) {
    assert.ok(darkBlock.includes(token), `暗色表缺少 ${token}`);
  }
});

test('禁阴影 / 禁渐变 / 禁毛玻璃', () => {
  const css = body('app.css');
  for (const banned of ['box-shadow', 'gradient', 'backdrop-filter', 'text-shadow', 'drop-shadow']) {
    assert.ok(!css.includes(banned), `不应出现 ${banned}`);
  }
});

test('间距只有 4/8/12/16/24/32，其余尺寸值在白名单内', () => {
  const css = body('app.css');
  const spacingProp = /^(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?$/u;
  const spacingAllowed = new Set([0, 4, 8, 12, 16, 24, 32]);
  const pxAllowed = new Set([0, 1, 4, 8, 12, 14, 16, 18, 20, 24, 28, 32, 40, 56, 80, 120, 160, 200, 240, 420, 480, 768, 1200]);

  const badSpacing: string[] = [];
  const badPx: string[] = [];
  for (const { line, prop, value } of declarations(css)) {
    if (prop.startsWith('--')) continue;
    for (const px of pxValues(value)) {
      if (spacingProp.test(prop)) {
        if (!spacingAllowed.has(px)) badSpacing.push(`${line}: ${prop}: ${px}px`);
      } else if (!pxAllowed.has(px)) {
        badPx.push(`${line}: ${prop}: ${px}px`);
      }
    }
  }
  assert.deepEqual(badSpacing, [], '间距只能是 4/8/12/16/24/32');
  assert.deepEqual(badPx, [], '出现了白名单之外的尺寸值');
});

test('圆角只有两档：组件 8px、内容区左上 12px', () => {
  const css = body('app.css');
  const allowed = new Set(['var(--radius)', 'var(--radius-paper)']);
  const bad: string[] = [];
  for (const { line, prop, value } of declarations(css)) {
    if (!prop.startsWith('border') || !prop.includes('radius')) continue;
    if (!allowed.has(value.trim())) bad.push(`${line}: ${prop}: ${value}`);
  }
  assert.deepEqual(bad, [], '圆角只允许 var(--radius) 与 var(--radius-paper)');
  assert.ok(css.includes('--radius: 8px'), '组件圆角应是 8px');
  assert.ok(css.includes('--radius-paper: 12px'), '内容区左上圆角应是 12px');
});

test('过渡只作用在 opacity / transform / 颜色 / 高度上', () => {
  const css = body('app.css');
  const allowed = new Set(['opacity', 'transform', 'height', 'color', 'background-color', 'border-color', 'fill', 'stroke']);
  const bad: string[] = [];
  for (const { line, prop, value } of declarations(css)) {
    if (prop !== 'transition') continue;
    for (const part of value.split(',')) {
      const name = part.trim().split(/\s+/u)[0] ?? '';
      if (name !== '' && !allowed.has(name) && !name.startsWith('--')) bad.push(`${line}: ${name}`);
    }
  }
  assert.deepEqual(bad, [], '过渡属性超出白名单');
});

// ──────────────────────────────── ⑤ 动效、断点、四态 ────────────────────────────────

test('四处动效时长与曲线齐全（180/150/240/300ms）', () => {
  const css = body('app.css');
  assert.ok(css.includes('--t-page: 180ms'), '页面切换应是 180ms');
  assert.ok(css.includes('--t-sse: 150ms'), 'SSE 新行淡入应是 150ms');
  assert.ok(css.includes('--t-card: 240ms'), '卡片进出应是 240ms');
  assert.ok(css.includes('--t-ok: 240ms'), '写成功变勾应是 240ms');
  assert.ok(css.includes('--t-state: 300ms'), '状态变色应是 300ms');
  assert.ok(css.includes('cubic-bezier(0.33, 1, 0.68, 1)'), 'easeOutCubic 曲线应存在');
  assert.ok(css.includes('cubic-bezier(0.32, 0, 0.67, 0)'), 'easeInCubic 曲线应存在');
  for (const frame of ['page-in', 'card-in', 'row-in', 'ok-in']) {
    assert.ok(css.includes(`@keyframes ${frame}`), `缺少关键帧 ${frame}`);
  }
});

test('单断点 768px：侧边栏收成底部导航条', () => {
  const css = body('app.css');
  assert.ok(css.includes('@media (max-width: 768px)'), '应只有 768px 这一个断点');
  const others = [...css.matchAll(/@media[^{]*\(\s*(?:max|min)-width:\s*(\d+)px/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(others)], ['768'], '不应出现第二个断点');
});

test('四态选择器齐全，且每个数据区块都走同一套状态容器', () => {
  const css = body('app.css');
  for (const state of ['loading', 'error', 'empty', 'data']) {
    assert.ok(css.includes(`[data-state="${state}"]`), `缺少 ${state} 态选择器`);
    assert.ok(css.includes(`[data-slot="${state}"]`) || css.includes(`data-slot="${state}"`), `缺少 ${state} 槽位`);
  }
  const js = body('app.js');
  for (const state of ["'loading'", "'error'", "'empty'", "'data'"]) {
    assert.ok(js.includes(state), `app.js 未使用 ${state} 态`);
  }
  assert.ok(js.includes('data-state='), '状态应写在 data-state 上');
});

test('侧边栏选中态 = 实心图标 + primary，未选中 = 线框', () => {
  const css = body('app.css');
  const html = body('ops.html');
  assert.ok(css.includes('.rail-item[data-active="true"] .icon-on'), '选中应展示实心图标');
  assert.ok(css.includes('.rail-item[data-active="true"] .icon-off'), '选中应隐藏线框图标');
  assert.ok(html.includes('class="icon icon-on"') && html.includes('class="icon icon-off"'), '导航项应同时内联两套图标');
  assert.ok(html.includes('id="rail-bottom"'), '管控应沉底（trailing）');
});

// ──────────────────────────────── ⑥ 契约对接 ────────────────────────────────

test('读端点与写命令严格按契约拼路径', () => {
  const js = body('app.js');
  const readEndpoints = [
    '/api/projection',
    '/api/stats/dashboard',
    '/api/events',
    '/api/events/stream',
    '/api/budget',
    '/api/config',
    '/api/doctor',
    '/api/persona/files',
    '/api/persona/file',
    '/api/persona/history',
    '/api/replay',
  ];
  for (const endpoint of readEndpoints) {
    assert.ok(js.includes(`'${endpoint}'`) || js.includes(`\`${endpoint}`), `缺少读端点 ${endpoint}`);
  }
  for (const name of ['wake', 'review-resolve', 'requeue', 'persona-approve', 'config-update', 'timer-cancel']) {
    assert.ok(js.includes(`'${name}'`), `缺少写命令 ${name}`);
  }
  assert.ok(js.includes('/api/commands/'), '写通道应走 /api/commands/');
  assert.ok(js.includes('limit') && js.includes('from_seq'), '事件接口应带 limit / from_seq');
  assert.ok(js.includes("q.set('limit', String(") , 'limit 应固定为每批条数');
  assert.ok(js.includes('const BATCH = 200'), '每批 200 条');
});

test('写操作带上 Bearer 与 X-Confirm，401 回到 token 输入态', () => {
  const js = body('app.js');
  assert.ok(js.includes('Authorization') && js.includes('Bearer'), '应带 Bearer 令牌');
  assert.ok(js.includes('X-Confirm'), '危险操作应带 X-Confirm 头');
  // 短语表与 src/web/server.ts 的 CONFIRM_PHRASES / DANGEROUS_FIELDS 同源：命令级全为 null，
  // 唯一必给的短语是字段级的 enable-destructive
  assert.ok(js.includes("const DANGEROUS_FIELDS = { 'tools.destructiveEnabled': 'enable-destructive' }"), '字段级危险短语应与 server 一致');
  assert.ok(js.includes('const PHRASE'), '应保留命令级短语表（与 CONFIRM_PHRASES 同源）');
  assert.ok(js.includes("phrases.join('; ')"), 'X-Confirm 应是分号分隔的短语列表');
  assert.ok(js.includes('irmia.ui.token'), '令牌应存 localStorage');
  assert.ok(js.includes('localStorage.setItem(TOKEN_KEY'), '令牌写入 localStorage');
  assert.ok(js.includes('res.status === 401'), '401 应回到输入态');
  const html = body('ops.html');
  assert.ok(html.includes('X-Confirm') || js.includes('确认短语'), '确认对话框应展示短语原文');
  assert.ok(js.includes('data.error'), '错误应读 { error: { code, message } }');
});

test('未实现命令如实透传服务端的 501 原因', () => {
  const js = body('app.js');
  assert.ok(!js.includes('UNAVAILABLE_COMMANDS'), '不应在前端自建“未提供命令”清单（原因由服务端给）');
  for (const command of ['dead-discard', 'export', 'backup', 'archive-now', 'ping', 'webhook-test']) {
    assert.ok(js.includes(`'${command}'`), `应保留 ${command} 的入口`);
  }
  assert.ok(js.includes('res.error?.message'), '错误原因应原样展示给人');
});

test('SSE 帧按契约解析：event / id / data / retry，断线带 Last-Event-ID 补拉', () => {
  const js = body('app.js');
  for (const field of ["field === 'event'", "field === 'id'", "field === 'data'", "field === 'retry'"]) {
    assert.ok(js.includes(field), `SSE 解析缺少 ${field}`);
  }
  assert.ok(js.includes("text/event-stream"), '应以 SSE 方式订阅');
  assert.ok(js.includes("'Last-Event-ID'"), '重连应带 Last-Event-ID');
  assert.ok(js.includes('if (S.sse.everConnected) void loadProjection();'), '重连应全量重拉投影');
  assert.ok(js.includes('setTimeout'), 'retry 语义应落到重连等待上');
});

test('六态状态机取值与 server 的 DashboardState 同名同序', () => {
  const js = body('app.js');
  assert.ok(
    js.includes("const STATE_ORDER = ['needs-review', 'paused', 'degraded', 'running', 'sleeping', 'idle']"),
    '六态应取 needs-review/paused/degraded/running/sleeping/idle',
  );
  assert.ok(js.includes('dash.stateText'), '大状态句优先用后端的 stateText');
  const css = body('app.css');
  assert.ok(css.includes('[data-state-kind="needs-review"]'), 'CSS 应有 needs-review 变色');
  assert.ok(css.includes('[data-state-kind="idle"]'), 'CSS 应有 idle 变色');
});

test('hash 路由：一级 + 页内二级 + token 首启流程', () => {
  const js = body('app.js');
  for (const route of ["'#/config'", "'#/plugins/skills'", "'#/data/stats'", "'#/data/events'", "'#/data/logs'", "'#/data/trace'", "'#/persona'", "'#/settings/ui'"]) {
    assert.ok(js.includes(route), `缺少路由 ${route}`);
  }
  assert.ok(js.includes('hashchange'), '应监听 hash 路由变化');
  assert.ok(js.includes("getItem(TOKEN_KEY)"), '启动应读 localStorage 里的令牌');
  const html = body('ops.html');
  assert.ok(html.includes('data-theme='), '明暗双模应挂在根元素 data-theme 上');
});

/**
 * 主壳页面模块测试 —— 五页迁进壳（web/pages/*.js）之后，这条交付路径要被断言住：
 *   ① 五个模块都在，都导出 init(el, ctx)（壳只认这一个出口），并交回 cleanup；
 *   ② 每页 init 之后渲染出自己的标题与副标题（挂在 .sh-page-head 的壳节奏里）；
 *   ③ 每页的四态容器齐（loading / error / empty / data 四个槽位都渲染出来）；
 *   ④ 数据加载失败也不白屏：标题还在、error 槽在、不抛异常；
 *   ⑤ index.html 带上壳样式 + 五个页面样式，且资源零外链。
 *
 * 跑法就是 npm test（node --test --experimental-strip-types）。
 * 渲染用 test/helpers/shell-dom.ts 的极简 DOM 桩：不追求 DOM 语义完整，
 * 只求"页面 init 真跑一遍"，顺带验证页面自身对缺元素容错。
 * 每个用例结束都调 cleanup：页面的定时器必须能被壳清掉（这也是断言之一）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installDom, makeCtx } from './helpers/shell-dom.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

interface PageSpec {
  name: string;
  title: string;
  sub: string;
  hash: string;
  /** 这一页首屏一定读的端点（契约对齐用） */
  endpoints: readonly string[];
}

const PAGES: readonly PageSpec[] = [
  { name: 'persona', title: '人格配置', sub: '她是谁、记得什么', hash: '#/persona', endpoints: ['/api/persona/files', '/api/persona/history'] },
  { name: 'channels', title: '消息适配器', sub: '她从哪里听到人说话', hash: '#/channels', endpoints: ['/api/config', '/api/events'] },
  { name: 'extensions', title: '扩展', sub: '她能用什么', hash: '#/extensions/skills', endpoints: ['/api/skills'] },
  { name: 'logs', title: '日志', sub: '账本、事件流', hash: '#/logs/stats', endpoints: ['/api/budget', '/api/stats/dashboard'] },
  { name: 'settings', title: '设置', sub: '观感、系统只读项', hash: '#/settings/system', endpoints: ['/api/config', '/api/projection'] },
];

/** 四个槽位：app.css 的 .block[data-state] 靠它们切态 */
const SLOTS = ['loading', 'error', 'empty', 'data'] as const;

const dom = installDom();

type Handler = (path: string, opts?: unknown) => unknown;

/** 让页面那一串 await ctx.api(…) 的微任务跑完 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

interface Booted {
  /** 页面根容器当前渲染出的 HTML */
  html(): string;
  /** 安全调用用的清理函数（非函数时是空操作） */
  cleanup: () => void;
  /** init 真交回了函数没有（壳靠它清定时器） */
  cleanupIsFn: boolean;
  calls: Array<{ path: string; opts: unknown }>;
}

/** 加载一页并真跑一遍 init（用完必须 cleanup：页面的定时器归壳管） */
async function boot(spec: PageSpec, handler?: Handler): Promise<Booted> {
  dom.setHash(spec.hash);
  dom.resetStorage();
  const mod = (await import(`../web/pages/${spec.name}.js`)) as { init?: unknown };
  assert.equal(typeof mod.init, 'function', `${spec.name}.js 必须导出 init`);
  const el = dom.el;
  el.innerHTML = '';
  const ctx = makeCtx(handler);
  const cleanup = (mod.init as (e: unknown, c: unknown) => unknown)(el, ctx);
  return {
    html: () => String(el.innerHTML),
    cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : () => undefined,
    cleanupIsFn: typeof cleanup === 'function',
    calls: ctx.calls as Array<{ path: string; opts: unknown }>,
  };
}

/** 每页跑一段断言，跑完一定清理（定时器泄漏会让测试进程挂着不退） */
async function eachPage(fn: (spec: PageSpec, page: Booted) => Promise<void> | void, handler?: Handler): Promise<void> {
  for (const spec of PAGES) {
    const page = await boot(spec, handler);
    try {
      await fn(spec, page);
    } finally {
      page.cleanup();
    }
  }
}

// ──────────────────────────────── ① 模块出口 ────────────────────────────────

test('五个页面模块都在，且都导出 init(el, ctx) 与 cleanup', async () => {
  for (const spec of PAGES) {
    const mod = (await import(`../web/pages/${spec.name}.js`)) as Record<string, unknown>;
    assert.equal(typeof mod.init, 'function', `${spec.name}.js 缺少 init`);
  }
  await eachPage((spec, page) => {
    assert.ok(page.cleanupIsFn, `${spec.name} 的 init 应返回 cleanup`);
  });
});

// ──────────────────────────────── ② 标题与壳节奏 ────────────────────────────────

test('每页都渲染出自己的标题与副标题，且挂在壳的页头节奏里', async () => {
  await eachPage((spec, page) => {
    const html = page.html();
    assert.ok(html.includes('class="sh-page-head"'), `${spec.name} 缺页头容器`);
    assert.ok(html.includes(`<h1 class="sh-page-title">${spec.title}</h1>`), `${spec.name} 的标题应是「${spec.title}」`);
    assert.ok(html.includes('class="sh-page-sub"') && html.includes(spec.sub), `${spec.name} 的副标题缺「${spec.sub}」`);
    assert.ok(html.includes('class="sh-page-body"'), `${spec.name} 缺内容区`);
  });
});

// ──────────────────────────────── ③ 四态齐全 ────────────────────────────────

test('每页的四态容器齐：loading / error / empty / data 四个槽位都在', async () => {
  await eachPage((spec, page) => {
    const html = page.html();
    for (const slot of SLOTS) {
      assert.ok(html.includes(`data-slot="${slot}"`), `${spec.name} 缺 ${slot} 槽位`);
    }
    assert.ok(/data-state="(loading|error|empty|data)"/u.test(html), `${spec.name} 的块没带 data-state`);
  });
});

test('四态是页面的状态而不是死字符串：加载完成后不再停在 loading', async () => {
  await eachPage(async (spec, page) => {
    await settle();
    const html = page.html();
    // 桩里的数据都是空集合：所以应当落到 empty（有数据时则落到 data），而不是继续 loading
    const states = [...html.matchAll(/data-state="([a-z]+)"/gu)].map((match) => match[1]);
    assert.ok(states.length > 0, `${spec.name} 没有四态块`);
    assert.ok(states.includes('empty') || states.includes('data'), `${spec.name} 加载完成后停在 ${states.join('/')}`);
  });
});

// ──────────────────────────────── ④ 读端点契约 ────────────────────────────────

test('每页首屏读的端点都落在 /api/* 上（与 server 同一套路径）', async () => {
  await eachPage((spec, page) => {
    assert.ok(page.calls.length > 0, `${spec.name} 首屏应当去读数据`);
    const paths = page.calls.map((call) => call.path.split('?')[0] ?? call.path);
    for (const endpoint of spec.endpoints) {
      assert.ok(paths.includes(endpoint), `${spec.name} 没去读 ${endpoint}（实际读了 ${paths.join(', ')}）`);
    }
    for (const path of paths) {
      assert.ok(path.startsWith('/api/'), `${spec.name} 读了一个非 /api 的地址：${path}`);
    }
  });
});

// ──────────────────────────────── ⑤ 失败不白屏 ────────────────────────────────

test('数据全读不到时降级到 error 态，标题仍在（不白屏、不抛）', async () => {
  await eachPage(
    async (spec, page) => {
      await settle();
      const html = page.html();
      assert.ok(html.includes(spec.title), `${spec.name} 出错后标题丢了`);
      assert.ok(html.includes('data-slot="error"'), `${spec.name} 出错后没有 error 槽`);
      assert.ok(!html.includes('undefined</h1>'), `${spec.name} 渲染出了 undefined`);
    },
    () => new Error('连不上本地服务：ECONNREFUSED'),
  );
});

test('error 槽里带的是服务端原话，页面不吞错误', async () => {
  await eachPage(
    async (spec, page) => {
      await settle();
      assert.ok(page.html().includes('连不上本地服务：ECONNREFUSED'), `${spec.name} 没把失败原因写进 error 槽`);
    },
    () => new Error('连不上本地服务：ECONNREFUSED'),
  );
});

// ──────────────────────────────── ⑥ 主壳资源清单与零外链 ────────────────────────────────

const SHELL_CSS = [
  '/app.css',
  '/shell.css',
  '/pages/overview.css',
  '/pages/persona.css',
  '/pages/channels.css',
  '/pages/extensions.css',
  '/pages/logs.css',
  '/pages/settings.css',
] as const;

test('index.html 带上壳样式与五个页面样式，一条都不缺', () => {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  for (const href of SHELL_CSS) {
    assert.ok(html.includes(`href="${href}"`), `index.html 缺样式 ${href}`);
  }
  assert.ok(html.includes('src="/shell.js"'), 'index.html 应加载主壳');
  for (const page of PAGES) {
    assert.ok(html.includes(`data-page-view="${page.name}"`), `index.html 缺 ${page.name} 的页面容器`);
  }
});

test('五页模块、样式与壳资源零外链（localhost / 127.0.0.1 除外）', () => {
  const files = [
    'index.html',
    'shell.js',
    'pages/_kit.js',
    ...PAGES.map((spec) => `pages/${spec.name}.js`),
    ...PAGES.map((spec) => `pages/${spec.name}.css`),
  ];
  for (const rel of files) {
    const text = readFileSync(join(WEB_DIR, rel), 'utf8');
    const external = [...text.matchAll(/https?:\/\/[^\s"'`)<>]*/gu)]
      .map((match) => match[0])
      .filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/u.test(url));
    assert.deepEqual(external, [], `${rel} 出现了外部 URL：${external.join(', ')}`);
  }
});

test('每页样式存在、非空，且只用自己的 token 与断点', () => {
  for (const spec of PAGES) {
    const css = readFileSync(join(WEB_DIR, 'pages', `${spec.name}.css`), 'utf8');
    assert.ok(css.trim().length > 0, `pages/${spec.name}.css 是空的`);
    assert.ok(css.includes('var(--'), `pages/${spec.name}.css 应当用 token 上色`);
    assert.ok(css.includes('@media (max-width: 768px)'), `pages/${spec.name}.css 缺窄屏断点`);
  }
});

test('主壳的页面注册表与五个模块名对齐（路由认得出它们）', () => {
  const shell = readFileSync(join(WEB_DIR, 'shell.js'), 'utf8');
  for (const spec of PAGES) {
    assert.ok(shell.includes(`'${spec.name}'`), `shell.js 的 PAGES 里缺 ${spec.name}`);
  }
  assert.ok(shell.includes('import(`/pages/${name}.js`)'), '壳应按页名懒加载 /pages/*.js');
});

// ──────────────────────────────── ⑦ 交付路径（真的经 HTTP 取得到） ────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

test('真实服务：主壳与五页模块都能按 URL 取到（壳靠这条路径懒加载页面）', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = join(WEB_DIR, normalize(decodeURIComponent(rel)).replace(/^[/\\]+/u, ''));
    const type = CONTENT_TYPES[extname(target)] ?? null;
    if (!target.startsWith(WEB_DIR) || type === null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(target));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  assert.ok(port > 0, '测试服务应拿到端口');
  try {
    const routes = [
      '/index.html',
      '/pages/_kit.js',
      ...PAGES.map((spec) => `/pages/${spec.name}.js`),
      ...PAGES.map((spec) => `/pages/${spec.name}.css`),
    ];
    for (const route of routes) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(res.status, 200, `${route} 应 200`);
      const type = String(res.headers.get('content-type') ?? '');
      if (route.endsWith('.js')) assert.match(type, /javascript/u, `${route} 的 Content-Type 应是 JS`);
      else if (route.endsWith('.css')) assert.match(type, /css/u, `${route} 的 Content-Type 应是 CSS`);
      else assert.match(type, /html/u, `${route} 的 Content-Type 应是 HTML`);
      assert.ok((await res.text()).length > 0, `${route} 不应为空`);
    }
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

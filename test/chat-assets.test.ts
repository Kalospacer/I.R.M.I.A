/**
 * 首页资源测试 — web/index.html 主壳 + 各页面模块（web/pages/*.js）
 *
 * 首页从「单页聊天版」搬进主壳之后，这条测试改盯新结构：壳负责路由/令牌门/品牌区，
 * 页面模块只管自己那一块。验收意图一条不减：
 *   ① 体积：壳骨架 + 聊天页六件套总计 <150KB（首屏必须轻，这一页不该有构建负担）；
 *   ② 零外链：除 127.0.0.1 外不出现任何外部 URL（零 CDN、零字体、零图床）；
 *   ③ 人话纪律：index.html 的**可见文案**里不出现工程师词汇（注释不算）；
 *   ④ 路由存在性：起真实的 web 服务，`/` 给主壳、`/ops.html` 仍给运维台、
 *      `/pages/*.js` 能被浏览器直接取到（模块是运行时 import 的，静态通道得通）。
 *
 * 另有 test/chat-visual.test.ts 管聊天页的「皮」，test/web-assets.test.ts 管运维台三件套。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// ──────────────────────────────── 脚手架 ────────────────────────────────

/** 真实前端目录（不是 fixture）：这一份测试要验的正是"交付到浏览器的字节" */
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

/** 壳骨架 + 聊天页（含它依赖的公共基元）：首屏真会拉下来的那几份 */
const CHAT_ASSETS = [
  'index.html',
  'shell.js',
  'shell.css',
  'chat.css',
  'pages/chat.js',
  'pages/_kit.js',
] as const;

const TEST_TOKEN = 'test-token-chat-0123456789';
const MAX_BYTES = 150 * 1024;

/** 工程师词汇表：这些词一旦出现在可见文案里，就说明翻译层漏了 */
const ENGINEER_WORDS = ['水位', '命中率', '投影', '水印'];

const bodies = new Map<string, string>();

let server: WebServer | undefined;
let log: EventLog | undefined;
let tmpDir = '';
let base = '';

before(async () => {
  for (const name of CHAT_ASSETS) {
    bodies.set(name, readFileSync(join(WEB_DIR, name), 'utf8'));
  }

  tmpDir = mkdtempSync(join(tmpdir(), 'irmia-chat-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  ensurePersonaSeeds(dataDir);
  log = await EventLog.open(join(dataDir, 'events'));
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

function body(name: (typeof CHAT_ASSETS)[number]): string {
  const text = bodies.get(name);
  assert.ok(text !== undefined, `${name} 尚未读取`);
  return text;
}

/** 剥掉注释与标签，只留下人真正会读到的文案 */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<script[\s\S]*?<\/script>/gu, ' ')
    .replace(/<style[\s\S]*?<\/style>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
}

// ──────────────────────────────── ① 体积 ────────────────────────────────

test('主壳与聊天页六件套齐全，总计 <150KB', () => {
  let total = 0;
  for (const name of CHAT_ASSETS) {
    const text = body(name);
    assert.ok(text.length > 0, `${name} 不应为空`);
    total += Buffer.byteLength(text, 'utf8');
  }
  assert.ok(total < MAX_BYTES, `六件套共 ${total} 字节，应小于 ${MAX_BYTES}`);
});

test('ops.html 与运维台三件套仍在（首页换壳没有把老页面弄丢）', () => {
  const ops = readFileSync(join(WEB_DIR, 'ops.html'), 'utf8');
  assert.ok(ops.includes('/app.css'), 'ops.html 应继续引用 app.css（绝对路径，改名后不受影响）');
  assert.ok(ops.includes('/app.js'), 'ops.html 应继续引用 app.js');
  assert.ok(ops.includes('运维台'), 'ops.html 应仍是运维台');
});

// ──────────────────────────────── ② 零外链 ────────────────────────────────

test('不引用任何外部 URL（零 CDN、零字体、零图床）', () => {
  for (const name of CHAT_ASSETS) {
    const matches = [...body(name).matchAll(/https?:\/\/[^\s"'`)<>]*/gu)].map((match) => match[0]);
    const external = matches.filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/u.test(url));
    assert.deepEqual(external, [], `${name} 出现了外部 URL`);
  }
});

test('index.html 只引用同源的样式与脚本（壳自己一份，页面模块运行时 import）', () => {
  const html = body('index.html');
  for (const href of ['/app.css', '/shell.css', '/chat.css', '/pages/overview.css']) {
    assert.ok(html.includes(`href="${href}"`), `主壳应引用 ${href}`);
  }
  assert.match(html, /<script type="module" src="\/shell\.js"><\/script>/u);
  assert.ok(!/<(script|link)[^>]+(?:src|href)="(?:https?:)?\/\//u.test(html), '不应有外链资源');
});

// ──────────────────────────────── ③ 人话纪律 ────────────────────────────────

test('可见文案里没有工程师词汇（注释不算）', () => {
  const text = visibleText(body('index.html'));
  const offenders = ENGINEER_WORDS.filter((word) => text.includes(word));
  assert.deepEqual(offenders, [], `可见文案出现了工程师词汇：${offenders.join('、')}`);
  for (const word of ['seq', 'turn', 'lane']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'iu').test(text), `可见文案出现了工程师词汇 ${word}`);
  }
});

test('主壳：七个页面槽位 + 导航项 + 令牌门 + 徽章位齐全', () => {
  const html = body('index.html');
  for (const page of ['overview', 'chat', 'persona', 'channels', 'extensions', 'logs', 'settings']) {
    assert.ok(html.includes(`id="page-${page}"`), `内容区缺少 ${page} 页槽位`);
    assert.ok(html.includes(`data-page="${page}"`), `导航缺少 ${page} 入口`);
  }
  assert.ok(html.includes('id="sh-gate"'), '令牌门应归壳统一管');
  assert.ok(html.includes('id="sh-badge-chat"'), '聊天项应有徽章位（未读计数）');
  assert.ok(html.includes('id="sh-badge-logs"'), '日志项应有徽章位');
  assert.ok(html.includes('sh-badge-warn'), '日志项徽章应是 warn 款（红点）');
  assert.ok(html.includes('data-theme='), '明暗双模应挂在根元素 data-theme 上');
});

test('聊天页：只剩对话流 / 确认卡片 / 输入行，且不在页内查全局 id', () => {
  const js = body('pages/chat.js');
  for (const anchor of ['id="c-feed"', 'id="c-list"', 'id="c-guide"', 'id="c-cards"', 'id="c-input"', 'id="c-send"']) {
    assert.ok(js.includes(anchor), `聊天页模板缺少 ${anchor}`);
  }
  assert.ok(js.includes('placeholder="输入消息…"'), '输入框占位符应是界面文案（走 copy-guide 词表）');
  assert.ok(js.includes('data-state="loading"'), '应有加载态');
  assert.match(js, /data-slot="empty"/u);
  assert.match(js, /data-slot="data"/u);

  // 顶栏与令牌门都归了壳：聊天页里不许再出现它们
  for (const gone of ['c-top', 'c-avatar', 'c-menu', 'c-gate', 'c-modal']) {
    assert.ok(!js.includes(gone), `聊天页不该再保留 ${gone}（已在壳里）`);
  }
  // 页面模块只在自己的容器里查元素：document.getElementById 一处都不该有
  assert.ok(!js.includes('document.getElementById'), '页面模块应只做容器内查询（el.querySelector）');
  assert.ok(js.includes("R.querySelector(`#${id}`)"), '页内查询应走容器根节点');
});

test('事件映射写在 pages/chat.js 里，状态句翻译层归壳的 shell.js', () => {
  const js = body('pages/chat.js');
  // 事件 → 对话的映射：她说的、你说的、别人说的、系统灰字
  for (const type of ["'message/assistant'", "'message/user'", "'wake/manual'", "'wake/channel'", "'wake/timer'", "'wake/heartbeat'"]) {
    assert.ok(js.includes(type), `事件映射缺少 ${type}`);
  }
  assert.ok(js.includes('spoke === true'), '沉默的心跳不该上屏');
  for (const endpoint of ["'/api/projection'", '/api/events?limit=', "'/api/events/stream'", "'/api/persona/files'"]) {
    assert.ok(js.includes(endpoint), `缺少数据来源 ${endpoint}`);
  }
  for (const command of ["'/api/commands/wake'", "'/api/commands/review-resolve'", "'/api/commands/answer'"]) {
    assert.ok(js.includes(command), `缺少写命令 ${command}`);
  }

  // 状态词表（docs/copy-guide.md 第二节）是壳的品牌区在说，不在聊天页里重复一遍
  const shell = body('shell.js');
  for (const phrase of ['执行中', '就绪', '休眠中', '降级运行', '已暂停（预算耗尽）', '待确认', '连接中断']) {
    assert.ok(shell.includes(phrase), `壳的状态词表缺少文案：${phrase}`);
  }
  for (const spoken of ['我在干活呢', '我在打盹', '我在呢', '连不上她了', '预算花完了']) {
    assert.ok(!shell.includes(spoken), `壳的品牌区不该再出现口语化状态句：${spoken}`);
  }
  assert.ok(shell.includes('irmia.ui.token'), '令牌应复用运维台的 localStorage 键');
  assert.ok(shell.includes("ctx.api('/api/stats/dashboard')"), '壳应自己轮询仪表盘喂品牌区');
});

// ──────────────────────────────── ④ 真实服务上的路由 ────────────────────────────────

test('真实服务：/ 给主壳、/ops.html 给运维台、/pages/*.js 可被取到，都 200', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200, '/ 应可访问');
  const homeText = await home.text();
  assert.ok(homeText.includes('/shell.js'), '/ 应是主壳');

  const ops = await fetch(`${base}/ops.html`);
  assert.equal(ops.status, 200, '/ops.html 应可访问');
  const opsText = await ops.text();
  assert.ok(opsText.includes('/app.js'), '/ops.html 应是运维台');

  // 页面模块是运行时 import 的：静态通道得能取到，否则一切白说
  for (const name of [...CHAT_ASSETS, 'pages/overview.js', 'pages/persona.js']) {
    const res = await fetch(`${base}/${name}`);
    assert.equal(res.status, 200, `/${name} 应可访问`);
  }
});

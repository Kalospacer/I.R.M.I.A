/**
 * 人格页编辑器测试 —— 直编这条交付路径要被断言住：
 *   ① 可编辑判定（isEditablePersonaFile）与后端 validatePersonaEdit 同一套白名单；
 *   ② 保存请求体形状：POST /api/commands/persona-edit + Authorization + Content-Type + {file, content}；
 *   ③ 失败保留草稿：editOutcome.keepDraft + renderEditor 把草稿渲染进 textarea；
 *   ④ 文件树铅笔标记（16px 内联 SVG + 「可编辑」tooltip）与编辑器 DOM；
 *   ⑤ 端到端：页面函数打到真实服务——写盘生效、越权被拒、401 变成一句能照着做的话。
 *
 * 跑法就是 npm test（node --test --experimental-strip-types）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { loadConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { fold } from '../src/state/fold.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { installDom, makeCtx } from './helpers/shell-dom.ts';

type Any = any;

interface EditResult {
  ok: boolean;
  data: Any;
  error: string | null;
}

interface EditOutcome {
  refresh: boolean;
  keepDraft: boolean;
  toast: string;
  tone: string;
}

interface PersonaPageModule {
  PERSONA_EDIT_MAX_BYTES: number;
  isEditablePersonaFile(path: unknown): boolean;
  buildEditPayload(file: unknown, content: unknown): { file: string; content: string };
  byteLength(text: unknown): number;
  editHeaders(token: unknown): Record<string, string>;
  submitPersonaEdit(ctx: Any, file: string, content: string): Promise<EditResult>;
  editOutcome(result: unknown): EditOutcome;
  renderEditor(state: Record<string, unknown>): string;
  init(el: Any, ctx: Any): (() => void) | void;
}

/**
 * 走「变量拼接的动态 import」：页面件是原生 ESM 的 .js，字面量路径会让 tsc 去解析它，
 * 而这份测试关心的是"浏览器真正拿到并执行的那份字节"，交给运行期解析即可。
 */
const PAGE_MODULE: string = '../web/pages/persona.js';

/** 页面的 init 会碰 document：先把最小全局装上，再 import 页面件 */
const dom = installDom();

let page: PersonaPageModule;
let dir = '';
let server: WebServer;
let token = '';

before(async () => {
  page = (await import(PAGE_MODULE)) as unknown as PersonaPageModule;
  dir = mkdtempSync(join(tmpdir(), 'irmia-persona-page-'));
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'persona', 'RELATIONSHIPS'), { recursive: true });
  writeFileSync(join(dataDir, 'persona', 'STATE.md'), '# 当前状态\n\n旧内容\n', 'utf8');

  const loaded = await loadConfig(dir);
  const log = await EventLog.open(join(dataDir, 'events'));
  const timers = new TimerStore(join(dataDir, 'timers.json'));
  server = await startWebServer({
    log,
    projection: fold([]),
    config: loaded.config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers,
    now: () => new Date(),
    host: '127.0.0.1',
    port: 0,
    out: () => {},
  });
  token = server.token;
});

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

// ──────────────────────────────── ① 可编辑判定 ────────────────────────────────

describe('可编辑判定 · isEditablePersonaFile', () => {
  const EDITABLE = [
    'IDENTITY.md',
    'CONSTITUTION.md',
    'STYLE.md',
    'STATE.md',
    'RELATIONSHIPS/用户.md',
    'RELATIONSHIPS\\用户.md',
    '  STATE.md  ',
  ];

  const READONLY = [
    'proposals/IDENTITY.md',
    'PROPOSALS/STATE.md',
    'proposals/RELATIONSHIPS/x.md',
    'OTHER.md',
    'README.md',
    'State.md',
    'STATE.txt',
    '.STATE.md',
    'RELATIONSHIPS/',
    'RELATIONSHIPS/a/b.md',
    'RELATIONSHIPS/..',
    'RELATIONSHIPS/../STATE.md',
    '../STATE.md',
    'STATE.md/..',
    '',
    '   ',
  ];

  test('白名单内：顶层四个具名文件 + RELATIONSHIPS/ 下一级', () => {
    for (const path of EDITABLE) {
      assert.equal(page.isEditablePersonaFile(path), true, `${path} 应判为可编辑`);
    }
  });

  test('提案区、白名单外与穿越路径一律不可编辑', () => {
    for (const path of READONLY) {
      assert.equal(page.isEditablePersonaFile(path), false, `${path} 应判为不可编辑`);
    }
  });

  test('非字符串输入不炸，且判为不可编辑', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.equal(page.isEditablePersonaFile(value), false, `${String(value)} 应判为不可编辑`);
    }
  });
});

// ──────────────────────────────── ② 保存请求 ────────────────────────────────

describe('保存请求 · buildEditPayload / editHeaders / submitPersonaEdit', () => {
  test('请求体形状是 {file, content}，路径归一化与后端 safePersonaRel 同套', () => {
    assert.deepEqual(page.buildEditPayload('STATE.md', '# x\n'), { file: 'STATE.md', content: '# x\n' });
    assert.deepEqual(Object.keys(page.buildEditPayload('a', 'b')), ['file', 'content']);
    assert.equal(page.buildEditPayload(' RELATIONSHIPS\\用户.md ', 'x').file, 'RELATIONSHIPS/用户.md');
  });

  test('内容原样带去，不 trim（空白属于人格文件的内容）', () => {
    assert.equal(page.buildEditPayload('STATE.md', '  x  \n\n').content, '  x  \n\n');
  });

  test('请求头：Content-Type 与 Bearer 令牌', () => {
    assert.deepEqual(page.editHeaders('tok'), { 'Content-Type': 'application/json', Authorization: 'Bearer tok' });
    assert.deepEqual(page.editHeaders(''), { 'Content-Type': 'application/json' });
    assert.deepEqual(page.editHeaders(null), { 'Content-Type': 'application/json' });
  });

  test('走 POST /api/commands/persona-edit，体是 {file, content} 的 JSON', async () => {
    const ctx = makeCtx();
    const res = await page.submitPersonaEdit(ctx, 'STATE.md', '# 草稿\n');
    assert.equal(res.ok, true);
    assert.equal(ctx.calls.length, 1);
    const call = ctx.calls[0]!;
    assert.equal(call.path, '/api/commands/persona-edit');
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers['Content-Type'], 'application/json');
    assert.equal(call.opts.headers.Authorization, `Bearer ${ctx.token}`);
    assert.deepEqual(JSON.parse(call.opts.body), { file: 'STATE.md', content: '# 草稿\n' });
  });

  test('服务端拒绝不抛：原话进 error，交调用方去提示', async () => {
    const reason = '只允许编辑 IDENTITY.md / CONSTITUTION.md / STYLE.md / STATE.md 或 RELATIONSHIPS/<名字>.md';
    const ctx = makeCtx(() => new Error(reason));
    const res = await page.submitPersonaEdit(ctx, 'OTHER.md', 'x');
    assert.equal(res.ok, false);
    assert.equal(res.error, reason);
  });

  test('UTF-8 字节口径与后端 Buffer.byteLength 同尺', () => {
    assert.equal(page.byteLength('abc'), 3);
    assert.equal(page.byteLength('伊尔弥亚'), 12);
    assert.equal(page.byteLength(''), 0);
    assert.equal(page.byteLength(null), 0);
  });
});

// ──────────────────────────────── ③ 失败保留草稿 ────────────────────────────────

describe('失败保留草稿 · editOutcome / renderEditor', () => {
  test('成功才刷新；失败 keepDraft 为真（编辑区不动）', () => {
    const ok = page.editOutcome({ ok: true, data: { changed: true, diffHash: 'a1b2' }, error: null });
    assert.deepEqual(ok, { refresh: true, keepDraft: false, toast: '已保存', tone: 'ok' });

    const bad = page.editOutcome({ ok: false, data: null, error: '内容过大（70000 字节，上限 65536）' });
    assert.deepEqual(bad, {
      refresh: false,
      keepDraft: true,
      toast: '内容过大（70000 字节，上限 65536）',
      tone: 'danger',
    });
  });

  test('编辑器把草稿原样渲染进 textarea：失败后重绘也不丢人写的内容', () => {
    const html = page.renderEditor({ path: 'STATE.md', draft: '# 草稿\n第二行\n', base: '# 旧文\n', saving: false });
    assert.ok(html.includes('id="ps-editor"'), '应有编辑区');
    assert.ok(html.includes('# 草稿\n第二行'), '草稿正文应进 textarea');
    assert.ok(html.includes('id="ps-dirty"') && html.includes('未保存'), '脏状态应显示未保存');
    assert.ok(html.includes('>恢复原状<') && html.includes('>保存<'), '缺两个动作按钮');
    assert.ok(!/data-act="persona-save"[^>]*disabled/u.test(html), '有改动且未超限时保存应可用');
  });

  test('底部给字节数与上限；超限与空内容都禁用保存并说明', () => {
    const normal = page.renderEditor({ path: 'STATE.md', draft: '正文', base: '', saving: false });
    assert.ok(normal.includes('上限'), '字节行应说明上限');
    assert.ok(normal.includes(String(page.PERSONA_EDIT_MAX_BYTES)) || normal.includes('65,536'), '应给出上限数值');

    const over = page.renderEditor({
      path: 'STATE.md',
      draft: 'x'.repeat(page.PERSONA_EDIT_MAX_BYTES + 1),
      base: '',
      saving: false,
    });
    assert.ok(/data-act="persona-save"[^>]*disabled/u.test(over), '超限时保存应禁用');
    assert.ok(over.includes('超出上限'), '应说明超出上限');

    const blank = page.renderEditor({ path: 'STATE.md', draft: '   \n', base: 'x', saving: false });
    assert.ok(/data-act="persona-save"[^>]*disabled/u.test(blank), '空内容时保存应禁用');
    assert.ok(blank.includes('内容为空'), '应说明内容为空');
  });

  test('核心文件出警示行；普通文件不警示', () => {
    const core = page.renderEditor({ path: 'IDENTITY.md', draft: 'x', base: 'x', reserved: true, saving: false });
    assert.ok(core.includes('核心文件'), '核心文件应有警示行');
    assert.ok(core.includes('仅人类可改'), '核心文件应有「仅人类可改」标记');
    assert.ok(core.includes('已同步'), '与基准一致时应显示已同步');

    const plain = page.renderEditor({ path: 'STATE.md', draft: 'x', base: 'x', saving: false });
    assert.ok(!plain.includes('核心文件'), '非核心文件不该出现警示行');
  });

  test('前导空行不被 HTML 解析吞掉（textarea 的首个换行规则）', () => {
    const html = page.renderEditor({ path: 'STATE.md', draft: '\n正文\n', base: '', saving: false });
    assert.ok(html.includes('>&#10;正文'), '首行换行应以 &#10; 保住');
  });
});

// ──────────────────────────────── ④ 页面渲染 ────────────────────────────────

const FILE_ENTRIES = [
  { path: 'IDENTITY.md', name: 'IDENTITY.md', bytes: 24, mtime: '2026-09-30T00:00:00.000Z', reserved: true, tokens: 12, proposalCount: 0, proposals: 0, isSeed: false },
  { path: 'STATE.md', name: 'STATE.md', bytes: 30, mtime: '2026-09-30T00:00:00.000Z', reserved: false, tokens: 15, proposalCount: 0, proposals: 0, isSeed: false },
  { path: 'RELATIONSHIPS/用户.md', name: '用户.md', bytes: 12, mtime: '2026-09-30T00:00:00.000Z', reserved: false, tokens: 6, proposalCount: 0, proposals: 0, isSeed: false },
  { path: 'OTHER.md', name: 'OTHER.md', bytes: 8, mtime: '2026-09-30T00:00:00.000Z', reserved: false, tokens: 4, proposalCount: 0, proposals: 0, isSeed: false },
];

const IDENTITY_TEXT = '# 我是谁\n\n伊尔弥亚。\n';

/** 端点桩：形状与 src/web/server.ts 的读端点对齐（首屏选中第一份 = IDENTITY.md） */
function personaHandler(path: string): Any {
  const bare = path.split('?')[0];
  if (bare === '/api/persona/files') {
    return { root: '/tmp/persona', files: FILE_ENTRIES, relationships: ['用户'], proposals: [] };
  }
  if (bare === '/api/persona/file') {
    return { path: 'IDENTITY.md', content: IDENTITY_TEXT, reserved: true, tokens: 12, bytes: 24, mtime: '2026-09-30T00:00:00.000Z' };
  }
  if (bare === '/api/persona/history') return { entries: [] };
  return undefined;
}

/** 真跑一遍页面的 init（用完必须 cleanup：定时器归壳管） */
async function bootPersona(): Promise<{ html: () => string; cleanup: () => void }> {
  dom.setHash('#/persona');
  dom.resetStorage();
  const el = dom.el;
  el.innerHTML = '';
  const ctx = makeCtx(personaHandler);
  const cleanup = page.init(el, ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    html: () => String(el.innerHTML),
    cleanup: typeof cleanup === 'function' ? cleanup : () => undefined,
  };
}

describe('页面渲染 · 文件树与编辑器', () => {
  test('文件树：可编辑文件带 16px 铅笔与「可编辑」tooltip，白名单外没有', async () => {
    const booted = await bootPersona();
    try {
      const html = booted.html();
      assert.equal([...html.matchAll(/class="ps-pencil"/gu)].length, 3, 'IDENTITY / STATE / RELATIONSHIPS 三行应带铅笔');
      assert.ok(html.includes('width="16"') && html.includes('height="16"'), '铅笔应是 16px');
      assert.equal([...html.matchAll(/<title>可编辑<\/title>/gu)].length, 3, 'tooltip 文案应是「可编辑」');
      assert.equal([...html.matchAll(/data-editable="true"/gu)].length, 3, '可编辑标记应落在行上');
      assert.equal([...html.matchAll(/data-editable="false"/gu)].length, 1, '白名单外的行不带铅笔');
    } finally {
      booted.cleanup();
    }
  });

  test('选中可编辑文件后渲染编辑器：工具栏 + 编辑区 + 字节上限 + 核心文件警示', async () => {
    const booted = await bootPersona();
    try {
      const html = booted.html();
      assert.ok(html.includes('id="ps-toolbar"'), '缺工具栏');
      assert.ok(html.includes('id="ps-editor"'), '缺编辑区');
      assert.ok(html.includes('>恢复原状<') && html.includes('>保存<'), '缺动作按钮');
      assert.ok(html.includes('# 我是谁'), '编辑区应载入服务端原文');
      assert.ok(html.includes('上限'), '字节行应给出上限');
      assert.ok(html.includes('核心文件'), 'IDENTITY.md 应出核心文件警示行');
      assert.ok(html.includes('id="ps-dirty"') && html.includes('已同步'), '刚载入应是已同步');
    } finally {
      booted.cleanup();
    }
  });
});

// ──────────────────────────────── ⑤ 端到端 ────────────────────────────────

/** 壳的 ctx.api 语义：401 抛 '401'（壳弹令牌门），其余错误抛服务端原话 */
function liveCtx(): Any {
  const calls: Array<{ path: string; opts: Any }> = [];
  return {
    token,
    calls,
    async api(path: string, opts: Any = {}): Promise<Any> {
      calls.push({ path, opts });
      const res = await fetch(`http://127.0.0.1:${server.port()}${path}`, opts);
      if (res.status === 401) throw new Error('401');
      const text = await res.text();
      let body: Any = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = text;
      }
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
  };
}

describe('端到端：页面函数打到真实 /api/commands/persona-edit', () => {
  test('保存：写盘生效 + 服务端报 changed', async () => {
    const res = await page.submitPersonaEdit(liveCtx(), 'STATE.md', '# 当前状态\n\n新内容\n');
    assert.equal(res.ok, true, `保存应成功：${res.error ?? ''}`);
    assert.equal(res.data.changed, true);
    assert.match(readFileSync(join(dir, 'data', 'persona', 'STATE.md'), 'utf8'), /新内容/u);
  });

  test('相同内容幂等：服务端报 changed:false，页面照旧提示「已保存」', async () => {
    const current = readFileSync(join(dir, 'data', 'persona', 'STATE.md'), 'utf8');
    const res = await page.submitPersonaEdit(liveCtx(), 'STATE.md', current);
    assert.equal(res.ok, true);
    assert.equal(res.data.changed, false);
    assert.equal(page.editOutcome(res).toast, '已保存');
  });

  test('越权文件：不吞错误、不抛，页面拿到服务端原话', async () => {
    const res = await page.submitPersonaEdit(liveCtx(), 'OTHER.md', 'x');
    assert.equal(res.ok, false);
    assert.match(String(res.error), /只允许编辑/u);
  });

  test('令牌无效：401 变成一句能照着做的话', async () => {
    const ctx = liveCtx();
    ctx.token = 'wrong-token';
    const res = await page.submitPersonaEdit(ctx, 'STATE.md', 'x');
    assert.equal(res.ok, false);
    assert.match(String(res.error), /访问令牌无效/u);
  });
});

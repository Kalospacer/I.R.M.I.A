/**
 * web/app.js 无头冒烟 —— 在最小 DOM 桩上把前端真跑一遍
 *
 * 用法：node scripts/smoke-web.mjs
 *
 * 它补的是 test/web-assets.test.ts 管不到的层面：那份测试只断言“字节是对的”，这份冒烟验证
 * “代码跑得起来”——boot → 四页渲染 → 写通道 → 确认框 → 预算弹层 → 重放 → SSE 帧合入。
 * 任何未被桩覆盖的浏览器 API 会直接报错，这正是想要的效果。
 */

// app.js 用 instanceof Element 判断事件目标；浏览器有这些全局类，node 里补上
class Element {}
globalThis.Element = Element;

class El extends Element {
  constructor(tag = 'div') {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.id = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this._html = '';
    this.classList = { add() {}, remove() {}, contains: () => false };
  }

  set innerHTML(v) {
    this._html = String(v);
  }

  get innerHTML() {
    return this._html;
  }

  addEventListener(type, fn) {
    this._handlers = Object.assign(this._handlers ?? {}, { [type]: fn });
  }
  removeEventListener() {}
  click() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  remove() {}
  closest() {
    return null;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  scrollIntoView() {}
  focus() {}
  get offsetWidth() {
    return 100;
  }
  get offsetHeight() {
    return 480;
  }
  get clientHeight() {
    return 480;
  }
  get scrollTop() {
    return 0;
  }
  set scrollTop(_v) {}
}

// 表单类元素继承 El：app.js 用 instanceof HTMLInputElement 分流事件
globalThis.HTMLInputElement = class HTMLInputElement extends El {};
globalThis.HTMLSelectElement = class HTMLSelectElement extends El {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement extends El {};
const INPUT_IDS = /(input|jump|from|to)$/u;

const registry = new Map();
const handlers = new Map();

globalThis.document = {
  documentElement: new El('html'),
  body: new El('body'),
  getElementById(id) {
    if (!registry.has(id)) {
      const el = INPUT_IDS.test(id) ? new globalThis.HTMLInputElement() : new El();
      el.id = id;
      registry.set(id, el);
    }
    return registry.get(id);
  },
  createElement: (tag) => new El(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(type, fn) {
    handlers.set(type, fn);
  },
};

globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener(type, fn) {
    handlers.set(`win:${type}`, fn);
  },
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

globalThis.CSS = { escape: (s) => String(s) };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });

let hash = '#/';
globalThis.location = {
  get hash() {
    return hash;
  },
  set hash(v) {
    hash = v;
    (handlers.get('hashchange') ?? handlers.get('win:hashchange'))?.();
  },
};

const projection = {
  lastSeq: 5, watermark: 4, pending: [{ wakeSeq: 3, source: 'timer', claimCount: 0 }],
  openTurn: { turn: 2, step: 1 }, openTools: [], needsReview: [{ callId: 'call-1', name: 'write_persona', at: '2026-02-10T10:00:00.000Z', sideEffect: 'idempotent', argsSummary: '{"file":"STYLE.md"}' }],
  budget: { tokensToday: 1200, tokensTodayHeavy: 800, tokensTodayLight: 400, cacheHitToday: 900, cacheMissToday: 300, tokensTask: 100, stepsThisTurn: 1, toolCallsThisStep: 0 },
  timers: [{ timerId: 't1', at: '2026-02-14T11:00:00.000Z' }], claimedByTurn: {}, intentions: [], todoList: [], jobs: {},
  waitingHuman: null, lastExhausted: {}, dedupeKeys: [], lastModelSuccessAt: null,
  firstEventAt: '2026-01-01T00:00:00.000Z', failStreak: 0, degraded: null, idleTicks: 0,
  lastWake: { source: 'timer', at: '2026-02-14T10:02:00.000Z' }, lastAssistantText: '今天的复盘做完了',
  lastAssistantAt: null, deadLetters: [{ inputSeq: 9, claimCount: 3, at: '2026-02-13T10:00:00.000Z' }],
  lastArchiveAt: '2026-01-20T00:00:00.000Z', pressure: 0.1,
};
const events = [
  { seq: 1, ts: '2026-02-14T10:00:00.000Z', type: 'session/start', data: { pid: 1, version: '0.1.0', schemaVersion: '1' }, visibility: 'internal' },
  { seq: 2, ts: '2026-02-14T10:01:00.000Z', type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'safe_read', arguments: '{"path":"a.md"}', sideEffect: 'none' }, visibility: 'model' },
  { seq: 3, ts: '2026-02-14T10:02:00.000Z', type: 'tool/result', data: { turn: 1, step: 1, callId: 'call-1', callSeq: 2, status: 'ok', content: '读数完成' }, visibility: 'model' },
  { seq: 4, ts: '2026-02-14T10:03:00.000Z', type: 'budget/consumed', data: { turn: 1, step: 1, lane: 'heavy', inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20 }, visibility: 'model' },
  { seq: 5, ts: '2026-02-14T10:04:00.000Z', type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' }, spoke: true }, visibility: 'model' },
];
const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: `2026-02-14T${String(i).padStart(2, '0')}:00Z`, tokens: i * 10, input: i * 8, output: i * 2, hit: i * 5, miss: i }));
// 与 src/web/server.ts 的 UNIMPLEMENTED_COMMANDS 一致：这些命令回 501 + 原因（不写假事件）
const UNIMPLEMENTED = {
  'dead-discard': 'schema 里还没有 input/discarded 事件类型',
  export: '日志导出属于运维模块（M6）的动作',
  backup: '备份快照属于运维模块（M6）的动作',
  'archive-now': '归档属于运维模块（M6）的动作',
  ping: '需要模型接入层（DsClient）注入',
};
const payloads = {
  '/api/projection': projection,
  // 形状逐字对齐 src/web/server.ts 的 DashboardView
  '/api/stats/dashboard': {
    generatedAt: '2026-02-14T10:05:00.000Z',
    state: 'running',
    stateText: 'Agent 正在值守',
    detail: 'turn 2 · 第 1 步 · 今天的复盘做完了',
    guardedDays: 43,
    nextWakeAt: '2026-02-14T11:00:00.000Z',
    tiles: { watermark: 4, pending: 1, tokensToday: 1200, cacheHitRate: 0.75, needsReview: 1, failStreak: 0 },
    budget: { tokensToday: 1200, heavy: 800, light: 400, cacheHit: 900, cacheMiss: 300 },
    lastWake: { source: 'timer', at: '2026-02-14T10:02:00.000Z' },
    openTurn: { turn: 2, step: 1 },
    lastAssistantText: '今天的复盘做完了',
    idleTicks: 0,
    degraded: null,
    waitingHuman: null,
    deadLetters: 1,
    suggestions: [{ id: 'archive-stale', level: 'info', text: '最近一次快照是 2026-01-20T00:00:00.000Z，已超过 7 天。' }],
    hourly,
    personaProposals: 1,
    empty: false,
    recent: events.map((ev) => ({ seq: ev.seq, ts: ev.ts, type: ev.type, visibility: ev.visibility, summary: `摘要 #${ev.seq}` })),
  },
  // 形状逐字对齐 src/web/server.ts 的 EventsPage
  '/api/events': { events, fromSeq: 1, nextFromSeq: 6, nextBeforeSeq: 1, lastSeq: 5, hasMore: false },
  // 形状逐字对齐 src/web/server.ts 的 BudgetView
  '/api/budget': {
    range: 'today',
    generatedAt: '2026-02-14T10:05:00.000Z',
    limitSource: 'file',
    today: { tokens: 1200, heavy: 800, light: 400, cacheHit: 900, cacheMiss: 300, hitRate: 0.75 },
    limits: { stepTools: 20, turnSteps: 30, taskTokens: 500000, dailyTokens: 2000000, softRatio: 0.8 },
    dailyTokens: 2000000,
    softRatio: 0.8,
    taskTokens: 500000,
    topUps: {},
    layers: [{ layer: 'daily', used: 1200, limit: 2000000, hardRatio: 0.0006, softLimit: 1600000, softRatio: 0.00075, over: false, soft: false }],
    hourly,
    daily: [{ date: '2026-02-14', tokens: 1200, heavy: 800, light: 400, hit: 900, miss: 300 }],
    turns: [{ turn: 1, input: 100, output: 20, hit: 80, miss: 20, hitRate: 0.8, durationMs: 900, reasonKind: 'completed' }],
    month: { tokens: 1000, turns: 2, avgPerTurn: 500 },
  },
  // 形状逐字对齐 src/web/server.ts 的 PersonaFilesView
  '/api/persona/files': {
    root: 'C:\\data\\persona',
    files: [
      { path: 'IDENTITY.md', name: 'IDENTITY.md', bytes: 200, mtime: '2026-02-01T00:00:00.000Z', reserved: true, tokens: 120, proposalCount: 0, proposals: 0, isSeed: false },
      { path: 'CONSTITUTION.md', name: 'CONSTITUTION.md', bytes: 180, mtime: '2026-02-01T00:00:00.000Z', reserved: true, tokens: 110, proposalCount: 0, proposals: 0, isSeed: false },
      { path: 'STYLE.md', name: 'STYLE.md', bytes: 150, mtime: '2026-02-10T00:00:00.000Z', reserved: false, tokens: 90, proposalCount: 1, proposals: 1, isSeed: false },
      { path: 'STATE.md', name: 'STATE.md', bytes: 80, mtime: '2026-02-12T00:00:00.000Z', reserved: false, tokens: 40, proposalCount: 0, proposals: 0, isSeed: false },
      { path: 'RELATIONSHIPS/用户.md', name: '用户.md', bytes: 90, mtime: '2026-02-12T00:00:00.000Z', reserved: false, tokens: 50, proposalCount: 0, proposals: 0, isSeed: false },
    ],
    relationships: ['用户'],
    proposals: ['STYLE.md'],
  },
  // 形状逐字对齐 readPersonaFileView
  '/api/persona/file': { path: 'IDENTITY.md', content: '# 我是谁\n\n- 名字\n**粗体**\n```\ncode\n```', bytes: 200, mtime: '2026-02-01T00:00:00.000Z', tokens: 120, reserved: false },
  '/api/persona/history': { entries: [{ seq: 5, ts: '2026-02-01T00:00:00.000Z', file: 'STYLE.md', by: 'agent', diffHash: 'abcdef1234567890' }] },
  '/api/config': { schemaVersion: 1, dataDir: 'C:\\data', timezone: 'Asia/Shanghai', models: { heavy: { model: 'deepseek-chat', baseUrl: 'x', apiKeyEnv: 'IRMIA_API_KEY' }, light: { model: 'deepseek-chat', baseUrl: 'x', apiKeyEnv: 'IRMIA_API_KEY' } }, budget: { stepTools: 20, turnSteps: 30, taskTokens: 500000, dailyTokens: 2000000, softRatio: 0.8, failStreakMax: 5 }, wake: { heartbeatBaselineMin: 30, idleBackoffMax: 8 }, persona: { compactionThresholdTokens: 32000, handoffBudgetTokens: 4096, handoffFoldTokens: 1024 }, paths: { workspaceAllowlist: ['C:\\ws'] }, tools: { destructiveEnabled: false }, alerts: { rateLimitMin: 30 } },
  // 形状逐字对齐 /api/doctor
  '/api/doctor': { dataDir: 'C:\\data', events: 5, badLines: 0, failures: [], skips: [], items: [{ id: 'lock', title: '锁一致', status: 'ok', ok: true, detail: '持有者一致' }] },
  // 形状逐字对齐 ReplayView
  '/api/replay': {
    turn: 1, step: 1, ts: '2026-02-14T10:01:00.000Z', origin: 'runtime/agent-loop',
    renderVersion: 'rv-abcdef123', personaHash: 'ph-abcdef123', configHash: 'ch-abcdef123',
    fingerprints: { renderVersion: 'rv-abcdef123', personaHash: 'ph-abcdef123', configHash: 'ch-abcdef123', currentPersonaHash: 'ph-fedcba999', personaChanged: true, configChanged: false },
    request: { instructions: '你是 Irmia', input: [] },
    messages: [{ role: 'system', content: '你是 Irmia' }, { role: 'user', content: 'x'.repeat(400) }],
    usage: { lane: 'heavy', model: 'deepseek-chat', inputTokens: 10, outputTokens: 2, cacheHitTokens: 8, cacheMissTokens: 2, durationMs: 900, finishReason: 'completed' },
  },
};

let streamController = null;
let calls = 0;
const paths = [];
globalThis.fetch = async (url) => {
  calls += 1;
  const path = String(url).split('?')[0];
  paths.push(String(url));
  if (path === '/api/events/stream') {
    const enc = new TextEncoder();
    // 不 close：保持长连接语义；后续用 pushFrame 按需推帧
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          streamController = c;
          c.enqueue(enc.encode('retry: 3000\n\n'));
        },
      }),
    };
  }
  // persona/file 的 path 以请求为准（真实后端会按 safePersonaRel 归一化后回填）
  if (path === '/api/persona/file') {
    const wanted = new URLSearchParams(String(url).split('?')[1] ?? '').get('path') ?? 'IDENTITY.md';
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        path: wanted,
        content: `# ${wanted}\n\n- 一条约定\n**粗体**\n\`\`\`\ncode\n\`\`\``,
        bytes: 200,
        mtime: '2026-02-01T00:00:00.000Z',
        tokens: 120,
        reserved: wanted === 'IDENTITY.md' || wanted === 'CONSTITUTION.md',
      }),
    };
  }
  // 写命令：未实现的回 501 + 原因，其余回成功体（真实服务会写事件，这里只验证通道）
  if (path.startsWith('/api/commands/')) {
    const name = path.slice('/api/commands/'.length);
    const reason = UNIMPLEMENTED[name];
    if (reason !== undefined) {
      return {
        ok: false,
        status: 501,
        text: async () => JSON.stringify({ error: { code: 'not-implemented', message: `命令 ${name} 尚未实现：${reason}` } }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, seq: 9, type: name }) };
  }
  const data = payloads[path];
  if (data === undefined) return { ok: false, status: 404, text: async () => '{"error":{"code":"not-found","message":"无此端点"}}' };
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
};

localStorage.setItem('irmia.ui.token', 'test-token');
await import(new URL('../web/app.js', import.meta.url).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);

function idOf(el) {
  return el && el._html ? el._html.length : 0;
}

const root = registry.get('page-root');
if (!root._html.includes('ov-tiles')) throw new Error('总览未渲染磁贴');
if (!root._html.includes('ov-banner')) throw new Error('总览未渲染待确认横幅');
if (!root._html.includes('ov-suggest')) throw new Error('总览未渲染建议区');

location.hash = '#/events';
await sleep(60);
if (!root._html.includes('ev-filter')) throw new Error('记录页未渲染过滤栏');
const spacer = registry.get('ev-spacer');
if ((spacer._html.match(/class="ev-row"/g) ?? []).length !== 5) throw new Error('虚拟滚动未渲染事件行');

location.hash = '#/persona';
await sleep(120);
if (!root._html.includes('ps-tree')) throw new Error('人格页未渲染文件树');

location.hash = '#/control';
await sleep(120);
if (!root._html.includes('ctl-nav')) throw new Error('管控页未渲染分组');

// ── 交互冒烟：用真实事件分派驱动各个 data-act 分支 ──
function clickAct(act, data = {}) {
  const el = new El('button');
  el.dataset = Object.assign({ act }, data);
  el.closest = (sel) => (sel === '[data-act]' ? el : null);
  const handler = handlers.get('click');
  if (!handler) throw new Error('click 处理器未注册');
  handler({ target: el, preventDefault() {} });
  return el;
}

async function step(label, fn) {
  try {
    await fn();
    await sleep(40);
  } catch (err) {
    throw new Error(`${label} 抛错：${err?.stack ?? err}`);
  }
}

await step('立即唤醒', () => clickAct('wake'));
await step('预算弹层', () => clickAct('open-budget'));
await step('抽屉切换 7d', () => clickAct('drawer-range', { range: '7d' }));
if (!registry.get('drawer-data')._html.includes('lane-card')) throw new Error('预算弹层未渲染双 lane 顶卡');
if (!registry.get('drawer-data')._html.includes('<svg')) throw new Error('预算弹层未渲染 24h SVG');
await step('去人格页选文件', async () => {
  clickAct('goto-persona');
  await sleep(60);
  clickAct('persona-file', { path: 'STYLE.md' });
});
await sleep(60);
if (!registry.get('page-root')._html.includes('待批提案')) throw new Error('人格页未渲染提案区');
if (!registry.get('page-root')._html.includes('仅人类可改')) throw new Error('人格页未标记保留位');
await step('查看提案正文', () => clickAct('persona-proposal-view', { file: 'STYLE.md' }));
await step('批准提案（命令级短语为 null，不弹框）', async () => {
  document.getElementById('confirm-dialog').hidden = true;
  clickAct('persona-approve', { file: 'STYLE.md', hash: '' });
  await sleep(40);
  if (document.getElementById('confirm-dialog').hidden !== true) throw new Error('persona-approve 不应要求确认短语');
});
await step('人格 diff', () => clickAct('persona-diff', { file: 'STYLE.md', hash: 'abcdef12' }));
await step('去工具组', () => clickAct('goto-tools'));
await step('doctor', () => clickAct('ctl-doctor'));
await sleep(80);
if (!registry.get('page-root')._html.includes('ctl-tools-grid')) throw new Error('工具组未渲染');
await step('能力组', () => clickAct('ctl-group', { group: 'capability' }));
await sleep(40);
if (!registry.get('page-root')._html.includes('destructive 工具总开关')) throw new Error('能力组未渲染 toggle 行');
await step('切 destructive 触发确认框', () => clickAct('ctl-toggle', { path: 'tools.destructiveEnabled' }));
if (document.getElementById('confirm-dialog').hidden !== false) throw new Error('危险操作未弹确认框');
if (document.getElementById('confirm-phrase').textContent !== 'enable-destructive') throw new Error('确认框未展示短语原文');
const phraseInput = document.getElementById('confirm-phrase-input');
phraseInput.value = 'enable-destructive';
handlers.get('input')({ target: phraseInput });
if (document.getElementById('confirm-ok').disabled !== false) throw new Error('短语一致后执行键应可用');
await step('确认执行（即刻写入草稿，不发请求）', () => document.getElementById('confirm-ok').onclick?.());
await step('保存配置（只带字段级短语）', async () => {
  document.getElementById('confirm-dialog').hidden = true;
  clickAct('ctl-save');
  if (document.getElementById('confirm-dialog').hidden !== false) throw new Error('config-update 未弹确认框');
  const want = document.getElementById('confirm-phrase').textContent;
  if (want !== 'enable-destructive') throw new Error(`字段级危险短语不对：${want}`);
  const input = document.getElementById('confirm-phrase-input');
  input.value = want;
  handlers.get('input')({ target: input });
  document.getElementById('confirm-ok').onclick?.();
});
// 未接本服务的动作：照发请求，服务端回 501 + 原因（不写假事件）
await step('死信丢弃（501 + 原因）', async () => {
  document.getElementById('confirm-dialog').hidden = true;
  clickAct('dead-discard', { seq: '9' });
  await sleep(40);
  if (document.getElementById('confirm-dialog').hidden !== true) throw new Error('dead-discard 不应弹确认框');
  const toasts = document.getElementById('toast-host').children.map((child) => child.textContent).join(' | ');
  if (!toasts.includes('尚未实现')) throw new Error('服务端的 501 原因未如实展示');
});
await step('死信重投', async () => {
  document.getElementById('confirm-dialog').hidden = true;
  clickAct('dead-requeue', { seq: '9' });
  await sleep(40);
  if (document.getElementById('confirm-dialog').hidden !== true) throw new Error('requeue 不应要求确认短语');
});
await step('待确认结案', async () => {
  document.getElementById('confirm-dialog').hidden = true;
  clickAct('review-resolve', { call: 'call-1', outcome: 'succeeded' });
  await sleep(40);
  if (document.getElementById('confirm-dialog').hidden !== true) throw new Error('review-resolve 不应要求确认短语');
});
await step('取消定时器', async () => {
  document.getElementById('confirm-dialog').hidden = true;
  clickAct('timer-cancel', { id: 't1' });
  await sleep(40);
  if (document.getElementById('confirm-dialog').hidden !== true) throw new Error('timer-cancel 不应要求确认短语');
});
await step('忽略建议', () => clickAct('suggest-dismiss', { id: 'archive-stale' }));
await step('主题切暗', () => clickAct('ctl-theme', { themeValue: 'dark' }));
if (document.documentElement.dataset.theme !== 'dark') throw new Error('主题未切换');
await step('工具动作', async () => {
  clickAct('ctl-export');
  clickAct('ctl-backup');
  clickAct('ctl-archive');
  clickAct('ctl-webhook-test');
  clickAct('ctl-ping');
});
await step('记录页展开 + 重放 + 复制 + 导出', async () => {
  clickAct('goto-events');
  await sleep(60);
  clickAct('ev-row', { seq: '2' });
  await sleep(80);
  const spacer = registry.get('ev-spacer');
  if (!spacer._html.includes('ev-expand')) throw new Error('展开行未渲染');
  if (!spacer._html.includes('重放此 step')) throw new Error('展开行未提供重放入口');
  if (!spacer._html.includes('render ')) throw new Error('重放态未渲染三指纹');
  clickAct('ev-copy', { seq: '2' });
  clickAct('ev-diff', { turn: '1', step: '1' });
  clickAct('ev-export-json', { turn: '1', step: '1' });
});
await step('seq 跳转与过滤', async () => {
  const jump = document.getElementById('ev-jump-input');
  jump.value = '3';
  clickAct('ev-jump');
  await sleep(60);
  clickAct('ev-clear-filter');
  clickAct('ev-reload');
  clickAct('ev-earlier');
  clickAct('ev-follow', { checked: true });
});
await step('重试入口', async () => {
  clickAct('ctl-reload');
  clickAct('retry-overview');
  clickAct('persona-reload');
  clickAct('drawer-retry');
});

await step('SSE 推一帧', async () => {
  location.hash = '#/events';
  await sleep(80);
  const spacer = registry.get('ev-spacer');
  const count = () => (spacer._html.match(/class="ev-row"/g) ?? []).length;
  const before = count();
  if (streamController === null) throw new Error('SSE 流未建立');
  streamController.enqueue(
    new TextEncoder().encode(
      'event: tool/call\nid: 6\ndata: {"seq":6,"ts":"2026-02-14T10:05:00.000Z","type":"tool/call","data":{"turn":1,"step":2,"callId":"call-2","name":"write_file","arguments":"{}","sideEffect":"idempotent"},"visibility":"model"}\n\n',
    ),
  );
  await sleep(80);
  if (count() !== before + 1) throw new Error(`SSE 帧未合入事件流（${before} → ${count()}）`);
  if (!spacer._html.includes('data-new="true"')) throw new Error('SSE 新行未标记淡入');
});

console.log('覆盖端点:', [...new Set(paths.map((p) => p.split('?')[0]))].join('  '));
console.log(`冒烟通过：四页渲染 + 写通道 + 确认框 + 预算弹层 + 重放 + SSE 帧合入（${calls} 次 fetch）`);
process.exit(0);

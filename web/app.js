/* Irmia 运维台前端 —— 收纳逻辑照 AstrBot WebUI：侧边栏少量一级入口（聊天 / 配置文件 / 插件 / */

// ──────────────────────────────── 常量 ────────────────────────────────

const BATCH = 200; // 事件流每批条数（契约：200/批）
const ROW_H = 40; // 记录页固定行高（虚拟滚动靠它算偏移）
const EXPAND_H = 240;
const TOKEN_KEY = 'irmia.ui.token';
const THEME_KEY = 'irmia.theme';
const DISMISS_KEY = 'irmia.suggest.dismissed';
const SKILL_IGNORE_KEY = 'irmia.skill.ignored';
const DISMISS_MS = 7 * 24 * 3600 * 1000;
const CLIP = 60;

const PAGES = [
{
id: 'config',
title: '配置文件',
sub: '模型、预算、通道与插件',
tabs: [
{ id: 'ai', label: 'AI 配置' },
{ id: 'platform', label: '平台配置' },
{ id: 'plugins', label: '插件配置' },
],
},
{
id: 'plugins',
title: '插件',
sub: '技能、MCP、Hook 与工具',
tabs: [
{ id: 'skills', label: '技能' },
{ id: 'mcp', label: 'MCP' },
{ id: 'hooks', label: 'Hook' },
{ id: 'tools', label: '工具行为' },
],
},
{
id: 'data',
title: '数据与日志',
sub: '统计、事件、日志与重放',
tabs: [
{ id: 'stats', label: '统计' },
{ id: 'events', label: '事件' },
{ id: 'logs', label: '日志' },
{ id: 'trace', label: '追踪' },
],
},
{ id: 'persona', title: '人格', sub: '她是谁、记得什么', tabs: [] },
{ id: 'more', title: '更多功能', sub: '导出、备份、归档与连通性', tabs: [] },
{
id: 'settings',
title: '设置',
sub: '界面、系统与关于',
tabs: [
{ id: 'ui', label: '界面' },
{ id: 'system', label: '系统' },
{ id: 'about', label: '关于' },
],
},
];

const PAGE_BY_ID = new Map(PAGES.map((page) => [page.id, page]));

function defaultTabOf(pageId) {
return PAGE_BY_ID.get(pageId)?.tabs[0]?.id ?? '';
}

const LEGACY_ROUTES = {
'': { page: 'data', tab: 'stats' },
overview: { page: 'data', tab: 'stats' },
control: { page: 'config', tab: 'ai' },
events: { page: 'data', tab: 'events' },
settings: { page: 'settings', tab: 'ui' },
};

/* 危险操作的 X-Confirm 短语表 —— 与 src/web/server.ts 的 CONFIRM_PHRASES 逐字对齐 */
const PHRASE = {
wake: null,
'review-resolve': null,
requeue: null,
'persona-approve': null,
'persona-reject': null,
'config-update': null,
'timer-cancel': null,
'webhook-test': null,
'skill-confirm': null,
};

/* 字段级危险标识 —— 与 src/web/server.ts 的 DANGEROUS_FIELDS 逐字对齐 */
const DANGEROUS_FIELDS = { 'tools.destructiveEnabled': 'enable-destructive' };

const EP = {
projection: '/api/projection',
dashboard: '/api/stats/dashboard',
events: '/api/events',
stream: '/api/events/stream',
budget: '/api/budget',
personaFiles: '/api/persona/files',
personaFile: '/api/persona/file',
personaHistory: '/api/persona/history',
replay: '/api/replay',
config: '/api/config',
doctor: '/api/doctor',
skills: '/api/skills',
mcp: '/api/mcp',
hooks: '/api/hooks',
alarms: '/api/alarms',
tools: '/api/tools',
cmd: (name) => `/api/commands/${name}`,
};

const DOMAIN_GROUPS = [
{ name: '生命周期', types: ['session/start', 'session/end', 'turn/start', 'turn/end', 'step/start', 'step/end'] },
{ name: '消息', types: ['message/user', 'message/assistant', 'message/reasoning', 'developer/message'] },
{ name: '工具', types: ['tool/call', 'tool/result', 'tool/zombie'] },
{ name: '唤醒与队列', types: ['wake/timer', 'wake/file', 'wake/webhook', 'wake/manual', 'wake/heartbeat', 'wake/intention', 'wake/job', 'timer/set', 'timer/fired', 'timer/cancelled', 'input/claimed', 'input/dead-letter', 'input/requeued'] },
{ name: '预算', types: ['budget/consumed', 'budget/rollover', 'budget/exhausted', 'budget/topped-up'] },
{ name: '策略与审计', types: ['policy/denied', 'log/repaired', 'instance/takeover', 'alarm/sent', 'review/resolved', 'snapshot/checkpoint', 'compaction/summary', 'persona/updated', 'config/changed'] },
{ name: '扩展面', types: ['mcp/server-started', 'mcp/server-stopped', 'skill/installed', 'hook/fired', 'speak/sent', 'intention/raised', 'intention/acted', 'todo/updated', 'job/started', 'job/finished', 'human/asked', 'human/answered', 'model/degraded', 'model/restored'] },
];

/* 六态顺序与取值 —— 与 src/web/server.ts 的 DashboardState 同名同序 */
const STATE_ORDER = ['needs-review', 'paused', 'degraded', 'running', 'sleeping', 'idle'];

const TRUST_LABEL = {
trusted: '已确认',
'never-confirmed': '未确认',
'agent-proposed': 'agent 自沉淀',
'content-changed': '确认后被改过',
};

const CFG_TABS = [
{
id: 'ai',
groups: [
{
id: 'models',
name: '模型',
fields: [
{ p: 'models.heavy.model', l: 'heavy 模型' },
{ p: 'models.heavy.baseUrl', l: 'heavy 端点' },
{ p: 'models.heavy.apiKeyEnv', l: 'heavy 密钥来源', k: 'secret' },
{ p: 'models.light.model', l: 'light 模型' },
{ p: 'models.light.baseUrl', l: 'light 端点' },
{ p: 'models.light.apiKeyEnv', l: 'light 密钥来源', k: 'secret' },
{ p: 'models.degraded.model', l: '降级链备用模型' },
{ p: 'models.degraded.baseUrl', l: '降级链端点' },
],
},
{
id: 'persona',
name: '人格',
fields: [
{ p: 'persona.compactionThresholdTokens', l: '压缩阈值（token）', k: 'number' },
{ p: 'persona.handoffBudgetTokens', l: '交接笔记总预算（token）', k: 'number' },
{ p: 'persona.handoffFoldTokens', l: '单条折叠满预算（token）', k: 'number' },
],
},
{
id: 'capability',
name: '能力',
fields: [
{ p: 'tools.destructiveEnabled', l: 'destructive 工具总开关', k: 'toggle' },
{ p: 'paths.workspaceAllowlist', l: '路径白名单', k: 'lines' },
{ p: 'paths.commandDenylist', l: '命令黑名单', k: 'lines', d: 1 },
{ p: 'paths.watchPaths', l: '文件监听路径', k: 'lines', d: 1 },
],
},
{
id: 'advanced',
name: '高级',
fields: [
{ p: 'budget.stepTools', l: '单步工具调用上限', k: 'number' },
{ p: 'budget.turnSteps', l: '单轮步数上限', k: 'number' },
{ p: 'budget.taskTokens', l: '单任务 token 上限', k: 'number' },
{ p: 'budget.dailyTokens', l: '每日 token 上限', k: 'number' },
{ p: 'budget.softRatio', l: '软阈值比例（0-1）', k: 'number' },
{ p: 'budget.failStreakMax', l: '连续失败上限', k: 'number' },
{ p: 'wake.heartbeatBaselineMin', l: '心跳基线间隔（分钟）', k: 'number' },
{ p: 'wake.idleBackoffMax', l: '空闲退避上限倍数', k: 'number' },
{ p: 'wake.heartbeatFloorMin', l: '心跳间隔下限（分钟）', k: 'number', h: '退避再深也不短于它；压力大时最多压到这个速度' },
{ p: 'wake.heartbeatCeilMin', l: '心跳间隔上限（分钟）', k: 'number', h: '安静再久也不超过它——超过一小时不露面，人会觉得她睡着了' },
{ p: 'speak.typingEffect', l: '发言打字节奏', k: 'toggle', h: '按"这段话要打多久"逐条发出，像人在打字；关掉则一次发完' },
{ p: 'speak.charsPerMinute', l: '打字速度（字/分钟）', k: 'number', h: '默认 90，中文手机输入的常见速度' },
{ p: 'tools.planMode', l: '计划模式', k: 'toggle', h: '开启后 destructive 调用先经人审' },
],
},
],
},
{
id: 'platform',
groups: [
{
id: 'channels',
name: '通道',
fields: [
{ p: 'channels.qqOfficial.enabled', l: 'QQ 官方 Bot 通道', k: 'toggle' },
{ p: 'channels.qqOfficial.appIdEnv', l: 'AppID 环境变量名' },
{ p: 'channels.qqOfficial.clientSecretEnv', l: 'ClientSecret 环境变量名', k: 'secret' },
{ p: 'channels.qqOfficial.apiBase', l: 'API 根地址' },
{ p: 'channels.onebot.enabled', l: 'OneBot 11 通道', k: 'toggle' },
{ p: 'channels.onebot.wsUrl', l: '协议端 ws 地址' },
{ p: 'channels.onebot.tokenEnv', l: 'access_token 环境变量名', k: 'secret' },
],
},
{
id: 'alerts',
name: '告警出口',
fields: [
{ p: 'alerts.webhookUrl', l: '告警出口 webhook' },
{ p: 'alerts.rateLimitMin', l: '同类告警限流窗口（分钟）', k: 'number' },
{ p: 'alerts.enabled', l: '告警总开关', k: 'toggle', d: 1 },
],
},
{
id: 'web',
name: '本地服务',
fields: [
{ p: 'web.host', l: '绑定地址', s: 1 },
{ p: 'web.port', l: '监听端口', k: 'number', s: 1 },
{ p: 'dataDir', l: '数据目录', s: 1 },
{ p: 'timezone', l: '时区', s: 1 },
{ p: 'schemaVersion', l: '配置 schema 版本', k: 'number', s: 1 },
],
},
],
},
{ id: 'plugins', groups: [{ id: 'toolset', name: 'destructive 工具开关集', k: 'toolset' }] },
];

// ──────────────────────────────── 全局状态 ────────────────────────────────

const S = {
token: null,
theme: 'light',
page: 'config',
tab: 'ai',
query: new URLSearchParams(),
proj: null,
projError: null,
projLoading: true,
dash: null,
dashError: null,
dashLoading: true,
events: [],
seqIndex: new Map(),
evLoading: true,
evError: null,
evCursor: null,
filters: { types: new Set(), visibility: 'all', follow: true },
openSeq: null,
newSeqs: new Set(),
newCount: 0,
replay: null,
replayError: null,
persona: { view: null, files: null, filesError: null, filesLoading: false, cur: null, curError: null, curLoading: false, hist: null, histError: null, histLoading: false },
ctl: { cfg: null, cfgError: null, cfgLoading: false, draft: new Map(), reveal: new Set() },
skills: { data: null, error: null, loading: false, ignored: new Set() },
mcp: { data: null, error: null, loading: false },
hooks: { data: null, error: null, loading: false },
alarms: { data: null, error: null, loading: false, cur: null, curError: null, curLoading: false },
tools: { data: null, error: null, loading: false },
doctor: { data: null, error: null, loading: false },
budget: { range: 'today', data: null, error: null, loading: false },
trace: { turn: '', step: '' },
dismissed: new Set(),
sse: { online: false, lastSeq: 0, retry: 3000, abort: null, everConnected: false },
};

// ──────────────────────────────── 工具函数 ────────────────────────────────

/* 所有动态文本必须先过这里（事件内容来自外部输入，一律当不可信数据） */
function sv(v) {
return esc(String(v ?? ''));
}

function esc(value) {
return String(value ?? '')
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

function clip(text, max = CLIP) {
const s = String(text ?? '').replace(/\s+/g, ' ');
return s.length > max ? `${s.slice(0, max)}…` : s;
}

function icon(id, cls = 'icon') {
return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function num(value, fallback = '—') {
return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : fallback;
}

function pct(value) {
return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function timeOf(iso) {
const d = new Date(String(iso));
return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

function stampOf(iso) {
const d = new Date(String(iso));
return Number.isNaN(d.getTime()) ? '未知时刻' : d.toLocaleString('zh-CN', { hour12: false });
}

function daysSince(iso) {
const d = new Date(String(iso));
if (Number.isNaN(d.getTime())) return null;
return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function nextTimerAt(proj) {
const list = (proj?.timers ?? []).map((t) => t?.at).filter((at) => typeof at === 'string').sort();
return list.length > 0 ? list[0] : null;
}

function getPath(obj, path) {
return path.split('.').reduce((cur, key) => (cur !== null && typeof cur === 'object' ? cur[key] : undefined), obj);
}

function setPath(obj, path, value) {
const keys = path.split('.');
let cur = obj;
for (let i = 0; i < keys.length - 1; i += 1) {
const key = keys[i];
if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {};
cur = cur[key];
}
cur[keys[keys.length - 1]] = value;
}

function sleep(ms) {
return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDismissed() {
try {
const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}');
const now = Date.now();
return new Set(Object.keys(raw).filter((key) => typeof raw[key] === 'number' && raw[key] > now));
} catch {
return new Set();
}
}

function saveDismissed() {
const out = {};
for (const key of S.dismissed) out[key] = Date.now() + DISMISS_MS;
localStorage.setItem(DISMISS_KEY, JSON.stringify(out));
}

function loadIgnored() {
try {
const raw = JSON.parse(localStorage.getItem(SKILL_IGNORE_KEY) ?? '[]');
return new Set(Array.isArray(raw) ? raw.map((item) => String(item)) : []);
} catch {
return new Set();
}
}

function saveIgnored() {
localStorage.setItem(SKILL_IGNORE_KEY, JSON.stringify([...S.skills.ignored]));
}

// ──────────────────────────────── 渲染基元 ────────────────────────────────

function tabRoot(page, tab) {
const root = document.getElementById('tab-root');
if (!root) return null;
return page !== undefined && !atTab(page, tab) ? null : root;
}

function ch(title, right = '') {
return `<div class="card-head"><h3 class="card-title">${title}</h3>${right}</div>`;
}

function slots(o = {}) {
const retry = o.retry ? `<button class="btn" data-act="${esc(o.retry)}">重试</button>` : '';
const act = o.emptyAct ? `<button class="btn btn-primary" data-act="${esc(o.emptyAct.act)}">${esc(o.emptyAct.label)}</button>` : '';
return `<div class="st-line" data-slot="loading">${icon('i-refresh')}<span>${esc(o.loading ?? '正在读取…')}</span></div>
<div class="st-line st-error" data-slot="error">${icon('i-alert')}<span class="st-msg">${esc(o.error ?? '读取失败')}</span>${retry}</div>
<div class="st-empty" data-slot="empty">${icon(o.emptyIcon ?? 'i-info', 'icon icon-lg')}<div class="st-title">${esc(o.emptyTitle ?? '还没有数据')}</div><p>${esc(o.emptyHint ?? '')}</p>${act}</div>
<div data-slot="data">${o.slot ?? ''}</div>`;
}

function blockCard(id, title, right, state, opts = {}) {
return `<div class="card block" data-state="${state}" id="${esc(id)}">${ch(title, right)}${slots(opts)}</div>`;
}

function stateOf(loading, error, empty, hasData) {
if (loading && !hasData) return 'loading';
if (error && !hasData) return 'error';
return hasData ? 'data' : 'empty';
}

function section(state, slot, opts = {}) {
const loading = opts.loading ?? '正在读取…';
const error = opts.error ?? '读取失败';
const retry = opts.retry ? `<button class="btn" data-act="${esc(opts.retry)}">重试</button>` : '';
const emptyIcon = opts.emptyIcon ?? 'i-info';
const emptyTitle = opts.emptyTitle ?? '还没有数据';
const emptyHint = opts.emptyHint ?? '等第一条事件写进来就有了。';
const emptyAction = opts.emptyAction ? `<button class="btn btn-primary" data-act="${esc(opts.emptyAction.act)}">${esc(opts.emptyAction.label)}</button>` : '';
const idAttr = opts.id ? ` id="${esc(opts.id)}"` : '';
return `<div class="block ${opts.cls ?? ''}" data-state="${state}"${idAttr}>
<div class="st-line" data-slot="loading">${icon('i-refresh')}<span>${esc(loading)}</span></div>
<div class="st-line st-error" data-slot="error">${icon('i-alert')}<span class="st-msg">${esc(error)}</span>${retry}</div>
<div class="st-empty" data-slot="empty">${icon(emptyIcon, 'icon icon-lg')}<div class="st-title">${esc(emptyTitle)}</div><p>${esc(emptyHint)}</p>${emptyAction}</div>
<div data-slot="data">${slot}</div>
</div>`;
}

// ──────────────────────────────── API 层 ────────────────────────────────

function authHeaders(extra) {
const headers = Object.assign({ Accept: 'application/json' }, extra ?? {});
if (S.token) headers.Authorization = `Bearer ${S.token}`;
return headers;
}

async function api(path, opts = {}) {
const init = { method: opts.method ?? 'GET', headers: authHeaders(opts.headers) };
if (opts.body !== undefined) {
init.headers['Content-Type'] = 'application/json';
init.body = JSON.stringify(opts.body);
}
// X-Confirm 是短语列表（`; ` 分隔）：命令级必给，字段级危险短语由 config-update 追加
const phrases = Array.isArray(opts.confirm) ? opts.confirm.filter(Boolean) : opts.confirm ? [opts.confirm] : [];
if (phrases.length > 0) init.headers['X-Confirm'] = phrases.join('; ');
let res;
try {
res = await fetch(path, init);
} catch (err) {
return { ok: false, status: 0, error: { code: 'network', message: `连不上本地服务：${String(err?.message ?? err)}` } };
}
const text = await res.text();
let data = null;
try {
data = text === '' ? null : JSON.parse(text);
} catch {
data = null;
}
if (res.status === 401) {
setToken(null);
return { ok: false, status: 401, error: { code: 'unauthorized', message: '令牌无效或已重置，请重新粘贴' } };
}
if (!res.ok) {
const err = data && typeof data === 'object' && data.error ? data.error : { code: `http-${res.status}`, message: res.statusText || '请求失败' };
return { ok: false, status: res.status, error: err };
}
return { ok: true, status: res.status, data };
}

function setToken(token) {
S.token = token;
if (token) localStorage.setItem(TOKEN_KEY, token);
else localStorage.removeItem(TOKEN_KEY);
renderGate();
}

/* 写命令：成功后按钮变勾 240ms + toast，并立即重拉投影（与 CLI 同一条写事件通道） */
async function command(name, payload, opts = {}) {
const res = await api(EP.cmd(name), { method: 'POST', body: payload, confirm: opts.confirm });
if (res.ok) {
flashOk(opts.btn);
toast(opts.done ?? '已生效并落日志');
void loadProjection();
return true;
}
toast(res.error?.message ?? '操作失败', 'danger');
return false;
}

/* 带确认短语的写命令：短语取自 PHRASE（与 server 的 CONFIRM_PHRASES 同一张表） */
function writeCommand(name, payload, opts = {}) {
const base = PHRASE[name] ?? null;
const extra = (opts.fieldPhrases ?? []).filter(Boolean);
const phrases = base === null ? extra : [base, ...extra];
if (phrases.length === 0) return command(name, payload, { btn: opts.btn, done: opts.done });
return openConfirm({
title: opts.title ?? '确认操作',
body: opts.body ?? '确认短语会原样发给本地服务。',
phrase: phrases.join('; '),
okLabel: opts.okLabel ?? '执行',
onOk: () => command(name, payload, { btn: opts.btn, done: opts.done, confirm: phrases }),
});
}

function flashOk(btn) {
if (!btn) return;
btn.dataset.done = 'true';
setTimeout(() => {
delete btn.dataset.done;
}, 240);
}

function toast(message, tone = 'ok') {
const host = document.getElementById('toast-host');
if (!host) return;
const el = document.createElement('div');
el.className = 'toast';
el.dataset.tone = tone;
el.textContent = message;
host.appendChild(el);
setTimeout(() => el.remove(), 4000);
}

// ──────────────────────────────── 数据加载 ────────────────────────────────

async function loadProjection() {
const res = await api(EP.projection);
if (res.ok && res.data && typeof res.data === 'object') {
S.proj = res.data;
S.projError = null;
} else {
S.projError = res.error?.message ?? '投影读取失败';
}
S.projLoading = false;
renderRailBadges();
if (atTab('data', 'stats')) renderStatsTab();
if (S.page === 'settings') renderSettingsTab();
}

async function loadDashboard() {
const res = await api(EP.dashboard);
if (res.ok && res.data && typeof res.data === 'object') {
S.dash = res.data;
S.dashError = null;
} else {
S.dashError = res.error?.message ?? 'dashboard 读取失败';
}
S.dashLoading = false;
if (atTab('data', 'stats')) renderStatsTab();
}

let refreshTick = 0;
function refreshSoon() {
if (refreshTick) return;
refreshTick = setTimeout(() => {
refreshTick = 0;
void loadProjection();
}, 800);
}

function mergeEvents(list) {
let added = 0;
for (const ev of list) {
if (!ev || typeof ev !== 'object' || typeof ev.seq !== 'number') continue;
if (S.seqIndex.has(ev.seq)) continue;
S.seqIndex.set(ev.seq, ev);
S.events.push(ev);
if (ev.seq > S.sse.lastSeq) S.sse.lastSeq = ev.seq;
added += 1;
}
if (added > 0) S.events.sort((a, b) => a.seq - b.seq);
return added;
}

async function loadEvents(opts = {}) {
const q = new URLSearchParams();
const types = [...S.filters.types];
if (types.length > 0) q.set('types', types.join(','));
if (S.filters.visibility !== 'all') q.set('visibility', S.filters.visibility);
q.set('limit', String(opts.limit ?? BATCH));
if (opts.fromSeq !== undefined && typeof opts.fromSeq === 'number') q.set('from_seq', String(opts.fromSeq));
if (typeof opts.cursor === 'number') q.set('from_seq', String(opts.cursor));

if (opts.reset) {
S.evLoading = true;
S.evError = null;
if (atTab('data', 'events')) paintEvents();
}
const res = await api(`${EP.events}?${q.toString()}`);
S.evLoading = false;
if (!res.ok) {
S.evError = res.error?.message ?? '事件读取失败';
} else {
const payload = res.data;
const list = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
if (opts.reset) {
S.events = [];
S.seqIndex = new Map();
}
mergeEvents(list);
S.evError = null;
S.evCursor = typeof payload?.nextBeforeSeq === 'number' ? payload.nextBeforeSeq : null;
}
renderRailBadges();
if (atTab('data', 'events')) paintEvents();
if (atTab('data', 'stats')) renderStatsTab();
if (atTab('data', 'trace')) renderTraceTab();
}

async function loadBudget() {
S.budget.loading = true;
S.budget.error = null;
paintBudgetTab();
const res = await api(`${EP.budget}?range=${encodeURIComponent(S.budget.range)}`);
S.budget.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.budget.data = res.data;
S.budget.error = null;
} else {
S.budget.error = res.error?.message ?? '预算读取失败';
}
paintBudgetTab();
}

function paintBudgetTab() {
if (!atTab('data', 'stats')) return;
const host = document.getElementById('stat-budget');
if (!host) {
renderStatsTab();
return;
}
host.innerHTML = budgetCardHtml();
}

async function loadPersonaFiles() {
S.persona.filesLoading = true;
if (S.page === 'persona') renderPersonaTab();
const res = await api(EP.personaFiles);
S.persona.filesLoading = false;
if (!res.ok) {
S.persona.filesError = res.error?.message ?? '文件树读取失败';
} else {
const payload = res.data;
const list = Array.isArray(payload) ? payload : Array.isArray(payload?.files) ? payload.files : [];
S.persona.view = payload && typeof payload === 'object' ? payload : null;
S.persona.files = list.map((item) => (typeof item === 'string' ? { path: item } : item));
S.persona.filesError = null;
if (S.persona.cur === null && S.persona.files.length > 0) void selectPersonaFile(S.persona.files[0].path);
}
renderRailBadges();
if (S.page === 'persona') renderPersonaTab();
}

async function selectPersonaFile(path) {
S.persona.cur = { path };
S.persona.curLoading = true;
S.persona.curError = null;
if (S.page === 'persona') renderPersonaTab();
const res = await api(`${EP.personaFile}?path=${encodeURIComponent(path)}`);
S.persona.curLoading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.persona.cur = Object.assign({ path }, res.data);
S.persona.curError = null;
} else {
S.persona.curError = res.error?.message ?? '文件读取失败';
}
if (S.page === 'persona') renderPersonaTab();
}

async function loadPersonaHistory() {
S.persona.histLoading = true;
if (S.page === 'persona') renderPersonaTab();
const res = await api(EP.personaHistory);
S.persona.histLoading = false;
if (!res.ok) {
S.persona.histError = res.error?.message ?? '演化时间线读取失败';
} else {
const payload = res.data;
S.persona.hist = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : [];
S.persona.histError = null;
}
if (S.page === 'persona') renderPersonaTab();
}

async function loadConfig() {
S.ctl.cfgLoading = true;
if (S.page === 'config') renderConfigTab();
const res = await api(EP.config);
S.ctl.cfgLoading = false;
if (!res.ok) {
S.ctl.cfgError = res.error?.message ?? '配置读取失败';
} else {
S.ctl.cfg = res.data && typeof res.data === 'object' ? res.data : {};
S.ctl.cfgError = null;
S.ctl.draft = new Map();
}
renderRailBadges();
renderSaveFab();
if (S.page === 'config') renderConfigTab();
if (S.page === 'settings') renderSettingsTab();
}

async function loadReplay(turn, step) {
S.replay = null;
S.replayError = null;
if (atTab('data', 'trace')) renderTraceTab();
const res = await api(`${EP.replay}?turn=${encodeURIComponent(turn)}&step=${encodeURIComponent(step)}`);
if (res.ok && res.data && typeof res.data === 'object') S.replay = res.data;
else S.replayError = res.error?.message ?? '重放数据读取失败';
if (atTab('data', 'events')) paintEvents();
if (atTab('data', 'trace')) renderTraceTab();
}

/* 工具组的不变量自检（与 CLI 的 doctor 同一个 runDoctor），面板住在「数据与日志 · 日志」 */
async function runDoctor() {
S.doctor.loading = true;
S.doctor.error = null;
if (atTab('data', 'logs')) renderAlarmsTab();
const res = await api(EP.doctor);
S.doctor.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.doctor.data = Array.isArray(res.data) ? res.data : Array.isArray(res.data.items) ? res.data.items : [];
S.doctor.error = null;
} else {
S.doctor.error = res.error?.message ?? 'doctor 读取失败';
}
if (atTab('data', 'logs')) renderAlarmsTab();
}

/* 插件页 · 技能：目录扫描 + 信任门裁决（与 CLI 的 skill list 同一个 SkillManager 的口径） */
async function loadSkills() {
S.skills.loading = true;
if (atTab('plugins', 'skills')) renderSkillsTab();
const res = await api(EP.skills);
S.skills.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.skills.data = res.data;
S.skills.error = null;
} else {
S.skills.error = res.error?.message ?? '技能目录读取失败';
}
renderRailBadges();
if (atTab('plugins', 'skills')) renderSkillsTab();
}

async function loadMcp() {
S.mcp.loading = true;
if (atTab('plugins', 'mcp')) renderMcpTab();
const res = await api(EP.mcp);
S.mcp.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.mcp.data = res.data;
S.mcp.error = null;
} else {
S.mcp.error = res.error?.message ?? 'MCP 状态读取失败';
}
renderRailBadges();
if (atTab('plugins', 'mcp')) renderMcpTab();
}

async function loadHooks() {
S.hooks.loading = true;
if (atTab('plugins', 'hooks')) renderHooksTab();
const res = await api(EP.hooks);
S.hooks.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.hooks.data = res.data;
S.hooks.error = null;
} else {
S.hooks.error = res.error?.message ?? '钩子配置读取失败';
}
renderRailBadges();
if (atTab('plugins', 'hooks')) renderHooksTab();
}

async function loadTools() {
S.tools.loading = true;
if (atTab('plugins', 'tools')) renderToolBehaviorTab();
const res = await api(EP.tools);
S.tools.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.tools.data = res.data;
S.tools.error = null;
} else {
S.tools.error = res.error?.message ?? '工具清单读取失败';
}
if (atTab('plugins', 'tools')) renderToolBehaviorTab();
if (atTab('config', 'plugins')) renderConfigTab();
}

async function loadAlarms() {
S.alarms.loading = true;
if (atTab('data', 'logs')) renderAlarmsTab();
const res = await api(EP.alarms);
S.alarms.loading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.alarms.data = res.data;
S.alarms.error = null;
} else {
S.alarms.error = res.error?.message ?? '告警目录读取失败';
}
if (atTab('data', 'logs')) renderAlarmsTab();
}

async function selectAlarm(name) {
S.alarms.cur = { name };
S.alarms.curLoading = true;
S.alarms.curError = null;
if (atTab('data', 'logs')) renderAlarmsTab();
const res = await api(`${EP.alarms}?file=${encodeURIComponent(name)}`);
S.alarms.curLoading = false;
if (res.ok && res.data && typeof res.data === 'object') {
S.alarms.cur = res.data;
S.alarms.curError = null;
} else {
S.alarms.curError = res.error?.message ?? '告警文件读取失败';
}
if (atTab('data', 'logs')) renderAlarmsTab();
}

// ──────────────────────────────── SSE 实时推送 ────────────────────────────────

function setOnline(online) {
S.sse.online = online;
const dot = document.getElementById('conn-dot');
if (dot) {
dot.dataset.online = online ? 'true' : 'false';
dot.title = online ? '实时连接：在线' : '实时连接：重连中';
}
}

function handleFrame(frame) {
let name = 'message';
let id = null;
let retry = null;
const dataLines = [];
for (const raw of frame.split('\n')) {
if (raw === '' || raw.startsWith(':')) continue;
const idx = raw.indexOf(':');
const field = idx < 0 ? raw : raw.slice(0, idx);
const value = idx < 0 ? '' : raw.slice(idx + 1).replace(/^ /, '');
if (field === 'event') name = value;
else if (field === 'id') id = value;
else if (field === 'data') dataLines.push(value);
else if (field === 'retry') retry = Number(value);
}
if (retry !== null && Number.isFinite(retry) && retry > 0) S.sse.retry = retry;
if (dataLines.length === 0) return;

let payload = null;
const raw = dataLines.join('\n');
try {
payload = JSON.parse(raw);
} catch {
payload = { type: name, data: { raw } };
}
const seq = typeof payload?.seq === 'number' ? payload.seq : Number(id);
const type = typeof payload?.type === 'string' ? payload.type : name;
const event = typeof payload?.seq === 'number' ? payload : { seq, ts: new Date().toISOString(), type, data: payload?.data ?? {}, visibility: 'internal' };
if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) return;
if (event.type === undefined || event.type === null) event.type = type;
if (S.seqIndex.has(event.seq)) return;

S.newSeqs.add(event.seq);
S.events.push(event);
S.seqIndex.set(event.seq, event);
if (event.seq > S.sse.lastSeq) S.sse.lastSeq = event.seq;
S.newCount += 1;

if (REFRESH_TYPES.has(event.type)) refreshSoon();
if (event.type === 'persona/updated') renderRailBadges();

if (atTab('data', 'events')) paintEvents();
else if (atTab('data', 'stats')) renderStatsTab();
else if (atTab('data', 'trace')) renderTraceTab();
}

const REFRESH_TYPES = new Set([
'session/start', 'turn/start', 'turn/end', 'tool/result', 'budget/consumed', 'budget/exhausted',
'budget/rollover', 'budget/topped-up', 'review/resolved', 'persona/updated', 'config/changed',
'model/degraded', 'model/restored', 'input/dead-letter', 'input/requeued', 'input/claimed',
'timer/set', 'timer/fired', 'timer/cancelled', 'job/started', 'job/finished', 'human/asked', 'human/answered',
]);

async function startStream() {
for (;;) {
if (!S.token) return;
const ctrl = new AbortController();
S.sse.abort = ctrl;
let online = false;
try {
const streamHeaders = { Accept: 'text/event-stream', Authorization: `Bearer ${S.token}` };
// 断线重连：显式带上最后收到的 seq（契约里的 Last-Event-ID 语义）
if (S.sse.lastSeq > 0) streamHeaders['Last-Event-ID'] = String(S.sse.lastSeq);
const res = await fetch(EP.stream, { headers: streamHeaders, signal: ctrl.signal });
if (!res.ok || !res.body) throw new Error(`流式响应 ${res.status}`);
online = true;
setOnline(true);
// 断线 reconcile：服务端按 Last-Event-ID 补拉增量，前端只需全量重拉投影
if (S.sse.everConnected) void loadProjection();
S.sse.everConnected = true;

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
for (;;) {
const { value, done } = await reader.read();
if (done) break;
buffer += decoder.decode(value, { stream: true });
let cut = buffer.indexOf('\n\n');
while (cut >= 0) {
const frame = buffer.slice(0, cut);
buffer = buffer.slice(cut + 2);
handleFrame(frame);
cut = buffer.indexOf('\n\n');
}
}
throw new Error('流已结束');
} catch (err) {
if (ctrl.signal.aborted) return;
if (online) toast(`实时连接中断：${String(err?.message ?? err)}`, 'danger');
setOnline(false);
await sleep(S.sse.retry);
}
}
}

// ──────────────────────────────── 状态机与摘要 ────────────────────────────────

function stateMachine(proj, dash) {
const needsReview = proj?.needsReview?.length ?? 0;
const paused = proj?.lastExhausted && Object.keys(proj.lastExhausted).length > 0;
const next = nextTimerAt(proj);
let kind = 'idle';
if (needsReview > 0) kind = 'alert';
else if (paused) kind = 'paused';
else if (proj?.degraded) kind = 'degraded';
else if (proj?.openTurn) kind = 'running';
else if ((proj?.idleTicks ?? 0) >= 4) kind = 'sleeping';

const remote = typeof dash?.state === 'string' ? dash.state : null;
if (remote !== null && STATE_ORDER.includes(remote)) kind = remote;

const text = {
'needs-review': '有事等你确认',
paused: '已暂停，等新的预算',
degraded: `降级运行中（${proj?.degraded?.lane ?? '未知 lane'}）`,
running: 'Agent 正在值守',
sleeping: '沉睡中',
idle: next ? `待机，下次唤醒 ${timeOf(next)}` : '待机，等待唤醒',
onboarding: '还没有开始记载',
};
const subline = {
'needs-review': `${needsReview} 项工具调用等人确认结果`,
paused: '预算耗尽后暂停，加预算即可继续',
degraded: proj?.degraded?.reason ?? '降级链已接管',
running: `turn ${proj?.openTurn?.turn ?? '-'} · step ${proj?.openTurn?.step ?? '-'}`,
sleeping: `连续 ${proj?.idleTicks ?? 0} 次空拍，退避中`,
idle: next ? `定时器 ${timeOf(next)} 触发` : '等心跳或外部唤醒',
onboarding: '先决定种子人格怎么来',
};
// 后端 dashboard 是权威（与 CLI status 同源）：stateText / detail 现成可用就不自己造句
const remoteText = typeof dash?.stateText === 'string' && dash.stateText !== '' ? dash.stateText : null;
const remoteDetail = typeof dash?.detail === 'string' && dash.detail !== '' ? dash.detail : null;
return {
kind,
text: remoteText ?? text[kind] ?? text.idle,
subline: remoteDetail ?? subline[kind] ?? '',
sublineRemote: remoteDetail !== null,
};
}

function reasonKind(reason) {
return reason && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : '未知结局';
}

function wakeSource(source) {
const map = { timer: '定时器', file: '文件', webhook: 'webhook', manual: '手动', heartbeat: '心跳', intention: '意图', job: '后台任务' };
return map[source] ?? String(source ?? '未知来源');
}

function summarize(ev) {
const d = ev?.data ?? {};
const type = String(ev?.type ?? '');
if (type === 'tool/call') return `${d.name ?? '工具'}(${clip(d.arguments)})`;
if (type === 'tool/result') return `${d.status ?? '结果'} · ${clip(d.content)}`;
if (type === 'budget/consumed') return `+${num(d.inputTokens, '0')}↑ +${num(d.outputTokens, '0')}↓ (hit ${num(d.cacheHitTokens, '0')}) ${d.lane ?? ''}`;
if (type === 'turn/end') return reasonKind(d.reason);
if (type === 'turn/start') return `turn ${d.turn ?? '-'}`;
if (type === 'step/start') return `turn ${d.turn ?? '-'} step ${d.step ?? '-'} · ${d.model ?? ''}`;
if (type === 'step/end') return `${d.toolCalls ?? 0} 次工具调用`;
if (type === 'wake/manual') return `手动唤醒 · ${clip(d.note)}`;
if (type === 'wake/timer') return `定时器 ${d.timerId ?? ''}`;
if (type === 'wake/file') return `${d.kind ?? '变更'} · ${d.path ?? ''}`;
if (type === 'wake/webhook') return `webhook ${d.path ?? ''}`;
if (type === 'wake/heartbeat') return `心跳 · 空拍 ${d.idleTicks ?? 0} · 压力 ${typeof d.pressure === 'number' ? d.pressure.toFixed(2) : '—'}`;
if (type === 'wake/intention') return `意图 · ${clip(d.content)}`;
if (type === 'message/user') return `${wakeSource(d.source)} · ${clip(d.text)}`;
if (type === 'message/assistant') return clip(d.text) || `工具调用 ${(d.toolCalls ?? []).length} 个`;
if (type === 'policy/denied') return `${d.tool ?? '工具'} 被拦：${d.rule ?? ''} · ${clip(d.reason)}`;
if (type === 'review/resolved') return `${d.callId ?? ''} → ${d.outcome ?? ''} · ${clip(d.note)}`;
if (type === 'input/dead-letter') return `输入 ${d.inputSeq ?? ''} 进死信（认领 ${d.claimCount ?? 0} 次）`;
if (type === 'instance/takeover') return `接管旧实例 pid ${d.previousPid ?? ''}`;
if (type === 'model/degraded') return `${d.lane ?? ''} 降级：${clip(d.reason)}`;
if (type === 'alarm/sent') return `${d.level ?? ''} · ${clip(d.title)}`;
if (type === 'persona/updated') return `${d.file ?? ''} by ${d.by ?? ''}`;
if (type === 'config/changed') return (d.fields ?? []).join(', ');
if (type === 'session/start') return `pid ${d.pid ?? ''} · schema ${d.schemaVersion ?? ''}`;
return clip(JSON.stringify(d), CLIP);
}

function typeTone(type) {
const t = String(type ?? '');
if (t === 'policy/denied' || t === 'input/dead-letter' || t === 'log/repaired') return 'danger';
if (t.startsWith('budget/')) return 'warn';
if (t.startsWith('tool/')) return 'info';
return '';
}

function isDanger(type) {
const t = String(type ?? '');
return t === 'policy/denied' || t === 'input/dead-letter' || t.startsWith('tool/zombie');
}

// ──────────────────────────────── 壳层与路由 ────────────────────────────────

function atTab(page, tab) {
return S.page === page && (tab === undefined || S.tab === tab);
}

function route() {
const hash = location.hash.replace(/^#\/?/, '');
const [path, query] = hash.split('?');
const [head, second] = path.split('/');
S.query = new URLSearchParams(query ?? '');
if (PAGE_BY_ID.has(head)) {
const page = PAGE_BY_ID.get(head);
S.page = head;
S.tab = page.tabs.some((item) => item.id === second) ? second : defaultTabOf(head);
return S.page;
}
const legacy = LEGACY_ROUTES[head] ?? LEGACY_ROUTES[''];
S.page = legacy.page;
S.tab = legacy.tab ?? defaultTabOf(legacy.page);
return S.page;
}

function hashOf(pageId, tabId) {
return tabId ? `#/${pageId}/${tabId}` : `#/${pageId}`;
}

function tabsHtml(page) {
return page.tabs
.map(
(tab) => `<button class="tab" role="tab" data-act="go-tab" data-page="${esc(page.id)}" data-tab="${esc(tab.id)}" aria-selected="${S.tab === tab.id ? 'true' : 'false'}" data-on="${S.tab === tab.id ? 'true' : 'false'}">${esc(tab.label)}</button>`,
)
.join('');
}

function renderChrome() {
const page = PAGE_BY_ID.get(S.page) ?? PAGE_BY_ID.get('config');
const title = document.getElementById('page-title');
const sub = document.getElementById('page-subtitle');
if (title) title.textContent = page.title;
if (sub) sub.textContent = page.sub;
for (const item of PAGES) {
const el = document.getElementById(`nav-${item.id}`);
if (el) el.dataset.active = item.id === S.page ? 'true' : 'false';
}
const tabs = document.getElementById('page-tabs');
if (tabs) {
tabs.hidden = page.tabs.length === 0;
tabs.innerHTML = tabsHtml(page);
}
renderSaveFab();
const root = document.getElementById('page-root');
if (root) {
root.dataset.anim = 'out';
void root.offsetWidth;
root.dataset.anim = 'in';
}
}

function renderSaveFab() {
const save = document.getElementById('cfg-save');
if (!save) return;
const dirty = S.ctl.draft.size;
save.hidden = !(S.page === 'config' && dirty > 0);
const label = document.getElementById('cfg-save-label');
if (label) label.textContent = `保存 ${dirty} 项改动`;
}

function renderTabBody() {
if (!document.getElementById('tab-root')) return;
const loads = [];
if (S.page === 'config') {
renderConfigTab();
if (S.ctl.cfg === null && !S.ctl.cfgLoading) loads.push(loadConfig());
if (S.tab === 'plugins' && S.tools.data === null && !S.tools.loading) loads.push(loadTools());
} else if (S.page === 'plugins') {
if (S.tab === 'skills') {
renderSkillsTab();
if (S.skills.data === null && !S.skills.loading) loads.push(loadSkills());
} else if (S.tab === 'mcp') {
renderMcpTab();
if (S.mcp.data === null && !S.mcp.loading) loads.push(loadMcp());
} else if (S.tab === 'hooks') {
renderHooksTab();
if (S.hooks.data === null && !S.hooks.loading) loads.push(loadHooks());
} else {
renderToolBehaviorTab();
if (S.tools.data === null && !S.tools.loading) loads.push(loadTools());
}
} else if (S.page === 'data') {
if (S.tab === 'stats') {
renderStatsTab();
if (S.proj === null && !S.projLoading) loads.push(loadProjection());
if (S.dash === null && !S.dashLoading) loads.push(loadDashboard());
if (S.budget.data === null && !S.budget.loading) loads.push(loadBudget());
} else if (S.tab === 'events') {
renderEventsTab();
if (S.events.length === 0 && !S.evLoading) loads.push(loadEvents({ reset: true }));
} else if (S.tab === 'logs') {
renderAlarmsTab();
if (S.alarms.data === null && !S.alarms.loading) loads.push(loadAlarms());
if (S.doctor.data === null && !S.doctor.loading) loads.push(runDoctor());
} else {
renderTraceTab();
}
} else if (S.page === 'persona') {
renderPersonaTab();
if (S.persona.files === null && !S.persona.filesLoading) loads.push(loadPersonaFiles());
if (S.persona.hist === null && !S.persona.histLoading) loads.push(loadPersonaHistory());
} else if (S.page === 'more') {
renderMoreTab();
if (S.proj === null && !S.projLoading) loads.push(loadProjection());
} else {
renderSettingsTab();
if (S.ctl.cfg === null && !S.ctl.cfgLoading) loads.push(loadConfig());
if (S.proj === null && !S.projLoading) loads.push(loadProjection());
}
return Promise.all(loads);
}

function gotoHash(target, anchorId) {
if (location.hash !== target) location.hash = target;
route();
renderChrome();
void renderTabBody();
if (anchorId) {
const el = document.getElementById(anchorId);
if (el) el.scrollIntoView({ block: 'start' });
}
}

function setBadge(id, text, tone) {
const el = document.getElementById(id);
if (!el) return;
if (!text) {
el.hidden = true;
return;
}
el.hidden = false;
el.dataset.tone = tone;
el.title = text;
}

function renderRailBadges() {
const proj = S.proj;
const needsReview = proj?.needsReview?.length ?? 0;
const dead = proj?.deadLetters?.length ?? 0;
const paused = proj?.lastExhausted && Object.keys(proj.lastExhausted).length > 0;

if (needsReview > 0) setBadge('rail-badge-data', `${needsReview} 项待确认`, 'danger');
else if (dead > 0) setBadge('rail-badge-data', `${dead} 条死信`, 'danger');
else if (paused || proj?.degraded) setBadge('rail-badge-data', paused ? '已暂停' : '降级中', 'warn');
else setBadge('rail-badge-data', '', '');

const files = S.persona.files ?? [];
const proposals = files.reduce((acc, f) => acc + (Number(f?.proposals) || 0), 0) + (S.dash?.personaProposals ?? 0);
setBadge('rail-badge-persona', proposals > 0 ? `${proposals} 个待批提案` : '', 'info');

const destructive = S.ctl.cfg?.tools?.destructiveEnabled;
setBadge('rail-badge-config', destructive === true || (Array.isArray(destructive) && destructive.length > 0) ? 'destructive 已开' : '', 'warn');

const skillPending = (S.skills.data?.items ?? []).filter((item) => item?.inCatalog !== true && !S.skills.ignored.has(String(item?.name))).length;
const mcpIdle = (S.mcp.data?.servers ?? []).filter((item) => item?.state === 'never-started' && item?.disabled !== true).length;
const hookProblems = (S.hooks.data?.problems ?? []).length;
if (skillPending > 0) setBadge('rail-badge-plugins', `${skillPending} 个技能待确认`, 'danger');
else if (hookProblems > 0) setBadge('rail-badge-plugins', `${hookProblems} 条钩子配置有问题`, 'warn');
else if (mcpIdle > 0) setBadge('rail-badge-plugins', `${mcpIdle} 个 MCP 未启动`, 'info');
else setBadge('rail-badge-plugins', '', '');

const archDays = proj?.lastArchiveAt ? daysSince(proj.lastArchiveAt) : null;
setBadge('rail-badge-more', archDays === null || archDays > 7 ? '待归档' : '', 'warn');
setBadge('rail-badge-settings', '', '');
}

// ──────────────────────────────── 数据与日志 · 统计 ────────────────────────────────

function sparkline(series, key, w = 160, h = 24) {
const values = series.map((point) => Number(point?.[key]) || 0);
if (values.length < 2) return '';
const max = Math.max(...values, 1);
const step = w / (values.length - 1);
const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(h - (v / max) * h).toFixed(1)}`).join(' ');
return `<svg class="tile-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" style="fill:none;stroke:var(--primary)" stroke-width="1"/></svg>`;
}

function hourSeries() {
const raw = S.dash?.hourly ?? S.dash?.series?.hourly ?? [];
return Array.isArray(raw) ? raw.slice(0, 24) : [];
}

function tilesHtml(proj, dash) {
// 磁贴优先后端 DashboardView.tiles（与 CLI status 同源），投影只做兜底
const t = dash?.tiles ?? {};
const b = dash?.budget ?? {};
const tokensToday = t.tokensToday ?? b.tokensToday ?? proj?.budget?.tokensToday ?? 0;
const heavy = b.heavy ?? proj?.budget?.tokensTodayHeavy ?? 0;
const light = b.light ?? proj?.budget?.tokensTodayLight ?? 0;
const hit = b.cacheHit ?? proj?.budget?.cacheHitToday ?? 0;
const miss = b.cacheMiss ?? proj?.budget?.cacheMissToday ?? 0;
const rate = typeof t.cacheHitRate === 'number' ? t.cacheHitRate : hit + miss > 0 ? hit / (hit + miss) : null;
const dead = typeof dash?.deadLetters === 'number' ? dash.deadLetters : proj?.deadLetters?.length ?? 0;
const series = hourSeries();
const hitBar = hit + miss > 0 ? `<div class="hitbar" title="命中 ${num(hit)} / 未命中 ${num(miss)}"><span class="hitbar-hit" style="width:${Math.round((hit / (hit + miss)) * 100)}%"></span><span class="hitbar-miss" style="width:${Math.round((miss / (hit + miss)) * 100)}%"></span></div>` : '';
const tiles = [
{ act: 'open-budget', label: '水位', value: num(t.watermark ?? proj?.watermark), sub: `末 seq ${num(proj?.lastSeq)}`, spark: 'tokens' },
{ act: 'goto-events', label: '待办', value: num(t.pending ?? proj?.pending?.length ?? 0), sub: '待处理输入' },
{ act: 'open-budget', label: '今日消耗', value: num(tokensToday), sub: `heavy ${num(heavy)} · light ${num(light)}`, extra: hitBar },
{ act: 'open-budget', label: '缓存命中率', value: rate === null ? '—' : pct(rate), sub: `hit ${num(hit)} / miss ${num(miss)}` },
{ act: 'goto-review', label: '待确认', value: num(t.needsReview ?? proj?.needsReview?.length ?? 0), sub: dead > 0 ? `死信 ${num(dead)}` : '无死信' },
{ act: 'goto-events', label: '连续失败', value: num(t.failStreak ?? proj?.failStreak ?? 0), sub: `降级 ${proj?.degraded ? '中' : '无'}` },
];
return `<div class="tiles">${tiles
.map(
(tile) => `<button class="tile" data-act="${tile.act}">
<span class="tile-label">${esc(tile.label)}</span>
<span class="tile-value">${esc(tile.value)}</span>
<span class="tile-sub">${esc(tile.sub)}</span>
${tile.spark && series.length > 1 ? sparkline(series, tile.spark) : ''}
${tile.extra ?? ''}
</button>`,
)
.join('')}</div>`;
}

function suggestionsHtml(proj, dash) {
const local = [];
const now = Date.now();
const stale = (proj?.needsReview ?? []).filter((item) => {
const at = new Date(String(item?.at)).getTime();
return Number.isFinite(at) && now - at > 3 * 86400000;
});
if (stale.length > 0) local.push({ id: 'review-stale', level: 'warn', text: `${stale.length} 项待确认已超 3 天：不结案会被恢复流程一直当未完成。` });
const hit = proj?.budget?.cacheHitToday ?? 0;
const miss = proj?.budget?.cacheMissToday ?? 0;
if (hit + miss > 20 && hit / (hit + miss) < 0.6) local.push({ id: 'cache-hit-low', level: 'info', text: `今日缓存命中率 ${pct(hit / (hit + miss))}：常驻前缀可能被频繁改写。` });
const archDays = proj?.lastArchiveAt ? daysSince(proj.lastArchiveAt) : null;
if (archDays === null || archDays > 7) local.push({ id: 'archive-stale', level: 'info', text: archDays === null ? '还没有折叠快照：冷启动要全量重放。' : `最近快照 ${stampOf(proj.lastArchiveAt)}，已超 7 天。` });
if ((proj?.deadLetters?.length ?? 0) > 0) local.push({ id: 'dead-letters', level: 'warn', text: `死信队列有 ${proj.deadLetters.length} 条输入：需要人看一眼。` });
const items = Array.isArray(dash?.suggestions) && dash.suggestions.length > 0 ? dash.suggestions : local;
const kept = items.filter((item) => item && !S.dismissed.has(String(item.id ?? item.text)));
if (kept.length === 0) return '';
return `<div class="card block" data-state="data" id="stat-suggest">
${ch('建议', '<span class="tv">可忽略 7 天</span>')}
<div data-slot="data">${kept
.map(
(item) => `<div class="suggest-item row spread">
<div>
<div>${esc(item.text ?? '')}</div>
<div class="tv">${esc(item.level === 'warn' ? '需要看一眼' : '参考')}</div>
</div>
<button class="btn btn-quiet" data-act="suggest-dismiss" data-id="${esc(String(item.id ?? item.text))}">忽略</button>
</div>`,
)
.join('')}</div>
</div>`;
}

function bannerHtml(proj) {
const review = proj?.needsReview ?? [];
const dead = proj?.deadLetters ?? [];
if (review.length === 0 && dead.length === 0) return '';
const cards = review
.map(
(item) => `<div class="banner-item" data-call="${esc(item.callId)}">
<div class="row spread">
<div>
<div><b>${esc(item.name ?? '未知工具')}</b> <span class="badge" data-tone="danger">${esc(item.toolResultStatus ?? 'unknown')}</span></div>
<div class="banner-meta">callId ${esc(item.callId)} · ${esc(stampOf(item.at))} · sideEffect ${esc(item.sideEffect ?? '未知')}</div>
<div class="tv">参数摘要：${esc(clip(item.argsSummary ?? item.arguments, 120))}</div>
</div>
</div>
<div class="row row-wrap">
<input class="banner-note" data-role="review-note" data-call="${esc(item.callId)}" placeholder="备注">
<button class="btn btn-primary" data-act="review-resolve" data-call="${esc(item.callId)}" data-outcome="succeeded">确认成功</button>
<button class="btn" data-act="review-resolve" data-call="${esc(item.callId)}" data-outcome="failed">确认失败</button>
<button class="btn" data-act="review-resolve" data-call="${esc(item.callId)}" data-outcome="partial">部分生效</button>
</div>
</div>`,
)
.join('');
const deadCards = dead
.map(
(item) => `<div class="banner-item">
<div><b>死信</b> <span class="banner-meta">输入 ${esc(item.inputSeq)} · 认领 ${esc(item.claimCount)} 次 · ${esc(stampOf(item.at))}</span></div>
<div class="row">
<button class="btn" data-act="dead-requeue" data-seq="${esc(item.inputSeq)}">重新入队</button>
<button class="btn btn-danger" data-act="dead-discard" data-seq="${esc(item.inputSeq)}">丢弃</button>
</div>      </div>`,
)
.join('');
return `<div class="banner card-enter" id="ev-banner">
<div class="banner-head">${icon('i-alert')}<b>有待确认的事</b><span class="tiny variant push">处理完自动消失</span></div>
${cards}${deadCards}
</div>`;
}

function headHtml(proj, dash, sm) {
const days = proj?.firstEventAt ? daysSince(proj.firstEventAt) : null;
const wakeAt = proj?.lastWake;
const lastText = proj?.lastAssistantText ? clip(proj.lastAssistantText, 30) : '';
return `<section class="head-grid" data-state-kind="${esc(sm.kind)}" id="stat-head">
<div>
<div class="guarded">已守护 <b>${days === null ? '—' : num(days)}</b> 天${proj?.firstEventAt ? ` · 自 ${esc(stampOf(proj.firstEventAt))}` : ''}</div>
<h2 class="state-line">${esc(sm.text)}</h2>
<p class="subline">${sm.sublineRemote || !wakeAt ? '' : `${esc(timeOf(wakeAt.at))} ${esc(wakeSource(wakeAt.source))} · `}${esc(sm.subline)}${lastText ? ` · 她说：「${esc(lastText)}」` : ''}</p>
</div>
<div class="cta-wrap">
<button class="btn btn-primary" data-act="wake">${icon('i-play')}<span class="btn-glyph">立即唤醒</span>${icon('i-check', 'icon btn-check')}</button>
<button class="btn" data-act="wake-menu" title="待触发定时器">${icon('i-chevron')}</button>
</div>
<div id="stat-timers" hidden></div>
</section>`;
}

function timerMenuHtml(proj) {
const timers = proj?.timers ?? [];
if (timers.length === 0) return '<div class="muted-block">没有待触发定时器。</div>';
return `<div class="stack">${timers
.map(
(t) => `<div class="row spread ev-line">
<span class="mono tiny">${esc(t.timerId ?? '')} · ${t.cron ? `cron ${esc(t.cron)}` : esc(timeOf(t.at))}</span>
<button class="btn btn-quiet" data-act="timer-cancel" data-id="${esc(t.timerId ?? '')}">取消</button>
</div>`,
)
.join('')}</div>`;
}

function recentHtml() {
// dashboard.recent 带的是 summarizeEvent 的摘要（与 CLI tail 同一实现），优先用它
const remote = Array.isArray(S.dash?.recent) && S.dash.recent.length > 0 ? S.dash.recent : null;
const list = (remote ?? S.events.map((ev) => ({ seq: ev.seq, ts: ev.ts, type: ev.type, summary: ev.summary ?? summarize(ev) }))).slice(-10).reverse();
if (list.length === 0) return '';
return list
.map(
(ev) => `<div class="ev-line">
<span class="ev-time">${esc(timeOf(ev.ts))}</span>
<span class="ev-seq">#${esc(ev.seq)}</span>
<span class="badge" data-tone="${esc(typeTone(ev.type))}">${esc(ev.type)}</span>
<span class="ev-sum ${isDanger(ev.type) ? 'st-error' : ''}">${esc(ev.summary ?? summarize(ev))}</span>
</div>`,
)
.join('');
}

function renderStatsTab() {
const root = tabRoot('data', 'stats');
if (!root) return;
const proj = S.proj;
if (!proj) {
root.innerHTML = `<div class="page-enter">${section(S.projError ? 'error' : 'loading', '', { error: S.projError ?? undefined, retry: 'retry-stats' })}</div>`;
return;
}
const sm = stateMachine(proj, S.dash);
const onboarding = S.dash?.empty === true || (S.events.length === 1 && S.events[0]?.type === 'session/start');
const head = onboarding
? `<section class="head-grid" data-state-kind="onboarding" id="stat-head">
<div>
<div class="guarded">已守护 <b>—</b> 天</div>
<h2 class="state-line">她还没有人格</h2>
<p class="subline">第一卷日志里只有一条 session/start：先决定种子人格怎么来。</p>
</div>
<div class="cta-wrap"><button class="btn btn-primary" data-act="goto-persona">${icon('i-user')}<span class="btn-glyph">去填人格</span>${icon('i-check', 'icon btn-check')}</button></div>
</section>`
: headHtml(proj, S.dash, sm);

const recent = S.events.length > 0 ? recentHtml() : section('loading', '');
root.innerHTML = `<div class="page-enter">
${head}
<div class="card block" data-state="data" id="stat-tiles">
${ch('此刻的六个数', '<span class="tv"></span>')}
<div data-slot="data">${tilesHtml(proj, S.dash)}</div>
</div>
<div class="card" id="stat-budget">${budgetCardHtml()}</div>
${blockCard('stat-recent', '最近事件', '<button class="btn btn-quiet" data-act="goto-events">查看全部 →</button>', stateOf(S.evLoading, S.evError, false, S.events.length > 0), {
loading: '正在读取事件…',
error: S.evError ?? '事件读取失败',
retry: 'retry-events',
emptyIcon: 'i-list',
emptyTitle: '还没有事件',
emptyHint: '等第一条 event 写进日志。',
slot: `<div class="ev-list-tight">${recent}</div>`,
})}
<div class="card">
${ch('快捷入口')}
<div class="quick-row" id="stat-quick">
<button class="btn" data-act="goto-logs">${icon('i-doctor')}doctor 自检</button>
<button class="btn" data-act="goto-trace">${icon('i-replay')}追踪重放</button>
<button class="btn" data-act="goto-plugins">${icon('i-puzzle')}插件</button>
<button class="btn" data-act="goto-more">${icon('i-grid')}更多功能</button>
<button class="btn" data-act="goto-config">${icon('i-sliders')}配置文件</button>
</div>
</div>
${suggestionsHtml(proj, S.dash)}

</div>`;
const timers = document.getElementById('stat-timers');
if (timers) timers.hidden = true;
}

function budgetCardHtml() {
const d = S.budget.data;
const hasData = d !== null && (Number(d?.today?.tokens ?? 0) > 0 || (Array.isArray(d?.turns) && d.turns.length > 0));
return `${ch('预算', `<div class="row"><span class="tv">${S.budget.range === '7d' ? '近 7 天' : '今日'}</span>
<div class="seg" id="budget-range">
<button data-act="budget-range" data-range="today" data-on="${S.budget.range === 'today' ? 'true' : 'false'}">今日</button>
<button data-act="budget-range" data-range="7d" data-on="${S.budget.range === '7d' ? 'true' : 'false'}">7 天</button>
</div></div>`)}
${section(stateOf(S.budget.loading, S.budget.error, false, hasData), budgetBodyHtml(d), {
id: 'stat-budget-block',
loading: '正在取预算数据…',
error: S.budget.error ?? '预算读取失败',
retry: 'retry-budget',
emptyIcon: 'i-timer',
emptyTitle: '还没有消耗记录',
emptyHint: '这段时间还没有发生模型调用。',
})}`;
}

function budgetBodyHtml(d) {
if (!d || typeof d !== 'object') return '';
const today = d.today ?? {};
const total = Number(today.tokens ?? 0);
const month = d.month ?? {};
return `<div class="stack">
<div class="grid grid-2">
${laneCard('heavy lane', Number(today.heavy ?? 0), total)}
${laneCard('light lane', Number(today.light ?? 0), total)}
</div>
${limitBar(d.layers, d.limits)}
<div class="card">
${ch('24 小时', '<span class="tv">命中率与 token 堆叠</span>')}
${hourChart(d.series ?? d.hourly)}
</div>
<div class="card">
${ch('最近 20 个 turn', '<span class="tv">点行跳事件页</span>')}
${turnsTable(d.turns)}
</div>
<div class="card">
${ch('本月（估算）')}
<div class="row row-wrap tiny variant">
<span>月累计 ${esc(num(month.tokens ?? d.monthTokens))} token</span>
<span>· turn 数 ${esc(num(month.turns ?? d.monthTurns))}</span>
<span>· 单次均价 ${esc(num(month.avgPerTurn ?? d.avgPerTurn))} token</span>
</div>
<div class="tv" style="margin-top:8px">与 CLI budget 同源。</div>
</div>
</div>`;
}

function laneCard(lane, tokens, total) {
const share = total > 0 ? tokens / total : 0;
return `<div class="lane-card">
<div class="tile-label">${esc(lane)}</div>
<div class="lane-val">${num(tokens)}</div>
<div class="tv">占今日 ${total > 0 ? pct(share) : '—'}</div>
<div class="budgetbar"><span style="width:${Math.round(Math.min(1, share) * 100)}%"></span></div>
</div>`;
}

function limitBar(layers, limits) {
const daily = Array.isArray(layers) ? layers.find((item) => item?.layer === 'daily') : null;
const used = Number(daily?.used ?? 0);
const limit = Number(daily?.limit ?? limits?.dailyTokens ?? 0);
const soft = Number(daily?.softLimit ?? 0);
const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
const tone = limit > 0 && used > limit ? 'danger' : soft > 0 && used > soft ? 'warn' : '';
return `<div class="stack">
<div class="row spread tiny variant"><span>距硬阈值（daily 层）</span><span class="mono">${num(used)} / ${limit > 0 ? num(limit) : '未设'}${soft > 0 ? `（软 ${num(soft)}）` : ''}</span></div>
<div class="budgetbar" data-tone="${tone}"><span style="width:${Math.round(ratio * 100)}%"></span></div>
</div>`;
}

function hourChart(series) {
const points = Array.isArray(series) ? series.slice(0, 24) : [];
if (points.length < 2) return '<div class="muted-block">还没有 24 小时的序列数据。</div>';
const w = 240;
const h = 120;
const max = Math.max(...points.map((p) => (Number(p?.input) || 0) + (Number(p?.output) || 0)), 1);
const step = w / (points.length - 1);
const xy = points.map((p, i) => {
const total = (Number(p?.input) || 0) + (Number(p?.output) || 0);
const hit = Number(p?.hit) || 0;
const miss = Number(p?.miss) || 0;
const rate = hit + miss > 0 ? hit / (hit + miss) : 0;
return { x: Number((i * step).toFixed(1)), y: Number((h - (total / max) * h).toFixed(1)), r: Number((h - rate * h).toFixed(1)) };
});
const areaPath = `M0 ${h} ${xy.map((p) => `L${p.x} ${p.y}`).join(' ')} L${w} ${h} Z`;
const linePath = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
const ratePath = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.r}`).join(' ');
return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="24 小时消耗与命中率">
<path d="${areaPath}" style="fill:var(--surface-highest)" stroke="none"/>
<path d="${linePath}" style="fill:none;stroke:var(--primary)" stroke-width="1"/>
<path d="${ratePath}" style="fill:none;stroke:var(--ok)" stroke-width="1" stroke-dasharray="4 4"/>
</svg>
<div class="tv">实线 = token 堆叠面积 · 虚线 = 命中率 · 横轴 = 24 小时</div>`;
}

function turnsTable(turns) {
const list = Array.isArray(turns) ? turns.slice(-20).reverse() : [];
if (list.length === 0) return '<div class="muted-block">还没有 turn 明细。</div>';
return `<table class="turn-table">
<thead><tr><th>turn</th><th>结局</th><th>输入</th><th>输出</th><th>命中率</th><th>耗时</th></tr></thead>
<tbody>${list
.map(
(t) => `<tr data-act="open-turn" data-turn="${esc(t?.turn ?? '')}" title="跳到事件页对应区间">
<td class="mono">${esc(t?.turn ?? '')}</td>
<td>${esc(t?.reasonKind ?? t?.reason?.kind ?? '—')}</td>
<td class="mono">${esc(num(t?.input ?? t?.inputTokens))}</td>
<td class="mono">${esc(num(t?.output ?? t?.outputTokens))}</td>
<td class="mono">${esc(t?.hitRate === undefined || t?.hitRate === null ? '—' : pct(t.hitRate))}</td>
<td class="mono">${esc(num(t?.durationMs))}ms</td>
</tr>`,
)
.join('')}</tbody>
</table>`;
}

// ──────────────────────────────── 数据与日志 · 事件 ────────────────────────────────

function filtersHtml() {
const groups = DOMAIN_GROUPS.map((group) => {
const on = group.types.some((t) => S.filters.types.has(t));
return `<details class="type-group" data-on="${on ? 'true' : 'false'}">
<summary>${esc(group.name)}${on ? ' ●' : ''}</summary>
<div class="type-panel"><div class="type-list">
${group.types
.map(
(t) => `<label class="checkbox"><input type="checkbox" data-act="type-toggle" value="${esc(t)}" ${S.filters.types.has(t) ? 'checked' : ''}><span class="mono tiny">${esc(t)}</span></label>`,
)
.join('')}
</div></div>
</details>`;
}).join('');
return `<div class="filter-bar" id="ev-filter">
<div class="type-groups">${groups}</div>
<label class="row tiny variant">可见性
<select data-act="visibility">
<option value="all" ${S.filters.visibility === 'all' ? 'selected' : ''}>全部</option>
<option value="model" ${S.filters.visibility === 'model' ? 'selected' : ''}>model</option>
<option value="internal" ${S.filters.visibility === 'internal' ? 'selected' : ''}>internal</option>
</select>
</label>
<label class="row tiny variant">跳到 seq
<input id="ev-jump-input" type="number" min="0" step="1" placeholder="seq" style="width:120px">
<button class="btn" data-act="ev-jump">跳</button>
</label>
<label class="row tiny variant"><input type="checkbox" data-act="ev-follow" ${S.filters.follow ? 'checked' : ''}>跟随新事件</label>
<button class="btn push" data-act="ev-reload">${icon('i-refresh')}重新加载</button>
</div>`;
}

function eventFootHtml() {
return `${S.evCursor !== null ? `<button class="btn" data-act="ev-earlier">加载更早一批（${BATCH} 条）</button>` : ''}
<span class="tv">共 ${S.events.length} 条在本地 · 每批 ${BATCH} 条 · 虚拟滚动</span>`;
}

function paintEvents() {
if (!atTab('data', 'events')) return;
const viewport = document.getElementById('ev-list');
if (!viewport) {
renderEventsTab();
return;
}
const spacer = document.getElementById('ev-spacer');
if (spacer) spacer.style.height = `${S.events.length * ROW_H + (S.openSeq !== null ? EXPAND_H : 0)}px`;
paintRows();
renderNewbar();
const foot = document.getElementById('ev-foot');
if (foot) foot.innerHTML = eventFootHtml();
}

function renderEventsTab() {
const root = tabRoot('data', 'events');
if (!root) return;
const listState = stateOf(S.evLoading, S.evError, S.events.length === 0, S.events.length > 0);
const banner = (S.proj?.needsReview?.length ?? 0) > 0 || (S.proj?.deadLetters?.length ?? 0) > 0 ? bannerHtml(S.proj) : '';
root.innerHTML = `<div class="page-enter">
${banner}
${filtersHtml()}
<div id="ev-newbar-wrap"></div>
${section(listState, '<div class="ev-viewport" id="ev-list"><div class="ev-spacer" id="ev-spacer"></div></div>', {
id: 'ev-list-block',
loading: '正在读取事件…',
error: S.evError ?? '事件读取失败',
retry: 'ev-reload',
emptyIcon: 'i-list',
emptyTitle: '没有匹配的事件',
emptyHint: '放宽过滤条件，或等新的日志写进来。',
emptyAction: { act: 'ev-clear-filter', label: '清空过滤' },
})}
<div class="row" id="ev-foot" style="margin-top:12px">${eventFootHtml()}</div>
<p class="footnote">与命令行 tail 同源。</p>
</div>`;
const spacer = document.getElementById('ev-spacer');
if (spacer) {
spacer.style.height = `${S.events.length * ROW_H + (S.openSeq !== null ? EXPAND_H : 0)}px`;
const viewport = document.getElementById('ev-list');
if (viewport) {
viewport.addEventListener('scroll', onEventsScroll, { passive: true });
paintRows();
if (S.filters.follow && S.newCount > 0) {
viewport.scrollTop = spacer.offsetHeight;
S.newCount = 0;
}
}
}
renderNewbar();
const spec = S.query.get('replay');
if (spec) {
const [turn, step] = spec.split(':').map((value) => Number(value));
if (Number.isFinite(turn) && Number.isFinite(step)) {
const hit = S.events.find((item) => Number(item?.data?.turn) === turn && Number(item?.data?.step) === step);
if (hit && S.openSeq !== hit.seq) {
S.openSeq = hit.seq;
paintRows();
}
if (!S.replay) void loadReplay(turn, step);
}
}
}

let rowTick = 0;

function onEventsScroll() {
if (rowTick) return;
rowTick = requestAnimationFrame(() => {
rowTick = 0;
paintRows();
});
}

function openRowIndex() {
return S.openSeq === null ? -1 : S.events.findIndex((ev) => ev.seq === S.openSeq);
}

function offsetOf(index) {
const open = openRowIndex();
return index * ROW_H + (open >= 0 && open < index ? EXPAND_H : 0);
}

function paintRows() {
const viewport = document.getElementById('ev-list');
const spacer = document.getElementById('ev-spacer');
if (!viewport || !spacer) return;
const top = viewport.scrollTop;
const height = viewport.clientHeight || 400;
const from = Math.max(0, Math.floor(top / ROW_H) - 8);
const to = Math.min(S.events.length, Math.ceil((top + height) / ROW_H) + 8);
const parts = [];
const open = openRowIndex();
for (let i = from; i < to; i += 1) {
const ev = S.events[i];
if (!ev) continue;
parts.push(rowHtml(ev, i));
if (i === open) parts.push(expandHtml(ev, offsetOf(i) + ROW_H));
}
spacer.innerHTML = parts.join('');
S.newSeqs.clear();
}

function rowHtml(ev, index) {
return `<button class="ev-row" data-act="ev-row" data-seq="${esc(ev.seq)}" data-index="${index}" data-open="${S.openSeq === ev.seq ? 'true' : 'false'}" data-danger="${isDanger(ev.type) ? 'true' : 'false'}" data-new="${S.newSeqs.has(ev.seq) ? 'true' : 'false'}" style="top:${offsetOf(index)}px">
<span class="ev-time">${esc(timeOf(ev.ts))}</span>
<span class="ev-seq">#${esc(ev.seq)}</span>
<span class="badge" data-tone="${esc(typeTone(ev.type))}">${esc(ev.type)}</span>
<span class="ev-sum">${esc(summarize(ev))}</span>
<span class="badge">${esc(ev.visibility ?? 'internal')}</span>
</button>`;
}

function replayHtml(ev) {
const turn = ev?.data?.turn;
const step = ev?.data?.step;
if (typeof turn !== 'number' || typeof step !== 'number') return '<div class="tv">这条事件没有 turn/step，无法重放。</div>';
if (S.replayError) {
return `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.replayError)}</span><button class="btn" data-act="ev-replay" data-turn="${esc(turn)}" data-step="${esc(step)}">重试</button></div>`;
}
const r = S.replay;
if (!r) return `<div class="st-line">${icon('i-refresh')}<span>正在重建第 ${esc(turn)} 轮第 ${esc(step)} 步的请求体…</span></div>`;
return `<div class="stack" id="ev-replay">${replayBodyHtml(r, turn, step)}</div>`;
}

function replayBodyHtml(r, turn, step) {
const messages = Array.isArray(r.request?.messages) ? r.request.messages : Array.isArray(r.messages) ? r.messages : [];
const usage = r.usage ?? {};
const fp = r.fingerprints ?? {};
return `<div class="row row-wrap">
<span class="badge" data-tone="info">render ${esc(String(r.renderVersion ?? fp.renderVersion ?? '未知').slice(0, 8))}</span>
<span class="badge" data-tone="info">persona ${esc(String(r.personaHash ?? fp.personaHash ?? '未知').slice(0, 8))}</span>
<span class="badge" data-tone="info">config ${esc(String(r.configHash ?? fp.configHash ?? '未知').slice(0, 8))}</span>
<button class="btn btn-quiet push" data-act="ev-diff" data-turn="${esc(turn)}" data-step="${esc(step)}">与当前渲染 diff</button>
<button class="btn btn-quiet" data-act="ev-export-json" data-turn="${esc(turn)}" data-step="${esc(step)}">导出 JSON</button>
</div>
${messages.length > 0
? `<div class="replay-roles" id="tr-request">${messages
.map((m) => {
const body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
const long = body.length > 240;
return `<div class="role-line" data-role="${esc(m?.role ?? 'user')}">
<span class="role-name">${esc(m?.role ?? '?')}</span>
<div class="role-body"><div class="code" data-collapsed="${long ? 'true' : 'false'}">${esc(long ? `${body.slice(0, 240)}…` : body)}</div>
${long ? '<button class="btn btn-quiet" data-act="ev-expand-msg">展开全文</button>' : ''}</div>
</div>`;
})
.join('')}</div>`
: '<div class="tv">这次请求体为空（可能是纯流程 step）。</div>'}
<div class="tv">当时 usage：输入 ${esc(num(usage.inputTokens))} · 输出 ${esc(num(usage.outputTokens))} · 命中 ${esc(num(usage.cacheHitTokens))} · 耗时 ${esc(num(usage.durationMs))}ms</div>
${r.diff ? `<div class="card">${ch('与当前渲染的 diff')}<div class="code">${esc(typeof r.diff === 'string' ? r.diff : JSON.stringify(r.diff, null, 2))}</div></div>` : ''}`;
}

function expandHtml(ev, top) {
return `<div class="ev-expand" style="top:${top}px">
<dl class="kv">
<dt>seq / type</dt><dd>#${esc(ev.seq)} · ${esc(ev.type)}</dd>
<dt>ts</dt><dd>${esc(ev.ts)}</dd>
<dt>visibility</dt><dd>${esc(ev.visibility ?? 'internal')}</dd>
<dt>origin</dt><dd>${esc(ev.origin ?? '—')}</dd>
${ev.parentCallId ? `<dt>parentCallId</dt><dd>${esc(ev.parentCallId)}</dd>` : ''}
</dl>
<div class="row" style="margin:8px 0">
<button class="btn" data-act="ev-copy" data-seq="${esc(ev.seq)}">${icon('i-copy')}复制 JSON</button>
${typeof ev?.data?.turn === 'number' && typeof ev?.data?.step === 'number'
? `<button class="btn" data-act="ev-replay" data-turn="${esc(ev.data.turn)}" data-step="${esc(ev.data.step)}">${icon('i-replay')}重放此 step</button>`
: ''}
</div>
<div class="code">${esc(JSON.stringify(ev.data ?? {}, null, 2))}</div>
${typeof ev?.data?.turn === 'number' && typeof ev?.data?.step === 'number' ? `<div style="margin-top:8px">${replayHtml(ev)}</div>` : ''}
</div>`;
}

function renderNewbar() {
const wrap = document.getElementById('ev-newbar-wrap');
if (!wrap) return;
if (S.filters.follow || S.newCount === 0) {
wrap.innerHTML = '';
return;
}
wrap.innerHTML = `<button class="newbar" data-act="ev-follow-now">${icon('i-refresh')}<span>${S.newCount} 条新事件</span></button>`;
}

// ──────────────────────────────── 人格 ────────────────────────────────

function personaTreeHtml() {
const files = S.persona.files ?? [];
if (files.length === 0) return '';
return files
.map((file) => {
const path = String(file?.path ?? file?.name ?? '');
const name = String(file?.name ?? path.split('/').pop() ?? '');
const reserved = file?.reserved === true;
const proposals = Number(file?.proposals ?? file?.proposalCount) || 0;
return `<button class="tree-item" data-act="persona-file" data-path="${esc(path)}" data-on="${S.persona.cur?.path === path ? 'true' : 'false'}" data-indent="${path.includes('/') ? '1' : '0'}">
${icon(reserved ? 'i-lock' : 'i-file')}
<span>${esc(name)}</span>
${proposals > 0 ? `<span class="badge push" data-tone="info">提案 ${proposals}</span>` : ''}
${reserved ? '<span class="badge push">仅人类可改</span>' : ''}
</button>`;
})
.join('');
}

function proposalFiles() {
const list = S.persona.view?.proposals;
return Array.isArray(list) ? list.map((item) => String(item)) : [];
}

function lastEditorOf(path) {
const entry = (S.persona.hist ?? []).find((item) => item?.file === path);
return typeof entry?.by === 'string' ? entry.by : null;
}

function markdown(text) {
const lines = esc(text ?? '').split('\n');
const out = [];
let inCode = false;
let listOpen = false;
for (const line of lines) {
if (line.trim().startsWith('```')) {
if (listOpen) {
out.push('</ul>');
listOpen = false;
}
out.push(inCode ? '</pre>' : '<pre>');
inCode = !inCode;
continue;
}
if (inCode) {
out.push(line);
continue;
}
const heading = /^(#{1,3})\s+(.*)$/.exec(line);
if (heading) {
if (listOpen) {
out.push('</ul>');
listOpen = false;
}
const level = heading[1].length;
out.push(`<h${level}>${heading[2]}</h${level}>`);
continue;
}
const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
if (bullet) {
if (!listOpen) {
out.push('<ul>');
listOpen = true;
}
out.push(`<li>${bullet[1]}</li>`);
continue;
}
if (listOpen) {
out.push('</ul>');
listOpen = false;
}
if (line.trim() === '') continue;
out.push(`<p>${line}</p>`);
}
if (listOpen) out.push('</ul>');
if (inCode) out.push('</pre>');
return out
.join('\n')
.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
.replace(/`([^`]+)`/g, '<code>$1</code>');
}

function personaContentHtml() {
const cur = S.persona.cur;
if (!cur) return '';
if (S.persona.curLoading) return `<div class="st-line">${icon('i-refresh')}<span>正在读取 ${esc(cur.path)}…</span></div>`;
if (S.persona.curError) return `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.persona.curError)}</span><button class="btn" data-act="persona-reload">重试</button></div>`;
const tokens = Number(cur.tokens ?? cur.estimatedTokens);
const budget = Number(cur.budget ?? 1500);
const ratio = Number.isFinite(tokens) && budget > 0 ? Math.min(1, tokens / budget) : null;
const tone = ratio === null ? '' : ratio > 1 ? 'danger' : ratio > 0.8 ? 'warn' : '';
const editor = lastEditorOf(cur.path);
const hasProposal = proposalFiles().includes(cur.path);
return `<div class="stack" id="ps-content">
<div class="row row-wrap tiny variant">
<span class="mono">${esc(cur.path)}</span>
<span>· 估算 ${tokens ? num(tokens) : '—'} token</span>
<span>· 常驻预算占用 ${ratio === null ? '—' : pct(ratio)}（合计 / 1.5k）</span>
<span>· 最后修改 ${esc(cur.mtime ? stampOf(cur.mtime) : '未知')}${editor === null ? '' : ` by ${esc(editor)}`}</span>
${cur.reserved === true ? '<span class="badge" data-tone="warn">仅人类可改</span>' : ''}
</div>
<div class="budgetbar" data-tone="${tone}"><span style="width:${ratio === null ? 0 : Math.round(ratio * 100)}%"></span></div>
<div class="md">${markdown(cur.content ?? '')}</div>
${hasProposal
? `<div class="card" id="ps-proposal">
${ch('待批提案', '<span class="tv">批准即写 persona/updated（by: human）</span>')}
<div class="row spread ev-line">
<div>
<div class="mono tiny">proposals/${esc(cur.path)}</div>
<div class="tv">批准前先看一眼提案正文。</div>
</div>
<div class="row">
<button class="btn" data-act="persona-proposal-view" data-file="${esc(cur.path)}">查看提案</button>
<button class="btn btn-primary" data-act="persona-approve" data-file="${esc(cur.path)}" data-hash="">批准</button>
<button class="btn" data-act="persona-reject" data-file="${esc(cur.path)}">拒绝</button>
</div>
</div>
</div>`
: ''}
</div>`;
}

function timelineHtml() {
const entries = S.persona.hist ?? [];
if (entries.length === 0) return '';
return `<div class="timeline" id="ps-timeline">${entries
.map(
(entry) => `<div class="tl-item">
<span class="ev-time">${esc(stampOf(entry?.ts))}</span>
<span class="mono tiny">${esc(entry?.file ?? '')}</span>
<span class="badge" data-tone="${entry?.by === 'human' ? 'info' : ''}">${esc(entry?.by ?? 'agent')}</span>
<span class="mono tiny variant">${esc(String(entry?.diffHash ?? '').slice(0, 8))}</span>
<button class="btn btn-quiet push" data-act="persona-diff" data-file="${esc(entry?.file ?? '')}" data-hash="${esc(entry?.diffHash ?? '')}">查看 diff</button>
</div>`,
)
.join('')}</div>`;
}

function renderPersonaTab() {
const root = tabRoot();
if (!root || S.page !== 'persona') return;
const files = S.persona.files;
const hist = S.persona.hist;
const treeState = stateOf(files === null, S.persona.filesError, files?.length === 0, Array.isArray(files) && files.length > 0);
const contentState = S.persona.cur === null ? 'empty' : S.persona.curLoading ? 'loading' : S.persona.curError !== null ? 'error' : 'data';
const histState = stateOf(hist === null, S.persona.histError, hist?.length === 0, Array.isArray(hist) && hist.length > 0);
root.innerHTML = `<div class="page-enter">
<div class="split">
<div>
${section(treeState, `<div class="tree" id="ps-tree">${personaTreeHtml()}</div>`, {
loading: '正在读取人格文件…',
error: S.persona.filesError ?? '文件树读取失败',
retry: 'persona-reload',
emptyIcon: 'i-file',
emptyTitle: '还没有人格文件',
emptyHint: '首次启动会写入模板。',
})}
</div>
<div>
${section(contentState, personaContentHtml(), {
loading: '正在读取…',
error: S.persona.curError ?? '文件读取失败',
retry: 'persona-reload',
emptyIcon: 'i-user',
emptyTitle: '选一个文件',
emptyHint: '左列点一份，这里显示只读渲染。',
})}
</div>
</div>
<div class="card" style="margin-top:16px">
${ch('演化时间线', '<span class="tv">persona/updated 倒序</span>')}
${section(histState, timelineHtml(), {
loading: '正在读取演化记录…',
error: S.persona.histError ?? '时间线读取失败',
retry: 'persona-reload',
emptyIcon: 'i-timer',
emptyTitle: '还没有演化记录',
emptyHint: '第一次 persona/updated 之后就有条目。',
})}
</div>

</div>`;
}

// ──────────────────────────────── 插件页四格 ────────────────────────────────

function skillRowHtml(item) {
const name = String(item?.name ?? '');
const state = String(item?.trust ?? 'never-confirmed');
const tone = state === 'trusted' ? 'ok' : state === 'content-changed' ? 'danger' : state === 'agent-proposed' ? 'warn' : 'info';
const actions =
item?.inCatalog === true
? '<span class="badge" data-tone="ok">已进 catalog</span>'
: S.skills.ignored.has(name)
? `<span class="badge">已忽略（仅本地）</span><button class="btn" data-act="skill-restore" data-name="${esc(name)}">恢复</button>`
: `<button class="btn btn-primary" data-act="skill-confirm" data-name="${esc(name)}">${icon('i-check')}确认</button><button class="btn" data-act="skill-ignore" data-name="${esc(name)}">忽略</button>`;
return `<div class="field-row" data-trust="${esc(state)}">
<div>${esc(name)} <span class="badge" data-tone="${tone}">${esc(TRUST_LABEL[state] ?? state)}</span>
<div class="field-hint mono">${esc(item?.skillPath ?? '')} · ${esc(num(item?.bytes))} 字节 · ${esc(String(item?.contentHash ?? '').slice(0, 8))}</div>
<div class="field-hint">${esc(clip(item?.description ?? '', 90))}</div>
<div class="field-hint">${esc(item?.trustDetail ?? '')}</div>
</div>
<div class="row">${actions}</div>
</div>`;
}

function renderSkillsTab() {
const root = tabRoot('plugins', 'skills');
if (!root) return;
const d = S.skills.data;
const items = Array.isArray(d?.items) ? d.items : [];
const active = items.filter((item) => item?.inCatalog === true);
const pending = items.filter((item) => item?.inCatalog !== true && !S.skills.ignored.has(String(item?.name)));
const ignored = items.filter((item) => item?.inCatalog !== true && S.skills.ignored.has(String(item?.name)));
const rejected = Array.isArray(d?.rejected) ? d.rejected : [];
const state = stateOf(S.skills.loading, S.skills.error, items.length === 0, items.length > 0);
const right = `<div class="row"><span class="tv">${d === null ? '' : `${active.length} 已生效 · ${pending.length} 待确认 · catalog ${num(d.catalogTokens)} token`}</span>
<button class="btn" data-act="skills-reload">${icon('i-refresh')}重扫</button></div>`;
const body = `<div class="stack">
${pending.length > 0 ? `<div class="card" id="sk-pending">${ch('信任门：待确认', '<span class="tv">没确认就不进 catalog</span>')}${pending.map(skillRowHtml).join('')}</div>` : ''}
<div class="card" id="sk-active">${ch('已生效', '<span class="tv">catalog 里就是这些</span>')}${active.length === 0 ? '<div class="tv">还没有技能被确认。</div>' : active.map(skillRowHtml).join('')}</div>
${ignored.length > 0 ? `<div class="card" id="sk-ignored">${ch('已忽略', '<span class="tv">只在这台浏览器里忽略，不写事件</span>')}${ignored.map(skillRowHtml).join('')}</div>` : ''}
${rejected.length > 0 ? `<div class="card" id="sk-rejected">${ch('被拒绝的目录', '<span class="tv">frontmatter 非法或重名</span>')}${rejected.map((item) => `<div class="ev-line"><span class="mono tiny">${sv(item?.relDir )}</span><span class="tv">${sv(item?.reason )}</span></div>`).join('')}</div>` : ''}
</div>`;
root.innerHTML = `<div class="page-enter">
${blockCard('sk-list-block', '技能目录', right, state, {
loading: '正在扫描技能目录…',
error: S.skills.error ?? '技能目录读取失败',
retry: 'skills-reload',
emptyIcon: 'i-list',
emptyTitle: '还没有技能目录',
emptyHint: '技能放在 skills/<name>/SKILL.md。',
slot: body,
})}

</div>`;
}

function renderMcpTab() {
const root = tabRoot('plugins', 'mcp');
if (!root) return;
const d = S.mcp.data;
const servers = Array.isArray(d?.servers) ? d.servers : [];
const problems = Array.isArray(d?.problems) ? d.problems : [];
const state = stateOf(S.mcp.loading, S.mcp.error, servers.length === 0, servers.length > 0);
const right = `<div class="row"><span class="tv">${d === null ? '' : `声明 ${servers.length} 个 · 注册工具 ${num(d.registeredCount)} 件`}</span>
<button class="btn" data-act="mcp-reload">${icon('i-refresh')}刷新</button></div>`;
const body = `<div class="stack">
${servers.map(mcpRowHtml).join('')}
${problems.length > 0 ? `<div class="card" id="mcp-problems">${ch('配置问题')}${problems.map((item) => `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(String(item))}</span></div>`).join('')}</div>` : ''}
</div>`;
root.innerHTML = `<div class="page-enter">
${blockCard('mcp-list', 'MCP servers', right, state, {
loading: '正在读 MCP 配置与状态…',
error: S.mcp.error ?? 'MCP 状态读取失败',
retry: 'mcp-reload',
emptyIcon: 'i-puzzle',
emptyTitle: '还没有配置 MCP server',
emptyHint: '在 config.json 的 mcp.servers[] 里声明 { name, command, args }。',
slot: body,
})}

</div>`;
}

function mcpRowHtml(server) {
const state = String(server?.state ?? 'never-started');
const tone = state === 'started' ? 'ok' : state === 'stopped' ? 'warn' : state === 'disabled' ? '' : 'info';
const label = { started: '运行过', stopped: '已停止', disabled: '已停用', 'never-started': '从未启动' }[state] ?? state;
const tools = Array.isArray(server?.registeredTools) ? server.registeredTools : [];
return `<div class="card" data-mcp="${sv(server?.name )}">
${ch(`${sv(server?.name )} <span class="badge" data-tone="${tone}">${esc(label)}</span>`, `<span class="tv">${esc(num(server?.toolsCount))} 件工具</span>`)}
<div class="tiny variant mono">${sv(server?.command )} ${esc((server?.args ?? []).join(' '))}</div>
<div class="tv">${server?.lastAt ? `最近一次：${esc(stampOf(server.lastAt))}${server?.stopReason ? `（${esc(String(server.stopReason))}）` : ''}${server?.pid ? ` · pid ${esc(num(server.pid))}` : ''}` : '日志里没有它的启动记录'}</div>
${tools.length > 0 ? `<div class="row row-wrap">${tools.map((tool) => `<span class="badge">${esc(tool)}</span>`).join('')}</div>` : ''}
</div>`;
}

function renderHooksTab() {
const root = tabRoot('plugins', 'hooks');
if (!root) return;
const d = S.hooks.data;
const entries = Array.isArray(d?.entries) ? d.entries : [];
const problems = Array.isArray(d?.problems) ? d.problems : [];
const state = stateOf(S.hooks.loading, S.hooks.error, entries.length === 0, entries.length > 0);
const right = `<div class="row"><span class="badge" data-tone="warn">agent 不可改</span><button class="btn" data-act="hooks-reload">${icon('i-refresh')}重读</button></div>`;
const body = `<div id="hk-entries">${entries
.map(
(entry) => `<div class="field-row" data-hook="${sv(entry?.hook )}">
<div>${sv(entry?.hook )} <span class="badge">${esc(clip(String(entry?.matcher ?? ''), 30))}</span>
<div class="field-hint mono">${sv(entry?.command )}</div>
${entry?.if ? `<div class="field-hint">条件：${esc(String(entry.if))}</div>` : ''}
</div>
<div class="tiny variant mono">超时 ${esc(num(entry?.timeoutMs))}ms</div>
</div>`,
)
.join('')}</div>`;
root.innerHTML = `<div class="page-enter">
${blockCard('hk-list', 'Hook 条目', right, state, {
loading: '正在读钩子配置…',
error: S.hooks.error ?? '钩子配置读取失败',
retry: 'hooks-reload',
emptyIcon: 'i-hook',
emptyTitle: '没有钩子',
emptyHint: `要加就在 ${d?.relative ?? 'data/hooks.json'} 里手写：agent 侧只读。`,
slot: body,
})}
<div class="tiny variant mono" id="hk-path">${esc(String(d?.relative ?? 'data/hooks.json'))}${d?.exists === false ? '（文件不存在 = 没配钩子，正常态）' : ''}</div>
${problems.length > 0 ? `<div class="card" id="hk-problems">${ch('坏条目', '<span class="tv">一条坏配置不该让整份配置失效，但必须说出来</span>')}${problems.map((item) => `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(String(item))}</span></div>`).join('')}</div>` : ''}

</div>`;
}

function renderToolBehaviorTab() {
const root = tabRoot('plugins', 'tools');
if (!root) return;
const d = S.tools.data;
const tools = Array.isArray(d?.tools) ? d.tools : [];
const state = stateOf(S.tools.loading, S.tools.error, tools.length === 0, tools.length > 0);
const right = `<div class="row"><span class="tv">${d === null ? '' : `${tools.length} 件 · destructive：${esc(policyLabel(d.destructivePolicy))}`}</span>
<button class="btn" data-act="tools-reload">${icon('i-refresh')}刷新</button></div>`;
const body = tools
.map(
(tool) => `<div class="field-row" data-side-effect="${sv(tool?.sideEffect )}">
<div>${sv(tool?.name )}
<span class="badge" data-tone="${tool?.sideEffect === 'destructive' ? 'danger' : tool?.sideEffect === 'idempotent' ? 'warn' : ''}">${esc(String(tool?.sideEffect ?? 'none'))}</span>
<span class="badge" data-tone="info">${sv(tool?.executionMode )}</span>
${tool?.fromMcp === true ? '<span class="badge">MCP</span>' : ''}
<div class="field-hint">${sv(tool?.description )}</div>
</div>
<div class="tiny variant mono">超时 ${esc(num(tool?.timeoutMs))}ms</div>
</div>`,
)
.join('');
root.innerHTML = `<div class="page-enter">
${blockCard('tl-list', '工具清单', right, state, {
loading: '正在读工具注册表…',
error: S.tools.error ?? '工具清单读取失败',
retry: 'tools-reload',
emptyIcon: 'i-wrench',
emptyTitle: '观测服务没拿到工具注册表',
emptyHint: '注册表由 real-loop 注入，这个进程读到空清单。',
slot: body,
})}

</div>`;
}

function policyLabel(policy) {
if (policy === true) return '全开';
if (Array.isArray(policy)) return policy.length === 0 ? '按名单（空）' : `按名单（${policy.length} 件）`;
return '全关';
}

// ──────────────────────────────── 数据与日志 · 日志 / 追踪 ────────────────────────────────

function doctorPanelHtml() {
const items = S.doctor.data ?? [];
const body = S.doctor.loading
? `<div class="st-line">${icon('i-refresh')}<span>正在跑不变量自检…</span></div>`
: S.doctor.error
? `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.doctor.error)}</span><button class="btn" data-act="log-doctor">重试</button></div>`
: items.length === 0
? '<div class="tv">还没跑过：点右上角的运行。</div>'
: items
.map(
(item) => `<div class="check-line" data-ok="${item?.ok === true ? 'true' : 'false'}">
<span>${item?.ok === true ? '✓' : '✗'}</span>
<span>${esc(item?.title ?? item?.id ?? '')}</span>
<span class="tiny variant push">${esc(clip(item?.detail ?? '', 60))}</span>
${item?.status && item.status !== 'ok' ? `<span class="tv">${esc(item.status)}</span>` : ''}
</div>`,
)
.join('');
return `<div class="card" id="log-doctor">
${ch('doctor 自检', `<button class="btn" data-act="log-doctor">${icon('i-doctor')}运行</button>`)}
${body}
</div>`;
}

function renderAlarmsTab() {
const root = tabRoot('data', 'logs');
if (!root) return;
const d = S.alarms.data;
const files = Array.isArray(d?.files) ? d.files : [];
const cur = S.alarms.cur;
const listState = stateOf(S.alarms.loading, S.alarms.error, files.length === 0, files.length > 0);
const curState = cur === null ? 'empty' : S.alarms.curLoading ? 'loading' : S.alarms.curError ? 'error' : 'data';
const listBody = `<div class="tree" id="log-files">${files
.map(
(file) => `<button class="tree-item" data-act="alarm-select" data-name="${sv(file?.name )}" data-on="${cur?.name === file?.name ? 'true' : 'false'}">
${icon('i-file')}<span>${sv(file?.name )}</span><span class="badge push">${esc(num(file?.lines))} 行</span>
</button>`,
)
.join('')}</div>
<div class="tv" style="margin-top:8px">共 ${files.length} 份 · 单份读取上限 200k 字符</div>`;
root.innerHTML = `<div class="page-enter">
<div class="split">
${blockCard('log-alarms', '告警落盘', `<button class="btn" data-act="alarms-reload">${icon('i-refresh')}重读</button>`, listState, {
loading: '正在读告警目录…',
error: S.alarms.error ?? '告警目录读取失败',
retry: 'alarms-reload',
emptyIcon: 'i-file',
emptyTitle: '还没有告警落盘',
emptyHint: '第一条告警发出后这个目录才出现。',
slot: listBody,
})}
${blockCard('log-content', `内容 <span class="tiny variant mono">${sv(cur?.name )}</span>`, '', curState, {
loading: '正在读这一份…',
error: S.alarms.curError ?? '读取失败',
retry: 'alarms-reload',
emptyIcon: 'i-file',
emptyTitle: '选一份告警文件',
emptyHint: '左列点一份，这里显示原文。',
slot: `<div class="row tiny variant"><span>${esc(num(cur?.lines))} 行 · ${esc(num(cur?.bytes))} 字节</span>${cur?.mtime ? `<span>· ${esc(stampOf(cur.mtime))}</span>` : ''}${cur?.truncated ? '<span class="badge" data-tone="warn">已截断</span>' : ''}</div>
<div class="code" style="max-height:420px">${sv(cur?.content )}</div>`,
})}
</div>
<div class="tiny variant mono" id="log-dir">${esc(String(d?.relative ?? 'alarms'))}</div>
${doctorPanelHtml()}

</div>`;
}

function renderTraceTab() {
const root = tabRoot('data', 'trace');
if (!root) return;
const turn = S.trace.turn;
const step = S.trace.step;
const turnList = [...new Set(S.events.map((ev) => Number(ev?.data?.turn)).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b).slice(-48);
const stepList = [...new Set(S.events.filter((ev) => String(ev?.data?.turn) === String(turn)).map((ev) => Number(ev?.data?.step)).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
const state = S.replayError ? 'error' : S.replay ? 'data' : turn !== '' ? 'loading' : 'empty';
root.innerHTML = `<div class="page-enter">
<div class="card" id="tr-form">
${ch('重放某一步', '<span class="tv">按当时的日志重建请求体</span>')}
<div class="row row-wrap">
<label class="row tiny variant">turn
<input id="tr-turn" type="number" min="1" step="1" list="tr-turns" value="${esc(turn)}" style="width:120px">
</label>
<datalist id="tr-turns">${turnList.map((value) => `<option value="${esc(value)}"></option>`).join('')}</datalist>
<label class="row tiny variant">step
<input id="tr-step" type="number" min="1" step="1" list="tr-steps" value="${esc(step)}" style="width:120px">
</label>
<datalist id="tr-steps">${stepList.map((value) => `<option value="${esc(value)}"></option>`).join('')}</datalist>
<button class="btn btn-primary" data-act="trace-run">${icon('i-replay')}重建请求体</button>
<button class="btn" data-act="trace-from-last">取最近一步</button>
</div>
<div class="field-hint">turn/step 从已加载事件取；没写进日志的 step 重建不出来。</div>
</div>
${blockCard('tr-result', '请求体与三指纹', '', state, {
loading: `正在重建 turn ${esc(turn)} step ${esc(step)} 的请求体…`,
error: S.replayError ?? '重放数据读取失败',
retry: 'trace-run',
emptyIcon: 'i-replay',
emptyTitle: '先选一步',
emptyHint: '填 turn 与 step，这里显示当时的请求体。',
slot: `<div class="stack" id="tr-fingerprints">${S.replay ? replayBodyHtml(S.replay, turn, step) : ''}</div>`,
})}

</div>`;
}

// ──────────────────────────────── 更多功能 / 设置 ────────────────────────────────

function moreToolsHtml() {
const proj = S.proj;
return `<div class="tool-grid" id="more-grid">
<div class="tool-cell">
<b>导出日志段</b>
<div class="row"><input type="number" id="more-export-from" placeholder="from" style="width:120px"><input type="number" id="more-export-to" placeholder="to" style="width:120px"></div>
<button class="btn" data-act="more-export">${icon('i-export')}导出</button>
</div>
<div class="tool-cell">
<b>备份快照</b>
<button class="btn" data-act="more-backup">${icon('i-backup')}立即备份</button>
</div>
<div class="tool-cell">
<b>归档管理</b>
<button class="btn" data-act="more-archive">${icon('i-archive')}立即归档</button>
</div>
<div class="tool-cell">
<b>连通性</b>
<button class="btn" data-act="more-webhook-test">${icon('i-ping')}webhook 测试</button>
<button class="btn" data-act="more-ping">${icon('i-ping')}端点 ping</button>
</div>
</div>`;
}

function renderMoreTab() {
const root = tabRoot();
if (!root || S.page !== 'more') return;
root.innerHTML = `<div class="page-enter">
${moreToolsHtml()}

</div>`;
}

function setUiHtml() {
return `<div class="card" id="set-ui">
${ch('界面', '<span class="tv">即时生效</span>')}
<div class="field-row">
<div>明暗模式 <span class="field-hint">仅本地偏好，即时生效；不进配置、不影响渲染指纹</span></div>
<div class="seg" id="set-theme">
<button data-act="ctl-theme" data-theme-value="light" data-on="${S.theme === 'light' ? 'true' : 'false'}">亮</button>
<button data-act="ctl-theme" data-theme-value="dark" data-on="${S.theme === 'dark' ? 'true' : 'false'}">暗</button>
</div>
</div>
<div class="field-row">
<div>当前主题 <span class="field-hint">存 localStorage；首启跟随系统偏好</span></div>
<div class="mono tiny">${esc(S.theme)}</div>
</div>
</div>`;
}

function settingsSystemHtml() {
const cfg = S.ctl.cfg ?? {};
const rows = [
{ label: '数据目录', value: String(cfg.dataDir ?? '—'), restart: true },
{ label: '时区', value: String(cfg.timezone ?? '—'), restart: true },
{ label: '绑定地址', value: String(cfg.web?.host ?? '—'), restart: true },
{ label: '监听端口', value: String(cfg.web?.port ?? '—'), restart: true },
{ label: '配置 schema 版本', value: String(cfg.schemaVersion ?? '—'), restart: false },
{ label: 'destructive 策略', value: policyLabel(cfg.tools?.destructiveEnabled), restart: false },
];
return `<div class="page-enter">
<div class="card" id="set-system">
${ch('系统', '<span class="tv">只读；改这些请去配置文件 · 平台配置</span>')}
${rows
.map(
(row) => `<div class="field-row">
<div>${esc(row.label)} ${row.restart ? '<span class="badge" data-tone="warn">需重启</span>' : ''}</div>
<div class="mono tiny">${esc(row.value)}</div>
</div>`,
)
.join('')}
</div>

</div>`;
}

function settingsAboutHtml() {
const proj = S.proj;
const cfg = S.ctl.cfg ?? {};
const days = proj?.firstEventAt ? daysSince(proj.firstEventAt) : null;
return `<div class="page-enter">
<div class="card" id="set-about">
${ch('关于', '<span class="tv">零构建前端：这三个文件就是全部</span>')}
<div class="field-row"><div>已守护</div><div class="mono">${days === null ? '—' : `${num(days)} 天`}${proj?.firstEventAt ? `（自 ${esc(stampOf(proj.firstEventAt))}）` : ''}</div></div>
<div class="field-row"><div>事件水位</div><div class="mono">${esc(num(proj?.watermark))}</div></div>
<div class="field-row"><div>配置 schema 版本</div><div class="mono">${esc(String(cfg.schemaVersion ?? '—'))}</div></div>
<div class="field-row"><div>数据目录</div><div class="mono">${esc(String(cfg.dataDir ?? '—'))}</div></div>
</div>
</div>`;
}

function renderSettingsTab() {
const root = tabRoot();
if (!root || S.page !== 'settings') return;
if (S.tab === 'system') {
root.innerHTML = settingsSystemHtml();
return;
}
if (S.tab === 'about') {
root.innerHTML = settingsAboutHtml();
return;
}
root.innerHTML = `<div class="page-enter">
${setUiHtml()}
</div>`;
}

// ──────────────────────────────── 配置文件页 ────────────────────────────────

function destructivePolicy() {
if (S.ctl.draft.has('tools.destructiveEnabled')) return S.ctl.draft.get('tools.destructiveEnabled');
return getPath(S.ctl.cfg ?? {}, 'tools.destructiveEnabled');
}

function cfgFieldHtml(groupId, f) {
const value = getPath(S.ctl.cfg ?? {}, f.p);
const draft = S.ctl.draft.get(f.p);
const shown = draft !== undefined ? draft : value;
const dis = f.d === 1 ? 'disabled' : '';
const restart = f.s === 1 ? '<span class="badge" data-tone="warn">需重启</span>' : '';
const pending = f.d === 1 ? '<span class="badge">字段待落地</span>' : '';
const hint = f.h ? `<div class="field-hint">${esc(f.h)}</div>` : '';
let control = '';
if (f.k === 'toggle') {
control = `<button class="toggle" role="switch" aria-checked="${shown === true}" data-act="ctl-toggle" data-path="${esc(f.p)}" ${dis}></button>`;
} else if (f.k === 'lines') {
control = `<textarea rows="4" data-act="ctl-edit" data-path="${esc(f.p)}" data-kind="lines" ${dis}>${esc(Array.isArray(shown) ? shown.join('\n') : String(shown ?? ''))}</textarea>`;
} else if (f.k === 'secret') {
const text = String(shown ?? '');
const revealed = S.ctl.reveal.has(f.p);
control = `<div class="row"><span class="mono tiny">${esc(revealed ? text : text.replace(/[A-Za-z0-9]/g, '•'))}</span><button class="btn btn-quiet" data-act="ctl-reveal" data-path="${esc(f.p)}">${revealed ? '隐藏' : '显示'}</button></div>`;
} else if (f.k === 'number') {
control = `<input type="number" value="${esc(shown ?? '')}" data-act="ctl-edit" data-path="${esc(f.p)}" data-kind="number" ${dis}>`;
} else {
control = `<input type="text" value="${esc(shown ?? '')}" data-act="ctl-edit" data-path="${esc(f.p)}" data-kind="text" ${dis}>`;
}
return `<div class="field-row" data-group="${esc(groupId)}"><div>${esc(f.l)} ${restart}${pending}${hint}</div><div>${control}</div></div>`;
}

function cfgGroupHtml(group) {
if (group.kind === 'toolset') return cfgToolsetHtml();
const fields = group.fields ?? [];
if (fields.length === 0) return '';
const dirty = fields.filter((f) => S.ctl.draft.has(f.p)).length;
return `<div class="card block" data-state="data" id="cfg-group-${esc(group.id)}">
${ch(group.name, `<span class="tv">${dirty > 0 ? `${dirty} 项待保存` : '与落盘一致'}</span>`)}
<div data-slot="data">${fields.map((f) => cfgFieldHtml(group.id, f)).join('')}</div>
</div>`;
}

function cfgToolsetHtml() {
const raw = destructivePolicy();
const mode = raw === true ? 'all' : Array.isArray(raw) ? 'list' : 'off';
const list = Array.isArray(raw) ? raw.map(String) : [];
const destructive = (S.tools.data?.tools ?? []).filter((item) => item?.sideEffect === 'destructive');
const rows = S.tools.loading
? `<div class="st-line">${icon('i-refresh')}<span>正在读工具清单…</span></div>`
: S.tools.error
? `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.tools.error)}</span></div>`
: destructive.length === 0
? '<div class="muted-block">注册表里没有 destructive 工具。</div>'
: destructive
.map(
(item) => `<div class="field-row">
<div>${esc(item.name)} <span class="field-hint">${esc(item.executionMode === 'exclusive' ? '独占执行' : '可并行')} · ${esc(clip(item.description, 60))}</span></div>
<div><button class="toggle" role="switch" aria-checked="${mode === 'all' || list.includes(item.name) ? 'true' : 'false'}" data-act="cfg-destructive-tool" data-name="${esc(item.name)}" ${mode === 'all' ? 'disabled' : ''}></button></div>
</div>`,
)
.join('');
const summary = mode === 'all' ? '全开：所有 destructive 工具都进模型清单' : mode === 'list' ? `按名单：只放行 ${list.length} 件` : '全关：一件都不进模型清单';
return `<div class="card block" data-state="data" id="cfg-toolset">
${ch('tools.destructiveEnabled', '<span class="tv">写回配置的就是这一个字段</span>')}
<div class="row row-wrap" style="margin-bottom:8px">
<div class="seg" id="cfg-destructive-mode">
<button data-act="cfg-destructive-mode" data-mode="off" data-on="${mode === 'off' ? 'true' : 'false'}">全关</button>
<button data-act="cfg-destructive-mode" data-mode="all" data-on="${mode === 'all' ? 'true' : 'false'}">全开</button>
<button data-act="cfg-destructive-mode" data-mode="list" data-on="${mode === 'list' ? 'true' : 'false'}">按名单</button>
</div>
<span class="tiny variant push">${esc(summary)}</span>
</div>
${rows}
<div class="tv" style="margin-top:8px">危险字段：提交自动带 X-Confirm 短语 enable-destructive。</div>
</div>`;
}

function renderConfigTab() {
const root = tabRoot();
if (!root || S.page !== 'config') return;
const tab = CFG_TABS.find((item) => item.id === S.tab) ?? CFG_TABS[0];
const dirty = S.ctl.draft.size;
const body =
S.ctl.cfg === null
? section(S.ctl.cfgError ? 'error' : 'loading', '', { error: S.ctl.cfgError ?? undefined, loading: '正在读取配置…', retry: 'ctl-reload' })
: `<div class="stack" id="cfg-panel">${tab.groups.map(cfgGroupHtml).join('')}</div>`;
root.innerHTML = `<div class="page-enter">
<div class="card" id="cfg-path-card">
${ch('配置文件', `<span class="tv">${dirty > 0 ? `${dirty} 项待保存` : '与落盘配置一致'}</span>`)}
<div class="row row-wrap tiny variant">
<span class="mono" id="cfg-path">config.json</span>
<span>· 数据目录 <span class="mono">${esc(String(S.ctl.cfg?.dataDir ?? '—'))}</span></span>
<span>· 密钥只留环境变量名</span>
</div>
<div class="field-hint">${esc(tab.hint ?? '')}</div>
</div>
${body}
<p class="footnote">拦截在执行器层生效，这里的开关只是给人看的门。</p>
</div>`;
}

// ──────────────────────────────── 门、确认框、对话框 ────────────────────────────────

function renderGate() {
const gate = document.getElementById('token-gate');
if (!gate) return;
gate.hidden = S.token !== null;
if (S.token === null) {
const input = document.getElementById('token-input');
if (input) input.focus();
}
}

function renderGateError(message) {
const el = document.getElementById('token-error');
if (!el) return;
el.hidden = !message;
el.textContent = message ?? '';
}

function openConfirm({ title, body, phrase, okLabel, onOk }) {
const dialog = document.getElementById('confirm-dialog');
const phraseEl = document.getElementById('confirm-phrase');
const input = document.getElementById('confirm-phrase-input');
const ok = document.getElementById('confirm-ok');
if (!dialog || !phraseEl || !input || !ok) return;
document.getElementById('confirm-title').textContent = title;
document.getElementById('confirm-body').textContent = body;
phraseEl.textContent = phrase ?? '（本操作不需要短语）';
input.value = '';
ok.textContent = okLabel ?? '执行';
ok.disabled = Boolean(phrase);
dialog.hidden = false;
ok.onclick = () => {
dialog.hidden = true;
void onOk();
};
window.__confirmPhrase = phrase ?? null;
input.focus();
}

function closeConfirm() {
const dialog = document.getElementById('confirm-dialog');
if (dialog) dialog.hidden = true;
window.__confirmPhrase = null;
}

function confirmPhraseInput() {
const input = document.getElementById('confirm-phrase-input');
const ok = document.getElementById('confirm-ok');
if (!input || !ok) return;
const want = window.__confirmPhrase;
ok.disabled = Boolean(want) && input.value.trim() !== want;
}

// ──────────────────────────────── 交互分派 ────────────────────────────────

function reviewNote(callId) {
const el = document.querySelector(`[data-role="review-note"][data-call="${CSS.escape(callId)}"]`);
return el && typeof el.value === 'string' ? el.value : '';
}

async function handleAction(act, el) {
const btn = el;
switch (act) {
case 'wake': {
await command('wake', { note: '来自运维台的手动唤醒' }, { btn, done: '已注入手动唤醒' });
return;
}
case 'wake-menu': {
const wrap = document.getElementById('stat-timers');
if (!wrap) return;
wrap.hidden = false;
wrap.innerHTML = timerMenuHtml(S.proj);
return;
}
case 'timer-cancel': {
return writeCommand('timer-cancel', { timerId: btn.dataset.id }, {
btn,
title: '取消定时器',
body: `取消后 ${btn.dataset.id} 不会再触发（保留已触发的历史）。`,
done: '定时器已取消',
});
}
case 'review-resolve': {
const callId = btn.dataset.call;
await command('review-resolve', { callId, outcome: btn.dataset.outcome, note: reviewNote(callId) }, { btn, done: '已结案并写进日志' });
return;
}
case 'dead-requeue': {
return writeCommand('requeue', { inputSeq: Number(btn.dataset.seq) }, {
btn,
title: '重新入队',
body: `输入 ${btn.dataset.seq} 会拿一次完整的新机会（认领计数归零）。`,
done: '已重新入队',
});
}
case 'dead-discard': {
await command('dead-discard', { inputSeq: Number(btn.dataset.seq) }, { btn });
return;
}
case 'open-budget': {
gotoHash('#/data/stats', 'stat-budget');
return;
}
case 'budget-range': {
S.budget.range = btn.dataset.range === '7d' ? '7d' : 'today';
paintBudgetTab();
void loadBudget();
return;
}
case 'retry-stats':
case 'retry-overview': {
void loadProjection();
void loadDashboard();
void loadEvents({ reset: true });
if (S.budget.data === null) void loadBudget();
return;
}
case 'retry-budget': {
void loadBudget();
return;
}
case 'go-tab': {
gotoHash(hashOf(btn.dataset.page, btn.dataset.tab));
return;
}
case 'goto-events': {
gotoHash('#/data/events');
return;
}
case 'goto-logs': {
gotoHash('#/data/logs');
return;
}
case 'goto-trace': {
gotoHash('#/data/trace');
return;
}
case 'goto-plugins': {
gotoHash('#/plugins/skills');
return;
}
case 'goto-config': {
gotoHash('#/config');
return;
}
case 'goto-persona': {
gotoHash('#/persona');
return;
}
case 'goto-more': {
gotoHash('#/more');
return;
}
case 'goto-settings': {
gotoHash('#/settings/ui');
return;
}
case 'goto-review': {
gotoHash('#/data/events', 'ev-banner');
return;
}
case 'goto-replay': {
const last = S.events[S.events.length - 1];
const turn = Number(last?.data?.turn);
const step = Number(last?.data?.step);
if (Number.isFinite(turn) && Number.isFinite(step)) {
S.trace = { turn: String(turn), step: String(step) };
void loadReplay(turn, step);
}
gotoHash('#/data/trace');
return;
}
case 'suggest-dismiss': {
S.dismissed.add(String(btn.dataset.id));
saveDismissed();
renderStatsTab();
return;
}
case 'type-toggle':
case 'visibility':
case 'ev-follow':
case 'ev-jump':
case 'ev-reload':
case 'ev-clear-filter':
case 'ev-earlier': {
await handleEventFilterAction(act, el);
return;
}
case 'ev-row': {
const seq = Number(btn.dataset.seq);
S.openSeq = S.openSeq === seq ? null : seq;
S.replay = null;
S.replayError = null;
paintRows();
const spacer = document.getElementById('ev-spacer');
if (spacer) spacer.style.height = `${S.events.length * ROW_H + (S.openSeq !== null ? EXPAND_H : 0)}px`;
const ev = S.seqIndex.get(seq);
if (S.openSeq !== null && ev && typeof ev?.data?.turn === 'number' && typeof ev?.data?.step === 'number') {
void loadReplay(ev.data.turn, ev.data.step);
}
return;
}
case 'ev-copy': {
const ev = S.seqIndex.get(Number(btn.dataset.seq));
if (ev) {
await navigator.clipboard?.writeText(JSON.stringify(ev, null, 2));
toast('事件 JSON 已复制');
}
return;
}
case 'ev-replay': {
await loadReplay(Number(btn.dataset.turn), Number(btn.dataset.step));
return;
}
case 'ev-expand-msg': {
const code = btn.parentElement?.querySelector('.code');
if (code && code.dataset.collapsed === 'true') {
code.dataset.collapsed = 'false';
btn.remove();
}
return;
}
case 'ev-export-json': {
const blob = new Blob([JSON.stringify(S.replay ?? {}, null, 2)], { type: 'application/json' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `replay-turn${btn.dataset.turn}-step${btn.dataset.step}.json`;
a.click();
URL.revokeObjectURL(url);
return;
}
case 'ev-diff': {
const fp = S.replay?.fingerprints;
if (!fp || typeof fp !== 'object') {
toast('还没有重放数据：先重建一次请求体', 'danger');
return;
}
S.replay = Object.assign({}, S.replay, { diff: fingerprintDiff(fp) });
paintRows();
if (atTab('data', 'trace')) renderTraceTab();
toast('已算出与当前渲染的指纹差异');
return;
}
case 'ev-goto-seq': {
S.openSeq = Number(btn.dataset.seq);
gotoHash('#/data/events');
return;
}
case 'persona-file': {
await selectPersonaFile(btn.dataset.path);
return;
}
case 'persona-reload': {
void loadPersonaFiles();
void loadPersonaHistory();
if (S.persona.cur) void selectPersonaFile(S.persona.cur.path);
return;
}
case 'persona-approve': {
await writeCommand('persona-approve', { file: btn.dataset.file, diffHash: btn.dataset.hash ?? '' }, {
btn,
title: '批准人格提案',
body: `批准后 ${btn.dataset.file} 会被提案内容覆盖，并写一条 persona/updated（by: human）。`,
done: '提案已批准，人格已更新',
});
void selectPersonaFile(btn.dataset.file);
void loadPersonaFiles();
void loadPersonaHistory();
return;
}
case 'persona-reject': {
await command('persona-reject', { file: btn.dataset.file, diffHash: btn.dataset.hash ?? '' }, { btn, done: '提案已拒绝' });
void selectPersonaFile(btn.dataset.file);
void loadPersonaFiles();
void loadPersonaHistory();
return;
}
case 'persona-proposal-view': {
await selectPersonaFile(`proposals/${btn.dataset.file}`);
return;
}
case 'persona-diff': {
toast(`diff ${btn.dataset.file} @ ${String(btn.dataset.hash).slice(0, 8)}：用 CLI persona diff 取全文`);
return;
}
case 'skills-reload': {
void loadSkills();
return;
}
case 'skill-confirm': {
const name = String(btn.dataset.name ?? '');
await writeCommand('skill-confirm', { name }, {
btn,
title: '确认这个技能',
body: `写一条 skill/installed（by: human），${name} 才会进 catalog。`,
done: '已确认，技能进 catalog',
});
void loadSkills();
return;
}
case 'skill-ignore': {
S.skills.ignored.add(String(btn.dataset.name ?? ''));
saveIgnored();
renderSkillsTab();
renderRailBadges();
return;
}
case 'skill-restore': {
S.skills.ignored.delete(String(btn.dataset.name ?? ''));
saveIgnored();
renderSkillsTab();
renderRailBadges();
return;
}
case 'mcp-reload': {
void loadMcp();
return;
}
case 'hooks-reload': {
void loadHooks();
return;
}
case 'tools-reload': {
void loadTools();
return;
}
case 'alarms-reload': {
S.alarms.cur = null;
S.alarms.curError = null;
void loadAlarms();
return;
}
case 'alarm-select': {
await selectAlarm(String(btn.dataset.name ?? ''));
return;
}
case 'trace-run': {
const turn = Number(document.getElementById('tr-turn')?.value ?? NaN);
const step = Number(document.getElementById('tr-step')?.value ?? NaN);
if (!Number.isFinite(turn) || !Number.isFinite(step)) {
toast('先填 turn 与 step（都是数字）', 'danger');
return;
}
S.trace = { turn: String(turn), step: String(step) };
await loadReplay(turn, step);
return;
}
case 'trace-from-last': {
const last = [...S.events].reverse().find((ev) => typeof ev?.data?.turn === 'number' && typeof ev?.data?.step === 'number');
if (!last) {
toast('日志里还没有带 turn/step 的事件', 'danger');
return;
}
S.trace = { turn: String(last.data.turn), step: String(last.data.step) };
await loadReplay(last.data.turn, last.data.step);
return;
}
case 'log-doctor': {
await runDoctor();
return;
}
case 'more-export': {
const from = Number(document.getElementById('more-export-from')?.value ?? 0);
const to = Number(document.getElementById('more-export-to')?.value ?? 0);
await command('export', { from, to }, { btn, done: '导出任务已受理' });
return;
}
case 'more-backup': {
await command('backup', {}, { btn, done: '备份任务已受理' });
return;
}
case 'more-archive': {
await command('archive-now', {}, { btn, done: '归档任务已受理' });
return;
}
case 'more-webhook-test': {
await command('webhook-test', { url: getPath(S.ctl.cfg ?? {}, 'alerts.webhookUrl') ?? '' }, { btn, done: '测试消息已发出' });
return;
}
case 'more-ping': {
await command('ping', { lane: 'heavy' }, { btn, done: '连通性结果见 toast/事件' });
return;
}
case 'ctl-reload': {
void loadConfig();
return;
}
case 'ctl-toggle': {
const path = btn.dataset.path;
const now = btn.getAttribute('aria-checked') === 'true';
const fieldPhrase = DANGEROUS_FIELDS[path];
if (!now && fieldPhrase !== undefined) {
openConfirm({
title: '开启 destructive 工具',
body: '开启后 Agent 可执行破坏性动作。拦截仍在执行器层，但门开了。',
phrase: fieldPhrase,
okLabel: '开启',
onOk: () => {
S.ctl.draft.set(path, true);
renderConfigTab();
renderSaveFab();
},
});
return;
}
S.ctl.draft.set(path, !now);
renderConfigTab();
renderSaveFab();
return;
}
case 'ctl-edit': {
const raw = btn.value;
S.ctl.draft.set(btn.dataset.path, btn.dataset.kind === 'lines' ? raw.split('\n').map((line) => line.trim()).filter(Boolean) : btn.dataset.kind === 'number' ? Number(raw) : raw);
renderSaveFab();
return;
}
case 'ctl-reveal': {
const path = btn.dataset.path;
if (S.ctl.reveal.has(path)) S.ctl.reveal.delete(path);
else S.ctl.reveal.add(path);
renderConfigTab();
return;
}
case 'cfg-destructive-mode': {
const mode = btn.dataset.mode;
if (mode === 'all') {
openConfirm({
title: '全开 destructive 工具',
body: '全开后所有 destructive 工具都进模型清单。拦截仍在执行器层，但门全开了。',
phrase: DANGEROUS_FIELDS['tools.destructiveEnabled'],
okLabel: '全开',
onOk: () => {
S.ctl.draft.set('tools.destructiveEnabled', true);
renderConfigTab();
renderSaveFab();
},
});
return;
}
const current = destructivePolicy();
S.ctl.draft.set('tools.destructiveEnabled', mode === 'off' ? false : Array.isArray(current) ? current.map(String) : []);
renderConfigTab();
renderSaveFab();
return;
}
case 'cfg-destructive-tool': {
const current = destructivePolicy();
const list = new Set(Array.isArray(current) ? current.map(String) : []);
const name = String(btn.dataset.name ?? '');
if (list.has(name)) list.delete(name);
else list.add(name);
S.ctl.draft.set('tools.destructiveEnabled', [...list]);
renderConfigTab();
renderSaveFab();
return;
}
case 'ctl-save': {
const fields = {};
for (const [path, value] of S.ctl.draft) setPath(fields, path, value);
// 字段级危险：改"它能碰什么"时，X-Confirm 要追加 DANGEROUS_FIELDS 里的短语
const fieldPhrases = [...S.ctl.draft.entries()]
.filter(([path, value]) => DANGEROUS_FIELDS[path] !== undefined && value !== false && !(Array.isArray(value) && value.length === 0))
.map(([path]) => DANGEROUS_FIELDS[path]);
const count = S.ctl.draft.size;
await writeCommand('config-update', { fields }, {
btn,
fieldPhrases,
title: '保存配置改动',
body: `将一次性提交 ${count} 个字段 → 写一条 config/changed；校验失败会原样回滚。`,
done: '已生效并落日志',
});
S.ctl.draft = new Map();
renderSaveFab();
void loadConfig();
return;
}
case 'ctl-theme': {
applyTheme(btn.dataset.themeValue === 'dark' ? 'dark' : 'light');
renderTabBody();
return;
}
case 'open-turn': {
S.filters.types = new Set(['budget/consumed', 'turn/end']);
gotoHash('#/data/events');
void loadEvents({ reset: true });
return;
}
default:
return;
}
}

function fingerprintDiff(fp) {
return [
`renderVersion  ${fp.renderVersion ?? '—'}`,
`personaHash    ${fp.personaHash ?? '—'} → 当前 ${fp.currentPersonaHash || '（取不到）'}${fp.personaChanged ? '   ← 变了' : '   = 一致'}`,
`configHash     ${fp.configHash || '—'}${fp.configChanged ? '   ← 与当前配置不一致' : '   = 与当前一致'}`,
'',
fp.personaChanged || fp.configChanged
? '结论：人格或配置之后变了，重建的请求体与当下不同。'
: '结论：三指纹一致，重建的请求体就是当下那一份。',
].join('\n');
}

async function handleEventFilterAction(act, el) {
if (act === 'type-toggle') {
if (el.checked) S.filters.types.add(el.value);
else S.filters.types.delete(el.value);
} else if (act === 'visibility') {
S.filters.visibility = el.value;
} else if (act === 'ev-follow') {
S.filters.follow = el.checked;
if (el.checked) {
S.newCount = 0;
renderNewbar();
}
} else if (act === 'ev-jump') {
const seq = Number(document.getElementById('ev-jump-input')?.value ?? 0);
if (Number.isFinite(seq) && seq > 0) {
if (S.seqIndex.has(seq)) {
S.openSeq = seq;
paintRows();
const row = document.querySelector(`[data-act="ev-row"][data-seq="${seq}"]`);
if (row) row.scrollIntoView({ block: 'center' });
} else {
await loadEvents({ reset: true, fromSeq: Math.max(0, seq - BATCH) });
}
}
return;
} else if (act === 'ev-reload') {
S.events = [];
S.seqIndex = new Map();
await loadEvents({ reset: true });
return;
} else if (act === 'ev-clear-filter') {
S.filters.types = new Set();
S.filters.visibility = 'all';
S.events = [];
S.seqIndex = new Map();
await loadEvents({ reset: true });
return;
} else if (act === 'ev-earlier') {
if (S.evCursor !== null) await loadEvents({ reset: false, cursor: S.evCursor });
return;
}
renderEventsTab();
}

function applyTheme(theme) {
S.theme = theme;
document.documentElement.dataset.theme = theme;
localStorage.setItem(THEME_KEY, theme);
}

// ──────────────────────────────── 事件绑定与启动 ────────────────────────────────

function bind() {
document.addEventListener('click', (event) => {
const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
if (!target) return;
const act = target.dataset.act;
if (!act) return;
if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
event.preventDefault();
void handleAction(act, target);
});

document.addEventListener('change', (event) => {
const target = event.target;
if (!(target instanceof Element)) return;
const el = target.closest('[data-act]');
if (!el) return;
const act = el.dataset.act;
if (act === 'type-toggle' || act === 'visibility' || act === 'ev-follow') void handleEventFilterAction(act, el);
});

document.addEventListener('input', (event) => {
const target = event.target;
if (target instanceof HTMLInputElement && target.id === 'confirm-phrase-input') confirmPhraseInput();
if (target instanceof Element && target.closest('[data-act="ctl-edit"]')) void handleAction('ctl-edit', target);
});

document.getElementById('confirm-cancel')?.addEventListener('click', closeConfirm);
document.getElementById('token-form')?.addEventListener('submit', async (event) => {
event.preventDefault();
const input = document.getElementById('token-input');
const value = input && typeof input.value === 'string' ? input.value.trim() : '';
if (value === '') {
renderGateError('先粘贴令牌再连接。');
return;
}
setToken(value);
const res = await api(EP.projection);
if (!res.ok) {
setToken(null);
renderGateError(res.error?.message ?? '连接失败');
return;
}
S.proj = res.data;
S.projLoading = false;
renderGateError(null);
await bootData();
});

window.addEventListener('hashchange', () => {
route();
renderChrome();
void renderTabBody();
});
}

async function bootData() {
renderChrome();
await Promise.all([renderTabBody(), loadProjection(), loadDashboard(), loadEvents({ reset: true })]);
void startStream();
}

function boot() {
S.dismissed = loadDismissed();
S.skills.ignored = loadIgnored();
const storedTheme = localStorage.getItem(THEME_KEY);
applyTheme(storedTheme === 'dark' ? 'dark' : storedTheme === 'light' ? 'light' : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
S.token = localStorage.getItem(TOKEN_KEY);
route();
bind();
renderGate();
renderChrome();
renderRailBadges();
if (!S.token) {
void renderTabBody();
return;
}
void (async () => {
const res = await api(EP.projection);
if (!res.ok) {
renderGateError(res.error?.message ?? '令牌失效');
renderGate();
void renderTabBody();
return;
}
S.proj = res.data;
S.projLoading = false;
renderGateError(null);
await bootData();
})();
}

boot();

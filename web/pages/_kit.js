/**
 * 页面公共基元 —— 五页（人格 / 消息适配器 / 扩展 / 日志 / 设置）共用的一份工具
 *
 * 纪律（与运维台同一条，不动摇）：
 *   ① 所有动态文本先过 esc：事件内容来自外部输入，一律当不可信数据；
 *   ② 图标来自内联 sprite（壳只带 her-mark），零外链；
 *   ③ 四态统一走 app.css 的 .block[data-state]（loading / error / empty / data）；
 *   ④ 壳的约定：export function init(el, ctx)，ctx = { api(path, opts), token }。
 */

// ──────────────────────────────── 图标 sprite ────────────────────────────────
// 从运维台（web/ops.html）迁过来的同一套线框符号：换壳不换脸。
const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false">
<symbol id="i-chat" viewBox="0 0 24 24"><path d="M4 5h16v11H10l-6 4z" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-chat-f" viewBox="0 0 24 24"><path d="M4 5h16v11H10l-6 4z" fill="currentColor"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-sliders-f" viewBox="0 0 24 24"><path d="M4 5h16v2H4zM4 11h16v2H4zM4 17h16v2H4z" fill="currentColor"/><path d="M9 4v4M15 10v4M7 16v4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-puzzle" viewBox="0 0 24 24"><path d="M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-12 0zM12 18v3" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-puzzle-f" viewBox="0 0 24 24"><path d="M6 7h12v5a6 6 0 0 1-12 0z" fill="currentColor"/><path d="M9 3v4M15 3v4M12 18v3" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-database" viewBox="0 0 24 24"><path d="M5 7c0-1.5 3-3 7-3s7 1.5 7 3-3 3-7 3-7-1.5-7-3zM5 7v10c0 1.5 3 3 7 3s7-1.5 7-3V7" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-database-f" viewBox="0 0 24 24"><path d="M12 4c4 0 7 1.5 7 3v10c0 1.5-3 3-7 3s-7-1.5-7-3V7c0-1.5 3-3 7-3z" fill="currentColor"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-user-f" viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0z" fill="currentColor"/></symbol>
<symbol id="i-grid" viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-grid-f" viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="currentColor"/></symbol>
<symbol id="i-cog" viewBox="0 0 24 24"><path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-cog-f" viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-shield-f" viewBox="0 0 24 24"><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" fill="currentColor"/></symbol>
<symbol id="i-list" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor"/></symbol>
<symbol id="i-timer" viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 13l4 4 10-11" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4l9 16H3zM12 10v4M12 17h.01" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8h.01" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-3-6M20 4v5h-5" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-export" viewBox="0 0 24 24"><path d="M12 4v10M8 8l4-4 4 4M5 20h14" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-backup" viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 10h16" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-doctor" viewBox="0 0 24 24"><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6zM9 12l2 2 4-4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-chevron" viewBox="0 0 24 24"><path d="M8 10l4 4 4-4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><path d="M9 9h10v10H9zM5 15V5h10" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-replay" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2-5M4 4v4h4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-archive" viewBox="0 0 24 24"><path d="M4 6h16v4H4zM6 10v10h12V10M10 14h4" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-ping" viewBox="0 0 24 24"><path d="M4 12h4l2-4 3 8 3-6 2 2h2" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-save" viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5zM8 4v6h7V4M8 20v-6h8v6" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-hook" viewBox="0 0 24 24"><path d="M12 3v9a5 5 0 0 0 10 0v-2M12 3h3M12 3H9" fill="none" stroke="currentColor"/></symbol>
<symbol id="i-wrench" viewBox="0 0 24 24"><path d="M14 6a4 4 0 1 1 4 4l-9 9-3-3 9-9z" fill="none" stroke="currentColor"/></symbol>
</svg>`;

/** 把图标符号注入文档（一次；壳只带 her-mark，符号集归页面层） */
export function mountSprite() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('irmia-sprite') !== null) return;
  const host = document.createElement('div');
  host.id = 'irmia-sprite';
  host.innerHTML = SPRITE;
  document.body.appendChild(host);
}

// ──────────────────────────────── 文本与格式化 ────────────────────────────────

/** 所有动态文本的唯一出口（XSS 面收在一处） */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** esc 的短别名：模板里出现频率太高，名字短一点读起来更像句子 */
export function sv(v) {
  return esc(String(v ?? ''));
}

export function clip(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function icon(id, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

export function num(value, fallback = '—') {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : fallback;
}

export function pct(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

export function timeOf(iso) {
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function stampOf(iso) {
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? '未知时刻' : d.toLocaleString('zh-CN', { hour12: false });
}

export function daysSince(iso) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

export function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur !== null && typeof cur === 'object' ? cur[key] : undefined), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 数组化：端点返回 {items:[…]} 还是裸数组，两种都吃 */
export function listOf(payload, key) {
  if (Array.isArray(payload)) return payload;
  const inner = payload !== null && typeof payload === 'object' ? payload[key] : null;
  return Array.isArray(inner) ? inner : [];
}

// ──────────────────────────────── 四态渲染基元 ────────────────────────────────

export function stateOf(loading, error, empty, hasData) {
  if (loading && !hasData) return 'loading';
  if (error && !hasData) return 'error';
  return hasData ? 'data' : 'empty';
}

export function ch(title, right = '') {
  return `<div class="card-head"><h3 class="card-title">${title}</h3>${right}</div>`;
}

/** 四态槽位：.block[data-state] 由 app.css 决定谁可见 */
export function slots(o = {}) {
  const retry = o.retry ? `<button class="btn" data-act="${esc(o.retry)}">重试</button>` : '';
  const act = o.emptyAct ? `<button class="btn btn-primary" data-act="${esc(o.emptyAct.act)}">${esc(o.emptyAct.label)}</button>` : '';
  return `<div class="st-line" data-slot="loading">${icon('i-refresh')}<span>${esc(o.loading ?? '正在读取…')}</span></div>
<div class="st-line st-error" data-slot="error">${icon('i-alert')}<span class="st-msg">${esc(o.error ?? '读取失败')}</span>${retry}</div>
<div class="st-empty" data-slot="empty">${icon(o.emptyIcon ?? 'i-info', 'icon icon-lg')}<div class="st-title">${esc(o.emptyTitle ?? '暂无数据')}</div><p>${esc(o.emptyHint ?? '')}</p>${act}</div>
<div data-slot="data">${o.slot ?? ''}</div>`;
}

export function blockCard(id, title, right, state, opts = {}) {
  return `<div class="card block" data-state="${state}" id="${esc(id)}">${ch(title, right)}${slots(opts)}</div>`;
}

export function section(state, slot, opts = {}) {
  const retry = opts.retry ? `<button class="btn" data-act="${esc(opts.retry)}">重试</button>` : '';
  const emptyAct = opts.emptyAction ? `<button class="btn btn-primary" data-act="${esc(opts.emptyAction.act)}">${esc(opts.emptyAction.label)}</button>` : '';
  const idAttr = opts.id ? ` id="${esc(opts.id)}"` : '';
  return `<div class="block ${opts.cls ?? ''}" data-state="${state}"${idAttr}>
<div class="st-line" data-slot="loading">${icon('i-refresh')}<span>${esc(opts.loading ?? '正在读取…')}</span></div>
<div class="st-line st-error" data-slot="error">${icon('i-alert')}<span class="st-msg">${esc(opts.error ?? '读取失败')}</span>${retry}</div>
<div class="st-empty" data-slot="empty">${icon(opts.emptyIcon ?? 'i-info', 'icon icon-lg')}<div class="st-title">${esc(opts.emptyTitle ?? '暂无数据')}</div><p>${esc(opts.emptyHint ?? '')}</p>${emptyAct}</div>
<div data-slot="data">${slot}</div>
</div>`;
}

// ──────────────────────────────── 页内 tab 与 hash ────────────────────────────────

/**
 * 壳的路由只吃第一段（#/logs），页内二级由页面自己读第二段（#/logs/events）。
 * 这样深链能直接落到 tab 上，又不给壳加复杂度。
 */
export function subOf(ids, fallback) {
  const raw = String(location.hash ?? '').replace(/^#\/?/, '').split('?')[0];
  const seg = raw.split('/')[1] ?? '';
  return ids.includes(seg) ? seg : fallback;
}

export function tabBar(items, active) {
  return `<div class="tabs" role="tablist" aria-label="页内分区">${items
    .map((it) => `<button class="tab" role="tab" data-act="subtab" data-sub="${esc(it.id)}" data-on="${active === it.id}" aria-selected="${active === it.id}">${esc(it.label)}</button>`)
    .join('')}</div>`;
}

export function goSub(page, sub) {
  location.hash = sub ? `#/${page}/${sub}` : `#/${page}`;
}

/**
 * 壳只在页面切换时叫 init；页内二级 tab 不吃壳的路由。
 * 这个监听器把 hashchange 收进页面自己：切二级不重进 init，也不丢已加载的数据。
 */
export function watchSub(ids, fallback, cb) {
  const sync = () => cb(subOf(ids, fallback));
  window.addEventListener('hashchange', sync);
  return () => window.removeEventListener('hashchange', sync);
}

// ──────────────────────────────── 数据与命令 ────────────────────────────────

/** 读：把壳的 api 包成 {ok,data,error}，页面里就不再到处写 try/catch */
export async function get(ctx, path) {
  try {
    const data = await ctx.api(path);
    return { ok: true, data, error: null };
  } catch (err) {
    return { ok: false, data: null, error: String(err?.message ?? err) };
  }
}

/**
 * 写：统一 /api/commands/<name>，POST + JSON。
 * X-Confirm 只在字段级危险操作时需要（与 src/web/server.ts 的 CONFIRM_PHRASES / DANGEROUS_FIELDS 逐字对齐）。
 */
export async function command(ctx, name, payload = {}, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const phrases = opts.confirm === undefined ? [] : [].concat(opts.confirm).filter(Boolean);
  if (phrases.length > 0) headers['X-Confirm'] = phrases.join('; ');
  try {
    await ctx.api(`/api/commands/${name}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (opts.quiet !== true) toast(opts.done ?? '已生效并落日志');
    return true;
  } catch (err) {
    toast(String(err?.message ?? err), 'danger');
    return false;
  }
}

/** 定时器返回清理函数：页面的 cleanup 直接把它交回壳 */
export function every(ms, fn) {
  const timer = setInterval(() => { void fn(); }, ms);
  return () => clearInterval(timer);
}

// ──────────────────────────────── 提示 ────────────────────────────────

/** 壳的 toast 宿主（#sh-toast）；没有宿主就静默——提示不该比页面本身更脆 */
export function toast(message, tone = 'ok') {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('sh-toast');
  if (host === null || host === undefined) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.textContent = String(message);
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/** 事件委托：innerHTML 全量重渲染后绑定仍在（挂在页面根上，一次） */
export function delegate(el, handler) {
  el.addEventListener('click', (ev) => {
    const target = ev.target;
    const node = target !== null && target !== undefined && typeof target.closest === 'function' ? target.closest('[data-act]') : null;
    if (node === null || node === undefined) return;
    void handler(node.dataset.act, node, ev);
  });
  el.addEventListener('change', (ev) => {
    const target = ev.target;
    if (target === null || target === undefined) return;
    const act = target.dataset?.act;
    if (act !== undefined && act !== null) void handler(act, target, ev);
  });
}

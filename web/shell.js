/**
 * Irmia 主壳 —— 路由 / 令牌门 / 品牌区状态 / 页面注册表
 * 我亲自操刀的部分：壳的结构与节奏。页面内容在各 pages/*.js 模块里。
 *
 * 约定：
 * - hash 路由：#/overview（默认）/ #/chat / #/persona / #/channels / #/extensions / #/logs / #/settings
 * - 每页模块暴露 { init(el, ctx), destroy? }；ctx = { api, token, setBadge }
 * - token 门全壳共享（localStorage 键 irmia.ui.token，与聊天页同源）
 */

const TOKEN_KEY = 'irmia.ui.token';
const PAGES = ['overview', 'chat', 'persona', 'channels', 'extensions', 'logs', 'settings'];

/** 全局上下文：API 请求封装与事件订阅都在这里给各页用 */
const ctx = {
  token: null,
  online: false,
  setBadge,
  async api(path, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    if (ctx.token !== null) headers.Authorization = `Bearer ${ctx.token}`;
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      showGate('访问令牌无效，请重新粘贴。');
      throw new Error('401');
    }
    const text = await res.text();
    let body = null;
    try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
    return body;
  },
};

/**
 * 导航徽章 —— 页面模块往壳里回写「外面还有事」的唯一出口。
 *   setBadge('chat', '3')   数字徽章（聊天未读）
 *   setBadge('logs', '')    一枚纯点（红点款，表示「有人等你一句话」）
 *   setBadge('chat', null)  收起
 * 导航项没有徽章位就现建一个，免得每个页面各造一套自己的计数。
 */
function setBadge(page, text) {
  const item = document.querySelector(`.sh-item[data-page="${page}"]`);
  if (item === null) return;
  let badge = item.querySelector('.sh-badge');
  if (badge === null) {
    badge = document.createElement('span');
    badge.className = 'sh-badge';
    badge.hidden = true;
    item.appendChild(badge);
  }
  const show = text !== null && text !== undefined;
  badge.hidden = !show;
  badge.textContent = show ? String(text) : '';
}

// ──────────────────────────────── 令牌门 ────────────────────────────────

const gate = document.getElementById('sh-gate');
const gateInput = document.getElementById('sh-gate-input');
const gateError = document.getElementById('sh-gate-error');

function showGate(hint) {
  gate.hidden = false;
  gateError.hidden = !hint;
  if (hint) gateError.textContent = hint;
  gateInput.focus();
}

document.getElementById('sh-gate-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const value = gateInput.value.trim();
  if (value === '') return;
  localStorage.setItem(TOKEN_KEY, value);
  ctx.token = value;
  gate.hidden = true;
  boot();
});

// ──────────────────────────────── 路由 ────────────────────────────────

const modules = new Map();
let currentPage = null;
let currentCleanup = null;

async function loadModule(name) {
  if (!modules.has(name)) {
    modules.set(name, await import(`/pages/${name}.js`));
  }
  return modules.get(name);
}

function pageFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
  return PAGES.includes(raw) ? raw : 'overview';
}

async function navigate() {
  const name = pageFromHash();
  if (name === currentPage) return;

  // 选中态
  for (const btn of document.querySelectorAll('.sh-item[data-page]')) {
    if (btn.dataset.page === name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  // 页面切换：180ms 淡入淡出（MaidKit 曲线）
  const main = document.getElementById('sh-main');
  const prev = currentPage === null ? null : document.getElementById(`page-${currentPage}`);
  const next = document.getElementById(`page-${name}`);
  if (!next) return;

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch { /* 清理失败不拦路由 */ }
    currentCleanup = null;
  }

  if (prev) {
    prev.style.opacity = '0';
    await new Promise(r => setTimeout(r, 90));
    prev.hidden = true;
    prev.style.opacity = '';
  }
  next.hidden = false;
  next.style.opacity = '0';
  next.style.transition = 'opacity 180ms ease-out';

  const mod = await loadModule(name);
  if (typeof mod.init === 'function') {
    currentCleanup = mod.init(next, ctx) ?? null;
  }
  requestAnimationFrame(() => { next.style.opacity = '1'; });
  currentPage = name;
}

window.addEventListener('hashchange', () => { void navigate(); });

for (const btn of document.querySelectorAll('.sh-item[data-page]')) {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    if (page) location.hash = `#/${page}`;
  });
}
document.querySelector('.sh-brand').addEventListener('click', () => { location.hash = '#/overview'; });

// ──────────────────────────────── 品牌区状态 ────────────────────────────────

const dot = document.getElementById('sh-dot');
const brandStatus = document.getElementById('sh-brand-status');

function paintBrand(state) {
  dot.dataset.kind = state.kind;
  brandStatus.textContent = state.text;
}

/** 状态词表：状态机六态 → 界面用词（全站唯一一份，与 GUI 的 humanState 同一张表） */
export function humanStatus(stats) {
  const s = stats?.state;
  switch (s) {
    case 'running': return { kind: 'running', text: '执行中' };
    case 'idle': return { kind: 'idle', text: '就绪' };
    case 'sleeping': return { kind: 'sleeping', text: '休眠中' };
    case 'degraded': return { kind: 'degraded', text: '降级运行' };
    case 'paused': return { kind: 'paused', text: '已暂停（预算耗尽）' };
    case 'needs-review': {
      const count = stats?.tiles?.needsReview;
      return { kind: 'needs-review', text: Number.isFinite(count) ? `待确认（${count} 项）` : '待确认' };
    }
    default: return { kind: 'loading', text: ctx.online ? '就绪' : '连接中断' };
  }
}

async function pollStatus() {
  try {
    const stats = await ctx.api('/api/stats/dashboard');
    ctx.online = true;
    paintBrand(humanStatus(stats));
  } catch {
    ctx.online = false;
    paintBrand({ kind: 'offline', text: '连接中断' });
  }
}

// ──────────────────────────────── 启动 ────────────────────────────────

async function boot() {
  await pollStatus();
  setInterval(() => { void pollStatus(); }, 10_000);
  await navigate();
}

(function main() {
  // URL 快捷通道：?token= 落库后立刻从地址栏抹掉
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  ctx.token = localStorage.getItem(TOKEN_KEY);
  if (ctx.token === null) {
    showGate('');
    return;
  }
  gate.hidden = true;
  void boot();
})();

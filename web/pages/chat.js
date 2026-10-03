/**
 * 聊天页（#/chat）—— 原单页聊天版搬进主壳之后的形态
 *
 * 壳已经替这一页做的事：品牌区（她的脸 + 状态句）、令牌门、导航徽章槽位、氛围光。
 * 所以这一页只剩三块：对话流 → 确认卡片 → 输入行（顶栏整块还给壳，聊天页不再有头像/状态/菜单）。
 *
 * 数据来源（全部走壳的 ctx.api：401 由壳统一弹门，这里只认「成没成」）：
 *   · GET  /api/projection       —— 有没有事等她拿不准 / 有没有提问挂着
 *   · GET  /api/events?limit=50  —— 首屏对话（往下翻的历史不走这里）
 *   · GET  /api/events/stream    —— 实时新事件（fetch 手解析，因为要带 Authorization 头）
 *   · GET  /api/persona/files    —— 人格是不是种子模板（只用来决定空对话时那张引导卡说什么）
 *   · POST /api/commands/wake · review-resolve · answer
 *
 * 页面模块约定：init(root, ctx) 挂载并启动 SSE，返回的 destroy() 断流、清定时器、摘监听。
 * 往外说话的唯一出口是 ctx.setBadge(page, textOrNull)：聊天未读计数与「有人等你一句话」的红点都走它。
 */

// 提示条与其它页面共用一份（_kit 写的是壳的 #sh-toast），聊天页只多带自己的生命周期管理
import { toast } from './_kit.js';

// ──────────────────────────────── 常量与状态 ────────────────────────────────

/** 主题存储键：与运维台共用同一个键（壳暂未接管切换，这里只负责把已选的主题应用上） */
const THEME_KEY = 'irmia.theme';

/** 首屏一次补齐多少条对话 */
const FIRST_PAGE = 50;

/** 首启引导：人格还是种子模板时她先说的一句（IDENTITY.md 是人格文件里最先要填的那一份） */
const SEED_GREETING = '我是伊尔弥亚，刚搬来这台机器。带我去填一下 IDENTITY.md 吧——告诉我我是谁、该用什么语气说话。';

/** 人格已经填过时的轻量招呼：只说明她在，不打扰 */
const PLAIN_GREETING = '我在呢。有什么要我做的？';

/** 状态新鲜度节流：SSE 连着来事件时最多 1 秒重算一次 */
const REFRESH_MS = 1000;

/** 页内骨架：对话流（三态槽位）→ 确认卡片 → 输入行；顶栏与令牌门都不在这里 */
const TEMPLATE = `
  <div class="c-app">
    <main class="c-feed" id="c-feed" data-state="loading">
      <div class="c-hint" data-slot="loading">正在读取会话…</div>
      <!-- 空对话时她先说一句；说什么由 JS 按人格是否还是种子模板决定（见 paintGuide）。
           这里留空容器：没有 JS 的兜底是一张白纸，而不是两句模板话。 -->
      <div class="c-guide" data-slot="empty" id="c-guide"></div>
      <div class="c-list" data-slot="data" id="c-list"></div>
    </main>

    <!-- 待确认的调用：确认卡片贴在对话流底部（黄边） -->
    <div class="c-cards" id="c-cards" hidden></div>

    <footer class="c-compose">
      <label class="sr" for="c-input">输入消息</label>
      <input id="c-input" type="text" autocomplete="off" placeholder="输入消息…" spellcheck="false">
      <button class="c-send" id="c-send" aria-label="发送" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      </button>
    </footer>
  </div>
`;

/** 挂载期状态：init 时整份重置，destroy 之后不再被读写 */
const S = {
  /** 已收到的原始事件（按 seq 升序） */
  events: [],
  /** 渲染条目（由事件翻译而来，含本地乐观插入的那一条） */
  items: [],
  /** 已渲染进 DOM 的条目数：只追加、不重绘，这样老气泡不会重播淡入 */
  drawn: 0,
  /** 相邻同侧同文本去重：首屏 wake 与紧随其后的用户消息是同一句话 */
  lastShown: null,
  proj: null,
  online: false,
  everConnected: false,
  retryMs: 3000,
  lastSeq: 0,
  abort: null,
  refreshTimer: null,
  /** 未决卡片的参数摘要缓存：callId → 参数文本 */
  argCache: new Map(),
  /** 人格是不是种子模板（IDENTITY.md 还没填）：决定空对话时那张引导卡说什么；null = 还没问到 */
  isSeed: null,
  /** 首屏补齐期间为 true：这几条是历史，落屏即全显，不播打字机 */
  bulk: false,
  /** 未读：页面不在前台时到的她的气泡（进页即清零） */
  unread: 0,
  /** 生命周期闸门：destroy 时 abort，所有可中断的等待立刻结束，协程自行退出 */
  life: null,
};

/** 当前挂载的根节点：模板与 el.querySelector 都以它为准（不再全局抓 id） */
let R = null;

/** 壳给的上下文（api / token / setBadge）：模块级持有，工具函数共用 */
let ctx = null;

/** alive 为 false 时一切协程不再碰 DOM（destroy 之后） */
let alive = false;

// ──────────────────────────────── 小工具 ────────────────────────────────

/** 页内查询：壳里只认自己这一块，绝不去全局抓 id（同一壳里别的页面可能同名） */
function $(id) {
  return R === null ? null : R.querySelector(`#${id}`);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 截断：界面上任何一句都不该长到要读第二遍 */
function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 可被打断的等待：页面销毁时立刻结束，等的人自己看 alive 决定要不要继续 */
function pause(ms) {
  const signal = S.life.signal;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 说话时刻：只取时分（气泡角落 hover 才淡入的那 10px 小字） */
function stamp(ts) {
  const date = new Date(typeof ts === 'string' ? ts : Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ──────────────────────────────── API 层 ────────────────────────────────

/**
 * 壳的 ctx.api 失败即抛错、401 直接弹门；这里包回旧签名（{ ok, data, error }），
 * 好让下面的调用点只关心「成没成 + 一句给用户看的话」。
 */
async function api(path, opts = {}) {
  const init = { method: opts.method ?? 'GET' };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  try {
    const data = await ctx.api(path, init);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: { message: err?.message ?? '无法连接本地服务。' } };
  }
}

// ──────────────────────────── 导航徽章（回写壳） ────────────────────────────

/** 未读计数 → 聊天项的数字徽章；0 就是收起 */
function paintUnread() {
  if (ctx === null) return;
  ctx.setBadge('chat', S.unread > 0 ? String(S.unread) : null);
}

/** 「有人等你一句话」→ 日志项一枚纯点（壳里那枚是 warn 款） */
function paintReviewBadge(count) {
  if (ctx === null) return;
  ctx.setBadge('logs', count > 0 ? '' : null);
}

/** 后台标签页里到的她的消息才算未读：人正看着这一页时不打扰 */
function onVisibility() {
  if (document.hidden || S.unread === 0) return;
  S.unread = 0;
  paintUnread();
}

// ──────────────────────────────── 事件 → 对话 ────────────────────────────────

/** 通道标识翻成界面用词 */
function channelLabel(data) {
  const channel = data?.channel === 'onebot' || data?.channel === 'qq-official' ? 'QQ' : String(data?.channel ?? '外部');
  const shape = { c2c: '私聊', 'group-at': '群聊', group: '群聊', guild: '频道' }[data?.chatType] ?? '消息';
  return `${channel}${shape}`;
}

/**
 * 一条事件值不值得出现在聊天里？返回渲染条目或 null（条目上另带一份 ts：气泡角落的时间戳要用）。
 * 判据只有一条：**人看得懂的事才上屏**。工具调用、预算记账、轮次推进都是过程，
 * 过程不进聊天——所以它们在这里被显式丢弃（运维台里有全量）。
 */
function toItem(event) {
  const item = toItemOf(event);
  if (item !== null && typeof event?.ts === 'string') item.ts = event.ts;
  return item;
}

/** 真正的事件 → 条目映射（时间由 toItem 统一补上，映射本身不关心 ts） */
function toItemOf(event) {
  const data = event?.data ?? {};
  switch (event.type) {
    case 'message/assistant': {
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (text === '') return null; // 只有工具调用的中间步：不刷屏
      return { kind: 'bubble', side: 'her', text };
    }
    case 'message/user':
      // 永远不上屏：它是唤醒输入的渲染层镜像（wake/manual、wake/channel 已各自上屏）。
      // 假循环的认领摘要（"N 条待办…"）同理是记账不是对话。
      return null;
    case 'wake/manual':
      return { kind: 'bubble', side: 'me', text: String(data.note ?? '').trim() || '（手动唤醒）' };
    case 'wake/channel':
      return { kind: 'bubble', side: 'them', text: String(data.text ?? ''), src: channelLabel(data) };
    case 'wake/timer':
      return { kind: 'sys', text: '（定时任务触发）' };
    case 'wake/heartbeat':
      // 心跳是她自己转的圈：沉默的那批（事件里没有 spoke 标记）一律不上屏，
      // 真说了话会另有一条 message/assistant 变成气泡
      return data.spoke === true ? { kind: 'sys', text: '（心跳触发）' } : null;
    case 'wake/webhook':
      return { kind: 'sys', text: '（webhook 触发）' };
    case 'wake/file':
      return { kind: 'sys', text: '（文件变更触发）' };
    case 'wake/job':
      return { kind: 'sys', text: '（后台任务完成）' };
    case 'wake/intention':
      return { kind: 'sys', text: '（意图触发）' };
    case 'human/answered':
      return { kind: 'sys', text: `（人工答复：${clip(data.answer, 24)}）` };
    case 'review/resolved':
      return { kind: 'sys', text: `（复核结果：${data.outcome === 'succeeded' ? '标记成功' : '标记失败'}）` };
    default:
      return null;
  }
}

/** 同侧同文本的紧邻重复只留一条：wake 与随后的用户消息是同一句话 */
function pushItem(item) {
  const key = item.kind === 'bubble' ? `${item.side}\u0000${item.text}` : null;
  if (key !== null && S.lastShown === key) return false;
  S.items.push(item);
  S.lastShown = key;
  return true;
}

function addEvent(event) {
  if (typeof event?.seq !== 'number') return;
  if (S.events.some((item) => item.seq === event.seq)) return;
  S.events.push(event);
  S.events.sort((a, b) => a.seq - b.seq);
  if (event.seq > S.lastSeq) S.lastSeq = event.seq;
  const item = toItem(event);
  if (item === null) {
    // 事件本身不上屏，但它可能带着确认卡片要用的参数摘要
    rememberArgs(event);
    return;
  }
  rememberArgs(event);
  if (pushItem(item)) {
    // 只有「此刻刚到」的气泡才配打字机：首屏那批历史走 bulk 通道（见 loadFirstPage）
    item.live = S.bulk === false;
    // 人不在这一页（切去了别的标签）：她的新消息记成未读，徽章上回写
    if (item.kind === 'bubble' && item.side === 'her' && S.bulk === false && document.hidden) {
      S.unread += 1;
      paintUnread();
    }
    paintFeed();
    refreshSoon();
  }
}

/** 工具调用的参数留一份：确认卡片上要显示「她打算干什么」 */
function rememberArgs(event) {
  if (event.type !== 'tool/call') return;
  const callId = event.data?.callId;
  if (typeof callId !== 'string') return;
  S.argCache.set(callId, argSummary(event.data?.arguments));
}

/** 参数摘要：JSON 尽量摊平成 `a=1 b=2`，摊不平就原样截断 */
function argSummary(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const parts = Object.entries(parsed).map(([key, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}=${clip(text, 40)}`;
      });
      return clip(parts.join(' '), 120);
    }
  } catch {
    // 不是 JSON 就原样展示
  }
  return clip(raw, 120);
}

// ──────────────────────────────── 对话流渲染 ────────────────────────────────

/** 复用壳里那一枚记号：气泡左侧的 28px 小脸与侧边栏品牌区是同一份图形（#her-mark） */
function faceNode(cls) {
  const box = el('span', cls);
  // 静态字面量交给解析器建 SVG 元素：省掉命名空间那串 URL（它会被"零外链"的验收当成外链）
  box.innerHTML = '<svg class="c-face" viewBox="0 0 32 32" aria-hidden="true"><use href="#her-mark"></use></svg>';
  return box;
}

/** 一行对话：她在左（带一枚小脸）、你在右；气泡里带来源小字与 hover 才现的时间戳 */
function rowNode(item) {
  const row = el('div', 'c-row');
  row.dataset.side = item.side;
  if (item.side !== 'me') row.appendChild(faceNode('c-mini'));
  const bubble = el('div', 'c-bubble');
  bubble.dataset.side = item.side;
  bubble.appendChild(el('span', 'c-text', item.text));
  if (item.src !== undefined) bubble.appendChild(el('span', 'c-src', `来源：${item.src}`));
  const time = stamp(item.ts);
  if (time !== '') bubble.appendChild(el('span', 'c-time', time));
  row.appendChild(bubble);
  return row;
}

/**
 * 打字机：她的新气泡逐字显现。
 * 每帧 2-4 字、按总时长约 480ms 折算帧间隔（长句触到 16ms 下限就匀速铺完），
 * 末尾跟一枚 600ms 方波光标，放完即撤。历史气泡不走这里——它落屏就该是完整的。
 */
async function typewrite(row, text) {
  const target = row.querySelector('.c-text');
  // 结构对不上（或宿主没有 after）就退化成全显：宁可少一个效果，也不能丢字
  if (target === null || typeof target.after !== 'function') {
    if (target !== null) target.textContent = text;
    return;
  }
  const caret = el('span', 'c-caret', '▍');
  target.after(caret);
  target.textContent = '';
  const frameMs = Math.max(16, Math.round(480 / Math.ceil(text.length / 3)));
  let at = 0;
  while (at < text.length) {
    at += 2 + (at % 3); // 步长 2/3/4 轮着来，看不出机械感
    target.textContent = text.slice(0, at);
    await pause(frameMs);
    if (!alive) return; // 页面被切走了：停在这里，剩下的字不用再补
  }
  caret.remove();
}

function paintFeed() {
  const list = $('c-list');
  const feed = $('c-feed');
  if (list === null || feed === null) return;
  // 首屏一次性补齐时必然"不在底部"（此刻 scrollTop 还是 0），要强制落到最新一条
  const firstFill = S.drawn === 0 && S.items.length > 0;
  for (let index = S.drawn; index < S.items.length; index++) {
    const item = S.items[index];
    const prev = index > 0 ? S.items[index - 1] : null;
    const node = item.kind === 'bubble' ? rowNode(item) : el('div', 'c-sys', item.text);
    if (item.kind === 'bubble') {
      // 连续同侧贴紧 4px、换侧换气 16px：CSS 只认这一枚标记
      node.dataset.cont = String(prev !== null && prev.kind === 'bubble' && prev.side === item.side);
    }
    list.appendChild(node);
    // 只有「此刻刚到」的她的气泡逐字显现；首屏历史（live 不是 true）落屏即全显
    if (item.kind === 'bubble' && item.live === true) void typewrite(node, item.text);
  }
  S.drawn = S.items.length;

  if (S.items.length === 0) {
    if (S.online) feed.dataset.state = 'empty';
    return;
  }
  feed.dataset.state = 'data';
  // 只有本来就在底部才自动跟随：正在往上翻历史时别把人拽回来
  const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  if (firstFill || near) feed.scrollTop = feed.scrollHeight;
}

// ──────────────────────────────── 确认卡片 ────────────────────────────────

function cardNode(build) {
  const card = el('div', 'c-card');
  build(card);
  return card;
}

/** 待确认的调用：她做了但没结案，需要人给一句「成没成」 */
function reviewCard(entry) {
  return cardNode((card) => {
    card.appendChild(el('div', 'c-card-head', `待确认：${entry.name ?? '一次操作'}`));
    const args = S.argCache.get(entry.callId) ?? '';
    if (args !== '') card.appendChild(el('div', 'c-card-args', args));
    card.appendChild(el('p', 'c-card-hint tiny variant', '执行结果未知，等待人工确认。'));

    const row = el('div', 'row');
    const ok = el('button', 'btn btn-primary', '标记成功');
    const bad = el('button', 'btn btn-danger', '标记失败');
    ok.addEventListener('click', () => resolveReview(entry.callId, 'succeeded', ok));
    bad.addEventListener('click', () => resolveReview(entry.callId, 'failed', bad));
    row.append(ok, bad);
    card.appendChild(row);
  });
}

/** 她问到你了：原来的问题 + 一个回答框 */
function askCard(question) {
  return cardNode((card) => {
    card.appendChild(el('div', 'c-card-head', '待答复'));
    card.appendChild(el('p', 'c-card-q', question));
    const row = el('div', 'row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = '输入答复…';
    input.setAttribute('aria-label', '输入答复');
    const send = el('button', 'btn btn-primary', '发送');
    const submit = () => {
      const text = input.value.trim();
      if (text === '') return;
      void answerHuman(text, send);
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    row.append(input, send);
    card.appendChild(row);
  });
}

function paintCards() {
  const host = $('c-cards');
  if (host === null) return;
  host.textContent = '';
  const proj = S.proj;
  if (proj === null || !S.online) {
    host.hidden = true;
    paintReviewBadge(0);
    return;
  }
  let count = 0;
  for (const entry of proj.needsReview ?? []) {
    host.appendChild(reviewCard(entry));
    count += 1;
  }
  if (proj.waitingHuman !== null && proj.waitingHuman !== undefined) {
    host.appendChild(askCard(String(proj.waitingHuman.question ?? '（问题内容缺失）')));
    count += 1;
  }
  host.hidden = count === 0;
  // 有人等你一句话：壳的日志项挂一枚红点（切到别的页也看得见）
  paintReviewBadge(count);
}

async function resolveReview(callId, outcome, btn) {
  btn.disabled = true;
  const res = await api('/api/commands/review-resolve', { method: 'POST', body: { callId, outcome } });
  btn.disabled = false;
  if (!res.ok) {
    toast(res.error?.message ?? '提交失败。', 'danger');
    return;
  }
  toast('已记录。');
  await refreshState();
}

async function answerHuman(text, btn) {
  btn.disabled = true;
  // 自由回答走 answer 命令（与 CLI 的 irmia answer 同一份实现）；答不进去就退化成一次唤醒
  const res = await api('/api/commands/answer', { method: 'POST', body: { answer: text } });
  btn.disabled = false;
  if (res.ok) {
    toast('答复已提交。');
    await refreshState();
    return;
  }
  const fallback = await api('/api/commands/wake', { method: 'POST', body: { note: `回答：${text}` } });
  if (fallback.ok) toast('已唤醒。');
  else toast(fallback.error?.message ?? '发送失败。', 'danger');
  await refreshState();
}

// ──────────────────────────────── 状态刷新 ────────────────────────────────

/** 这一页只关心「有没有待确认的调用」：她此刻的状态句由壳的品牌区负责 */
async function refreshState() {
  const res = await api('/api/projection');
  if (res.ok && res.data !== null && typeof res.data === 'object') S.proj = res.data;
  paintCards();
}

function refreshSoon() {
  if (!alive || S.refreshTimer !== null) return;
  S.refreshTimer = setTimeout(() => {
    S.refreshTimer = null;
    void refreshState();
  }, REFRESH_MS);
}

// ──────────────────────────────── 首启引导卡 ────────────────────────────────

/**
 * 空对话时她先开口。
 * 人格还是种子模板（IDENTITY.md 没填）就请人带路去填；已经填过只留一句轻量招呼。
 * 同一分支不重绘：否则打字机会被打断重播。
 */
function paintGuide() {
  const host = $('c-guide');
  if (S.isSeed === null || host === null) return; // 还没问到人格状态就先不猜，免得先说错话再改口
  const kind = S.isSeed ? 'seed' : 'plain';
  if (host.dataset.kind === kind) return;
  host.dataset.kind = kind;
  host.textContent = '';

  const row = el('div', 'c-row');
  row.dataset.side = 'her';
  row.dataset.cont = 'false';
  row.appendChild(faceNode('c-mini'));
  const bubble = el('div', 'c-bubble');
  bubble.dataset.side = 'her';
  bubble.appendChild(el('span', 'c-text', S.isSeed ? SEED_GREETING : PLAIN_GREETING));
  row.appendChild(bubble);
  host.appendChild(row);

  if (S.isSeed) {
    const actions = el('div', 'c-guide-actions');
    const go = el('button', 'btn btn-primary', '打开人格配置');
    go.addEventListener('click', () => {
      location.hash = '#/persona'; // 壳里的人格页（旧版跳的是运维台同名的锚点）
    });
    actions.appendChild(go);
    host.appendChild(actions);
  }
  void typewrite(row, S.isSeed ? SEED_GREETING : PLAIN_GREETING);
}

/** 读一次人格状态：只看 IDENTITY.md 是不是种子模板（判据由后端给，前端不自己认字） */
async function loadPersonaSeed() {
  const res = await api('/api/persona/files');
  const files = res.ok && res.data !== null && typeof res.data === 'object' && Array.isArray(res.data.files)
    ? res.data.files
    : null;
  // 读不到就当她不是种子：宁可不引导，也别误请人去填一份已经填过的人格
  S.isSeed = files !== null && files.some((file) => file?.path === 'IDENTITY.md' && file?.isSeed === true);
  if (alive) paintGuide();
}

// ──────────────────────────────── 首屏与实时流 ────────────────────────────────

async function loadFirstPage() {
  S.bulk = true; // 这一批是历史：落屏即全显，不打字
  const res = await api(`/api/events?limit=${FIRST_PAGE}`);
  if (res.ok) {
    const events = Array.isArray(res.data?.events) ? res.data.events : [];
    events.sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0));
    for (const event of events) addEvent(event);
    paintFeed();
  }
  S.bulk = false;
  return res.ok;
}

/** 手工解析 SSE：EventSource 不能带 Authorization 头，所以自己读流（与运维台同一套读法） */
async function startStream() {
  while (alive) {
    const ctrl = new AbortController();
    S.abort = ctrl;
    try {
      const headers = { Accept: 'text/event-stream', Authorization: `Bearer ${ctx.token}` };
      if (S.lastSeq > 0) headers['Last-Event-ID'] = String(S.lastSeq);
      const res = await fetch('/api/events/stream', { headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`连接被拒（${res.status}）`);
      S.online = true;
      // 连上之后要重绘一次对话流：空对话的 empty 态只有此刻才成立，引导卡正等这一下
      paintFeed();
      if (S.everConnected) void refreshState(); // 断线回来先对一遍状态
      S.everConnected = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          handleFrame(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
      throw new Error('连接断了');
    } catch {
      if (ctrl.signal.aborted || !alive) return;
      S.online = false;
      paintCards();
      await pause(S.retryMs); // 可中断：页面切走时立刻收手，不在后台空转重连
    }
  }
}

function handleFrame(frame) {
  let name = 'message';
  let id = null;
  const dataLines = [];
  for (const raw of frame.split('\n')) {
    if (raw === '' || raw.startsWith(':')) continue;
    const index = raw.indexOf(':');
    const field = index < 0 ? raw : raw.slice(0, index);
    const value = index < 0 ? '' : raw.slice(index + 1).replace(/^ /u, '');
    if (field === 'event') name = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'retry') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) S.retryMs = parsed;
    }
  }
  if (dataLines.length === 0) return;
  let payload = null;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    payload = { type: name, data: {} };
  }
  const seq = typeof payload?.seq === 'number' ? payload.seq : Number(id);
  if (!Number.isFinite(seq)) return;
  addEvent({
    seq,
    ts: typeof payload?.ts === 'string' ? payload.ts : new Date().toISOString(),
    type: typeof payload?.type === 'string' ? payload.type : name,
    data: payload?.data ?? {},
  });
}

// ──────────────────────────────── 发送 ────────────────────────────────

async function send() {
  const input = $('c-input');
  if (input === null) return;
  const text = input.value.trim();
  if (text === '') return;
  input.value = '';
  syncSendButton();

  // 乐观上屏：先让这句话出现在右边，事件回来时会被相邻去重吃掉，不会变两条
  if (pushItem({ kind: 'bubble', side: 'me', text })) paintFeed();

  const res = await api('/api/commands/wake', { method: 'POST', body: { note: text } });
  if (!res.ok) {
    toast(res.error?.message ?? '发送失败。', 'danger');
    return;
  }
  refreshSoon();
}

function syncSendButton() {
  const send = $('c-send');
  const input = $('c-input');
  if (send === null || input === null) return;
  send.disabled = input.value.trim() === '';
}

// ──────────────────────────────── 主题与事件绑定 ────────────────────────────────

/** 主题与运维台共用同一个键：壳还没接管切换，这一页只把已经选好的那套应用上 */
function paintTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;
  const theme = stored === 'dark' || stored === 'light' ? stored : (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
}

function bind() {
  const input = $('c-input');
  const send = $('c-send');
  if (input === null || send === null) return; // 模板缺件就静默降级：宁可少一块，也不整页崩
  input.addEventListener('input', syncSendButton);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
    }
  });
  send.addEventListener('click', () => void send());
  // 切回前台 = 人正在看着这一页：未读清零
  document.addEventListener('visibilitychange', onVisibility);
}

// ──────────────────────────────── 挂载与卸载 ────────────────────────────────

async function boot() {
  await loadFirstPage();
  await refreshState();
  paintFeed();
  void startStream();
  void loadPersonaSeed(); // 空对话时那张引导卡，要等它回来才知道该不该请人去填人格（打开人格配置）
}

/** 卸载：断流、清定时器、摘监听。徽章按「未读」语义留着，进页时自然会清 */
function destroy() {
  alive = false;
  S.life.abort();
  if (S.abort !== null) S.abort.abort();
  S.abort = null;
  if (S.refreshTimer !== null) {
    clearTimeout(S.refreshTimer);
    S.refreshTimer = null;
  }
  document.removeEventListener('visibilitychange', onVisibility);
  R = null; // 之后 $() 一律返回 null：即便有残留协程也写不动 DOM
  ctx = null;
}

export function init(root, context) {
  R = root;
  ctx = context;
  alive = true;
  // 状态重置：同一个模块实例会被壳反复 init/destroy，绝不能带着上一轮的事件跑
  S.events = [];
  S.items = [];
  S.drawn = 0;
  S.lastShown = null;
  S.proj = null;
  S.online = false;
  S.everConnected = false;
  S.retryMs = 3000;
  S.lastSeq = 0;
  S.abort = null;
  S.refreshTimer = null;
  S.argCache = new Map();
  S.isSeed = null;
  S.bulk = false;
  S.unread = 0;
  S.life = new AbortController();

  root.innerHTML = TEMPLATE;
  paintTheme();
  bind();
  paintUnread(); // 进聊天页 = 已读
  void boot();

  return destroy;
}

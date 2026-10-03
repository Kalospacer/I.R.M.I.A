/**
 * 扩展页（#/extensions）—— 四个 tab：技能 / MCP / Hook / 工具行为
 * 逻辑从运维台的「插件页四格」（renderSkillsTab 一族）平移，DOM 挂到 el。
 *
 * 数据：GET /api/skills · /api/mcp · /api/hooks · /api/tools（全是只读）
 * 写：POST /api/commands/skill-confirm（信任门放行；命令级无需 X-Confirm）
 * Hook 是 agent 不可改的：这一页只读，页面上把这条纪律标出来。
 */

import {
  esc, sv, clip, icon, num, stampOf, stateOf, ch, blockCard,
  mountSprite, listOf, get, command, every, delegate, subOf, tabBar, goSub, watchSub,
} from './_kit.js';

const TABS = [
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP' },
  { id: 'hooks', label: '钩子（Hook）' },
  { id: 'tools', label: '工具行为' },
];
const TAB_IDS = TABS.map((t) => t.id);

/** 信任门四态的界面用词（与运维台同一张表） */
const TRUST_LABEL = {
  trusted: '已确认',
  'never-confirmed': '未确认',
  'agent-proposed': 'agent 写入',
  'content-changed': '确认后内容变更',
};

const IGNORE_KEY = 'irmia.skill.ignored';

export function init(el, ctx) {
  mountSprite();

  const S = {
    tab: subOf(TAB_IDS, 'skills'),
    skills: { data: null, error: null, loading: false, ignored: loadIgnored() },
    mcp: { data: null, error: null, loading: false },
    hooks: { data: null, error: null, loading: false },
    tools: { data: null, error: null, loading: false },
  };

  function loadIgnored() {
    try {
      const raw = JSON.parse(localStorage.getItem(IGNORE_KEY) ?? '[]');
      return new Set(Array.isArray(raw) ? raw.map((item) => String(item)) : []);
    } catch {
      return new Set();
    }
  }

  function saveIgnored() {
    localStorage.setItem(IGNORE_KEY, JSON.stringify([...S.skills.ignored]));
  }

  // ── 数据加载 ──

  async function loadSkills() {
    S.skills.loading = true;
    paint();
    const res = await get(ctx, '/api/skills');
    S.skills.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.skills.data = res.data;
      S.skills.error = null;
    } else {
      S.skills.error = res.ok ? '技能目录读取失败' : res.error;
    }
    paint();
  }

  async function loadMcp() {
    S.mcp.loading = true;
    paint();
    const res = await get(ctx, '/api/mcp');
    S.mcp.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.mcp.data = res.data;
      S.mcp.error = null;
    } else {
      S.mcp.error = res.ok ? 'MCP 状态读取失败' : res.error;
    }
    paint();
  }

  async function loadHooks() {
    S.hooks.loading = true;
    paint();
    const res = await get(ctx, '/api/hooks');
    S.hooks.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.hooks.data = res.data;
      S.hooks.error = null;
    } else {
      S.hooks.error = res.ok ? '钩子配置读取失败' : res.error;
    }
    paint();
  }

  async function loadTools() {
    S.tools.loading = true;
    paint();
    const res = await get(ctx, '/api/tools');
    S.tools.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.tools.data = res.data;
      S.tools.error = null;
    } else {
      S.tools.error = res.ok ? '工具清单读取失败' : res.error;
    }
    paint();
  }

  function loadTab() {
    if (S.tab === 'skills') return loadSkills();
    if (S.tab === 'mcp') return loadMcp();
    if (S.tab === 'hooks') return loadHooks();
    return loadTools();
  }

  // ── 技能 ──

  function skillRowHtml(item) {
    const name = String(item?.name ?? '');
    const trust = String(item?.trust ?? 'never-confirmed');
    const tone = trust === 'trusted' ? 'ok' : trust === 'content-changed' ? 'danger' : trust === 'agent-proposed' ? 'warn' : 'info';
    const actions = item?.inCatalog === true
      ? '<span class="badge" data-tone="ok">已进入 catalog</span>'
      : S.skills.ignored.has(name)
        ? `<span class="badge">已忽略（仅本地）</span><button class="btn" data-act="skill-restore" data-name="${esc(name)}">恢复</button>`
        : `<button class="btn btn-primary" data-act="skill-confirm" data-name="${esc(name)}">${icon('i-check')}确认</button><button class="btn" data-act="skill-ignore" data-name="${esc(name)}">忽略</button>`;
    return `<div class="field-row" data-trust="${esc(trust)}">
<div>${esc(name)} <span class="badge" data-tone="${tone}">${esc(TRUST_LABEL[trust] ?? trust)}</span>
<div class="field-hint mono">${esc(item?.skillPath ?? '')} · ${esc(num(item?.bytes))} 字节 · ${esc(String(item?.contentHash ?? '').slice(0, 8))}</div>
<div class="field-hint">${esc(clip(item?.description ?? '', 90))}</div>
<div class="field-hint">${esc(item?.trustDetail ?? '')}</div>
</div>
<div class="row">${actions}</div>
</div>`;
  }

  function skillsBody() {
    const d = S.skills.data;
    const items = listOf(d, 'items');
    const active = items.filter((item) => item?.inCatalog === true);
    const pending = items.filter((item) => item?.inCatalog !== true && !S.skills.ignored.has(String(item?.name)));
    const ignored = items.filter((item) => item?.inCatalog !== true && S.skills.ignored.has(String(item?.name)));
    const rejected = listOf(d, 'rejected');
    return `<div class="stack">
${pending.length > 0 ? `<div class="card" id="sk-pending">${ch('信任门：待确认', '<span class="tv">未确认不进入 catalog</span>')}${pending.map(skillRowHtml).join('')}</div>` : ''}
<div class="card" id="sk-active">${ch('已生效', '<span class="tv">catalog 当前内容</span>')}${active.length === 0 ? '<div class="tv">暂无已确认技能。</div>' : active.map(skillRowHtml).join('')}</div>
${ignored.length > 0 ? `<div class="card" id="sk-ignored">${ch('已忽略', '<span class="tv">仅本机浏览器忽略，不写事件</span>')}${ignored.map(skillRowHtml).join('')}</div>` : ''}
${rejected.length > 0 ? `<div class="card" id="sk-rejected">${ch('被拒绝的目录', '<span class="tv">frontmatter 非法或重名</span>')}${rejected.map((item) => `<div class="ev-line"><span class="mono tiny">${sv(item?.relDir)}</span><span class="tv">${sv(item?.reason)}</span></div>`).join('')}</div>` : ''}
</div>`;
  }

  function skillsTab() {
    const d = S.skills.data;
    const items = listOf(d, 'items');
    const active = items.filter((item) => item?.inCatalog === true).length;
    const pending = items.filter((item) => item?.inCatalog !== true && !S.skills.ignored.has(String(item?.name))).length;
    const right = `<div class="row"><span class="tv">${d === null ? '' : `${active} 已生效 · ${pending} 待确认 · catalog ${num(d?.catalogTokens)} token`}</span>
<button class="btn" data-act="skills-reload">${icon('i-refresh')}重扫</button></div>`;
    return blockCard('sk-list-block', '技能目录', right, stateOf(S.skills.loading, S.skills.error, items.length === 0, items.length > 0), {
      loading: '正在扫描技能目录…',
      error: S.skills.error ?? '技能目录读取失败',
      retry: 'skills-reload',
      emptyIcon: 'i-list',
      emptyTitle: '暂无技能目录',
      emptyHint: '技能放在 skills/<name>/SKILL.md。',
      slot: skillsBody(),
    });
  }

  // ── MCP ──

  function mcpRowHtml(server) {
    const state = String(server?.state ?? 'never-started');
    const tone = state === 'started' ? 'ok' : state === 'stopped' ? 'warn' : state === 'disabled' ? '' : 'info';
    const label = { started: '已启动过', stopped: '已停止', disabled: '已停用', 'never-started': '从未启动' }[state] ?? state;
    const tools = listOf(server, 'registeredTools');
    return `<div class="card" data-mcp="${sv(server?.name)}">
${ch(`${sv(server?.name)} <span class="badge" data-tone="${tone}">${esc(label)}</span>`, `<span class="tv">${esc(num(server?.toolsCount))} 件工具</span>`)}
<div class="tiny variant mono">${sv(server?.command)} ${esc((server?.args ?? []).join(' '))}</div>
<div class="tv">${server?.lastAt ? `最近一次：${esc(stampOf(server.lastAt))}${server?.stopReason ? `（${esc(String(server.stopReason))}）` : ''}${server?.pid ? ` · pid ${esc(num(server.pid))}` : ''}` : '事件日志中无启动记录'}</div>
${tools.length > 0 ? `<div class="row row-wrap">${tools.map((tool) => `<span class="badge">${esc(tool)}</span>`).join('')}</div>` : ''}
</div>`;
  }

  function mcpTab() {
    const d = S.mcp.data;
    const servers = listOf(d, 'servers');
    const problems = listOf(d, 'problems');
    const right = `<div class="row"><span class="tv">${d === null ? '' : `声明 ${servers.length} 个 · 注册工具 ${num(d?.registeredCount)} 件`}</span>
<button class="btn" data-act="mcp-reload">${icon('i-refresh')}刷新</button></div>`;
    const body = `<div class="stack">
${servers.map(mcpRowHtml).join('')}
${problems.length > 0 ? `<div class="card" id="mcp-problems">${ch('配置问题')}${problems.map((item) => `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(String(item))}</span></div>`).join('')}</div>` : ''}
</div>`;
    return blockCard('mcp-list', 'MCP 服务', right, stateOf(S.mcp.loading, S.mcp.error, servers.length === 0, servers.length > 0), {
      loading: '正在读 MCP 配置与状态…',
      error: S.mcp.error ?? 'MCP 状态读取失败',
      retry: 'mcp-reload',
      emptyIcon: 'i-puzzle',
      emptyTitle: '未配置 MCP 服务',
      emptyHint: '在 config.json 的 mcp.servers[] 里声明 { name, command, args }。',
      slot: body,
    });
  }

  // ── Hook（只读） ──

  function hooksTab() {
    const d = S.hooks.data;
    const entries = listOf(d, 'entries');
    const problems = listOf(d, 'problems');
    const right = `<div class="row"><span class="badge" data-tone="warn">agent 不可改</span><button class="btn" data-act="hooks-reload">${icon('i-refresh')}重读</button></div>`;
    const body = `<div id="hk-entries">${entries
      .map(
        (entry) => `<div class="field-row" data-hook="${sv(entry?.hook)}">
<div>${sv(entry?.hook)} <span class="badge">${esc(clip(String(entry?.matcher ?? ''), 30))}</span>
<div class="field-hint mono">${sv(entry?.command)}</div>
${entry?.if ? `<div class="field-hint">条件：${esc(String(entry.if))}</div>` : ''}
</div>
<div class="tiny variant mono">超时 ${esc(num(entry?.timeoutMs))}ms</div>
</div>`,
      )
      .join('')}</div>`;
    return `${blockCard('hk-list', '钩子条目', right, stateOf(S.hooks.loading, S.hooks.error, entries.length === 0, entries.length > 0), {
      loading: '正在读钩子配置…',
      error: S.hooks.error ?? '钩子配置读取失败',
      retry: 'hooks-reload',
      emptyIcon: 'i-hook',
      emptyTitle: '未配置钩子',
      emptyHint: `钩子需在 ${d?.relative ?? 'data/hooks.json'} 手动添加；agent 侧只读。`,
      slot: body,
    })}
<div class="tiny variant mono" id="hk-path">${esc(String(d?.relative ?? 'data/hooks.json'))}${d?.exists === false ? '（文件不存在即未配置钩子，属正常态）' : ''}</div>
${problems.length > 0 ? `<div class="card" id="hk-problems">${ch('异常条目', '<span class="tv">单条配置错误不影响整份配置生效，但必须在此列出</span>')}${problems.map((item) => `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(String(item))}</span></div>`).join('')}</div>` : ''}`;
  }

  // ── 工具行为 ──

  function policyLabel(policy) {
    if (policy === true) return '全开';
    if (Array.isArray(policy)) return policy.length === 0 ? '按名单（空）' : `按名单（${policy.length} 件）`;
    return '全关';
  }

  function toolsTab() {
    const d = S.tools.data;
    const tools = listOf(d, 'tools');
    const right = `<div class="row"><span class="tv">${d === null ? '' : `${tools.length} 件 · 副作用 destructive：${esc(policyLabel(d?.destructivePolicy))}`}</span>
<button class="btn" data-act="tools-reload">${icon('i-refresh')}刷新</button></div>`;
    const body = tools
      .map(
        (tool) => `<div class="field-row" data-side-effect="${sv(tool?.sideEffect)}">
<div>${sv(tool?.name)}
<span class="badge" data-tone="${tool?.sideEffect === 'destructive' ? 'danger' : tool?.sideEffect === 'idempotent' ? 'warn' : ''}">${esc(String(tool?.sideEffect ?? 'none'))}</span>
<span class="badge" data-tone="info">${sv(tool?.executionMode)}</span>
${tool?.fromMcp === true ? '<span class="badge">MCP</span>' : ''}
<div class="field-hint">${sv(tool?.description)}</div>
</div>
<div class="tiny variant mono">超时 ${esc(num(tool?.timeoutMs))}ms</div>
</div>`,
      )
      .join('');
    return blockCard('tl-list', '工具清单', right, stateOf(S.tools.loading, S.tools.error, tools.length === 0, tools.length > 0), {
      loading: '正在读工具注册表…',
      error: S.tools.error ?? '工具清单读取失败',
      retry: 'tools-reload',
      emptyIcon: 'i-wrench',
      emptyTitle: '观测服务未读到工具注册表',
      emptyHint: '注册表由 real-loop 注入，这个进程读到空清单。',
      slot: body,
    });
  }

  // ── 渲染 ──

  function tabHtml() {
    if (S.tab === 'skills') return skillsTab();
    if (S.tab === 'mcp') return mcpTab();
    if (S.tab === 'hooks') return hooksTab();
    return toolsTab();
  }

  function paint() {
    el.innerHTML = `
<div class="sh-page-head">
  <h1 class="sh-page-title">扩展</h1>
  <p class="sh-page-sub">她能用什么；信任门放行状态与不可改项</p>
</div>
<div class="sh-page-body">
  ${tabBar(TABS, S.tab)}
  <div class="ext-body">${tabHtml()}</div>
</div>`;
  }

  // ── 交互 ──

  delegate(el, async (act, node) => {
    switch (act) {
      case 'subtab':
        goSub('extensions', String(node.dataset.sub ?? 'skills'));
        return;
      case 'skills-reload':
        void loadSkills();
        return;
      case 'mcp-reload':
        void loadMcp();
        return;
      case 'hooks-reload':
        void loadHooks();
        return;
      case 'tools-reload':
        void loadTools();
        return;
      case 'skill-confirm': {
        const name = String(node.dataset.name ?? '');
        await command(ctx, 'skill-confirm', { name }, { done: `已确认，${name} 进 catalog` });
        void loadSkills();
        return;
      }
      case 'skill-ignore':
        S.skills.ignored.add(String(node.dataset.name ?? ''));
        saveIgnored();
        paint();
        return;
      case 'skill-restore':
        S.skills.ignored.delete(String(node.dataset.name ?? ''));
        saveIgnored();
        paint();
        return;
      default:
        return;
    }
  });

  // 页内 tab 走 hash 第二段：监听 hashchange 自己切，壳不管二级
  const stopWatch = watchSub(TAB_IDS, 'skills', (next) => {
    if (next === S.tab) return;
    S.tab = next;
    paint();
    void loadTab();
  });

  paint();
  void loadTab();
  // 信任门与 MCP 状态会随 agent 侧写入变化：低频轮询（只在当前 tab 上）
  const stopPoll = every(20_000, () => { void loadTab(); });
  return () => {
    stopWatch();
    stopPoll();
  };
}

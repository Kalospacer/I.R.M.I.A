/**
 * 设置页（#/settings）—— 四个 tab：模型 / 界面 / 系统 / 关于
 * 逻辑从运维台的 renderSettingsTab 一族平移，另接上壳的主题口径（同一份 localStorage 键）。
 *
 * 数据：GET /api/config（生效配置本体）· GET /api/keys（密钥状态，只有掩码）·
 *       /api/projection · /api/doctor · /api/events?types=session/start
 * 写：POST /api/commands/config-update（模型名，落一条 config/changed）·
 *     POST /api/commands/set-key（密钥，带 X-Confirm: set-key，写 data/.keys.json）
 *
 * 只读纪律：系统卡里的值一律只读——改它们要去配置文件页；需重启的字段照实标出来。
 * 密钥只写不读：界面上拿到的永远是掩码，全值只在真正建连时从环境变量或 .keys.json 读。
 */

import {
  esc, num, stampOf, daysSince, getPath, setPath,
  stateOf, ch, section, mountSprite, listOf,
  get, command, toast, subOf, tabBar, goSub, watchSub,
} from './_kit.js';

const TABS = [
  { id: 'models', label: '模型' },
  { id: 'ui', label: '界面' },
  { id: 'system', label: '系统' },
  { id: 'about', label: '关于' },
];
const TAB_IDS = TABS.map((t) => t.id);

/** 与聊天版/运维台同一个偏好键：换壳不换她的亮暗 */
const THEME_KEY = 'irmia.theme';

/** 事件日志分片上限：常量在 src/log/event-log.ts 的 DEFAULT_SHARD_MAX_BYTES（只读展示） */
const SHARD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 两条模型 lane（与 src/config/config.ts 的 ModelsConfig.heavy/light 同名）。
 * label 是给人看的名字，note 说清它拿这份密钥干什么活。
 */
const LANES = [
  { id: 'heavy', label: '主循环（heavy）', note: 'turn 主力：她会话与工具调用所使用的模型' },
  { id: 'light', label: '轻量（light）', note: '必要性判断、压缩摘要与守卫分类所使用的模型' },
];

export function init(el, ctx) {
  mountSprite();

  const S = {
    tab: subOf(TAB_IDS, 'models'),
    cfg: null,
    cfgError: null,
    cfgLoading: true,
    keys: null,
    keysError: null,
    keysLoading: true,
    proj: null,
    projError: null,
    doctor: null,
    session: null,
    theme: readTheme(),
  };

  function readTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch {
      /* 隐私模式下读不到就跟随系统 */
    }
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    S.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }

  // ── 数据加载 ──

  async function load() {
    const [cfg, proj, doctor, session] = await Promise.all([
      get(ctx, '/api/config'),
      get(ctx, '/api/projection'),
      get(ctx, '/api/doctor'),
      get(ctx, '/api/events?types=session%2Fstart&limit=20'),
    ]);
    S.cfgLoading = false;
    if (cfg.ok && cfg.data !== null && typeof cfg.data === 'object') { S.cfg = cfg.data; S.cfgError = null; } else { S.cfgError = cfg.ok ? '配置读取失败' : cfg.error; }
    if (proj.ok) { S.proj = proj.data; S.projError = null; } else { S.projError = proj.error; }
    S.doctor = doctor.ok ? doctor.data : null;
    const list = session.ok ? listOf(session.data, 'events') : [];
    S.session = list.length > 0 ? list[list.length - 1] : null;
    paint();
  }

  /** 密钥状态单独一条：保存密钥后只刷它（掩码以服务端为准，本页不自己算一份） */
  async function loadKeys() {
    const res = await get(ctx, '/api/keys');
    S.keysLoading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') { S.keys = res.data; S.keysError = null; } else { S.keysError = res.ok ? '密钥状态读取失败' : res.error; }
    paint();
  }

  // ── 模型（可写） ──

  /** 某个受管键的状态：`{configured, mask}`（形状严格照 GET /api/keys 的契约） */
  function keyStateOf(name) {
    const raw = S.keys === null ? null : S.keys[name];
    if (raw === null || raw === undefined || typeof raw !== 'object') return { configured: false, mask: null };
    return {
      configured: raw.configured === true,
      mask: typeof raw.mask === 'string' ? raw.mask : null,
    };
  }

  function laneCard(lane) {
    const modelPath = `models.${lane.id}.model`;
    const model = getPath(S.cfg ?? {}, modelPath);
    const envName = getPath(S.cfg ?? {}, `models.${lane.id}.apiKeyEnv`);
    const st = keyStateOf(lane.id);
    const badge = st.configured
      ? `<span class="badge" data-tone="ok">已配置 ${esc(st.mask ?? '…')}</span>`
      : '<span class="badge">未配置密钥</span>';
    return `<div class="card block" data-state="data" id="set-lane-${esc(lane.id)}">
${ch(`${esc(lane.label)} ${badge}`, `<span class="tv mono">models.${esc(lane.id)}</span>`)}
<div class="field-row">
<div>模型名 <div class="field-hint">${esc(lane.note)}</div></div>
<div class="set-inline">
<input data-act="set-model-edit" data-lane="${esc(lane.id)}" type="text" value="${esc(model ?? '')}" spellcheck="false" placeholder="deepseek-chat">
<button class="btn" data-act="set-model-save" data-lane="${esc(lane.id)}">保存</button>
</div>
</div>
<div class="field-row">
<div>API key
<div class="field-hint">环境变量 <span class="mono">${esc(envName ?? '—')}</span> 优先；它没值时用这里填的值（存 data/.keys.json，只写不读）</div></div>
<div class="set-inline">
<input data-act="set-key-edit" data-name="${esc(lane.id)}" type="password" value="" autocomplete="off" spellcheck="false" placeholder="${st.configured ? '已配置；粘贴新密钥可覆盖' : 'sk-…'}">
<button class="btn btn-primary" data-act="set-key-save" data-name="${esc(lane.id)}">保存</button>
${st.configured ? `<button class="btn btn-quiet" data-act="set-key-clear" data-name="${esc(lane.id)}">清除</button>` : ''}
</div>
</div>
</div>`;
  }

  function modelsTab() {
    const cfgState = stateOf(S.cfgLoading, S.cfgError, false, S.cfg !== null);
    const keyNote = S.keysError === null ? '' : `（密钥状态读取失败：${esc(S.keysError)}）`;
    const body = S.cfg === null
      ? ''
      : `${LANES.map(laneCard).join('')}
<p class="footnote">密钥只写不读：这个页面拿到的永远是掩码（<span class="mono">sk-…1234</span>），全值只在真正建连时读一次。保存写的是本地文件与 config.json；<b>进程下次启动时接管</b>（环境变量压过文件，模型名同样重启后生效）${keyNote}</p>`;
    return section(cfgState, body, {
      loading: '正在读取生效配置…',
      error: S.cfgError ?? '配置读取失败',
      retry: 'set-reload',
      emptyIcon: 'i-sliders',
      emptyTitle: '配置未加载',
      emptyHint: '本地服务的 /api/config 没返回配置本体。',
    });
  }

  // ── 界面 ──

  function uiTab() {
    return `<div class="card block" data-state="data" id="set-ui">
${ch('界面', '<span class="tv">即时生效</span>')}
<div class="field-row">
<div>明暗模式 <span class="field-hint">仅本地偏好，即时生效；不进配置、不影响渲染指纹</span></div>
<div class="seg" id="set-theme">
<button data-act="set-theme" data-theme-value="light" data-on="${S.theme === 'light'}">亮</button>
<button data-act="set-theme" data-theme-value="dark" data-on="${S.theme === 'dark'}">暗</button>
</div>
</div>
<div class="field-row">
<div>当前主题 <span class="field-hint">存 localStorage（${esc(THEME_KEY)}）；首启跟随系统偏好</span></div>
<div class="mono tiny">${esc(S.theme)}</div>
</div>
<div class="field-row">
<div>壳与页面 <span class="field-hint">壳负责路由与令牌门；各页面为可懒加载模块</span></div>
<div class="mono tiny">index.html + shell.js + pages/*.js</div>
</div>
<p class="footnote">本页仅覆盖本机观感与模型密钥；其余配置在运维台的「配置文件」页修改。</p>
</div>`;
  }

  // ── 系统（只读） ──

  function systemTab() {
    const cfg = S.cfg ?? {};
    const shards = S.doctor?.events !== undefined && S.doctor?.events !== null ? S.doctor.events.shards : null;
    const rows = [
      { label: '数据目录', value: String(cfg.dataDir ?? '—'), restart: true },
      { label: '监听端口', value: String(getPath(cfg, 'web.port') ?? '—'), restart: true },
      { label: '绑定地址', value: String(getPath(cfg, 'web.host') ?? '—'), restart: true },
      { label: '时区', value: String(cfg.timezone ?? '—'), restart: true },
      {
        label: '日志分片大小',
        value: `${Math.round(SHARD_MAX_BYTES / 1024 / 1024)} MB/片${shards === null ? '' : ` · 当前 ${num(shards)} 片`}`,
        restart: true,
      },
      { label: '配置 schema 版本', value: String(cfg.schemaVersion ?? '—'), restart: false },
      { label: 'destructive 策略', value: policyLabel(getPath(cfg, 'tools.destructiveEnabled')), restart: false },
    ];
    return `<div class="card block" data-state="${stateOf(S.cfgLoading, S.cfgError, false, S.cfg !== null)}" id="set-system">
${ch('系统', '<span class="tv">只读；修改请至配置文件页</span>')}
${section(stateOf(S.cfgLoading, S.cfgError, false, S.cfg !== null), rows
      .map(
        (row) => `<div class="field-row">
<div>${esc(row.label)} ${row.restart ? '<span class="badge" data-tone="warn">需重启</span>' : ''}</div>
<div class="mono tiny">${esc(row.value)}</div>
</div>`,
      )
      .join(''), {
      loading: '正在读取生效配置…',
      error: S.cfgError ?? '配置读取失败',
      retry: 'set-reload',
      emptyIcon: 'i-cog',
      emptyTitle: '配置未加载',
      emptyHint: '本地服务的 /api/config 没返回配置本体。',
    })}
<div class="field-hint" style="margin-top:8px">分片上限是常量（src/log/event-log.ts 的 DEFAULT_SHARD_MAX_BYTES），不在配置文件中，故只读。</div>
</div>`;
  }

  function policyLabel(policy) {
    if (policy === true) return '全开';
    if (Array.isArray(policy)) return policy.length === 0 ? '按名单（空）' : `按名单（${policy.length} 件）`;
    return '全关';
  }

  // ── 关于 ──

  function aboutTab() {
    const proj = S.proj;
    const cfg = S.cfg ?? {};
    const days = proj?.firstEventAt !== null && proj?.firstEventAt !== undefined ? daysSince(proj.firstEventAt) : null;
    const version = S.session?.data?.version ?? null;
    const items = S.doctor?.items !== undefined && S.doctor?.items !== null ? S.doctor.items : null;
    const shards = S.doctor?.events !== undefined && S.doctor?.events !== null ? S.doctor.events.shards : null;
    const rows = [
      { label: '版本', value: version === null ? `未取到（配置 schema ${String(cfg.schemaVersion ?? '—')}）` : String(version) },
      { label: '守护天数', value: days === null ? '—' : `${num(days)} 天${proj?.firstEventAt ? `（自 ${stampOf(proj.firstEventAt)}）` : ''}` },
      { label: '事件水位', value: num(proj?.watermark ?? proj?.lastSeq) },
      { label: '落盘分片', value: shards === null ? '—' : `${num(shards)} 片 · 每片上限 ${Math.round(SHARD_MAX_BYTES / 1024 / 1024)} MB` },
      { label: '不变量自检', value: items === null ? '—' : `${items.length} 项（doctor 面板在日志页）` },
      { label: '进程', value: S.session?.data?.pid === undefined ? '—' : `pid ${num(S.session.data.pid)} · ${String(S.session.data.cwd ?? '')}` },
    ];
    return `<div class="card block" data-state="data" id="set-about">
${ch('关于', '<span class="tv">壳 + 页面模块，零构建</span>')}
${rows
      .map(
        (row) => `<div class="field-row">
<div>${esc(row.label)}</div>
<div class="mono tiny">${esc(row.value)}</div>
</div>`,
      )
      .join('')}
<p class="footnote">以上规模数据均为运行时实测（事件水位 / 落盘分片 / 自检项）；测试套件的规模以 npm test 为准。</p>
</div>`;
  }

  function tabHtml() {
    if (S.tab === 'models') return modelsTab();
    if (S.tab === 'system') return systemTab();
    if (S.tab === 'about') return aboutTab();
    return uiTab();
  }

  function paint() {
    el.innerHTML = `
<div class="sh-page-head">
  <h1 class="sh-page-title">设置</h1>
  <p class="sh-page-sub">模型密钥、观感、系统只读项与运行规模</p>
</div>
<div class="sh-page-body">
  ${tabBar(TABS, S.tab)}
  <div class="set-body">${tabHtml()}</div>
</div>`;
  }

  // ── 写：模型名与密钥 ──

  /** 输入框当前值：重渲染会丢焦点，所以输入态只在这一刻读（不做双份状态） */
  function inputValue(selector) {
    const node = el.querySelector(selector);
    return node === null || node === undefined ? '' : String(node.value ?? '');
  }

  /** 模型名 → `config-update`（点路径）；改的是 config.json，重启后接管 */
  async function saveModelName(lane) {
    const path = `models.${lane}.model`;
    const value = inputValue(`input[data-act="set-model-edit"][data-lane="${lane}"]`).trim();
    if (value === '') {
      toast('模型名不能为空', 'danger');
      return;
    }
    const fields = {};
    setPath(fields, path, value);
    const ok = await command(ctx, 'config-update', { fields }, { done: '已写入 config.json（进程重启后接管）' });
    if (!ok) return;
    if (S.cfg !== null) setPath(S.cfg, path, value);
    paint();
  }

  /** 密钥 → `set-key`（X-Confirm: set-key）；空串 = 清除该键 */
  async function saveKey(name, clear) {
    const value = clear ? '' : inputValue(`input[data-act="set-key-edit"][data-name="${name}"]`);
    if (!clear && value.trim() === '') {
      toast('密钥为空，请先粘贴密钥。', 'danger');
      return;
    }
    const ok = await command(ctx, 'set-key', { name, value }, {
      confirm: 'set-key',
      done: clear ? '已清除本地密钥' : '已生效',
    });
    if (!ok) return;
    S.keys = null;
    S.keysLoading = true;
    await loadKeys(); // 掩码以服务端为准：重新拉一次，输入框随重渲染清空（值不回显）
  }

  // ── 交互 ──

  el.addEventListener('click', (ev) => {
    const target = ev.target;
    const node = target !== null && target !== undefined && typeof target.closest === 'function' ? target.closest('[data-act]') : null;
    if (node === null || node === undefined) return;
    const act = node.dataset.act;
    if (act === 'set-theme') {
      applyTheme(node.dataset.themeValue === 'dark' ? 'dark' : 'light');
      paint();
      toast(S.theme === 'dark' ? '已切换为暗色主题' : '已切换为亮色主题');
      return;
    }
    if (act === 'subtab') {
      goSub('settings', String(node.dataset.sub ?? 'models'));
      return;
    }
    if (act === 'set-reload') {
      void load();
      void loadKeys();
      return;
    }
    if (act === 'set-model-save') {
      void saveModelName(String(node.dataset.lane ?? ''));
      return;
    }
    if (act === 'set-key-save') {
      void saveKey(String(node.dataset.name ?? ''), false);
      return;
    }
    if (act === 'set-key-clear') {
      void saveKey(String(node.dataset.name ?? ''), true);
      return;
    }
  });

  const stopWatch = watchSub(TAB_IDS, 'models', (next) => {
    if (next === S.tab) return;
    S.tab = next;
    paint();
  });

  paint();
  void load();
  void loadKeys();
  return () => stopWatch();
}

/**
 * 消息适配器页（#/channels）—— 逻辑从运维台的「配置文件 · 平台配置」拆出并重排
 *
 * 结构：两张通道卡（QQ 官方 / OneBot 11）+ webhook 参数卡 + 文件监听参数卡
 * 数据：GET /api/config（生效配置本体）+ GET /api/events（最近一条通道事件时刻）
 * 写：POST /api/commands/config-update（通道开关与参数都走它，落一条 config/changed）
 *
 * 口径说明：连接状态是从"生效配置 + 事件日志"实测出来的，不做臆造——
 *   enabled=false → 未启用；enabled=true 且有过通道事件 → 运行中（带最近时刻）；
 *   enabled=true 但一条事件都没有 → 已启用，等第一条消息。
 */

import {
  esc, stampOf, timeOf, getPath, setPath, stateOf, section,
  mountSprite, get, command, every, delegate, toast,
} from './_kit.js';

/** 通道定义：路径与展示名对齐 src/config/config.ts 的 ChannelsConfig */
const GROUPS = [
  {
    id: 'qq',
    title: 'QQ 官方 Bot 通道',
    channel: 'qq-official',
    enabledPath: 'channels.qqOfficial.enabled',
    hint: 'AppID 与 ClientSecret 只写环境变量名，值在建连时从进程环境读——不落配置文件。',
    fields: [
      { p: 'channels.qqOfficial.appIdEnv', l: 'AppID 环境变量名' },
      { p: 'channels.qqOfficial.clientSecretEnv', l: 'ClientSecret 环境变量名' },
      { p: 'channels.qqOfficial.apiBase', l: 'API 根地址' },
      { p: 'channels.qqOfficial.tokenUrl', l: '凭证地址' },
      { p: 'channels.qqOfficial.gatewayUrl', l: '网关覆盖地址' },
    ],
  },
  {
    id: 'onebot',
    title: 'OneBot 11 通道',
    channel: 'onebot',
    enabledPath: 'channels.onebot.enabled',
    hint: '协议端（NapCat / go-cqhttp）的正向 WebSocket；access_token 同样只写变量名。',
    fields: [
      { p: 'channels.onebot.wsUrl', l: '协议端 ws 地址' },
      { p: 'channels.onebot.tokenEnv', l: 'access_token 环境变量名' },
    ],
  },
];

/** 与运维台同一条实情：这两个字段能被写进配置，但当前版本还没读它 */
const PENDING_FIELDS = new Set(['paths.watchPaths']);

const EVENTS_QUERY = `/api/events?types=${encodeURIComponent('wake/channel,speak/sent,wake/webhook,wake/file')}&limit=200`;

export function init(el, ctx) {
  mountSprite();

  const S = {
    cfg: null,
    cfgError: null,
    cfgLoading: true,
    events: [],
    evError: null,
    evLoading: true,
    draft: new Map(),
  };

  // ── 数据加载 ──

  async function loadConfig() {
    S.cfgLoading = true;
    paint();
    const res = await get(ctx, '/api/config');
    S.cfgLoading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.cfg = res.data;
      S.cfgError = null;
      S.draft = new Map();
    } else {
      S.cfgError = res.ok ? '配置读取失败' : res.error;
    }
    paint();
  }

  async function loadEvents() {
    S.evLoading = true;
    paint();
    const res = await get(ctx, EVENTS_QUERY);
    S.evLoading = false;
    if (res.ok) {
      const payload = res.data;
      S.events = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
      S.evError = null;
    } else {
      S.evError = res.error;
    }
    paint();
  }

  // ── 通道状态（从事件日志实测） ──

  /** 某通道最近一条事件（wake/channel 与 speak/sent 都按 data.channel 归类） */
  function lastEventOf(channel) {
    let hit = null;
    for (const ev of S.events) {
      if (ev?.data?.channel !== channel) continue;
      if (hit === null || String(ev.ts) > String(hit.ts)) hit = ev;
    }
    return hit;
  }

  /** 某类事件最近时刻（webhook / 文件监听用） */
  function lastOfType(type) {
    let hit = null;
    for (const ev of S.events) {
      if (ev?.type !== type) continue;
      if (hit === null || String(ev.ts) > String(hit.ts)) hit = ev;
    }
    return hit;
  }

  function channelState(group) {
    const enabled = getPath(S.cfg ?? {}, group.enabledPath) === true;
    const last = lastEventOf(group.channel);
    if (!enabled) return { tone: '', label: '未启用', last, note: '配置项已关闭，适配器不会建立连接。' };
    if (last === null) return { tone: 'info', label: '已启用', last, note: '尚未收到通道事件。' };
    return { tone: 'ok', label: '运行中', last, note: `最近一条通道事件 ${timeOf(last.ts)}。` };
  }

  // ── 渲染 ──

  function fieldRow(f) {
    const current = getPath(S.cfg ?? {}, f.p);
    const draft = S.draft.has(f.p) ? S.draft.get(f.p) : current;
    const pending = PENDING_FIELDS.has(f.p);
    const isNumber = f.k === 'number';
    const value = draft === undefined || draft === null ? '' : String(draft);
    return `<div class="field-row">
<div>${esc(f.l)} ${pending ? '<span class="badge" data-tone="warn">字段待落地</span>' : ''}
<div class="field-hint mono">${esc(f.p)}</div></div>
<div>
<input data-act="ch-edit" data-path="${esc(f.p)}" data-kind="${esc(f.k ?? 'text')}" type="${isNumber ? 'number' : 'text'}" value="${esc(value)}" spellcheck="false" placeholder="未设置">
</div>
</div>`;
  }

  function channelCard(group) {
    const st = channelState(group);
    const enabled = getPath(S.cfg ?? {}, group.enabledPath) === true;
    const dirty = group.fields.filter((f) => S.draft.has(f.p)).length + (S.draft.has(group.enabledPath) ? 1 : 0);
    return `<div class="card block" data-state="data" id="ch-${esc(group.id)}">
<div class="card-head">
  <h3 class="card-title">${esc(group.title)} <span class="badge" data-tone="${st.tone}">${esc(st.label)}</span></h3>
  <div class="row">
    <span class="tv mono">${esc(group.channel)}</span>
    <button class="toggle" role="switch" aria-checked="${enabled}" data-act="ch-toggle" data-path="${esc(group.enabledPath)}" title="启用 / 停用"></button>
  </div>
</div>
<div class="tv">${esc(st.note)}${st.last === null ? '' : ` · #${esc(st.last.seq)}`}</div>
<div class="field-hint" style="margin-top:6px">${esc(group.hint)}</div>
${group.fields.map(fieldRow).join('')}
<div class="row" style="margin-top:12px">
  <button class="btn btn-primary" data-act="ch-save" data-group="${esc(group.id)}">保存${dirty > 0 ? `（${dirty} 项改动）` : ''}</button>
  <button class="btn" data-act="ch-reload">重新加载</button>
</div>
</div>`;
  }

  function webhookCard() {
    const url = getPath(S.cfg ?? {}, 'alerts.webhookUrl');
    const lastHook = lastOfType('wake/webhook');
    const lastSent = lastOfType('alarm/sent');
    const fields = [
      { p: 'alerts.webhookUrl', l: '告警出口 webhook' },
      { p: 'alerts.rateLimitMin', l: '同类告警限流窗口（分钟）', k: 'number' },
    ];
    return `<div class="card block" data-state="data" id="ch-webhook">
<div class="card-head">
  <h3 class="card-title">webhook <span class="badge" data-tone="${url === undefined || url === '' ? '' : 'ok'}">${url === undefined || url === '' ? '未配置出口' : '已配置出口'}</span></h3>
  <button class="btn" data-act="ch-save" data-group="webhook">保存</button>
</div>
<div class="tv">入站：${lastHook === null ? '暂无 webhook 唤醒记录' : `${timeOf(lastHook.ts)} · ${esc(String(lastHook.data?.path ?? ''))}`}</div>
<div class="tv">出站：${lastSent === null ? '暂无告警发送记录' : `最近一条告警 ${stampOf(lastSent.ts)} · ${esc(String(lastSent.data?.level ?? ''))}`}</div>
${fields.map(fieldRow).join('')}
<div class="field-hint">出口地址为空 = 只落日志不外发（与 src/config/config.ts 的 AlertsConfig 同一条口径）。</div>
</div>`;
  }

  function fileWatchCard() {
    const list = getPath(S.cfg ?? {}, 'paths.watchPaths');
    const lastFile = lastOfType('wake/file');
    const shown = Array.isArray(list) ? list.join('\n') : typeof list === 'string' ? list : '';
    return `<div class="card block" data-state="data" id="ch-filewatch">
<div class="card-head">
  <h3 class="card-title">文件监听 <span class="badge" data-tone="warn">字段待落地</span></h3>
  <button class="btn" data-act="ch-save" data-group="filewatch">保存</button>
</div>
<div class="tv">最近一条文件事件：${lastFile === null ? '暂无' : `${timeOf(lastFile.ts)} · ${esc(String(lastFile.data?.kind ?? ''))} ${esc(String(lastFile.data?.path ?? ''))}`}</div>
<div class="field-row">
  <div>paths.watchPaths
    <div class="field-hint mono">paths.watchPaths</div></div>
  <textarea data-act="ch-edit" data-path="paths.watchPaths" data-kind="lines" rows="3" spellcheck="false" placeholder="每行一条路径">${esc(shown)}</textarea>
</div>
<div class="field-hint">写进去不会立刻生效：当前版本的 PathsConfig 还没读这个字段（运维台的配置文件页同样标了「字段待落地」）。</div>
</div>`;
  }

  function paint() {
    const cfgState = stateOf(S.cfgLoading, S.cfgError, false, S.cfg !== null);
    const body = S.cfg === null
      ? ''
      : `<div class="ch-grid">${GROUPS.map(channelCard).join('')}</div>
<div class="ch-grid" style="margin-top:16px">${webhookCard()}${fileWatchCard()}</div>`;

    el.innerHTML = `
<div class="sh-page-head">
  <h1 class="sh-page-title">消息适配器</h1>
  <p class="sh-page-sub">她从哪里听到人说话，以及告警与文件从哪里叫醒她</p>
</div>
<div class="sh-page-body">
  ${section(cfgState, body, {
    loading: '正在读取生效配置…',
    error: S.cfgError ?? '配置读取失败',
    retry: 'ch-reload',
    emptyIcon: 'i-sliders',
    emptyTitle: '读不到配置',
    emptyHint: '本地服务的 /api/config 没返回配置本体。',
  })}
  <p class="footnote">事件样本：最近 200 条 · ${S.evLoading ? '正在读取…' : S.evError !== null ? `读取失败（${esc(S.evError)}）` : `${S.events.length} 条`}；通道状态由事件日志实测得出。</p>
</div>`;
  }

  // ── 保存 ──

  function fieldsFor(groupId) {
    const paths = groupId === 'webhook'
      ? ['alerts.webhookUrl', 'alerts.rateLimitMin']
      : groupId === 'filewatch'
        ? ['paths.watchPaths']
        : (GROUPS.find((g) => g.id === groupId)?.fields ?? []).map((f) => f.p);
    const fields = {};
    for (const path of paths) {
      if (!S.draft.has(path)) continue;
      const value = S.draft.get(path);
      // 清空 = 回到默认值：提交 null（配置解析器把 null 当"用默认"）。
      // 空串不能提交——`channels.*` 与 `alerts.webhookUrl` 走的 pickNonEmptyString 会当场拒绝并回滚。
      setPath(fields, path, typeof value === 'string' && value.trim() === '' ? null : value);
    }
    return fields;
  }

  async function saveGroup(groupId) {
    const fields = fieldsFor(groupId);
    if (Object.keys(fields).length === 0) {
      toast('没有待保存的改动。');
      return;
    }
    const pending = Object.keys(fields).filter((p) => PENDING_FIELDS.has(p));
    const ok = await command(ctx, 'config-update', { fields }, {
      done: pending.length > 0 ? `已写入 ${pending.join(', ')}（字段待落地，暂不生效）` : '已生效并落日志',
    });
    if (ok) await loadConfig();
  }

  // ── 交互 ──

  delegate(el, async (act, node) => {
    switch (act) {
      case 'ch-reload':
        void loadConfig();
        void loadEvents();
        return;
      case 'ch-toggle': {
        const path = String(node.dataset.path ?? '');
        const on = node.getAttribute('aria-checked') === 'true';
        S.draft.set(path, !on);
        paint();
        return;
      }
      case 'ch-edit': {
        const path = String(node.dataset.path ?? '');
        const kind = String(node.dataset.kind ?? 'text');
        const raw = node.value ?? '';
        const trimmed = raw.trim();
        // 数字框清空 = 回到默认值（null），不是 0：`Number('')` 会把限流窗口悄悄写成"不限流"
        const value = kind === 'number'
          ? (trimmed === '' ? null : Number(trimmed))
          : kind === 'lines'
            ? raw.split('\n').map((line) => line.trim()).filter(Boolean)
            : raw;
        S.draft.set(path, value);
        // 不重渲染：输入框要保持焦点与光标（改动数在点保存时再报）
        return;
      }
      case 'ch-save':
        await saveGroup(String(node.dataset.group ?? ''));
        return;
      default:
        return;
    }
  });

  // 输入框在 change 上分派（delegate 的 change 通路），点按类走 click
  paint();
  void loadConfig();
  void loadEvents();
  const stopPoll = every(15_000, () => { void loadEvents(); });
  return () => stopPoll();
}

/**
 * 日志页（#/logs）—— 四个 tab：统计 / 事件 / 日志 / 追踪
 * 全部从运维台平移（renderStatsTab / budgetCardHtml / renderEventsTab / renderAlarmsTab / renderTraceTab），
 * DOM 挂到 el，四态与虚拟滚动口径不变。
 *
 * 数据：GET /api/stats/dashboard · /api/budget · /api/events · /api/alarms · /api/doctor · /api/replay
 */

import {
  esc, sv, clip, icon, num, pct, timeOf, stampOf, daysSince,
  stateOf, ch, section, blockCard, mountSprite, listOf,
  get, every, delegate, toast, subOf, tabBar, goSub, watchSub,
} from './_kit.js';

const TABS = [
  { id: 'stats', label: '统计' },
  { id: 'events', label: '事件' },
  { id: 'logs', label: '日志' },
  { id: 'trace', label: '追踪' },
];
const TAB_IDS = TABS.map((t) => t.id);

const BATCH = 200; // 事件流每批条数（与 CLI/服务端契约一致）
const ROW_H = 40; // 固定行高：虚拟滚动靠它算偏移
const EXPAND_H = 240;
const CLIP = 60;

/** 事件类型分组（与运维台同一张分组表，过滤栏按它排布） */
const DOMAIN_GROUPS = [
  { name: '生命周期', types: ['session/start', 'session/end', 'turn/start', 'turn/end', 'step/start', 'step/end'] },
  { name: '消息', types: ['message/user', 'message/assistant', 'message/reasoning', 'developer/message'] },
  { name: '工具', types: ['tool/call', 'tool/result', 'tool/zombie'] },
  { name: '唤醒与队列', types: ['wake/timer', 'wake/file', 'wake/webhook', 'wake/manual', 'wake/heartbeat', 'wake/intention', 'wake/job', 'wake/channel', 'timer/set', 'timer/fired', 'timer/cancelled', 'input/claimed', 'input/dead-letter', 'input/requeued'] },
  { name: '预算', types: ['budget/consumed', 'budget/rollover', 'budget/exhausted', 'budget/topped-up'] },
  { name: '策略与审计', types: ['policy/denied', 'log/repaired', 'instance/takeover', 'alarm/sent', 'review/resolved', 'snapshot/checkpoint', 'compaction/summary', 'persona/updated', 'config/changed'] },
  { name: '扩展面', types: ['mcp/server-started', 'mcp/server-stopped', 'skill/installed', 'hook/fired', 'speak/sent', 'intention/raised', 'intention/acted', 'todo/updated', 'job/started', 'job/finished', 'human/asked', 'human/answered', 'human/expired', 'model/degraded', 'model/restored'] },
];

const STATE_ORDER = ['needs-review', 'paused', 'degraded', 'running', 'sleeping', 'idle'];

export function init(el, ctx) {
  mountSprite();

  const S = {
    tab: subOf(TAB_IDS, 'stats'),
    proj: null,
    projError: null,
    dash: null,
    dashError: null,
    budget: { range: 'today', data: null, error: null, loading: false },
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
    alarms: { data: null, error: null, loading: false, cur: null, curError: null, curLoading: false },
    doctor: { data: null, error: null, loading: false },
    trace: { turn: '', step: '' },
  };

  // ──────────────────────────── 摘要与状态的翻译层（平移） ────────────────────────────

  function reasonKind(reason) {
    return reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : '未知结局';
  }

  function wakeSource(source) {
    const map = { timer: '定时器', file: '文件', webhook: 'webhook', manual: '手动', heartbeat: '心跳', intention: '意图', job: '后台任务', channel: 'IM 通道' };
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
    if (type === 'wake/channel') return `${d.channel ?? '通道'} · ${clip(d.text)}`;
    if (type === 'speak/sent') return `${d.channel ?? ''} → ${clip(d.text)}`;
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

  function nextTimerAt(proj) {
    const list = (proj?.timers ?? []).map((t) => t?.at).filter((at) => typeof at === 'string').sort();
    return list.length > 0 ? list[0] : null;
  }

  function stateMachine(proj, dash) {
    const needsReview = proj?.needsReview?.length ?? 0;
    const paused = proj?.lastExhausted && Object.keys(proj.lastExhausted).length > 0;
    const next = nextTimerAt(proj);
    let kind = 'idle';
    if (needsReview > 0) kind = 'needs-review';
    else if (paused) kind = 'paused';
    else if (proj?.degraded) kind = 'degraded';
    else if (proj?.openTurn) kind = 'running';
    else if ((proj?.idleTicks ?? 0) >= 4) kind = 'sleeping';
    const remote = typeof dash?.state === 'string' ? dash.state : null;
    if (remote !== null && STATE_ORDER.includes(remote)) kind = remote;
    const text = {
      'needs-review': `待确认（${needsReview} 项）`,
      paused: '已暂停（预算耗尽）',
      degraded: `降级运行（${proj?.degraded?.lane ?? '未知 lane'}）`,
      running: '执行中',
      sleeping: '休眠中',
      idle: next ? `就绪 · 下次唤醒 ${timeOf(next)}` : '就绪',
      onboarding: '未开始记录',
    };
    const subline = {
      'needs-review': `${needsReview} 项待人工处置`,
      paused: '预算已耗尽；追加预算后可继续',
      degraded: proj?.degraded?.reason ?? '降级链已接管',
      running: `turn ${proj?.openTurn?.turn ?? '-'} · step ${proj?.openTurn?.step ?? '-'}`,
      sleeping: `连续 ${proj?.idleTicks ?? 0} 次空拍，心跳退避中`,
      idle: next ? `定时器 ${timeOf(next)} 触发` : '等待心跳或外部唤醒',
      onboarding: '待确定种子人格来源',
    };
    const remoteDetail = typeof dash?.detail === 'string' && dash.detail !== '' ? dash.detail : null;
    // 主状态句一律走前端词表（与壳的品牌区同一张）；服务端口径只作补充说明
    return { kind, text: text[kind] ?? text.idle, subline: remoteDetail ?? subline[kind] ?? '' };
  }

  // ──────────────────────────── 统计 tab ────────────────────────────

  function hourSeries() {
    const raw = S.dash?.hourly ?? S.dash?.series?.hourly ?? [];
    return Array.isArray(raw) ? raw.slice(0, 24) : [];
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

  /** 24 小时纯 SVG 曲线：实线 token 堆叠面积 + 虚线命中率（不外链任何图表库） */
  function hourChart(series) {
    const points = Array.isArray(series) ? series.slice(0, 24) : [];
    if (points.length < 2) return '<div class="muted-block">暂无 24 小时序列数据。</div>';
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
    if (list.length === 0) return '<div class="muted-block">暂无 turn 明细。</div>';
    return `<table class="turn-table">
<thead><tr><th>turn</th><th>结局</th><th>输入</th><th>输出</th><th>命中率</th><th>耗时</th></tr></thead>
<tbody>${list
      .map(
        (t) => `<tr data-act="open-turn" data-turn="${esc(t?.turn ?? '')}" title="到事件页看这一段">
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

  function budgetBodyHtml(d) {
    if (d === null || typeof d !== 'object') return '';
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
${ch('最近 20 个 turn', '<span class="tv">点击行进入事件页</span>')}
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

  function statsHeadHtml() {
    const proj = S.proj;
    if (proj === null) {
      return section(S.projError !== null ? 'error' : 'loading', '', { error: S.projError ?? undefined, retry: 'logs-reload' });
    }
    const sm = stateMachine(proj, S.dash);
    const days = proj?.firstEventAt !== null && proj?.firstEventAt !== undefined ? daysSince(proj.firstEventAt) : null;
    const t = S.dash?.tiles ?? {};
    return `<section class="head-grid" data-state-kind="${esc(sm.kind)}" id="log-head">
<div>
<div class="guarded">已守护 <b>${days === null ? '—' : num(days)}</b> 天${proj?.firstEventAt ? ` · 自 ${esc(stampOf(proj.firstEventAt))}` : ''}</div>
<h2 class="state-line">${esc(sm.text)}</h2>
<p class="subline">${esc(sm.subline)}</p>
</div>
<div class="cta-wrap">
<span class="badge">水位 ${esc(num(t.watermark ?? proj?.watermark))}</span>
<span class="badge" data-tone="${(t.needsReview ?? 0) > 0 ? 'danger' : ''}">待确认 ${esc(num(t.needsReview ?? 0))}</span>
</div>
</section>`;
  }

  function statsTab() {
    const d = S.budget.data;
    const hasData = d !== null && (Number(d?.today?.tokens ?? 0) > 0 || (Array.isArray(d?.turns) && d.turns.length > 0));
    return `${statsHeadHtml()}
<div class="card" id="stat-budget" style="margin-top:16px">
${ch('预算', `<div class="row"><span class="tv">${S.budget.range === '7d' ? '近 7 天' : '今日'}</span>
<div class="seg" id="budget-range">
<button data-act="budget-range" data-range="today" data-on="${S.budget.range === 'today'}">今日</button>
<button data-act="budget-range" data-range="7d" data-on="${S.budget.range === '7d'}">7 天</button>
</div></div>`)}
${section(stateOf(S.budget.loading, S.budget.error, false, hasData), budgetBodyHtml(d), {
      id: 'stat-budget-block',
      loading: '正在取预算数据…',
      error: S.budget.error ?? '预算读取失败',
      retry: 'budget-reload',
      emptyIcon: 'i-timer',
      emptyTitle: '暂无用量记录',
      emptyHint: '该时间段没有模型调用记录。',
    })}
</div>`;
  }

  // ──────────────────────────── 事件 tab ────────────────────────────

  function filtersHtml() {
    const groups = DOMAIN_GROUPS.map((group) => {
      const on = group.types.some((t) => S.filters.types.has(t));
      return `<details class="type-group" data-on="${on}">
<summary>${esc(group.name)}${on ? ' ●' : ''}</summary>
<div class="type-panel"><div class="type-list">
${group.types
          .map((t) => `<label class="checkbox"><input type="checkbox" data-act="type-toggle" value="${esc(t)}" ${S.filters.types.has(t) ? 'checked' : ''}><span class="mono tiny">${esc(t)}</span></label>`)
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

  function rowHtml(ev, index) {
    return `<button class="ev-row" data-act="ev-row" data-seq="${esc(ev.seq)}" data-index="${index}" data-open="${S.openSeq === ev.seq}" data-danger="${isDanger(ev.type)}" data-new="${S.newSeqs.has(ev.seq)}" style="top:${offsetOf(index)}px">
<span class="ev-time">${esc(timeOf(ev.ts))}</span>
<span class="ev-seq">#${esc(ev.seq)}</span>
<span class="badge" data-tone="${esc(typeTone(ev.type))}">${esc(ev.type)}</span>
<span class="ev-sum">${esc(summarize(ev))}</span>
<span class="badge">${esc(ev.visibility ?? 'internal')}</span>
</button>`;
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
<div class="role-body"><div class="code" data-collapsed="${long}">${esc(long ? `${body.slice(0, 240)}…` : body)}</div>
${long ? '<button class="btn btn-quiet" data-act="ev-expand-msg">展开全文</button>' : ''}</div>
</div>`;
        })
        .join('')}</div>`
      : '<div class="tv">这次请求体为空（可能是纯流程 step）。</div>'}
<div class="tv">当时 usage：输入 ${esc(num(usage.inputTokens))} · 输出 ${esc(num(usage.outputTokens))} · 命中 ${esc(num(usage.cacheHitTokens))} · 耗时 ${esc(num(usage.durationMs))}ms</div>
${r.diff ? `<div class="card">${ch('与当前渲染的 diff')}<div class="code">${esc(typeof r.diff === 'string' ? r.diff : JSON.stringify(r.diff, null, 2))}</div></div>` : ''}`;
  }

  function replayHtml(ev) {
    const turn = ev?.data?.turn;
    const step = ev?.data?.step;
    if (typeof turn !== 'number' || typeof step !== 'number') return '<div class="tv">这条事件没有 turn/step，无法重放。</div>';
    if (S.replayError !== null) {
      return `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.replayError)}</span><button class="btn" data-act="ev-replay" data-turn="${esc(turn)}" data-step="${esc(step)}">重试</button></div>`;
    }
    const r = S.replay;
    if (r === null) return `<div class="st-line">${icon('i-refresh')}<span>正在重建第 ${esc(turn)} 轮第 ${esc(step)} 步的请求体…</span></div>`;
    return `<div class="stack" id="ev-replay">${replayBodyHtml(r, turn, step)}</div>`;
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

  function openRowIndex() {
    return S.openSeq === null ? -1 : S.events.findIndex((ev) => ev.seq === S.openSeq);
  }

  function offsetOf(index) {
    const open = openRowIndex();
    return index * ROW_H + (open >= 0 && open < index ? EXPAND_H : 0);
  }

  /** 只画视口内的行（虚拟滚动）：DOM 数量与事件总数无关 */
  function paintRows() {
    const viewport = el.querySelector('#ev-list');
    const spacer = el.querySelector('#ev-spacer');
    if (viewport === null || spacer === null) return;
    const top = viewport.scrollTop;
    const height = viewport.clientHeight || 400;
    const from = Math.max(0, Math.floor(top / ROW_H) - 8);
    const to = Math.min(S.events.length, Math.ceil((top + height) / ROW_H) + 8);
    const parts = [];
    const open = openRowIndex();
    for (let i = from; i < to; i += 1) {
      const ev = S.events[i];
      if (ev === undefined) continue;
      parts.push(rowHtml(ev, i));
      if (i === open) parts.push(expandHtml(ev, offsetOf(i) + ROW_H));
    }
    spacer.innerHTML = parts.join('');
    S.newSeqs.clear();
  }

  function renderNewbar() {
    const wrap = el.querySelector('#ev-newbar-wrap');
    if (wrap === null) return;
    if (S.filters.follow || S.newCount === 0) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = `<button class="newbar" data-act="ev-follow-now">${icon('i-refresh')}<span>${S.newCount} 条新事件</span></button>`;
  }

  let rowTick = 0;
  function onEventsScroll() {
    if (rowTick !== 0) return;
    rowTick = requestAnimationFrame(() => {
      rowTick = 0;
      paintRows();
    });
  }

  function eventsTab() {
    const listState = stateOf(S.evLoading, S.evError, S.events.length === 0, S.events.length > 0);
    return `${filtersHtml()}
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
<p class="footnote">事件流与 CLI tail 同源；告警落盘见日志页。</p>`;
  }

  /** 事件 tab 落 DOM 后的收尾：spacer 高度 + 首屏行 + 新事件条 */
  function afterEventsPaint() {
    const spacer = el.querySelector('#ev-spacer');
    if (spacer === null) return;
    spacer.style.height = `${S.events.length * ROW_H + (S.openSeq !== null ? EXPAND_H : 0)}px`;
    paintRows();
    renderNewbar();
    const foot = el.querySelector('#ev-foot');
    if (foot !== null) foot.innerHTML = eventFootHtml();
    // 开着“跟随新事件”时，新事件一到就流到底（与运维台同一条节奏）
    const viewport = el.querySelector('#ev-list');
    if (viewport !== null && S.filters.follow && S.newCount > 0) {
      viewport.scrollTop = spacer.offsetHeight;
      S.newCount = 0;
      paintRows();
    }
  }

  // ──────────────────────────── 日志 tab ────────────────────────────

  function doctorPanelHtml() {
    const items = S.doctor.data ?? [];
    const body = S.doctor.loading
      ? `<div class="st-line">${icon('i-refresh')}<span>正在跑不变量自检…</span></div>`
      : S.doctor.error !== null
        ? `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.doctor.error)}</span><button class="btn" data-act="log-doctor">重试</button></div>`
        : items.length === 0
          ? '<div class="tv">尚未运行；点击右上角运行。</div>'
          : items
            .map(
              (item) => `<div class="check-line" data-ok="${item?.ok === true}">
<span>${item?.ok === true ? '✓' : '✗'}</span>
<span>${esc(item?.title ?? item?.id ?? '')}</span>
<span class="tiny variant push">${esc(clip(item?.detail ?? '', 60))}</span>
${item?.status && item.status !== 'ok' ? `<span class="tv">${esc(item.status)}</span>` : ''}
</div>`,
            )
            .join('');
    return `<div class="card" id="log-doctor">
${ch('自检（doctor）', `<button class="btn" data-act="log-doctor">${icon('i-doctor')}运行</button>`)}
${body}
</div>`;
  }

  function logsTab() {
    const d = S.alarms.data;
    const files = listOf(d, 'files');
    const cur = S.alarms.cur;
    const listState = stateOf(S.alarms.loading, S.alarms.error, files.length === 0, files.length > 0);
    const curState = cur === null ? 'empty' : S.alarms.curLoading ? 'loading' : S.alarms.curError !== null ? 'error' : 'data';
    const listBody = `<div class="tree" id="log-files">${files
      .map(
        (file) => `<button class="tree-item" data-act="alarm-select" data-name="${sv(file?.name)}" data-on="${cur?.name === file?.name}">
${icon('i-file')}<span>${sv(file?.name)}</span><span class="badge push">${esc(num(file?.lines))} 行</span>
</button>`,
      )
      .join('')}</div>
<div class="tv" style="margin-top:8px">共 ${files.length} 份 · 单份读取上限 200k 字符</div>`;
    return `<div class="split">
${blockCard('log-alarms', '告警落盘', `<button class="btn" data-act="alarms-reload">${icon('i-refresh')}重读</button>`, listState, {
      loading: '正在读告警目录…',
      error: S.alarms.error ?? '告警目录读取失败',
      retry: 'alarms-reload',
      emptyIcon: 'i-file',
      emptyTitle: '暂无告警落盘',
      emptyHint: '第一条告警发出后这个目录才出现。',
      slot: listBody,
    })}
${blockCard('log-content', `内容 <span class="tiny variant mono">${sv(cur?.name)}</span>`, '', curState, {
      loading: '正在读这一份…',
      error: S.alarms.curError ?? '读取失败',
      retry: 'alarms-reload',
      emptyIcon: 'i-file',
      emptyTitle: '未选择告警文件',
      emptyHint: '在左列选择一份文件查看原文。',
      slot: `<div class="row tiny variant"><span>${esc(num(cur?.lines))} 行 · ${esc(num(cur?.bytes))} 字节</span>${cur?.mtime ? `<span>· ${esc(stampOf(cur.mtime))}</span>` : ''}${cur?.truncated ? '<span class="badge" data-tone="warn">已截断</span>' : ''}</div>
<div class="code" style="max-height:420px">${sv(cur?.content)}</div>`,
    })}
</div>
<div class="tiny variant mono" id="log-dir">${esc(String(d?.relative ?? 'alarms'))}</div>
<div style="margin-top:16px">${doctorPanelHtml()}</div>`;
  }

  // ──────────────────────────── 追踪 tab ────────────────────────────

  function traceTab() {
    const turn = S.trace.turn;
    const step = S.trace.step;
    const turnList = [...new Set(S.events.map((ev) => Number(ev?.data?.turn)).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b).slice(-48);
    const stepList = [...new Set(S.events.filter((ev) => String(ev?.data?.turn) === String(turn)).map((ev) => Number(ev?.data?.step)).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
    const state = S.replayError !== null ? 'error' : S.replay !== null ? 'data' : turn !== '' ? 'loading' : 'empty';
    return `<div class="card" id="tr-form">
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
<div class="field-hint">turn/step 从已加载事件中获取；未写入日志的 step 无法重建。</div>
</div>
<div style="margin-top:16px">
${blockCard('tr-result', '请求体与三指纹', '', state, {
      loading: `正在重建 turn ${esc(turn)} step ${esc(step)} 的请求体…`,
      error: S.replayError ?? '重放数据读取失败',
      retry: 'trace-run',
      emptyIcon: 'i-replay',
      emptyTitle: '未选择步骤',
      emptyHint: '填 turn 与 step，这里显示当时的请求体。',
      slot: `<div class="stack" id="tr-fingerprints">${S.replay !== null ? replayBodyHtml(S.replay, turn, step) : ''}</div>`,
    })}
</div>`;
  }

  // ──────────────────────────── 渲染与切换 ────────────────────────────

  function tabHtml() {
    if (S.tab === 'stats') return statsTab();
    if (S.tab === 'events') return eventsTab();
    if (S.tab === 'logs') return logsTab();
    return traceTab();
  }

  function paint() {
    // 事件 tab 会因展开/新事件重画：先把滚动位置拿住，重画后放回去（否则点一行就跳顶）
    const prevScroll = S.tab === 'events' ? Number(el.querySelector('#ev-list')?.scrollTop ?? 0) : 0;
    el.innerHTML = `
<div class="sh-page-head">
  <h1 class="sh-page-title">日志</h1>
  <p class="sh-page-sub">账本、事件流、告警落盘与请求体重放</p>
</div>
<div class="sh-page-body">
  ${tabBar(TABS, S.tab)}
  <div class="logs-body">${tabHtml()}</div>
</div>`;
    if (S.tab === 'events') {
      afterEventsPaint();
      const viewport = el.querySelector('#ev-list');
      if (viewport !== null && prevScroll > 0) viewport.scrollTop = prevScroll;
    }
  }

  // ──────────────────────────── 数据加载 ────────────────────────────

  async function loadStats() {
    S.budget.loading = true;
    const [proj, dash, budget] = await Promise.all([
      get(ctx, '/api/projection'),
      get(ctx, '/api/stats/dashboard'),
      get(ctx, `/api/budget?range=${encodeURIComponent(S.budget.range)}`),
    ]);
    if (proj.ok) { S.proj = proj.data; S.projError = null; } else { S.projError = proj.error; }
    if (dash.ok) S.dash = dash.data;
    S.budget.loading = false;
    if (budget.ok && budget.data !== null && typeof budget.data === 'object') { S.budget.data = budget.data; S.budget.error = null; } else { S.budget.error = budget.ok ? '预算读取失败' : budget.error; }
    paint();
  }

  async function loadBudget() {
    S.budget.loading = true;
    paint();
    const res = await get(ctx, `/api/budget?range=${encodeURIComponent(S.budget.range)}`);
    S.budget.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.budget.data = res.data;
      S.budget.error = null;
    } else {
      S.budget.error = res.ok ? '预算读取失败' : res.error;
    }
    paint();
  }

  function mergeEvents(list) {
    let added = 0;
    for (const ev of list) {
      if (ev === null || typeof ev !== 'object' || typeof ev.seq !== 'number') continue;
      if (S.seqIndex.has(ev.seq)) continue;
      S.seqIndex.set(ev.seq, ev);
      S.events.push(ev);
      added += 1;
    }
    if (added > 0) S.events.sort((a, b) => a.seq - b.seq);
    return added;
  }

  function lastSeqOf() {
    return S.events.length === 0 ? 0 : S.events[S.events.length - 1].seq;
  }

  async function loadEvents(opts = {}) {
    const q = new URLSearchParams();
    const types = [...S.filters.types];
    if (types.length > 0) q.set('types', types.join(','));
    if (S.filters.visibility !== 'all') q.set('visibility', S.filters.visibility);
    q.set('limit', String(opts.limit ?? BATCH));
    if (typeof opts.fromSeq === 'number') q.set('from_seq', String(opts.fromSeq));
    if (typeof opts.cursor === 'number') q.set('from_seq', String(opts.cursor));

    if (opts.reset === true) {
      S.evLoading = true;
      S.evError = null;
      paint();
    }
    const res = await get(ctx, `/api/events?${q.toString()}`);
    S.evLoading = false;
    if (!res.ok) {
      S.evError = res.error;
    } else {
      const payload = res.data;
      const list = Array.isArray(payload) ? payload : listOf(payload, 'events');
      if (opts.reset === true) {
        S.events = [];
        S.seqIndex = new Map();
      }
      const added = mergeEvents(list);
      S.evError = null;
      S.evCursor = typeof payload?.nextBeforeSeq === 'number' ? payload.nextBeforeSeq : null;
      if (opts.newOnly === true && added > 0) S.newCount += added;
    }
    // 增量拉取（silent）不重画：重画会丢掉滚动位置与展开态
    if (S.tab === 'events' && opts.silent !== true) paint();
    if (S.tab === 'events' && opts.silent === true) {
      renderNewbar();
      const foot = el.querySelector('#ev-foot');
      if (foot !== null) foot.innerHTML = eventFootHtml();
    }
  }

  async function loadReplay(turn, step) {
    S.replay = null;
    S.replayError = null;
    paint();
    const res = await get(ctx, `/api/replay?turn=${encodeURIComponent(turn)}&step=${encodeURIComponent(step)}`);
    if (res.ok && res.data !== null && typeof res.data === 'object') S.replay = res.data;
    else S.replayError = res.ok ? '重放数据读取失败' : res.error;
    paint();
  }

  async function loadAlarms() {
    S.alarms.loading = true;
    paint();
    const res = await get(ctx, '/api/alarms');
    S.alarms.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.alarms.data = res.data;
      S.alarms.error = null;
    } else {
      S.alarms.error = res.ok ? '告警目录读取失败' : res.error;
    }
    paint();
  }

  async function selectAlarm(name) {
    S.alarms.cur = { name };
    S.alarms.curLoading = true;
    S.alarms.curError = null;
    paint();
    const res = await get(ctx, `/api/alarms?file=${encodeURIComponent(name)}`);
    S.alarms.curLoading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.alarms.cur = res.data;
      S.alarms.curError = null;
    } else {
      S.alarms.curError = res.ok ? '告警文件读取失败' : res.error;
    }
    paint();
  }

  async function runDoctor() {
    S.doctor.loading = true;
    S.doctor.error = null;
    paint();
    const res = await get(ctx, '/api/doctor');
    S.doctor.loading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.doctor.data = listOf(res.data, 'items');
      S.doctor.error = null;
    } else {
      S.doctor.error = res.ok ? 'doctor 读取失败' : res.error;
    }
    paint();
  }

  function loadTab() {
    if (S.tab === 'stats') return loadStats();
    if (S.tab === 'events') return loadEvents({ reset: true });
    if (S.tab === 'logs') return Promise.all([loadAlarms(), runDoctor()]);
    return Promise.resolve();
  }

  // ──────────────────────────── 交互 ────────────────────────────

  function fingerprintDiff(fp) {
    return [
      `renderVersion  ${fp.renderVersion ?? '—'}`,
      `personaHash    ${fp.personaHash ?? '—'} → 当前 ${fp.currentPersonaHash || '（取不到）'}${fp.personaChanged ? '   ← 变了' : '   = 一致'}`,
      `configHash     ${fp.configHash || '—'}${fp.configChanged ? '   ← 与当前配置不一致' : '   = 与当前一致'}`,
      '',
      fp.personaChanged || fp.configChanged
        ? '结论：人格或配置之后变了，重建的请求体与当下不同。'
        : '结论：三指纹一致，重建的请求体即当前渲染内容。',
    ].join('\n');
  }

  delegate(el, async (act, node) => {
    switch (act) {
      case 'subtab':
        goSub('logs', String(node.dataset.sub ?? 'stats'));
        return;
      case 'logs-reload':
        void loadTab();
        return;
      case 'budget-reload':
        void loadBudget();
        return;
      case 'budget-range':
        S.budget.range = node.dataset.range === '7d' ? '7d' : 'today';
        void loadBudget();
        return;
      case 'open-turn':
        S.filters.types = new Set(['budget/consumed', 'turn/end']);
        goSub('logs', 'events');
        S.tab = 'events';
        paint();
        void loadEvents({ reset: true });
        return;
      // ── 事件过滤 ──
      case 'type-toggle':
        if (node.checked) S.filters.types.add(node.value);
        else S.filters.types.delete(node.value);
        paint();
        void loadEvents({ reset: true });
        return;
      case 'visibility':
        S.filters.visibility = node.value;
        paint();
        void loadEvents({ reset: true });
        return;
      case 'ev-follow':
        S.filters.follow = node.checked;
        if (node.checked) S.newCount = 0;
        renderNewbar();
        return;
      case 'ev-follow-now':
        S.newCount = 0;
        paint();
        if (S.filters.follow) {
          const viewport = el.querySelector('#ev-list');
          const spacer = el.querySelector('#ev-spacer');
          if (viewport !== null && spacer !== null) viewport.scrollTop = spacer.offsetHeight;
        }
        return;
      case 'ev-jump': {
        const input = el.querySelector('#ev-jump-input');
        const seq = Number(input?.value ?? 0);
        if (Number.isFinite(seq) && seq > 0) {
          if (S.seqIndex.has(seq)) {
            S.openSeq = seq;
            paint();
          } else {
            await loadEvents({ reset: true, fromSeq: Math.max(0, seq - BATCH) });
          }
        }
        return;
      }
      case 'ev-reload':
        S.openSeq = null;
        await loadEvents({ reset: true });
        return;
      case 'ev-clear-filter':
        S.filters.types = new Set();
        S.filters.visibility = 'all';
        S.openSeq = null;
        await loadEvents({ reset: true });
        return;
      case 'ev-earlier':
        if (S.evCursor !== null) await loadEvents({ cursor: S.evCursor });
        return;
      case 'ev-row': {
        const seq = Number(node.dataset.seq);
        S.openSeq = S.openSeq === seq ? null : seq;
        S.replay = null;
        S.replayError = null;
        paint();
        const ev = S.seqIndex.get(seq);
        if (S.openSeq !== null && ev !== undefined && typeof ev?.data?.turn === 'number' && typeof ev?.data?.step === 'number') {
          void loadReplay(ev.data.turn, ev.data.step);
        }
        return;
      }
      case 'ev-copy': {
        const ev = S.seqIndex.get(Number(node.dataset.seq));
        if (ev !== undefined && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(JSON.stringify(ev, null, 2));
          toast('事件 JSON 已复制');
        }
        return;
      }
      case 'ev-replay':
        await loadReplay(Number(node.dataset.turn), Number(node.dataset.step));
        return;
      case 'ev-expand-msg': {
        const code = node.parentElement?.querySelector('.code');
        if (code !== null && code !== undefined && code.dataset.collapsed === 'true') {
          code.dataset.collapsed = 'false';
          node.remove();
        }
        return;
      }
      case 'ev-export-json': {
        const blob = new Blob([JSON.stringify(S.replay ?? {}, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `replay-turn${node.dataset.turn}-step${node.dataset.step}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      case 'ev-diff': {
        const fp = S.replay?.fingerprints;
        if (fp === undefined || fp === null || typeof fp !== 'object') {
          toast('暂无重放数据；请先重建请求体', 'danger');
          return;
        }
        S.replay = Object.assign({}, S.replay, { diff: fingerprintDiff(fp) });
        paint();
        toast('已生成与当前渲染的指纹差异');
        return;
      }
      // ── 日志 ──
      case 'alarms-reload':
        S.alarms.cur = null;
        S.alarms.curError = null;
        void loadAlarms();
        return;
      case 'alarm-select':
        await selectAlarm(String(node.dataset.name ?? ''));
        return;
      case 'log-doctor':
        await runDoctor();
        return;
      // ── 追踪 ──
      case 'trace-run': {
        const turn = Number(el.querySelector('#tr-turn')?.value ?? NaN);
        const step = Number(el.querySelector('#tr-step')?.value ?? NaN);
        if (!Number.isFinite(turn) || !Number.isFinite(step)) {
          toast('turn 与 step 必须为数字', 'danger');
          return;
        }
        S.trace = { turn: String(turn), step: String(step) };
        await loadReplay(turn, step);
        return;
      }
      case 'trace-from-last': {
        const last = [...S.events].reverse().find((item) => typeof item?.data?.turn === 'number' && typeof item?.data?.step === 'number');
        if (last === undefined) {
          toast('事件日志中无带 turn/step 的事件', 'danger');
          return;
        }
        S.trace = { turn: String(last.data.turn), step: String(last.data.step) };
        await loadReplay(last.data.turn, last.data.step);
        return;
      }
      default:
        return;
    }
  });

  // 虚拟滚动：scroll 不冒泡，用捕获阶段挂在页面根上（容器随 tab 增删，绑定只做一次）
  el.addEventListener('scroll', (ev) => {
    if (ev.target?.id !== 'ev-list') return;
    onEventsScroll();
  }, true);

  const stopWatch = watchSub(TAB_IDS, 'stats', (next) => {
    if (next === S.tab) return;
    S.tab = next;
    paint();
    void loadTab();
  });

  paint();
  void loadTab();
  // 跟随新事件：10s 一次增量拉取（只在事件 tab 上）；由“跟随”开关决定是自动流底还是发提示条
  const stopPoll = every(10_000, () => {
    if (S.tab !== 'events') return;
    void loadEvents({ fromSeq: lastSeqOf() + 1, newOnly: true, silent: true });
  });
  return () => {
    stopWatch();
    stopPoll();
    if (rowTick !== 0) cancelAnimationFrame(rowTick);
  };
}

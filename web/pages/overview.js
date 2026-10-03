/**
 * 运行情况页（默认首页）——我亲自操刀的视觉与交互
 * 结构：状态卡（她的存在感）→ 待确认横幅（有才出现）→ 磁贴×4 → 建议 → 最近发生的事
 * 数据：/api/stats/dashboard + /api/projection + /api/review
 */

export function init(el, ctx) {
  el.innerHTML = `
    <div class="sh-page-head">
      <h1 class="sh-page-title">运行情况</h1>
      <p class="sh-page-sub">状态、用量与待确认项</p>
    </div>
    <div class="sh-page-body ov-body">
      <section class="ov-hero">
        <span class="ov-hero-face"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#her-mark"></use></svg></span>
        <div class="ov-hero-text">
          <p class="ov-state" id="ov-state">正在读取状态…</p>
          <p class="ov-sub" id="ov-sub"></p>
        </div>
        <button class="ov-wake" id="ov-wake">立即唤醒</button>
      </section>

      <section class="ov-review" id="ov-review" hidden></section>

      <section class="ov-tiles">
        <div class="ov-tile" data-act="logs">
          <span class="ov-tile-value" id="ov-tokens">–</span>
          <span class="ov-tile-label">今日用量</span>
          <svg class="ov-spark" id="ov-spark-tokens" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"></svg>
        </div>
        <div class="ov-tile" data-act="logs">
          <span class="ov-tile-value" id="ov-hitrate">–</span>
          <span class="ov-tile-label">缓存命中率</span>
          <svg class="ov-spark" id="ov-spark-hit" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"></svg>
        </div>
        <div class="ov-tile" data-act="logs">
          <span class="ov-tile-value" id="ov-pending">–</span>
          <span class="ov-tile-label">待办</span>
        </div>
        <div class="ov-tile" data-act="logs">
          <span class="ov-tile-value" id="ov-fail">–</span>
          <span class="ov-tile-label">连续失败</span>
        </div>
      </section>

      <section class="ov-advice" id="ov-advice" hidden>
        <h2 class="ov-sec-title">建议</h2>
        <ul class="ov-advice-list" id="ov-advice-list"></ul>
      </section>

      <section class="ov-recent">
        <h2 class="ov-sec-title">最近事件</h2>
        <ul class="ov-recent-list" id="ov-recent-list"></ul>
      </section>
    </div>
  `;

  const $ = (id) => el.querySelector(`#${id}`);
  const stateEl = $('ov-state');
  const subEl = $('ov-sub');
  const reviewEl = $('ov-review');

  // ── 状态卡 ──
  async function paintHero() {
    const [stats, proj] = await Promise.all([
      ctx.api('/api/stats/dashboard'),
      ctx.api('/api/projection'),
    ]);
    const s = stats?.state;
    const day = stats?.guardedDays ?? 0;
    const pending = Number(stats?.tiles?.pending ?? proj?.pending?.length ?? 0);
    const needsReview = Number(stats?.tiles?.needsReview ?? proj?.needsReview?.length ?? 0);
    // 状态词表与壳的品牌区同一张：这里只把它放大，不另写一套
    const map = {
      running: '执行中', idle: '就绪', sleeping: '休眠中',
      degraded: '降级运行', paused: '已暂停（预算耗尽）',
      'needs-review': `待确认（${needsReview} 项）`,
    };
    stateEl.textContent = map[s] ?? (stats?.stateText || '就绪');
    const nextWake = stats?.nextWakeAt ? ` · 下次唤醒 ${fmtTime(stats.nextWakeAt)}` : '';
    subEl.textContent = `已守护 ${day} 天${nextWake}`;

    // 磁贴（数据形状实证对齐：tiles.* 与 budget.*）
    $('ov-tokens').textContent = fmtTokens(stats?.budget?.tokensToday ?? 0);
    const rate = stats?.tiles?.cacheHitRate;
    $('ov-hitrate').textContent = rate === null || rate === undefined ? '–' : `${Math.round(rate * 100)}%`;
    $('ov-pending').textContent = String(pending);
    $('ov-fail').textContent = String(stats?.tiles?.failStreak ?? 0);

    // 磁贴里的 24h 迷你趋势线（hourly 序列现成，纯 SVG 无库）
    paintSparkline($('ov-spark-tokens'), (stats?.hourly ?? []).map(h => h.tokens ?? 0));
    const hr = (stats?.hourly ?? []).map(h => {
      const hsum = (h.hit ?? 0) + (h.miss ?? 0);
      return hsum === 0 ? 0 : (h.hit ?? 0) / hsum;
    });
    paintSparkline($('ov-spark-hit'), hr, true);

    paintAdvice(stats, proj);
    await paintReview(stats, proj);
    paintRecent(stats);
  }

  // ── 待确认横幅 ──
  async function paintReview(stats, proj) {
    const items = proj?.needsReview ?? [];
    if (items.length === 0) { reviewEl.hidden = true; return; }
    reviewEl.hidden = false;
    reviewEl.innerHTML = `
      <p class="ov-review-head">待确认（${items.length} 项）</p>
      ${items.slice(0, 3).map((it) => `
        <div class="ov-review-item">
          <div class="ov-review-info">
            <strong>${esc(it.name ?? it.callId)}</strong>
            <span class="ov-review-meta">${fmtTime(it.at)}</span>
          </div>
          <div class="ov-review-acts">
            <button class="btn-mini ok" data-call="${esc(it.callId)}" data-outcome="succeeded">标记成功</button>
            <button class="btn-mini bad" data-call="${esc(it.callId)}" data-outcome="failed">标记失败</button>
          </div>
        </div>`).join('')}
      ${items.length > 3 ? `<p class="ov-review-more">另有 ${items.length - 3} 项，详见日志页。</p>` : ''}
    `;
    for (const btn of reviewEl.querySelectorAll('.btn-mini')) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await ctx.api('/api/commands/review-resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callId: btn.dataset.call, outcome: btn.dataset.outcome, note: '' }),
          });
          await paintHero();
        } catch { btn.disabled = false; }
      });
    }
  }

  // ── 建议区（服务端已给出条目，这里只管上屏）──
  function paintAdvice(stats, proj) {
    const list = $('ov-advice-list');
    const suggestions = stats?.suggestions ?? [];
    const mine = [];
    if (stats?.personaIsSeed) mine.push({ text: '人格仍为模板默认值：可在人格配置页填写。', act: 'persona' });
    const all = [...mine, ...suggestions.map(s => ({ text: `${s.title ?? ''}${s.body ? '：' + s.body : ''}`, act: s.act === 'goto-tools' ? 'logs' : null }))];
    if (all.length === 0) { $('ov-advice').hidden = true; return; }
    $('ov-advice').hidden = false;
    list.innerHTML = all.map(r => `<li class="ov-advice-item" ${r.act ? `data-act="${r.act}"` : ''}>${esc(r.text)}</li>`).join('');
    for (const item of list.querySelectorAll('[data-act]')) {
      item.addEventListener('click', () => { location.hash = `#/${item.dataset.act}`; });
    }
  }

  // ── 最近发生的事（服务端已翻译好的 summary 直接用）──
  function paintRecent(stats) {
    const events = (stats?.recent ?? []).slice(-8);
    const list = $('ov-recent-list');
    list.innerHTML = events.map((e) => {
      // 镜像与过程不上屏：message/user 是 wake 的渲染镜像，turn/* 与 step/* 是过程
      if (e.type === 'message/user') return null;
      if (e.type === 'turn/start' || e.type === 'step/start' || e.type === 'step/end') return null;
      if (e.type === 'wake/heartbeat') return null; // 心跳不打扰
      if (e.type === 'turn/end' && /completed/.test(e.summary ?? '')) return null;
      if (e.visibility !== 'model' && e.type !== 'turn/end') return null;
      return `<li class="ov-ev"><span class="ov-ev-time">${fmtTime(e.ts)}</span> <span class="ov-ev-text">${esc(e.summary ?? e.type)}</span></li>`;
    }).filter(Boolean).join('')
      || '<li class="ov-ev dim">暂无事件。</li>';
  }

  // ── 交互 ──
  $('ov-wake').addEventListener('click', async () => {
    const btn = $('ov-wake');
    btn.disabled = true;
    try {
      await ctx.api('/api/commands/wake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      btn.textContent = '已唤醒';
      setTimeout(() => { btn.disabled = false; btn.textContent = '立即唤醒'; }, 2400);
    } catch { btn.disabled = false; }
  });
  for (const tile of el.querySelectorAll('.ov-tile[data-act]')) {
    tile.addEventListener('click', () => { location.hash = `#/${tile.dataset.act}`; });
  }

  void paintHero();
  const timer = setInterval(() => { void paintHero(); }, 10_000);
  return () => clearInterval(timer);
}

function fmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function fmtTime(iso) { const d = new Date(iso); return Number.isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** 纯 SVG 迷你趋势线：24 个点折线 + 线下淡填（0.12 透明度），零库 */
function paintSparkline(svg, values, isRatio = false) {
  if (!svg) return;
  const pts = values.length === 0 ? new Array(24).fill(0) : values;
  const max = Math.max(...pts, isRatio ? 1 : 0.0001);
  const w = 100, h = 24;
  const step = w / (pts.length - 1 || 1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1).toFixed(1)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  svg.innerHTML =
    `<polygon points="${area}" fill="var(--accent)" opacity="0.12"/>` +
    `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`;
}

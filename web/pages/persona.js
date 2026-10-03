/**
 * 人格配置页（#/persona）—— 逻辑从运维台（web/app.js 的 renderPersonaTab 一族）平移
 *
 * 结构：文件树（左）+ 直编编辑器 / 提案只读（右）+ 演化时间线（下）
 * 数据：GET /api/persona/files · /api/persona/file?path= · /api/persona/history
 * 写：POST /api/commands/persona-edit（直编：旧内容快照 → 原子写 → persona/updated）
 *     POST /api/commands/persona-approve · persona-reject（提案处置）
 *
 * 直编白名单与后端逐字对齐（src/web/server.ts 的 validatePersonaEdit）：
 *   IDENTITY.md / CONSTITUTION.md / STYLE.md / STATE.md 与 RELATIONSHIPS/<名字>.md；
 *   提案区（proposals/）不归直编，只能批准或拒绝。
 */

import {
  esc, icon, num, pct, stampOf, stateOf, ch, section,
  mountSprite, listOf, get, command, every, delegate, toast,
} from './_kit.js';

/** 常驻预算口径（与运维台的「合计 / 1.5k」同一张刻度） */
const BUDGET_TOKENS = 1500;
/** 直编内容上限（与 src/web/server.ts 的 validatePersonaEdit 同一把尺） */
export const PERSONA_EDIT_MAX_BYTES = 64 * 1024;
/** 可直编的顶层具名文件 */
const EDITABLE_TOP_FILES = ['IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md', 'STATE.md'];
const RELATIONSHIPS_DIR = 'RELATIONSHIPS';
const PROPOSAL_DIR = 'proposals';

/**
 * 可编辑标记：铅笔（16px 内联 SVG）。sprite 里没有这一枚，也不为一个图标引外部图标库；
 * tooltip 走 SVG 的 <title>（原生悬停提示），aria-label 供读屏。
 */
const PENCIL_SVG = '<svg class="ps-pencil" viewBox="0 0 24 24" width="16" height="16" role="img" aria-label="可编辑"><title>可编辑</title><path d="M4 20h4L20 8l-4-4L4 16z" fill="none" stroke="currentColor"/><path d="M14 6l4 4" fill="none" stroke="currentColor"/></svg>';

// ──────────────────────────── 直编契约（纯函数：可单测，页面与测试同一处判定） ────────────────────────────

/** 路径归一化：与后端 safePersonaRel 同一套（反斜杠折成 /，去首尾空白） */
function normalizeRel(path) {
  return String(path ?? '').trim().replace(/\\/gu, '/');
}

/**
 * 这份文件能不能直编 —— 前端判定的唯一出口（铅笔标记、编辑器模式、保存动作都问它）。
 * 规则与 src/web/server.ts 的 validatePersonaEdit 一致：顶层四个具名文件，或 RELATIONSHIPS/ 下一级 .md。
 */
export function isEditablePersonaFile(path) {
  const rel = normalizeRel(path);
  if (rel === '' || rel.includes('\0') || !rel.endsWith('.md')) return false;
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (parts[0] === PROPOSAL_DIR) return false;
  if (parts.length === 1) return EDITABLE_TOP_FILES.includes(rel);
  return parts.length === 2 && parts[0] === RELATIONSHIPS_DIR;
}

/** 保存请求体：形状与后端 validatePersonaEdit 的读法一一对应（内容原样带去，不 trim） */
export function buildEditPayload(file, content) {
  return { file: normalizeRel(file), content: String(content ?? '') };
}

const ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** UTF-8 字节数：与后端 Buffer.byteLength(content, 'utf8') 同一把尺 */
export function byteLength(text) {
  const value = String(text ?? '');
  if (ENCODER !== null) return ENCODER.encode(value).length;
  // 没有 TextEncoder 的壳：按 UTF-8 折算（每个 %XX 与每个 ASCII 字面量各算 1 字节）
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}/giu, 'x').length;
}

/** 直编请求头：Authorization 由页面显式带上（壳的 ctx.api 也会注入，这里写明契约不靠隐式） */
export function editHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (typeof token === 'string' && token !== '') headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 保存一次直编。失败不抛：服务端的拒绝理由原话交给调用方去 toast，编辑区不动。
 */
export async function submitPersonaEdit(ctx, file, content) {
  try {
    const data = await ctx.api('/api/commands/persona-edit', {
      method: 'POST',
      headers: editHeaders(ctx?.token),
      body: JSON.stringify(buildEditPayload(file, content)),
    });
    return { ok: true, data: data ?? null, error: null };
  } catch (err) {
    const message = String(err?.message ?? err);
    const error = message === '401' ? '访问令牌无效：重新粘贴令牌后再保存。' : message;
    return { ok: false, data: null, error };
  }
}

/**
 * 保存结果 → 页面动作。规则只有一条：**成功才刷新，失败不动编辑区**。
 * keepDraft 为真时，草稿与光标原样留在 DOM 里，人不丢自己刚写的东西。
 */
export function editOutcome(result) {
  if (result?.ok === true) {
    return { refresh: true, keepDraft: false, toast: '已保存', tone: 'ok' };
  }
  return { refresh: false, keepDraft: true, toast: String(result?.error ?? '保存失败'), tone: 'danger' };
}

/** 底部提示：只说异常，正常时留白（名词化短句 + 一句怎么办） */
function editorHint(over, blank) {
  if (over) return '内容超出上限，保存已禁用。请删减后重试。';
  if (blank) return '内容为空，保存已禁用。';
  return '';
}

/** textarea 的首个换行会被 HTML 解析吞掉：以 &#10; 保住前导空行 */
function textareaText(text) {
  const body = esc(text);
  return body.startsWith('\n') ? `&#10;${body.slice(1)}` : body;
}

/**
 * 编辑器主体（工具栏 + 警示行 + 编辑区 + 字节行）。
 * 纯函数：给定草稿就渲染草稿——失败后重绘也不会把人写的内容弄丢。
 */
export function renderEditor(state) {
  const path = String(state?.path ?? '');
  const draft = String(state?.draft ?? '');
  const base = typeof state?.base === 'string' ? state.base : null;
  const reserved = state?.reserved === true;
  const saving = state?.saving === true;
  const bytes = byteLength(draft);
  const over = bytes > PERSONA_EDIT_MAX_BYTES;
  const blank = draft.trim() === '';
  const dirty = base !== null && draft !== base;
  const hint = editorHint(over, blank);
  return `<div class="row spread" id="ps-toolbar">
<div class="row row-wrap">
<span class="mono">${esc(path)}</span>
<span class="badge" id="ps-dirty" data-tone="${dirty ? 'warn' : ''}">${dirty ? '未保存' : '已同步'}</span>
${reserved ? '<span class="badge" data-tone="warn">仅人类可改</span>' : ''}
</div>
<div class="row">
<button class="btn" data-act="persona-revert"${dirty && !saving ? '' : ' disabled'}>恢复原状</button>
<button class="btn btn-primary" data-act="persona-save"${saving || over || blank ? ' disabled' : ''}>${saving ? '保存中…' : '保存'}</button>
</div>
</div>
${reserved
  ? `<div class="ps-notice" id="ps-core-note">${icon('i-alert')}<span>核心文件 · 改动改变人格基线，保存后立即生效；旧内容进入版本快照，可回滚。</span></div>`
  : ''}
<textarea class="ps-editor" id="ps-editor" spellcheck="false" aria-label="${esc(path)} 正文">${textareaText(draft)}</textarea>
<div class="row spread">
<span id="ps-bytes" class="mono tiny variant"${over ? ' data-tone="danger"' : ''}>${num(bytes)} / ${num(PERSONA_EDIT_MAX_BYTES)} 字节（上限）</span>
<span id="ps-hint" class="tiny variant">${esc(hint)}</span>
</div>`;
}

export function init(el, ctx) {
  mountSprite();

  const S = {
    view: null,
    files: null,
    filesError: null,
    filesLoading: true,
    cur: null,
    curError: null,
    curLoading: false,
    hist: null,
    histError: null,
    histLoading: true,
    /** 编辑区正文（服务端原文的活副本） */
    draft: null,
    /** 服务端当前原文：脏判定与「恢复原状」的基准 */
    base: null,
    saving: false,
  };

  const isDirty = () => S.base !== null && S.draft !== null && S.draft !== S.base;

  // ── 数据加载 ──

  async function loadFiles() {
    S.filesLoading = true;
    paint();
    const res = await get(ctx, '/api/persona/files');
    S.filesLoading = false;
    if (!res.ok) {
      S.filesError = res.error;
      S.files = S.files ?? null;
    } else {
      S.filesError = null;
      S.view = res.data !== null && typeof res.data === 'object' ? res.data : null;
      S.files = listOf(res.data, 'files').map((item) => (typeof item === 'string' ? { path: item } : item));
      // 首屏自动选中第一份（与运维台同一条节奏）
      if (S.cur === null && S.files.length > 0) void selectFile(S.files[0].path);
    }
    paint();
  }

  async function selectFile(path) {
    // 编辑区里有未保存的草稿：切走等于丢掉刚写的东西，先让人处置
    if (isDirty()) {
      toast('当前文件有未保存改动：先保存或恢复原状。', 'warn');
      return;
    }
    S.cur = { path };
    S.curLoading = true;
    S.curError = null;
    S.draft = null;
    S.base = null;
    paint();
    const res = await get(ctx, `/api/persona/file?path=${encodeURIComponent(path)}`);
    S.curLoading = false;
    if (res.ok && res.data !== null && typeof res.data === 'object') {
      S.cur = Object.assign({ path }, res.data);
      const content = typeof S.cur.content === 'string' ? S.cur.content : '';
      S.curError = null;
      S.draft = content;
      S.base = content;
    } else {
      S.curError = res.ok ? '文件读取失败' : res.error;
    }
    paint();
  }

  async function loadHistory() {
    S.histLoading = true;
    paint();
    const res = await get(ctx, '/api/persona/history');
    S.histLoading = false;
    if (!res.ok) {
      S.histError = res.error;
    } else {
      S.hist = listOf(res.data, 'entries');
      S.histError = null;
    }
    paint();
  }

  // ── 渲染 ──

  /** 提案清单（view.proposals）——哪几份文件当前挂着待批提案 */
  function proposalFiles() {
    const list = S.view?.proposals;
    return Array.isArray(list) ? list.map((item) => String(item)) : [];
  }

  function lastEditorOf(path) {
    const entry = (S.hist ?? []).find((item) => item?.file === path);
    return typeof entry?.by === 'string' ? entry.by : null;
  }

  function treeHtml() {
    const files = S.files ?? [];
    if (files.length === 0) return '';
    return files
      .map((file) => {
        const path = String(file?.path ?? file?.name ?? '');
        const name = String(file?.name ?? path.split('/').pop() ?? '');
        const reserved = file?.reserved === true;
        const proposals = Number(file?.proposals ?? file?.proposalCount) || 0;
        const editable = isEditablePersonaFile(path);
        return `<button class="tree-item" data-act="persona-file" data-path="${esc(path)}" data-on="${S.cur?.path === path}" data-indent="${path.includes('/') ? '1' : '0'}" data-editable="${editable}">
${icon(reserved ? 'i-lock' : 'i-file')}
<span>${esc(name)}</span>
${editable ? PENCIL_SVG : ''}
${proposals > 0 ? `<span class="badge push" data-tone="info">提案 ${proposals}</span>` : ''}
${reserved ? '<span class="badge push">仅人类可改</span>' : ''}
</button>`;
      })
      .join('');
  }

  /** 极简 markdown 渲染：标题 / 无序列表 / 代码块 / 粗体 / 行内码（输入已 esc）——只读面用 */
  function markdown(text) {
    const lines = esc(text ?? '').split('\n');
    const out = [];
    let inCode = false;
    let listOpen = false;
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (listOpen) { out.push('</ul>'); listOpen = false; }
        out.push(inCode ? '</pre>' : '<pre>');
        inCode = !inCode;
        continue;
      }
      if (inCode) { out.push(line); continue; }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        if (listOpen) { out.push('</ul>'); listOpen = false; }
        const level = heading[1].length;
        out.push(`<h${level}>${heading[2]}</h${level}>`);
        continue;
      }
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        if (!listOpen) { out.push('<ul>'); listOpen = true; }
        out.push(`<li>${bullet[1]}</li>`);
        continue;
      }
      if (listOpen) { out.push('</ul>'); listOpen = false; }
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

  /** 观测量：估算 token / 常驻预算占用 / 最后修改（编辑与只读两种模式共用） */
  function metaHtml(cur) {
    const tokens = Number(cur.tokens ?? cur.estimatedTokens);
    const budget = Number(cur.budget ?? BUDGET_TOKENS);
    const ratio = Number.isFinite(tokens) && budget > 0 ? Math.min(1, tokens / budget) : null;
    const tone = ratio === null ? '' : ratio > 1 ? 'danger' : ratio > 0.8 ? 'warn' : '';
    const editor = lastEditorOf(cur.path);
    return `<div class="row row-wrap tiny variant">
<span>估算 ${tokens ? num(tokens) : '—'} token</span>
<span>· 常驻预算占用 ${ratio === null ? '—' : pct(ratio)}（合计 / 1.5k）</span>
<span>· 最后修改 ${esc(cur.mtime ? stampOf(cur.mtime) : '未知')}${editor === null ? '' : ` by ${esc(editor)}`}</span>
</div>
<div class="budgetbar" data-tone="${tone}"><span style="width:${ratio === null ? 0 : Math.round(ratio * 100)}%"></span></div>`;
  }

  /** 待批提案卡：这一页唯一另一个写动作 */
  function proposalCard(path) {
    if (!proposalFiles().includes(path)) return '';
    return `<div class="card" id="ps-proposal">
${ch('待批提案', '<span class="tv">批准即写 persona/updated（by: human）</span>')}
<div class="row spread ev-line">
<div>
<div class="mono tiny">proposals/${esc(path)}</div>
<div class="tv">批准前请核对提案正文。</div>
</div>
<div class="row">
<button class="btn" data-act="persona-proposal-view" data-file="${esc(path)}">查看提案</button>
<button class="btn btn-primary" data-act="persona-approve" data-file="${esc(path)}" data-hash="">批准</button>
<button class="btn" data-act="persona-reject" data-file="${esc(path)}">拒绝</button>
</div>
</div>
</div>`;
  }

  /** 只读面：提案区与白名单外的文件只能看，不能直编 */
  function readonlyHead(cur) {
    const proposal = String(cur.path ?? '').startsWith(`${PROPOSAL_DIR}/`);
    return `<div class="ps-readonly" id="ps-readonly-note">${icon('i-lock')}<span>${proposal
      ? '只读 · 提案由 agent 写入，请用批准或拒绝处置。'
      : '只读 · 该文件不在直编白名单。'}</span></div>`;
  }

  function contentHtml() {
    const cur = S.cur;
    if (!cur) return '';
    if (S.curLoading) return `<div class="st-line">${icon('i-refresh')}<span>正在读取 ${esc(cur.path)}…</span></div>`;
    if (S.curError !== null) {
      return `<div class="st-line st-error">${icon('i-alert')}<span class="st-msg">${esc(S.curError)}</span><button class="btn" data-act="persona-reload">重试</button></div>`;
    }
    if (isEditablePersonaFile(cur.path)) {
      return `<div class="stack" id="ps-content">
${renderEditor({ path: cur.path, draft: S.draft ?? '', base: S.base, reserved: cur.reserved === true, saving: S.saving })}
${metaHtml(cur)}
${proposalCard(cur.path)}
</div>`;
    }
    return `<div class="stack" id="ps-content">
${metaHtml(cur)}
${readonlyHead(cur)}
<div class="md">${markdown(cur.content ?? '')}</div>
${proposalCard(cur.path)}
</div>`;
  }

  /** 只同步编辑器周边的数字与按钮：输入过程中不重建 DOM，光标与选区留在原处 */
  function syncChrome() {
    if (typeof el.querySelector !== 'function') return;
    const draft = S.draft ?? '';
    const bytes = byteLength(draft);
    const over = bytes > PERSONA_EDIT_MAX_BYTES;
    const blank = draft.trim() === '';
    const dirty = isDirty();

    const bytesNode = el.querySelector('#ps-bytes');
    if (bytesNode !== null && bytesNode !== undefined) {
      bytesNode.textContent = `${num(bytes)} / ${num(PERSONA_EDIT_MAX_BYTES)} 字节（上限）`;
      bytesNode.dataset.tone = over ? 'danger' : '';
    }
    const hintNode = el.querySelector('#ps-hint');
    if (hintNode !== null && hintNode !== undefined) hintNode.textContent = editorHint(over, blank);
    const dirtyNode = el.querySelector('#ps-dirty');
    if (dirtyNode !== null && dirtyNode !== undefined) {
      dirtyNode.textContent = dirty ? '未保存' : '已同步';
      dirtyNode.dataset.tone = dirty ? 'warn' : '';
    }
    const saveNode = el.querySelector('[data-act="persona-save"]');
    if (saveNode !== null && saveNode !== undefined) {
      saveNode.disabled = S.saving || over || blank;
      saveNode.textContent = S.saving ? '保存中…' : '保存';
    }
    const revertNode = el.querySelector('[data-act="persona-revert"]');
    if (revertNode !== null && revertNode !== undefined) revertNode.disabled = !dirty || S.saving;
  }

  function timelineHtml() {
    const entries = S.hist ?? [];
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

  function paint() {
    // 编辑区里有未保存的草稿：全量重绘会重建 textarea（光标与选区归零），只同步周边数字
    if (isDirty() || S.saving) {
      syncChrome();
      return;
    }
    const treeState = stateOf(S.filesLoading, S.filesError, S.files?.length === 0, Array.isArray(S.files) && S.files.length > 0);
    const contentState = S.cur === null ? 'empty' : S.curLoading ? 'loading' : S.curError !== null ? 'error' : 'data';
    const histState = stateOf(S.histLoading, S.histError, S.hist?.length === 0, Array.isArray(S.hist) && S.hist.length > 0);
    const proposals = (S.files ?? []).reduce((acc, f) => acc + (Number(f?.proposals) || 0), 0);

    el.innerHTML = `
<div class="sh-page-head">
  <h1 class="sh-page-title">人格配置</h1>
  <p class="sh-page-sub">她是谁、记得什么；以及待批提案与演化记录</p>
</div>
<div class="sh-page-body">
  <div class="split">
    <div>
      ${section(treeState, `<div class="tree" id="ps-tree">${treeHtml()}</div>`, {
        loading: '正在读取人格文件…',
        error: S.filesError ?? '文件树读取失败',
        retry: 'persona-reload',
        emptyIcon: 'i-file',
        emptyTitle: '暂无人格文件',
        emptyHint: '首次启动会写入模板。',
      })}
    </div>
    <div>
      ${section(contentState, contentHtml(), {
        loading: '正在读取…',
        error: S.curError ?? '文件读取失败',
        retry: 'persona-reload',
        emptyIcon: 'i-user',
        emptyTitle: '未选择文件',
        emptyHint: '在左列选择一份文件：带铅笔标记的可以直接改，其余只读。',
      })}
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    ${ch('演化时间线', `<span class="tv">persona/updated 倒序${proposals > 0 ? ` · ${proposals} 个待批提案` : ''}</span>`)}
    ${section(histState, timelineHtml(), {
      loading: '正在读取演化记录…',
      error: S.histError ?? '时间线读取失败',
      retry: 'persona-reload',
      emptyIcon: 'i-timer',
      emptyTitle: '暂无演化记录',
      emptyHint: '第一次 persona/updated 之后就有条目。',
    })}
  </div>
</div>`;
  }

  /** 保存：成功才刷新（树 + 时间线 + 当前文件），失败只提示——草稿与光标留在原处 */
  async function saveDraft() {
    const cur = S.cur;
    if (cur === null || S.draft === null || !isDirty()) return;
    const path = cur.path;
    const draft = S.draft;
    S.saving = true;
    syncChrome();
    const res = await submitPersonaEdit(ctx, path, draft);
    S.saving = false;
    const outcome = editOutcome(res);
    toast(outcome.toast, outcome.tone);
    if (!outcome.refresh) {
      syncChrome();
      return;
    }
    // 先认账再刷新：否则重绘会被「未保存」守卫挡住
    S.base = draft;
    void loadFiles();
    void loadHistory();
    await selectFile(path);
  }

  // ── 交互 ──

  /** 编辑区输入：只更新 S.draft 与周边数字，不重绘（重绘会打断输入） */
  const onInput = (ev) => {
    const node = ev?.target;
    if (node === null || node === undefined || node.id !== 'ps-editor') return;
    S.draft = String(node.value ?? '');
    syncChrome();
  };
  el.addEventListener('input', onInput);

  delegate(el, async (act, node) => {
    switch (act) {
      case 'persona-file': {
        const path = String(node.dataset.path ?? '');
        // 点自己：不重载，免得把草稿冲掉（读取失败的那次例外——再点一下就是重试）
        if (path === S.cur?.path && S.curError === null) return;
        await selectFile(path);
        return;
      }
      case 'persona-reload':
        if (isDirty()) {
          toast('当前文件有未保存改动：先保存或恢复原状。', 'warn');
          return;
        }
        void loadFiles();
        void loadHistory();
        if (S.cur !== null) void selectFile(S.cur.path);
        return;
      case 'persona-save':
        await saveDraft();
        return;
      case 'persona-revert':
        if (S.base === null || !isDirty()) return;
        S.draft = S.base;
        paint();
        toast('已恢复原状');
        return;
      case 'persona-proposal-view':
        await selectFile(`proposals/${String(node.dataset.file ?? '')}`);
        return;
      case 'persona-approve': {
        const file = String(node.dataset.file ?? '');
        const ok = await command(ctx, 'persona-approve', { file, diffHash: node.dataset.hash ?? '' }, { done: '提案已批准，人格已更新' });
        if (ok) {
          void selectFile(file);
          void loadFiles();
          void loadHistory();
        }
        return;
      }
      case 'persona-reject': {
        const file = String(node.dataset.file ?? '');
        const ok = await command(ctx, 'persona-reject', { file, diffHash: node.dataset.hash ?? '' }, { done: '提案已拒绝' });
        if (ok) {
          void selectFile(file);
          void loadFiles();
          void loadHistory();
        }
        return;
      }
      case 'persona-diff':
        toast(`diff ${node.dataset.file} @ ${String(node.dataset.hash ?? '').slice(0, 8)}：用 CLI persona diff 查看全文`);
        return;
      default:
        return;
    }
  });

  paint();
  void loadFiles();
  void loadHistory();
  // 提案与演化都由 agent 侧写入：低频轮询，页面切走就停
  const stopPoll = every(20_000, () => {
    void loadFiles();
    void loadHistory();
  });
  return () => {
    stopPoll();
    el.removeEventListener('input', onInput);
  };
}

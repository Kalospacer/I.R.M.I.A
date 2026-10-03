/**
 * 聊天页外观层验收 — web/index.html（壳）+ web/chat.css + web/pages/chat.js
 *
 * 与 test/chat-assets.test.ts（体积 / 零外链 / 人话纪律 / 路由）分工明确：这一份只管「皮」与「引导」。
 * 聊天页搬进主壳之后，顶栏与令牌门归壳，所以「她有脸」那一枚记号的来源也换成了壳的 #her-mark；
 * 其余视觉规格一条不减，断言照样打在磁盘上真正交付给浏览器的字节上：
 *   ① 她有脸：壳里内联的那枚 SVG 记号，气泡左侧 28px（顶栏那 48px 的脸归壳的品牌区用）；
 *   ② 状态点 8px 呼吸：只动 opacity —— 不许偷偷用缩放/位移抖人（样式留在 chat.css 里，壳内共用）；
 *   ③ 气泡质感：圆角四值、最大宽 70%、行高 1.65、时间戳 10px 且默认隐去；
 *   ④ 装饰纪律：渐变只有氛围光与发丝带（本文件 gradient 字面量 ≤3 处），且对话区在壳里是透明的；
 *   ⑤ 打字机：函数存在，且历史气泡不经过它（首屏走 bulk 通道）；
 *   ⑥ 首启引导卡：按 isSeed 分支，种子文案点名 IDENTITY.md 并给出「去填人格」入口；
 *   ⑦ 壳内挂载纪律：容器内查询、徽章回写壳、destroy 断流摘监听。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installDom } from './helpers/shell-dom.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

/** 真实前端目录（不是 fixture）：这一份测的正是"交付到浏览器的字节" */
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const CHAT_ASSETS = ['index.html', 'chat.css', 'pages/chat.js'] as const;
const MAX_BYTES = 80 * 1024;

const bodies = new Map<string, string>();
for (const name of CHAT_ASSETS) {
  bodies.set(name, readFileSync(join(WEB_DIR, name), 'utf8'));
}

function body(name: (typeof CHAT_ASSETS)[number]): string {
  const text = bodies.get(name);
  assert.ok(text !== undefined, `${name} 尚未读取`);
  return text;
}

/** 取一条选择器的规则体（`sel {` 到闭合的 `}`）：逐块断言，避免全文 grep 抓到别的规则 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `chat.css 里找不到规则 ${selector}`);
  const end = css.indexOf('}', start);
  assert.ok(end > start, `规则 ${selector} 没有闭合`);
  return css.slice(start, end);
}

/** 取一个关键帧块（从 `@keyframes x` 到下一个关键帧或文件尾） */
function frameBody(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name}`);
  assert.ok(start >= 0, `chat.css 里找不到关键帧 ${name}`);
  const next = css.indexOf('@keyframes', start + 1);
  return next >= 0 ? css.slice(start, next) : css.slice(start);
}

/** 表情符号（含图形符号）判定：用来守住「禁 emoji 图标」 */
const EMOJI = /\p{Extended_Pictographic}/u;

// ──────────────────────────────── ① 她有脸 ────────────────────────────────

test('她有脸：壳里内联的 SVG 记号，气泡左侧 28px', () => {
  const html = body('index.html');
  const symbol = /<symbol\b[^>]*id="her-mark"[\s\S]*?<\/symbol>/u.exec(html);
  assert.ok(symbol !== null, 'index.html 应内联 id="her-mark" 的 <symbol>（全壳唯一一份图形定义）');
  const mark = symbol[0] ?? '';
  assert.match(mark, /viewBox="0 0 32 32"/u, '记号应自带视框，缩放不失真');
  assert.ok(/<path\b/u.test(mark), '记号应由 <path> 描边构成（不用 emoji、不用素材图）');
  assert.ok(mark.includes('fill="currentColor"'), '鹿首应是 currentColor 实心剪影');
  assert.ok(mark.includes('fill="var(--surface'), '火苗镂空应引 token（var(--surface)），不写死');

  const css = body('chat.css');
  const avatar = ruleBody(css, '.c-avatar');
  assert.ok(avatar.includes('width: 48px') && avatar.includes('height: 48px'), '她的脸应是 48px（壳的品牌区沿用同一档）');
  assert.ok(avatar.includes('background: var(--accent-soft)'), '脸底应是浅蓝 --accent-soft');
  assert.ok(avatar.includes('border-radius: 16px'), '脸底应是圆角方底（16px）');

  const mini = ruleBody(css, '.c-mini');
  assert.ok(mini.includes('width: 28px') && mini.includes('height: 28px'), '气泡左侧小脸应是 28px');

  assert.ok(html.includes('href="#her-mark"'), '壳应真正引用这枚记号');
  assert.ok(
    body('pages/chat.js').includes('<use href="#her-mark"></use>'),
    '气泡小脸应复用壳里同一枚记号，而不是另画一个',
  );
});

// ──────────────────────────────── ② 状态点呼吸 ────────────────────────────────

test('状态点 8px 呼吸：两处节奏都只动 opacity', () => {
  const css = body('chat.css');
  const dot = ruleBody(css, '.c-dot');
  assert.ok(dot.includes('width: 8px') && dot.includes('height: 8px'), '状态点应是 8px');

  for (const name of ['c-breathe', 'c-pulse']) {
    const block = frameBody(css, name);
    assert.ok(!/transform|scale|translate/u.test(block), `${name} 不许用缩放/位移（只动透明度）`);
    const props = new Set([...block.matchAll(/([a-z-]+)\s*:\s*[^;{}]+;/gu)].map((match) => match[1] ?? ''));
    assert.deepEqual([...props], ['opacity'], `${name} 里只许出现 opacity`);
  }
  assert.ok(css.includes('c-breathe 2.4s'), '闲置/沉睡应是 2.4s 缓慢呼吸');
  assert.ok(css.includes('c-pulse 1s'), '告警应是 1s 脉冲');
  assert.match(css, /\.c-dot\[data-kind="running"\][^}]*animation: none/u, '运行中应常亮，不呼吸');
});

// ──────────────────────────────── ③ 气泡质感 ────────────────────────────────

test('气泡质感：圆角四值、70% 宽、行高 1.65、时间戳 hover 才现', () => {
  const css = body('chat.css');
  assert.ok(css.includes('border-radius: 16px 16px 16px 4px'), '她的气泡应是 16/16/16/4（左下收角）');
  assert.ok(css.includes('border-radius: 16px 16px 4px 16px'), '你的气泡应是 16/16/4/16（右下收角）');

  const bubble = ruleBody(css, '.c-bubble');
  assert.ok(bubble.includes('max-width: 70%'), '气泡最大宽应是 70%');
  assert.ok(bubble.includes('line-height: 1.65'), '气泡行高应是 1.65');

  const time = ruleBody(css, '.c-time');
  assert.ok(time.includes('font-size: 10px'), '时间戳应是 10px');
  assert.ok(time.includes('opacity: 0'), '时间戳默认应隐去');
  assert.ok(css.includes('.c-bubble:hover .c-time { opacity: 1; }'), 'hover 气泡时时间戳才淡入');

  assert.ok(css.includes('--gap-same: 4px'), '连续同侧气泡间距应是 4px');
  assert.ok(css.includes('--gap-turn: 16px'), '换侧气泡间距应是 16px');
  assert.ok(css.includes('.c-row[data-cont="true"]'), '行距应看 data-cont 标记');
});

// ──────────────────────────────── ④ 装饰纪律与壳内挂载 ────────────────────────────────

test('渐变只有氛围光与发丝带（≤3 处），且没有泛光与毛玻璃', () => {
  const css = body('chat.css');
  const count = [...css.matchAll(/linear-gradient/gu)].length;
  assert.ok(count <= 3, `渐变只该有 ≤3 处（氛围光明暗各一 + 发丝带），实际 ${count}`);
  assert.equal(
    [...css.matchAll(/repeating-linear-gradient/gu)].length,
    0,
    '网格纹理已移除（她的房间不是工程图纸）',
  );

  const hair = ruleBody(css, '.c-top::after');
  assert.ok(hair.includes('height: 3px'), '发丝带应是 3px');
  assert.ok(hair.includes('linear-gradient'), '发丝带应是那条从左往右的渐变');

  // 注释里点名这些属性是纪律说明，这里断言的是"没有真的声明出来"
  // 阴影纪律：只允许发丝级（--shadow-hairline = 0 1px 2px 5%），不许出现其他阴影写法
  const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;}]+)/gu)].map(m => m[1]);
  for (const s of shadows) {
    // 发丝阴影与聚焦环（0 0 0 3px accent-soft 是无障碍必需品，不算阴影）
    const okShadow = s.includes('var(--shadow-hairline)') || /^0 0 0 \d+px/.test(s.trim());
    assert.ok(okShadow, `只允许发丝阴影与聚焦环，出现：${s}`);
  }
  assert.ok(!/backdrop-filter\s*:/u.test(css), 'chat.css 不该有毛玻璃');
  assert.ok(!/text-shadow\s*:/u.test(css), 'chat.css 不该有文字阴影');
});

test('壳内挂载：聊天页占满内容区，对话区把壳的氛围光透出来', () => {
  const css = body('chat.css');
  assert.ok(css.includes('#page-chat { height: 100%; }'), '聊天页应占满壳内容区的确定高度');
  assert.ok(css.includes('#page-chat .c-feed { background: transparent; }'), '对话区背景应透明（氛围光由壳铺）');
  // 骨架只剩三块：对话流 / 确认卡片 / 输入行（顶栏归壳了）
  const app = ruleBody(css, '.c-app');
  assert.ok(app.includes('grid-template-rows: 1fr auto auto'), '骨架应是三行：1fr auto auto');
});

test('禁 emoji 图标、禁图片外链（图形只有那一枚内联 SVG）', () => {
  for (const name of CHAT_ASSETS) {
    assert.ok(!EMOJI.test(body(name)), `${name} 出现了 emoji 图标`);
  }
  const html = body('index.html');
  assert.ok(!/<img\b/u.test(html), 'index.html 不该有 <img>');
  assert.ok(!/https?:\/\//u.test(body('chat.css')), 'chat.css 不该出现外链');
  assert.ok(!/https?:\/\//u.test(html), 'index.html 不该出现外链');
});

// ──────────────────────────────── ⑤ 打字机 ────────────────────────────────

test('打字机只伺候新气泡：历史气泡不经过它', () => {
  const js = body('pages/chat.js');
  assert.ok(js.includes('async function typewrite(row, text)'), '打字机函数应存在');
  assert.equal(
    [...js.matchAll(/typewrite\(/gu)].length,
    3,
    'typewrite 应出现 3 次：1 处定义 + 2 处调用（对话流、引导卡）',
  );
  assert.ok(
    js.includes("if (item.kind === 'bubble' && item.live === true) void typewrite(node, item.text);"),
    '对话流里只有 live 的她的气泡才走打字机',
  );
  assert.ok(js.includes('item.live = S.bulk === false;'), '首屏补齐期间进来的条目不该被标成 live');
  assert.ok(js.includes('S.bulk = true;') && js.includes('S.bulk = false;'), '首屏应走 bulk 通道');

  assert.ok(js.includes('480 /') && js.includes('Math.max(16,'), '每帧 2-4 字、总时长约 480ms 折算帧间隔');
  assert.ok(js.includes('at += 2 + (at % 3)'), '每帧步长应落在 2-4 字之间');
  assert.ok(js.includes("el('span', 'c-caret', '▍')"), '光标应是 ▍');
  assert.ok(js.includes('caret.remove()'), '放完光标应撤掉');
  assert.ok(body('chat.css').includes('c-blink 600ms'), '光标应是 600ms 方波');
  assert.ok(body('chat.css').includes('steps(1, end)'), '方波要用 steps 硬切，不做渐变');
});

// ──────────────────────────────── ⑥ 首启引导卡 ────────────────────────────────

test('首启引导卡：isSeed 分支，种子文案点名 IDENTITY.md 并给出去填入口', () => {
  const js = body('pages/chat.js');
  assert.ok(js.includes('IDENTITY.md'), '种子文案里应点名 IDENTITY.md');
  assert.ok(js.includes('我是伊尔弥亚，刚搬来这台机器'), '欢迎卡应是她口吻的一句话');
  assert.ok(js.includes("el('button', 'btn btn-primary', '打开人格配置')"), '欢迎卡应带「打开人格配置」按钮');
  assert.ok(js.includes("location.hash = '#/persona'"), '按钮应跳壳内人格页（不再是运维台的锚点）');
  assert.ok(js.includes("'我在呢。有什么要我做的？'"), '非种子应是轻量招呼');
  assert.ok(js.includes("'/api/persona/files'"), '种子判据应读人格文件接口');
  assert.ok(js.includes("file?.path === 'IDENTITY.md' && file?.isSeed === true"), '只看 IDENTITY.md 的 isSeed');
  assert.ok(js.includes('S.isSeed ? SEED_GREETING : PLAIN_GREETING'), '两个分支都应落到实处');
  assert.ok(js.includes('id="c-guide"'), '引导卡容器应在页面模板里');
  assert.ok(js.includes('data-slot="empty"'), '引导卡应挂在空态槽位上');

  // 引导卡挂在 empty 态上，而 empty 只在"已连上 + 一条对话都没有"时成立：
  // 因此连上之后必须重绘一次对话流，否则首启永远停在加载提示（回归过一次）
  const onlineAt = js.indexOf('S.online = true;');
  assert.ok(onlineAt >= 0, '应有一处把 S.online 置真');
  assert.ok(
    js.slice(onlineAt, onlineAt + 260).includes('paintFeed()'),
    '连上之后必须重绘对话流：空对话的 empty 态（引导卡）只在那一刻才成立',
  );
  const css = body('chat.css');
  assert.ok(
    css.includes('.c-feed[data-state="data"] .c-hint'),
    '有对话时不该还挂着「正在读取会话」',
  );
});

// ──────────────────────────────── ⑦ 壳内挂载纪律 ────────────────────────────────

test('容器内查询、徽章回写壳、destroy 断流并摘监听', () => {
  const js = body('pages/chat.js');
  // 页内查询只认自己的容器
  assert.ok(js.includes("R.querySelector(`#${id}`)"), '页内查询应走容器根节点');
  assert.ok(!js.includes('document.getElementById'), '不许再全局抓 id');
  // 未读与待确认回写壳的导航徽章
  assert.ok(js.includes("ctx.setBadge('chat', S.unread > 0 ? String(S.unread) : null)"), '未读应写聊天项徽章');
  assert.ok(js.includes("ctx.setBadge('logs', count > 0 ? '' : null)"), 'needsReview 应写日志项红点');
  assert.ok(js.includes('visibilitychange'), '切回前台应把未读清零，得听可见性变化');
  // 卸载：断 SSE、清定时器、摘 document 级监听
  const destroyAt = js.indexOf('function destroy()');
  assert.ok(destroyAt >= 0, '应有 destroy');
  const tail = js.slice(destroyAt);
  assert.ok(tail.includes('S.life.abort()') && tail.includes('S.abort.abort()'), 'destroy 应掐断 SSE 与等待');
  assert.ok(tail.includes('clearTimeout(S.refreshTimer)'), 'destroy 应清掉节流定时器');
  assert.ok(tail.includes("document.removeEventListener('visibilitychange', onVisibility)"), 'destroy 应摘掉监听');
  assert.ok(tail.includes('return destroy;'), 'init 应把 destroy 交回壳');
});

// ──────────────────────────────── ⑧ 字体节奏与体积 ────────────────────────────────

test('字体节奏：17/650 状态句、14.5px 气泡、12px 灰字、10px 时间戳，字重只用 400/600/650', () => {
  const css = body('chat.css');
  const status = ruleBody(css, '.c-status');
  assert.ok(status.includes('font-size: 17px'), '状态句应是 17px');
  assert.ok(status.includes('font-weight: 650'), '状态句应是 650');
  assert.ok(ruleBody(css, '.c-bubble').includes('font-size: 14.5px'), '气泡应是 14.5px');
  assert.ok(ruleBody(css, '.c-sys').includes('font-size: 12px'), '系统灰字应是 12px');

  const weights = [...css.matchAll(/font-weight:\s*([^;]+);/gu)].map((match) => (match[1] ?? '').trim());
  assert.ok(weights.length > 0, '应至少声明一处字重');
  for (const weight of weights) {
    assert.ok(weight === '400' || weight === '600' || weight === '650', `字重只许 400/600/650 三档，出现了 ${weight}`);
  }
});

test('搬进壳后三件套总计仍 <80KB', () => {
  let total = 0;
  for (const name of CHAT_ASSETS) total += Buffer.byteLength(body(name), 'utf8');
  assert.ok(total < MAX_BYTES, `三件套共 ${total} 字节，应小于 ${MAX_BYTES}`);
});

// ──────────────────────── ⑨ 真在 DOM 桩里跑一遍 init / destroy ────────────────────────

test('init 真跑一遍：渲染三块骨架、读接口、徽章回写壳、destroy 之后不再发请求', async () => {
  // 用与五页同一套极简 DOM 桩：不追求 DOM 语义，只求页面 init 真跑一遍
  const dom = installDom();
  dom.setHash('#/chat');
  const calls: string[] = [];
  const badges: string[] = [];
  const ctx = {
    token: 'test-token-chat-page',
    async api(path: string): Promise<unknown> {
      calls.push(path);
      if (path.startsWith('/api/events?')) return { events: [] };
      if (path.startsWith('/api/projection')) return { needsReview: [], waitingHuman: null };
      if (path.startsWith('/api/persona/files')) return { files: [] };
      return {};
    },
    setBadge(page: string, text: string | null): void {
      badges.push(`${page}:${text === null ? 'off' : text}`);
    },
  };

  const mod = (await import('../web/pages/chat.js')) as { init: (el: unknown, ctx: unknown) => unknown };
  const cleanup = mod.init(dom.el, ctx);
  assert.equal(typeof cleanup, 'function', '聊天页 init 应把 destroy 交回壳');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const html = String(dom.el.innerHTML);
  for (const id of ['c-feed', 'c-cards', 'c-input', 'c-send']) {
    assert.ok(html.includes(`id="${id}"`), `渲染结果里应有 ${id}`);
  }
  assert.ok(!html.includes('c-top'), '顶栏不该出现在聊天页');
  assert.ok(calls.some((path) => path.startsWith('/api/events?limit=')), '首屏应补拉一段对话');
  assert.ok(calls.includes('/api/projection'), '应读一次投影（确认卡片与红点都靠它）');
  assert.ok(badges.includes('chat:off'), '进聊天页即已读：未读徽章应被收起');
  assert.ok(badges.includes('logs:off'), '没人等你说话时，日志项红点应被收起');

  // 卸载：SSE 掐断、定时器清掉、监听摘掉——之后一切安静
  (cleanup as () => void)();
  const settled = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, settled, 'destroy 之后不该再发请求');
});

/**
 * 数字资产（`MEMORIES/assets.md` + 框架聚合的事实层）——判据（v34，2026-10-06 用户的设计）
 *
 * 用户收窄后的口径（原话要点）：**「skill、MCP 工具、PATH 里有的东西，都已统一是数字资产。
 * 只不过还按照 skill、mcp 这样的习惯去分类。由 light loop 拿着索引清单，择机提醒。」**
 * 配套六条：事实层由框架聚合（别让她手抄）、她的知识层写"什么时候用/怎么用"、
 * 清单不常驻（只在"要干活"那一拍被 light 读一次，只有 ≤3 条进此刻层）、
 * 常驻的只有一行规则（先读说明再用、不许凭名字猜）、那一行要带全份清单的指路、
 * MCP 不进工具清单也不新增网关工具。
 *
 * 判据（只紧不松）：
 *   ① 有清单且"要干活" ⇒ 渲染那一行、条数 ≤3、**带指路**；
 *   ② 只有心跳的那一拍 ⇒ **不渲染**，而且**一次 light 都不发**；
 *   ③ 清单为空 / 不存在 ⇒ 不渲染、不报错，同样**不发请求**；
 *   ④ 条目格式坏的（只有名字、没有"在哪"）⇒ 如实降级（跳过 + 计数），不编、不崩；
 *   ⑤ 任务结束 ⇒ 那一行不再渲染（任务卡在，它就在；任务卡没了，它跟着没了）；
 *   ⑥ 选取只做一次：同一任务内多步共用一份（light 调用数 = 1）；
 *   ⑦ 事实层：技能目录 / MCP 声明 / PATH 探测——**不要求她手抄事实**，没核对就不假装核对过；
 *   ⑧ 常驻规则在装置自述里（且清单**不常驻**：没被挑中的条目根本不在她的上下文里）。
 *
 * 台子见 `test/fixtures/real-wake-rig.ts`：**真 RealLoop + 真 agent-loop + 真 render**，
 * 只有模型是假的——"那一行有没有真的进请求"只有走整条链路才证得了。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { heartbeatData, makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import { NOW_LAYER_BANNER, render, type RenderInput, type RenderPersona } from '../src/model/render.ts';
import { SELF_BRIEF } from '../src/model/self-brief.ts';
import {
  ASSET_NOTE_CHARS_MAX, ASSET_PICK_MAX, ASSETS_INDEX_POINTER, assetIndexLine, assetsFile,
  clipAssetNote, commandOf, ensureAssetsSeed,
  factOf, indexOf, isUsable, parseAssetLine, parseAssets, probeOnPath, readAssets, renderable,
  renderAssetsLine, selectAssets, withFacts, type AssetFactSource, type TaskAsset,
} from '../src/persona/assets.ts';
import { memoriesDir } from '../src/persona/memory-maintain.ts';

const NO_FACTS: AssetFactSource = { skills: undefined, mcp: undefined, probePath: undefined };
const NOW = '2026-02-14T10:00:00.000+08:00';
const PICK_THREE = '{"picks":[1,2,3]}';

/** 落一份清单（路径与生产一致：`<dataDir>/workspace/MEMORIES/assets.md`） */
function writeAssets(rig: { dir: string }, content: string): string {
  const file = join(rig.dir, 'data', 'workspace', 'MEMORIES', 'assets.md');
  mkdirSync(join(rig.dir, 'data', 'workspace', 'MEMORIES'), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 从一段渲染出来的 input 里取此刻层那一段文本 */
function nowLayerOfItems(items: ReadonlyArray<{ content?: unknown }> | undefined): string {
  for (const item of items ?? []) {
    if (typeof item.content === 'string' && item.content.includes(NOW_LAYER_BANNER)) return item.content;
  }
  return '';
}

/** 从一次请求里取出此刻层那一段文本（按段头认层，不按索引——与 render 自己的做法一致） */
function nowLayerOf(request: { input?: unknown }): string {
  const items = Array.isArray(request.input) ? request.input : [];
  return nowLayerOfItems(items as Array<{ content?: unknown }>);
}

/** 那一行（只取资产那一行本身，便于逐字断言） */
function assetLineOf(request: { input?: unknown }): string {
  return nowLayerOf(request).split('\n').find(text => text.startsWith('本任务相关资产：')) ?? '';
}

/** 那一行的条目部分（去掉 `本任务相关资产：` 前缀与 `——指路` 尾巴） */
function assetItemsOf(request: { input?: unknown }): string[] {
  const body = assetLineOf(request).replace(/^本任务相关资产：/u, '').split('——')[0] ?? '';
  return body === '' ? [] : body.split(' · ');
}

/**
 * 确定性的 PATH 探测（事实层的输入，v34）：这几条找得到、其余找不到。
 *
 * 用它而不是真 PATH：真探测依环境（这台机器上有没有那条命令），同一个用例在两台机器上会
 * 渲染出不同的那一行。`ffmpeg` 那条写着"未安装"，所以**根本不会被探**（照她写的算）。
 * Obscura 探到的路径**故意与她写的不一样**——这样"探测结论也给她"这件事才是可断言的。
 */
const GH_REAL = 'C:\\Program Files\\Git\\cmd\\gh.exe';
const PROBE = (command: string): { found: boolean; path?: string } => {
  const name = command.trim().toLowerCase();
  if (name === 'obscura' || name.endsWith('obscura.exe')) return { found: true, path: 'C:\\Tools\\obscura\\obscura.exe' };
  if (name === 'gh') return { found: true, path: GH_REAL };
  if (name === 'rg') return { found: true, path: 'C:\\bin\\rg.exe' };
  if (name === 'jq') return { found: true, path: 'C:\\bin\\jq.exe' };
  return { found: false };
};

const OBSCURA_WHERE = '路径：D:\\Tools\\obscura\\obscura.exe';
const FFMPEG_WHERE = '未安装（需要 winget install ffmpeg）';
const OBSCURA_LINE = `Obscura（${OBSCURA_WHERE} → C:\\Tools\\obscura\\obscura.exe）`;
const GH_LINE = `gh（已在 PATH → ${GH_REAL}）`;

/** 三件资产：`已在 PATH` / `路径：…` / `未安装（需要 X）`——三种诚实标注各写一条 */
const THREE_ASSETS = [
  '# 数字资产',
  '',
  `- [path] Obscura ｜ 按策略抓网页正文 ｜ ${OBSCURA_WHERE}`,
  '- [path] gh ｜ 命令行管 GitHub ｜ 已在 PATH',
  `- [path] ffmpeg ｜ 转码与抽帧 ｜ ${FFMPEG_WHERE}`,
].join('\n');

/**
 * ① 那一行的逐字期望：**两条能用的** + 末尾的指路。
 *
 * 写着"未安装"的那条**不进这一行**（它现在真的用不了，摆出来只会让她去试、然后撞墙）——
 * 这一点单独由 ①c 钉住。
 */
const THREE_ASSETS_LINE = `本任务相关资产：${OBSCURA_LINE} · ${GH_LINE}——${ASSETS_INDEX_POINTER}`;

// ──────────────────────────────── ① 要干活 ⇒ 渲染那一行 ────────────────────────────────

test('① 有清单且这一拍要干活：任务卡上渲染那一行，≤3 条，且带指路', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: PICK_THREE }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '把这篇文章抓下来整理成 markdown' });
  await rig.tick();

  // 一次 light（选取） + 一次 heavy（她这一拍）
  assert.deepEqual(
    rig.requests.map(item => item.lane),
    ['light', 'heavy'],
    '要干活的那一拍：先挑一次资产（light），再走她自己的主力车道',
  );
  const light = rig.requests[0]!.request;
  assert.ok(light.input.includes('Obscura'), '喂给 light 的是**索引**（编号+分类+名字+用途+就绪），不是清单全文');
  assert.ok(light.input.includes('[path]'), '分类要给它（分类决定怎么用）');
  assert.ok(light.input.includes('按策略抓网页正文'), '用途也要给（判断相关性靠它）');
  assert.ok(!light.input.includes('# 数字资产'), '那份说明的正文不进选取输入（廉价：只给索引行）');
  assert.ok(light.input.includes('把这篇文章抓下来整理成 markdown'), '挑资产要看这一轮要做什么');

  const line = assetLineOf(rig.requests[1]!.request);
  assert.equal(line, THREE_ASSETS_LINE, `那一行的形状与"在哪"必须照清单原文（实际：${line}）`);
  assert.equal(nowLayerOf(rig.requests[1]!.request).split('本任务相关资产：').length - 1, 1, '同一层里只说一次');
  assert.ok(line.includes(ASSETS_INDEX_POINTER), '**必须带指路**（light 漏选时她仍有路去读全份清单）');

  // 账：`memory/selected` 顺带带上那一行（重放据此逐字节重建）
  const selected = (await rig.events()).find(event => event.type === 'memory/selected');
  assert.ok(selected !== undefined, '装配账照旧落库');
  assert.equal((selected!.data as { assets?: string }).assets, THREE_ASSETS_LINE,
    '事件里记的是**当时挑出来的那一行**（盘上的清单以后会改，重建要靠它）');
  const consumed = (await rig.events()).filter(event => event.type === 'budget/consumed');
  assert.ok(consumed.some(event => event.data.lane === 'light'), '这一次选取也记账（lane=light）');
});

test('①b 模型给了一堆序号：渲染仍然只有 ≤3 条（上限是机制的）', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1,2,3,4,5,1,2,3]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, `${THREE_ASSETS}\n- [path] rg ｜ 全文检索 ｜ 已在 PATH\n- [path] jq ｜ 处理 JSON ｜ 已在 PATH\n`);

  rig.append('wake/manual', { note: '搜一下这个仓库里的 todo' });
  await rig.tick();

  const items = assetItemsOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.equal(items.length, ASSET_PICK_MAX - 1,
    `写着"未安装"的那条被滤掉之后，这一轮还剩 ${ASSET_PICK_MAX - 1} 条能用（实际：${items.join(' · ')}）`);
  assert.ok(items.length <= ASSET_PICK_MAX, '无论如何不超过上限');
  assert.ok(!assetLineOf(rig.requests.find(item => item.lane === 'heavy')!.request).includes('jq'),
    'light 给了五个序号，只有前三条进这一行（第四条之后一律不渲染）');
});

test('①c 标着"未安装"的被挑中了也不渲染（它现在真的用不了）', async (t) => {
  const rig = await makeRealWakeRig({
    // 只挑 ffmpeg（第 3 条，写着"未安装"）
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[3]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '把这段视频转一下' });
  await rig.tick();

  const now = nowLayerOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(!now.includes('本任务相关资产'), `挑中的是一条没装的 ⇒ 整行不出现（实际：${now}）`);
});

// ──────────────────────────────── ② 闲聊/心跳那一拍 ⇒ 不渲染 ────────────────────────────────

test('② 只有心跳的那一拍：不渲染那一行，而且一次 light 都不发', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }], probeAssetPath: PROBE });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  // 台子的假模型在"脚本耗尽还要被调用"时直接抛——所以"light 0 次"是被强判据钉住的
  rig.append('wake/heartbeat', heartbeatData(1800, 1));
  await rig.tick();

  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy'], '心跳拍不挑资产（没人在叫她干活）');
  const now = nowLayerOf(rig.requests[0]!.request);
  assert.ok(now.includes('当前任务：'), '任务卡与平时一致');
  assert.ok(!now.includes('本任务相关资产'), `不渲染那一行（实际：${now}）`);
  const selected = (await rig.events()).find(event => event.type === 'memory/selected');
  assert.equal((selected!.data as { assets?: string }).assets, undefined, '账上也不写（心跳轮 injection:heartbeat）');
});

// ──────────────────────────────── ③ 清单空 / 不存在 ⇒ 不渲染、不报错 ────────────────────────────────

test('③a 清单文件不存在、事实层也空：不渲染、不报错，且一次 light 都不发', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }], probeAssetPath: PROBE });
  t.after(rig.dispose);
  // 与生产同一条纪律：**框架不建这个文件**（那次首启种子之后，盘上这份由她自己维护）
  assert.equal(readAssets(join(rig.dir, 'data')), null, '读不到就是 null，不抛');

  rig.append('wake/manual', { note: '顺手看下今天有什么安排' });
  await rig.tick();

  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy'], '索引为空 ⇒ 不花这一次 light');
  assert.ok(!nowLayerOf(rig.requests[0]!.request).includes('本任务相关资产'));
});

test('③b 清单存在但一条条目都没有（只有说明）：不渲染、不发请求', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }], probeAssetPath: PROBE });
  t.after(rig.dispose);
  writeAssets(rig, '# 数字资产\n\n（还没记过任何东西。）\n');

  rig.append('wake/manual', { note: '随便聊聊' });
  await rig.tick();

  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy']);
  assert.ok(!nowLayerOf(rig.requests[0]!.request).includes('本任务相关资产'));
});

test('③c 选取失败（light 抛错）：这一轮没有那一行，但她照常开工', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ throws: new Error('light 挂了') }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '帮我看看磁盘' });
  await rig.tick();

  const now = nowLayerOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(!now.includes('本任务相关资产'), '挑不出来就不渲染（不编、不降级成"看着有"）');
  assert.ok(now.includes('当前任务：'), 'turn 照常跑完');
  assert.ok(rig.lines.some(line => line.includes('[数字资产] 选取失败')), '如实写在循环日志里');
});

// ──────────────────────────────── ④ 坏格式 ⇒ 如实降级或跳过 ────────────────────────────────

test('④a 解析规则：只有名字、没有"在哪"的行**跳过**（不降级成一条）', () => {
  assert.deepEqual(
    parseAssetLine('- [path] Obscura ｜ 抓网页正文 ｜ 路径：D:\\obscura.exe'),
    { kind: 'path', name: 'Obscura', purpose: '抓网页正文', where: '路径：D:\\obscura.exe', from: 'her' },
  );
  assert.equal(parseAssetLine('- gh ｜ 命令行管 GitHub'), null, '缺"在哪"：跳过（不许让看起来有）');
  assert.equal(parseAssetLine('- [skill] 周报 ｜ 生成周报'), null, '同上（分类不影响这条判据）');
  assert.equal(parseAssetLine('- ｜ 没有名字 ｜ 已在 PATH'), null, '缺名字：跳过');
  assert.equal(parseAssetLine('这条自由文本不是条目'), null, '没有分隔符：跳过');
  assert.equal(parseAssetLine('# 数字资产'), null, '标题不是条目');
  assert.equal(parseAssetLine('- x ｜ y ｜ '), null, '"在哪"只有空白：跳过');

  const doc = parseAssets([
    '# 数字资产',
    '- goo ｜ 只有名字',
    '- [path] gh ｜ 管 GitHub ｜ 已在 PATH',
    '随手写的一句',
    '',
    '- [path] ffmpeg ｜ 转码 ｜ 未安装（需要 winget）',
  ].join('\n'));
  assert.equal(doc.entries.length, 2, '只认三段齐全的那两条');
  assert.equal(doc.skipped, 2, '坏行**如实计数**（另外两条没读懂）');
});

test('④b 三分类：不写分类按 path 算；认不出的分类标记不算分类', () => {
  assert.equal(parseAssetLine('- gh ｜ 管 GitHub ｜ 已在 PATH')!.kind, 'path', '缺省 path');
  assert.equal(
    parseAssetLine('- ［skill］ 周报 ｜ 生成周报 ｜ 说明：MEMORIES/skills/weekly.md')!.kind,
    'skill',
    '全角方括号也认',
  );
  assert.equal(parseAssetLine('- [MCP] github ｜ 查 issue ｜ 已配好')!.kind, 'mcp', '大小写不敏感');
  assert.equal(
    parseAssetLine('- [foo] bar ｜ 用途 ｜ 已在 PATH')!.name,
    '[foo] bar',
    '认不出的分类标记**不当分类**（留在名字里，不猜）',
  );
});

test('④c 渲染：坏行只在真有的时候缀一句，且绝不把坏行当条目渲染', () => {
  const doc = parseAssets('- [path] gh ｜ 管 GitHub ｜ 已在 PATH\n- goo ｜ 只有名字\n');
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.skipped, 1);
  // 这里**没有事实层**（没传 probePath）：照她写的算，所以那一行就是她写的样子
  const line = renderAssetsLine(doc.entries, doc.skipped);
  assert.equal(line, `本任务相关资产：gh（已在 PATH）（清单里另有 1 行没读懂，格式是「[分类] 名字 ｜ 用途 ｜ 在哪」）——${ASSETS_INDEX_POINTER}`);
  assert.ok(!line.includes('goo'), '坏行不进那一行');
  // 没有坏行时不缀那半句（不制造每轮都挂着的噪音）
  assert.equal(renderAssetsLine(doc.entries, 0), `本任务相关资产：gh（已在 PATH）——${ASSETS_INDEX_POINTER}`);
  // 一条都没有 = 整行不出现（连指路都不出现：没有"这一轮有资产"这回事）
  assert.equal(renderAssetsLine([], 3), '');
});

test('④d 坏行混在清单里：选取只看好行，坏行在那一行尾部如实计数', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, [
    '# 数字资产',
    '- goo ｜ 这条只有名字（坏行）',
    '- [path] gh ｜ 命令行管 GitHub ｜ 已在 PATH',
  ].join('\n'));

  rig.append('wake/manual', { note: '处理一下这个 PR' });
  await rig.tick();

  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(!light.input.includes('goo'), '坏行不进选取输入（它没有"在哪"，挑出来也没法用）');
  const line = assetLineOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(line.startsWith(`本任务相关资产：${GH_LINE}`), '好行照常渲染');
  assert.ok(line.includes('另有 1 行没读懂'), `坏行如实计数（实际：${line}）`);
});

// ──────────────────────────────── ⑤ 任务完 ⇒ 那一行消失 ────────────────────────────────

test('⑤a 任务卡没了（任务结束）：整行一起消失——不需要任何"已读/清理"动作', () => {
  // 判据就是"当前任务那一节在不在"（既有的那一套）：任务卡为 null ⇒ 那一节连同资产那一行一起没了。
  // 这是纯渲染断言（不跑循环）：把它钉在这里，"任务完就不渲染"就不必靠一次完整 turn 去证。
  const base = buildRenderInput();
  const withTask = render({
    ...base,
    taskCard: { title: '抓一篇正文', turn: 1, step: 1, todoOpen: [], assets: `本任务相关资产：${OBSCURA_LINE}——${ASSETS_INDEX_POINTER}` },
  });
  const withoutTask = render({ ...base, taskCard: null });
  assert.ok(nowLayerOfItems(withTask.input).includes('本任务相关资产：'), '有任务 ⇒ 有那一行');
  assert.ok(!nowLayerOfItems(withoutTask.input).includes('本任务相关资产'), '任务卡没了 ⇒ 那一行也没了');
  assert.ok(!nowLayerOfItems(withoutTask.input).includes('当前任务：'), '确认：任务那一节整体不在了');
});

test('⑤b 那一行不进历史：它只在此刻层现渲染（下一轮的历史里没有它）', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [
      { outputItems: [{ type: 'message', text: PICK_THREE }] },
      // 第二个 turn：清单这一次挑不出相关的（模型回空）——证明那一行不是被缓存住的东西
      { outputItems: [{ type: 'message', text: '{"picks":[]}' }] },
    ],
    stream: [{ text: '', toolCalls: [] }, { text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '抓一篇正文' });
  await rig.tick();
  rig.append('wake/manual', { note: '再来一件不相干的事' });
  await rig.tick();

  const heavies = rig.requests.filter(item => item.lane === 'heavy');
  assert.equal(heavies.length, 2, '两个 turn 各一次主请求');
  assert.ok(nowLayerOf(heavies[0]!.request).includes('本任务相关资产：'), '第一次任务：有那一行');
  assert.ok(!nowLayerOf(heavies[1]!.request).includes('本任务相关资产'), '"没挑出相关的"那一轮就不渲染');
  const historyText = (heavies[1]!.request.input as Array<{ content?: unknown }>)
    .map(item => (typeof item.content === 'string' ? item.content : ''))
    .filter(text => !text.includes(NOW_LAYER_BANNER))
    .join('\n');
  assert.ok(!historyText.includes('本任务相关资产'), '那一行从不进历史（只在此刻层现渲染）');
});

// ──────────────────────────────── ⑥ 选取只做一次 ────────────────────────────────

test('⑥ 同一任务内多步共用一份选取：light 只调一次', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [
      // 第 1 步：调一次工具（任务继续 → 会产生第 2 步）
      { text: '', toolCalls: [{ callId: 'c1', name: 'safe_read', arguments: '{"path":"STATE.md"}' }] },
      // 第 2 步：收尾
      { text: '', toolCalls: [] },
    ],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '读一下 STATE 再做打算' });
  await rig.tick();

  const steps = (await rig.events()).filter(event => event.type === 'step/start');
  assert.ok(steps.length >= 2, `这一轮至少两步（实际 ${steps.length}）`);
  assert.equal(
    rig.requests.filter(item => item.lane === 'light').length, 1,
    '选取只做一次：判据一处、轮首一次，绝不每步重算',
  );
  for (const heavy of rig.requests.filter(item => item.lane === 'heavy')) {
    assert.ok(assetLineOf(heavy.request).startsWith(`本任务相关资产：Obscura（`),
      '每一步都看得见那一行（同一轮内逐字节不变）');
  }
});

// ──────────────────────────────── ⑦ 事实层（框架聚合，别让她手抄） ────────────────────────────────

test('⑦a 事实层：skill 在不在、命令在不在 PATH——都如实说，绝不美化她写的"在哪"', () => {
  const entries = [
    { kind: 'skill' as const, name: 'weekly', purpose: '周报', where: 'MEMORIES/skills/weekly.md' },
    { kind: 'skill' as const, name: 'ghost', purpose: '早就删掉的技能', where: 'MEMORIES/skills/ghost.md' },
    { kind: 'mcp' as const, name: 'github', purpose: '查 issue', where: '配好的那个 server' },
    { kind: 'mcp' as const, name: 'nope', purpose: '没配过的 server', where: '某人说的那个 server' },
    { kind: 'path' as const, name: 'definitely-not-a-real-command-xyz', purpose: '不存在', where: '已在 PATH' },
    { kind: 'path' as const, name: 'ffmpeg', purpose: '转码', where: '未安装（需要 winget install ffmpeg）' },
  ];
  const facts: AssetFactSource = {
    skills: ['weekly', 'other'],
    mcp: [{ name: 'github', ready: true }],
    probePath: () => ({ found: false }),
  };
  const withF = withFacts(entries, facts);
  assert.equal(withF[0]!.fact?.state, 'ready', '技能目录里有 ⇒ 就绪');
  assert.equal(withF[1]!.fact?.state, 'missing', '技能目录里没有 ⇒ 如实说"没找到"（不是一直看着像有）');
  assert.equal(withF[2]!.fact?.state, 'ready', 'server 已声明并启动 ⇒ 就绪');
  assert.equal(withF[3]!.fact?.state, 'missing', '配置里没有这个 server ⇒ 未找到');
  assert.equal(withF[4]!.fact?.state, 'missing', 'PATH 里没有 ⇒ 未找到');
  assert.equal(withF[5]!.fact?.state, 'declared', '她自己写了"未安装"⇒ 照她写的算，**不去探测、不替她改口**');
  // 渲染：**现在真能用的两条**照原文（探测到的路径也给她），用不了的三条整行不出现
  const line = renderAssetsLine(withF, 0);
  assert.equal(
    line,
    `本任务相关资产：weekly（MEMORIES/skills/weekly.md） · github（配好的那个 server）——${ASSETS_INDEX_POINTER}`,
    `用不了的不该出现（实际：${line}）`,
  );
  // 索引（喂给 light 的那份）里，用不了的三条**当场标出来**——免得它挑到必被滤掉的东西
  const indexLines = indexOf(entries, facts).map((entry, i) => assetIndexLine(entry, i + 1));
  assert.ok(indexLines[1]!.includes('⚠ 技能目录里没有它'), `实际：${indexLines[1]}`);
  assert.ok(indexLines[4]!.includes('⚠ PATH 里没有 definitely-not-a-real-command-xyz'));
  assert.ok(indexLines[5]!.includes('⚠ 清单里写着未安装'), '"未安装"也要标（light 不该挑它）');
  assert.ok(indexLines[0]!.includes('[skill] weekly'), '能用的那条照常进索引（只有分类与用途）');
});

test('⑦a2 MCP：就绪不可知就如实说"未知"；读不到配置面**绝不写**"配置里没有"', () => {
  const herMcp = { kind: 'mcp' as const, name: 'github', purpose: '查 issue 与 PR', where: '配置里那个 server' };
  // ① 声明面读得到、运行期状态看不到（生产上就是这一支）⇒ "已配置（是否已启动未知）"
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'github' }] }),
    { state: 'declared', detail: '已配置（是否已启动未知）' },
  );
  // ② 有真运行期状态就照它说（将来宿主把那半接进来时走这一支）
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'github', ready: true }] }),
    { state: 'ready', detail: 'server 已启动' },
  );
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'github', ready: false }] }),
    { state: 'declared', detail: '已配置（未启动）' },
  );
  // ③ 声明面**读得到**、里面没有她写的那个 ⇒ 这才是"确实没配"
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'other' }] }),
    { state: 'missing', detail: '配置里没有这个 server' },
  );
  // ④ 声明面**读不到**（undefined）⇒ 只说"读不到配置面"，**绝不说**"配置里没有这个 server"
  const unknown = factOf(herMcp, NO_FACTS);
  assert.equal(unknown.state, 'unknown', 'unknown = "这一轮没核过"，与 declared（有话说）是两回事');
  assert.equal(unknown.detail, '这一轮读不到 MCP 配置面');
  assert.ok(!unknown.detail.includes('配置里没有'), '读不到 ≠ 确实没有：那一句会是假话');
  // ⑤ 她自己写着"未安装"时照旧优先（mcp 也一样：不探测、不改口）
  assert.equal(factOf({ ...herMcp, where: '未安装（需要先装它的 CLI）' }, { mcp: [] }).detail, '清单里写着未安装');
  // ⑥ "未知"分两种，别混：
  const knownButNotRunning = { ...herMcp, fact: factOf(herMcp, { mcp: [{ name: 'github' }] }) };
  assert.equal(isUsable(knownButNotRunning), true, '"已配置（是否已启动未知）"是**能用**的那一侧');
  assert.equal(renderable(knownButNotRunning), true, '……而且**能进那一行**（有话说，只是不知道起没起）');
  const neverChecked = { ...herMcp, fact: unknown };
  assert.equal(isUsable(neverChecked), true, '"没核过"也不等于"不能用"（她照自己写的去试是对的）');
  assert.equal(renderable(neverChecked), false,
    '但**不进那一行**：摆一条"我压根没核过"的东西等于让她以为框架确认过');
});

test('⑦a3 MCP：配置里声明的 server 由框架自己列进索引（她不必手抄）', () => {
  const facts: AssetFactSource = { mcp: [{ name: 'github' }, { name: 'playwright' }] };
  const index = indexOf([], facts);
  assert.deepEqual(index.map(entry => `${entry.kind}:${entry.name}`), ['mcp:github', 'mcp:playwright']);
  assert.equal(index[0]!.fact?.detail, '已配置（是否已启动未知）', '事实条目本身也如实说"未知"');
  // 渲染：事实条目能进那一行（她是被告知的，不是"她没写就永远看不见"）
  assert.equal(
    renderAssetsLine(index, 0),
    '本任务相关资产：github（已配置（是否已启动未知）） · playwright（已配置（是否已启动未知））'
    + `——${ASSETS_INDEX_POINTER}`,
  );
});

test('⑦a4 MCP：端到端——配置里声明了 server，那一行就有它（她清单里没写过也一样）', async (t) => {
  const rig = await makeRealWakeRig({
    // 索引里两条：她的 `[path] gh` + 事实层的 `[mcp] github`，两条都挑中
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1,2]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
    // 这一格在生产上来自 `<dataDir>/../config.json` 的 `mcp.servers`（real-loop 的 declaredMcpServers）
    mcpServers: ['github'],
  });
  t.after(rig.dispose);
  writeAssets(rig, '# 数字资产\n\n- [path] gh ｜ 管 GitHub ｜ 已在 PATH\n');

  rig.append('wake/manual', { note: '看一下那个仓库的 issue' });
  await rig.tick();

  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(light.input.includes('[mcp] github'), '事实层把声明的 server 也列进了索引');
  const line = assetLineOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(line.includes('github（已配置（是否已启动未知））'), `实际：${line}`);
  assert.ok(!line.includes('server 已启动'), '**不许**把不可知说成"已启动"');
});

test('⑦a5 MCP：读不到配置面时，那一格留空、不渲染误导性文字', async (t) => {
  // 台子不写 `<dataDir>/../config.json` ⇒ real-loop 的 declaredMcpServers 回 undefined
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, '# 数字资产\n\n- [mcp] github ｜ 查 issue ｜ 配置里那个 server\n');

  rig.append('wake/manual', { note: '看一下 issue' });
  await rig.tick();

  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(light.input.includes('这一轮读不到 MCP 配置面'), '索引里如实说"读不到配置面"');
  assert.ok(!light.input.includes('配置里没有这个 server'), '**绝不**把"读不到"说成"确实没有"');
  assert.ok(!light.input.includes('⚠'), '连"未就绪"都不标——没核对不是"没有"（那也会是编的）');
  // 那一格**不渲染**：整行都不出现（不是"渲染一句误导性的话"）
  const now = nowLayerOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(!now.includes('本任务相关资产'), `读不到就不渲染那一行（实际：${now}）`);
  assert.ok(!now.includes('已探测'), '更不许写"已探测：未找到"那种假话');
});

test('⑦a6 MCP：默认那条路真的读 `<dataDir>/../config.json` 的 `mcp.servers`', async (t) => {
  // 这一条走**不注入 `mcpServers`** 的默认路径（覆盖点一给就绕过它了）：
  // 台子给的是临时目录，所以这里手工把那份 config.json 放进 `<dataDir>/..`（= 生产布局）。
  const rig = await makeRealWakeRig({
    // 索引里三条：她的 `[path] gh` + 事实层的 `[mcp] github` / `[mcp] playwright`
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1,2,3]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeFileSync(join(rig.dir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    mcp: { servers: [{ name: 'github', command: 'npx' }, { name: 'playwright', command: 'npx' }] },
  }), 'utf8');
  writeAssets(rig, '# 数字资产\n\n- [path] gh ｜ 管 GitHub ｜ 已在 PATH\n');

  rig.append('wake/manual', { note: '看一下 issue' });
  await rig.tick();

  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(light.input.includes('[mcp] github'), '声明面读到了 ⇒ 事实层自己列出来');
  assert.ok(light.input.includes('[mcp] playwright'));
  assert.ok(!light.input.includes('读不到 MCP 配置面'), '读到了就不写那句');
  const line = assetLineOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(line.includes('github（已配置（是否已启动未知））'), `实际：${line}`);
});

test('⑦a7 MCP：`mcp.servers` 形状不对（配置非法）⇒ 当作读不出来，不猜', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  // `name` 不合法（`parseMcpServers` 会抛）⇒ declaredMcpServers 回 undefined
  writeFileSync(join(rig.dir, 'config.json'), JSON.stringify({
    schemaVersion: 1, mcp: { servers: [{ name: '有中文的名字', command: 'x' }] },
  }), 'utf8');
  writeAssets(rig, '# 数字资产\n\n- [mcp] github ｜ 查 issue ｜ 配置里那个 server\n');

  rig.append('wake/manual', { note: '看一下 issue' });
  await rig.tick();

  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(light.input.includes('这一轮读不到 MCP 配置面'), '解不出来就当读不到（不猜、不编）');
  assert.ok(!nowLayerOf(rig.requests.find(item => item.lane === 'heavy')!.request).includes('本任务相关资产'));
});

test('⑦b 事实层：她没抄过的技能与 MCP server 也会进索引（框架自己列）', () => {
  const hers = [{ kind: 'path' as const, name: 'gh', purpose: '管 GitHub', where: '已在 PATH' }];
  const facts: AssetFactSource = {
    skills: ['weekly', 'dsh-docs'],
    mcp: [{ name: 'github', ready: false }],
    probePath: () => ({ found: true, path: 'C:\\bin\\gh.exe' }),
  };
  const index = indexOf(hers, facts);
  assert.deepEqual(
    index.map(entry => `${entry.kind}:${entry.name}`),
    ['path:gh', 'skill:weekly', 'skill:dsh-docs', 'mcp:github'],
    '她那一层在前，事实层补她没提过的',
  );
  assert.equal(index[0]!.fact?.state, 'ready', 'PATH 探测到了就绪');
  // 她写过同名的就不再重复列（她的那一层优先）
  const dedup = indexOf(
    [...hers, { kind: 'path' as const, name: 'GH', purpose: '重复写了一遍', where: '已在 PATH' }],
    { probePath: () => ({ found: true, path: 'C:\\bin\\gh.exe' }) },
  );
  assert.equal(dedup.filter(entry => entry.kind === 'path').length, 2, '两条都是她写的，事实层不再补');
});

test('⑦c 没核对手段时说"这一轮没核过"（unknown），不假装核对过、也不写"未找到"', () => {
  const asset = { kind: 'path' as const, name: 'gh', purpose: '管 GitHub', where: '已在 PATH' };
  const noProbe = factOf(asset, NO_FACTS);
  assert.equal(noProbe.state, 'unknown', '没探测手段 ⇒ unknown（不是 declared，更不是 ready/missing）');
  assert.equal(noProbe.detail, '这一轮没有探测 PATH');
  assert.ok(!noProbe.detail.includes('未找到'), '没核过就绝不写"未找到"（那是编）');
  assert.equal(isUsable({ ...asset, fact: noProbe }), true, '没核过 ≠ 不能用');
  assert.equal(renderable({ ...asset, fact: noProbe }), false, '没核过 ⇒ 不进那一行（整格留空）');
  assert.equal(factOf(asset, { probePath: () => ({ found: true, path: 'C:\\gh.exe' }) }).state, 'ready');
  assert.equal(commandOf(asset), 'gh', '「已在 PATH」⇒ 拿名字去探');
  assert.equal(commandOf({ ...asset, where: '路径：D:\\bin\\gh.exe' }), 'D:\\bin\\gh.exe');
  assert.equal(commandOf({ ...asset, where: '某人给的压缩包' }), null, '取不出命令 ⇒ 不探测（不猜）');
});

test('⑦d probeOnPath：真的查 PATH（用一份自造的 PATH 与目录证明它认得出/认不出）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-path-probe-'));
  try {
    writeFileSync(join(dir, 'gh.exe'), 'x', 'utf8');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    const hit = probeOnPath('gh', env);
    assert.equal(hit.found, true);
    // 大小写不比：Windows 上 `gh.EXE` 与 `gh.exe` 是同一个文件（探测结论按真实目录项给）
    assert.equal((hit.path ?? '').toLowerCase(), join(dir, 'gh.exe').toLowerCase());
    assert.equal(probeOnPath('nope-nope', env).found, false);
    // 直接给绝对路径也认（她写了 `路径：…` 的那种）——**带反斜杠的 Windows 路径也要认**
    assert.equal(probeOnPath(join(dir, 'gh.exe'), env).found, true);
    assert.equal(probeOnPath(join(dir, 'missing.exe'), env).found, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑦e 端到端：技能目录里没有的技能被挑中时，那一行如实写"已探测：未找到"', async (t) => {
  // 真的建一个技能目录（技能根下一个带 SKILL.md 的子目录 = 一个技能），让"事实层"有东西可核：
  // "她清单里那条技能还在不在"因此是**真查出来的**，不是用例编的。
  const { SkillManager } = await import('../src/skill/skills.ts');
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1,2]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
  });
  t.after(rig.dispose);
  mkdirSync(join(rig.dir, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(rig.dir, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: 真在目录里的那个技能\n---\n\n正文\n', 'utf8');
  writeAssets(rig, [
    '# 数字资产',
    '- [skill] alpha ｜ 真在目录里的那个技能 ｜ skills/alpha/SKILL.md',
    '- [skill] ghost-skill ｜ 早就删掉的技能 ｜ MEMORIES/skills/ghost.md',
  ].join('\n'));

  rig.append('wake/manual', { note: '拿那个技能做点事' });
  await rig.tick();

  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(light.input.includes('⚠ 技能目录里没有它'), `索引里就标明"未就绪"（实际：${light.input}）`);
  assert.ok(light.input.includes('技能目录里有它'), '还在的那条也照实说"就绪"');
  const line = assetLineOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(line.includes('alpha（skills/alpha/SKILL.md）'), '还在的那条照她写的渲染（就绪的不缀探测结论）');
  assert.ok(!line.includes('ghost-skill'), '"已探测：未找到"的那条**不进这一行**（它现在真的用不了）');
  assert.ok(line.includes(ASSETS_INDEX_POINTER), '指路照旧在');
});

test('⑦f 端到端：清单里只有一条、且它已被删掉 ⇒ 整行不出现（不渲染一件用不了的东西）', async (t) => {
  const { SkillManager } = await import('../src/skill/skills.ts');
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
    // 技能目录是空的（技能根下什么都没有）⇒ 她写的那条被核成"未找到"
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
  });
  t.after(rig.dispose);
  writeAssets(rig, [
    '# 数字资产',
    '- [skill] ghost-skill ｜ 早就删掉的技能 ｜ MEMORIES/skills/ghost.md',
  ].join('\n'));

  rig.append('wake/manual', { note: '拿那个技能做点事' });
  await rig.tick();

  const now = nowLayerOf(rig.requests.find(item => item.lane === 'heavy')!.request);
  assert.ok(!now.includes('本任务相关资产'), `用不了的被挑中也整行不出现（实际：${now}）`);
  assert.ok(!rig.lines.some(line => line.includes('[数字资产] 相关资产')),
    '循环日志里也没有"挑了哪几条"那一行（它本来就没渲染）');
});

// ──────────────────────────────── ⑧ 常驻规则、种子、（不常驻） ────────────────────────────────

test('⑧a 常驻规则只有一句：用资产先读说明、不许凭名字猜', () => {
  assert.ok(SELF_BRIEF.includes('先读它的说明再用'), '规则在装置自述里（常驻、短、稳定）');
  assert.ok(SELF_BRIEF.includes('不许凭名字猜怎么调'));
  assert.ok(SELF_BRIEF.includes('skill、MCP、PATH 里的命令，都算你的数字资产'), '一个概念三个分类要说清');
  assert.ok(SELF_BRIEF.includes('有哪些、在哪、就绪没有由框架给你'), '事实层不要求她手抄');
  assert.ok(/指路|全份清单|完整清单/u.test(SELF_BRIEF), '"择机提醒 + 指路"这件事她知道');
});

test('⑧b 清单不常驻：没被挑中的条目**不进她的上下文**', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '只看第一件事' });
  await rig.tick();

  const request = rig.requests.find(item => item.lane === 'heavy')!.request;
  const all = JSON.stringify(request.input);
  assert.ok(all.includes('Obscura'), '挑中的那条在');
  assert.ok(!all.includes('ffmpeg'), '**没挑中的那条不在**（清单不常驻——这正是"择机提醒"）');
  assert.ok(!all.includes('gh ｜'), '清单的原始行也不在（只有那一行提示里那几条）');
  const instructions = typeof request.instructions === 'string' ? request.instructions : '';
  assert.ok(!instructions.includes('Obscura'), '装置自述里也没有清单内容（常驻的只有那一行规则）');
});

test('⑧c 种子：只在文件不存在时写一次（幂等）；它是说明，不是条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-assets-seed-'));
  try {
    mkdirSync(memoriesDir(dir), { recursive: true });
    assert.equal(ensureAssetsSeed(dir), true, '第一次：写');
    const first = readAssets(dir);
    assert.ok(first !== null && first.entries.length === 0, '种子是**说明 + 围栏里的格式示例**，一条真资产都没预置');
    assert.equal(first?.skipped, 0, '说明与示例都不算坏行（不然她一打开就看到"另有 7 行没读懂"）');
    writeFileSync(assetsFile(dir), '# 数字资产\n\n- [path] gh ｜ 管 GitHub ｜ 已在 PATH\n', 'utf8');
    assert.equal(ensureAssetsSeed(dir), false, '第二次：文件已在，一个字节都不动');
    assert.equal(readAssets(dir)!.entries.length, 1, '她自己写的内容没被种子覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑧d selectAssets：索引为空时**一次请求都不发**（判据在发请求之前）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-assets-empty-'));
  let called = 0;
  try {
    mkdirSync(memoriesDir(dir), { recursive: true });
    writeFileSync(assetsFile(dir), '# 数字资产\n\n（空清单）\n', 'utf8');
    const result = await selectAssets(dir, {
      ds: { generate: async () => { called += 1; throw new Error('不该被调用'); }, modelFor: () => 'light' },
      task: '做点事',
      facts: NO_FACTS,
      now: () => new Date(NOW),
    });
    assert.equal(called, 0, '空清单不发请求');
    assert.equal(result.called, false);
    assert.equal(result.by, 'none');
    assert.deepEqual(result.entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑧e selectAssets：她一条都没写、但事实层有技能时，仍然会挑（框架自己知道有哪些）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-assets-facts-'));
  try {
    mkdirSync(memoriesDir(dir), { recursive: true });
    // 清单文件都不存在：不该因为没有她的清单就丢掉事实层
    const result = await selectAssets(dir, {
      ds: {
        generate: async () => ({
          status: 'completed', outputItems: [{ type: 'message', text: '{"picks":[1]}' }],
          usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 },
          incompleteReason: null, model: 'fake-light', responseId: 'r', durationMs: 1,
        }),
        modelFor: () => 'light',
      },
      task: '写一份周报',
      facts: { skills: ['weekly'], mcp: [{ name: 'github', ready: true }] },
      now: () => new Date(NOW),
    });
    assert.equal(result.called, true, '事实层有东西 ⇒ 值得花这一次 light');
    assert.deepEqual(result.entries.map(entry => `${entry.kind}:${entry.name}`), ['skill:weekly']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────── ⑩ 那一行里"她的说明"不再是整段（v39，2026-10-07） ──────────────────
/*
 * 用户点名的四件事，逐条钉在这里：
 *   ① 说明**整段**被搬进这一行（那 335 个字符的命令与实测结论属于 SKILL.md，属于她自己读）；
 *   ② anysearch 那条**括号不闭合**、命令塞在说明里（畸形）；
 *   ③ 事实层那几条本来就短，**别跟着一起截**；
 *   ④ 控制台把它印了两遍。
 * 判据的**口径**（一行、一句话；命令与细节属于 SKILL.md）写在 `assets.ts` 的 `clipAssetNote` 上，
 * 这里只钉"渲染出来的字节"。四条铁律（≤3 条、行尾有指路、确定性、重放逐字节重建）另外钉。
 */

/** 一条她自己写的资产（`purpose` 用不到就随便给；这一行不渲染用途） */
function herEntry(name: string, where: string, purpose = '用途'): TaskAsset {
  return { kind: 'skill', name, purpose, where, from: 'her' };
}

/** 从整行里取出某一条资产那一格（去掉标题、指路与分隔符） */
function cellOf(line: string, name: string): string {
  const body = line.replace(/^本任务相关资产：/u, '').split('——')[0] ?? '';
  return body.split(' · ').find(cell => cell.startsWith(`${name}（`)) ?? '';
}

test('⑩a 长说明（>60 字符）⇒ 截断，且行尾仍然是指路', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出部分还在继续写下去';
  assert.ok([...long].length > ASSET_NOTE_CHARS_MAX, `用例前提：这段说明 ${[...long].length} 字符，要超过上限`);
  const line = renderAssetsLine([herEntry('长说明', long)], 0);
  const cell = cellOf(line, '长说明');

  assert.ok(cell !== '', `那一条要渲染出来（实际整行：${line}）`);
  // 那一格 = `名字（说明）`；**说明**本身 ≤ 60（名字与括注是固定的那几个字节，不计在额度里）
  assert.ok(cell.endsWith('）'), `形状是 名字（说明）（实际：${cell}）`);
  const note = cell.slice('长说明（'.length, -1);
  assert.ok([...note].length <= ASSET_NOTE_CHARS_MAX, `说明要收进 60 字符（实际 ${[...note].length}：${note}）`);
  assert.ok(note.includes('…'), `超出就该缀省略号（实际：${note}）`);
  assert.ok(line.endsWith(`——${ASSETS_INDEX_POINTER}`), `行尾**永远**是指路（实际：${line}）`);
});

test('⑩b 畸形（多行 / 含反引号命令 / 括号不闭合）⇒ 只取第一句，并如实', () => {
  const nl = `第一句。\n第二句还有别的话要讲清楚一点\n第三句更多的话堆在这儿不下心就整段进来了`;
  const nlCell = cellOf(renderAssetsLine([herEntry('多行', nl)], 0), '多行');
  assert.equal(nlCell, '多行（第一句。）', `多行只取第一行、只取第一句（实际：${nlCell}）`);

  const cmd = '要跑这个：`pwsh -NoProfile -File "D:\\a\\b\\anysearch_cli.ps1" search "查询" --max_results 8` 就行，别另外装东西浪费时间';
  const cmdCell = cellOf(renderAssetsLine([herEntry('命令', cmd)], 0), '命令');
  const cmdNote = cmdCell.slice('命令（'.length, -1);
  assert.ok(cmdNote.includes('要跑这个：'), `切点别落在冒号上（切出来是个没宾语的残句，实际：${cmdNote}）`);
  assert.ok(cmdNote.endsWith('…'), `末尾那半句用省略号如实收住（实际：${cmdNote}）`);
  assert.ok(!cmdCell.includes('别另外装东西'), `命令后面那些细节不进这一行（实际：${cmdCell}）`);

  // anysearch 那条的真实形状：`说明：<路径>（…` 括号**不闭合**，后头还接着一段话
  const unbalanced = '说明：skills/bad/SKILL.md（正文同目录 scripts/x.py；**草稿，尚未过信任门进 catalog**，见 facts）';
  const badCell = cellOf(renderAssetsLine([herEntry('不闭合', unbalanced)], 0), '不闭合');
  assert.equal(badCell, '不闭合（skills/bad/SKILL.md）', `只留指路那一截（实际：${badCell}）`);
  assert.ok(!badCell.includes('尚未过信任门'), '括注里的细节（那一段话）不进这一行');
});

test('⑩c 事实层那几条本来就短 ⇒ 原样，不被截', () => {
  // 三次渲染（每次 ≤3 条，上限是机制的一部分，用例不越过它）：
  // ① 两种"就绪"写法原样；② `未安装` 的那条被滤掉；③ 事实条目与她那一条混在一起时各走各的路
  const ready: TaskAsset[] = [
    { kind: 'skill', name: 'weekly', purpose: '技能（读了它的说明再用）', where: 'skill 目录里有它', from: 'fact', fact: { state: 'ready', detail: '技能目录里有它' } },
    { kind: 'path', name: 'ffmpeg', purpose: '技能（读了它的说明再用）', where: '已在 PATH', from: 'fact', fact: { state: 'ready', detail: 'D:\\IrmiaAgent\\tools\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe' } },
    { kind: 'path', name: 'gh', purpose: '技能（读了它的说明再用）', where: '路径：D:\\IrmiaAgent\\tools\\gh\\very-long-folder-name\\gh.exe', from: 'fact', fact: { state: 'declared', detail: '清单里写的' } },
  ];
  const line = renderAssetsLine(ready, 0);
  for (const entry of ready) {
    const cell = cellOf(line, entry.name);
    assert.ok(cell !== '', `事实条目要在（实际整行：${line}）`);
    assert.ok(!cell.includes('…'), `事实层的"在哪"**不截**（${entry.name} 被截了：${cell}）`);
  }
  assert.ok(line.includes('weekly（skill 目录里有它）'), `原样（实际：${line}）`);
  // 事实条目**原样**：`已在 PATH` 就是 `已在 PATH`（`factEntries` 折出来的那几条本来就是这一格），
  // 一条都不加、一个字都不截
  assert.ok(line.includes('ffmpeg（已在 PATH）'), `事实条目原样（实际：${line}）`);
  assert.ok(line.includes('gh（路径：D:\\IrmiaAgent\\tools\\gh\\very-long-folder-name\\gh.exe）'), `路径：… 原样（实际：${line}）`);

  // 写着"未安装"的那条**不进这一行**（它现在真的用不了——'不用截'与'该滤'是两件事）
  const uninstalled: TaskAsset[] = [{
    kind: 'path', name: 'uninstalled-tool-with-a-long-name', purpose: '技能（读了它的说明再用）',
    where: '未安装（需要 winget install something-long）', from: 'fact',
    fact: { state: 'declared', detail: '清单里写着未安装' },
  }];
  assert.equal(renderAssetsLine(uninstalled, 0), '', '未安装的不渲染（整行都不出现）');

  // 事实条目与她那一条混在一起：各走各的路（她的被截、事实的原样）
  const mixed = renderAssetsLine([
    ...ready.slice(0, 1),
    herEntry('她写的', `说明：skills/x/SKILL.md（正文同目录 scripts/x.py；**草稿**，见 facts）`),
  ], 0);
  assert.ok(mixed.includes('weekly（skill 目录里有它）'), `事实条目原样（实际：${mixed}）`);
  assert.ok(mixed.includes('她写的（skills/x/SKILL.md）'), `她那一条只留指路（实际：${mixed}）`);
});

test('⑩d 确定性：同一输入两次渲染**逐字节相同**（重放要逐字节重建）', () => {
  const entries = [
    herEntry('甲', '说明：MEMORIES/skills/a/SKILL.md（正文同目录 scripts/a.py；**草稿**，见 facts）'),
    herEntry('乙', '要跑这个：`pwsh -File "D:\\x\\y.ps1" search "q"` 就行，别另外装东西浪费时间'),
    { kind: 'skill' as const, name: '丙', purpose: '用途', where: 'skill 目录里有它', from: 'fact' as const, fact: { state: 'ready' as const, detail: '技能目录里有它' } },
  ];
  const a = renderAssetsLine(entries, 2);
  const b = renderAssetsLine(entries, 2);
  assert.equal(a, b, '同一输入必须**逐字节**相同（禁时钟、禁随机、禁环境值）');
  assert.equal(clipAssetNote(entries[0]!.where), clipAssetNote(entries[0]!.where), '截断本身也是纯函数');
  // 截断不许切坏多字节字符：结果里的每个字符都必须在原输入里出现（代理对没被劈开）
  const clipped = clipAssetNote('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出部分还在继续写');
  const source = new Set([...('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出部分还在继续写')]);
  for (const char of clipped) {
    if (char === '…') continue;
    assert.ok(source.has(char), `截断切坏了一个多字节字符：${char}（码点 U+${(char.codePointAt(0) ?? 0).toString(16)}）`);
  }
});

test('⑩e 控制台只印一份标题（渲染结果自己就带 `本任务相关资产：`）', async (t) => {
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '抓一篇正文' });
  await rig.tick();

  const logs = rig.lines.filter(line => line.includes('[数字资产] 相关资产'));
  assert.equal(logs.length, 1, `挑出来的那一行只印**一条**日志（实际 ${logs.length} 条：${JSON.stringify(logs)}）`);
  assert.equal(logs[0]!.split('本任务相关资产：').length - 1, 1,
    `**标题只印一份**（前缀里不再重复一次，实际：${logs[0]!}）`);
  assert.ok(logs[0]!.startsWith('[数字资产] 相关资产（model）：'), `前缀形状（实际：${logs[0]!}）`);
  // 日志是显示层：进请求的那一份字节没动（标题仍然在渲染结果里）
  assert.equal(assetLineOf(rig.requests.find(item => item.lane === 'heavy')!.request).startsWith('本任务相关资产：'), true,
    '进请求的字节照旧带标题');
});

test('⑩f 将来有人在清单里塞命令：展示层也不会把整段抬进上下文', async (t) => {
  // 这一条防的是**反复会犯的错**（纪律写在 `clipAssetNote` 上）：清单那一格越写越长、
  // 把命令与细节都塞进去。截在展示层，不靠她自觉，也不改她的文件。
  const { SkillManager } = await import('../src/skill/skills.ts');
  const command = '说明：skills/heavy/SKILL.md。**这台机器上的可跑法只有一个**（10-07 实测）：'
    + '`pwsh -NoProfile -ExecutionPolicy Bypass -File "<repo>\\skills\\heavy\\scripts\\cli.ps1" '
    + 'search "查询" --max_results 8`／子命令换 `extract "URL"`；根目录没有 runtime.conf，python 侧缺 requests，都跑不通——'
    + '别在它们身上浪费时间。输出较长时用 `| Out-String -Width 300` 再截断。';
  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: '{"picks":[1]}' }] }],
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: () => ({ found: false }),
    // 真的建一个技能目录：那条技能**在**（事实层因此是 `ready`，不会被 `renderable` 滤掉）
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
  });
  t.after(rig.dispose);
  mkdirSync(join(rig.dir, 'skills', 'heavy'), { recursive: true });
  writeFileSync(join(rig.dir, 'skills', 'heavy', 'SKILL.md'),
    '---\nname: heavy\ndescription: 真在目录里的那个技能\n---\n\n正文\n', 'utf8');
  writeAssets(rig, [
    '# 数字资产',
    `- [skill] heavy ｜ 查网上实时的东西时用 ｜ ${command}`,
  ].join('\n'));

  rig.append('wake/manual', { note: '查点东西' });
  await rig.tick();

  const heavy = rig.requests.find(item => item.lane === 'heavy')!.request;
  const line = assetLineOf(heavy);
  assert.equal(line, `本任务相关资产：heavy（skills/heavy/SKILL.md）——${ASSETS_INDEX_POINTER}`,
    `只剩指路（实际：${line}）`);
  const now = nowLayerOf(heavy);
  assert.ok(!now.includes('--max_results'), '那一行里没有命令');
  assert.ok(!now.includes('runtime.conf'), '也没有实测结论');
  assert.ok(!now.includes('Out-String'), '也没有输出诀窍（那些属于 SKILL.md 正文）');
  // 喂给 light 的那份索引**照旧带用途摘要**（挑相关性要靠它；它只有 120 字符的额度）
  const light = rig.requests.find(item => item.lane === 'light')!.request;
  assert.ok(light.input.includes('查网上实时的东西时用'), '索引里仍然有用途（light 要照它判断相关性）');
  assert.ok(line.endsWith(ASSETS_INDEX_POINTER), '指路照旧在（她仍有路去读 SKILL.md）');
});

// ──────────────────────────────── 装配：纯渲染的最小输入 ────────────────────────────────

/** 纯渲染用例的最小 RenderInput（不读盘、不看时钟：render 本来就是纯函数） */
function buildRenderInput(): RenderInput {
  const persona: RenderPersona = {
    identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE',
  };
  return {
    events: [],
    persona,
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: NOW,
    timezone: 'Asia/Shanghai',
    model: 'fake-heavy',
    lane: 'heavy',
  };
}
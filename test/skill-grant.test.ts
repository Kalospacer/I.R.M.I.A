/**
 * **技能**的申请单：她发起装/删，用户只在界面点批准或驳回（2026-10-11 第二笔）
 *
 * 与 MCP 那条线**同一套形状**（见 `test/mcp-grant.test.ts` 与 `grant/mcp-grant.ts` 的文件头），
 * 这一份钉的是技能那一支**特有**的四件事：
 *   ① **`scripts/` 是风险点**：装技能 = 引入可执行内容（本机 `skills/anysearch/scripts/`
 *      里真有一批脚本）⇒ 申请单里那几个名字要进事件、要进卡面（方案稿 D8）；
 *   ② **删走回收站**：整目录 rename 进 `<dataDir>/trash/`，内容一个字节不改、可逆；
 *   ③ **落装之后写 `skill/installed{by:'human'}`** 才算过信任门（不写 = 装了但她看不见）；
 *   ④ **随包文件的路径**不许写到技能目录外面去（上跳 / 绝对路径 / 反斜杠 / 覆盖 SKILL.md）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyGrant, grantPathOf, grantReceiptLine, grantWakeNoteOf, grantsDirOf, parseGrantRequest, wakeForGrant,
} from '../src/grant/mcp-grant.ts';
import { CATALOG_HEADER, SKILL_FILE_NAME, SkillManager } from '../src/skill/skills.ts';
import { sha256Hex } from '../src/tools/fs/text-codec.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { AppEvent } from '../src/log/types.ts';

/** 一份合法的 `skill-install` 单子（各用例按需覆盖几格） */
function installFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'skill-install',
    name: 'morning-review',
    description: '每天早上翻一遍昨天的进展，落一份摘要',
    body: '# 早上复盘\n\n1. 读昨天的日记\n2. 写一份摘要\n',
    files: [],
    reason: '想每天固定做一次',
    ...extra,
  };
}

function writeGrantFile(workspace: string, id: string, data: unknown): string {
  const dir = grantsDirOf(join(workspace, 'data'));
  mkdirSync(dir, { recursive: true });
  const path = grantPathOf(join(workspace, 'data'), id);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

async function eventsOf(rig: Awaited<ReturnType<typeof makeRealWakeRig>>): Promise<AppEvent[]> {
  return [...(await rig.events())];
}

// ──────────────────────────────── ① 校验那一层 ────────────────────────────────

test('① 技能单子：description 是唯一触发机制 ⇒ 空的不收；名字走技能系统那把尺子', () => {
  const ok = parseGrantRequest(installFile());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.request.kind, 'skill-install');

  const noDesc = parseGrantRequest(installFile({ description: '' }));
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.ok === false ? noDesc.detail : '', /唯一的触发机制/u);

  // 名字：大写 / 下划线 / 路径分隔符 / 上跳 —— 全部由 `skillNameProblem` 判（不在这里重写）
  for (const bad of ['Morning-Review', 'morning_review', '../evil', 'a/b', 'C:\\x']) {
    const parsed = parseGrantRequest(installFile({ name: bad }));
    assert.equal(parsed.ok, false, `名字「${bad}」该被拒`);
  }
  // **技能名与 MCP 服务名不是同一把尺子**（技能只允许小写 + 连字符）：拿 MCP 那套来会放行大写
  const mcpName = parseGrantRequest(installFile({ name: 'Obscura_1' }));
  assert.equal(mcpName.ok, false);
});

test('①b scripts/ 单列一行：脚本名进摘要（卡面与事件都看得到那件事）', () => {
  const parsed = parseGrantRequest(installFile({
    files: [
      { path: 'scripts/run.js', content: 'console.log(1)\n' },
      { path: 'scripts/clean.py', content: 'print(1)\n' },
      { path: 'references/notes.md', content: '# 笔记\n' },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.files.length, 3);
});

test('①c 随包文件的路径不许写到技能目录外面去', () => {
  for (const bad of ['../outside.js', '/etc/passwd', 'C:\\x.js', 'scripts\\run.js', 'a//b.js', './x.js']) {
    const parsed = parseGrantRequest(installFile({ files: [{ path: bad, content: 'x' }] }));
    assert.equal(parsed.ok, false, `路径「${bad}」该被拒`);
  }
  // `SKILL.md` 不许从 files 里塞（正文有它自己那一格，从这里进会绕过长度校验）
  const overwrite = parseGrantRequest(installFile({ files: [{ path: SKILL_FILE_NAME, content: 'x' }] }));
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.ok === false ? overwrite.detail : '', /正文有它自己那一格/u);
});

test('①d 正文与文件数都有硬顶（技能是说明 + 少量脚本，不是数据包）', () => {
  const tooLong = parseGrantRequest(installFile({ body: 'x'.repeat(40_001) }));
  assert.equal(tooLong.ok, false);
  const tooMany = parseGrantRequest(installFile({
    files: Array.from({ length: 33 }, (_, i) => ({ path: `f${i}.md`, content: 'x' })),
  }));
  assert.equal(tooMany.ok, false);
});

// ──────────────────────────────── ② 待批 ────────────────────────────────

test('② 技能单子照样变成一条待批：问题、卡面、脚本名单都在**同一个信箱**里', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-1', installFile({
    files: [{ path: 'scripts/run.js', content: 'console.log(1)\n' }],
  }));

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  const asked = events.filter((event) => event.type === 'human/asked');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.data.source, 'system', '待批走挂起语义（与 MCP 那条同一条）');
  assert.match(asked[0]!.data.question, /批准装一个技能「morning-review」/u);
  // 卡面上"它会做什么"与**脚本那一行**都要在（用户点名的风险点）
  assert.match(asked[0]!.data.context, /它会做什么：每天早上翻一遍昨天的进展/u);
  assert.match(asked[0]!.data.context, /风险点：.*可执行脚本.*scripts\/run\.js/u, 'scripts/ 必须单列一行');
  assert.match(asked[0]!.data.context, /skill\/installed/u, '卡面要说清落地之后会写信任门那条凭据');

  const requested = events.filter((event) => event.type === 'grant/requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.data.kind, 'skill-install');
  assert.deepEqual(requested[0]!.data.skillScriptNames, ['scripts/run.js'], '脚本名单进事件（界面据此单列）');
  assert.equal(requested[0]!.data.skillFileCount, 1);
  // 正文**不进事件**（可能几十 KB）：事件里只有字节数
  assert.equal(typeof requested[0]!.data.skillBodyBytes, 'number');
  assert.ok(!JSON.stringify(requested[0]!.data).includes('读昨天的日记'), '正文不该出现在事件里');
});

// ──────────────────────────────── ③ 落地 ────────────────────────────────

test('③ 批准装：目录 + SKILL.md + 随包文件都写出来，且**扫描器认它**（信任门之外那一半）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-1', installFile({
    files: [
      { path: 'scripts/run.js', content: 'console.log("hi")\n' },
      { path: 'references/notes.md', content: '# 笔记\n' },
    ],
  }));
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'),
    configPath: join(rig.dir, 'config.json'),
    id: 's-1',
    requestedHash: requested.data.contentHash,
    skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'ok');
  assert.equal(applied.landed, 'morning-review');

  const dir = join(rig.dir, 'skills', 'morning-review');
  const text = readFileSync(join(dir, SKILL_FILE_NAME), 'utf8');
  assert.match(text, /^---\nname: morning-review\ndescription: 每天早上翻一遍昨天的进展，落一份摘要\n---\n/u);
  assert.match(text, /读昨天的日记/u, '正文原样写进去');
  assert.equal(readFileSync(join(dir, 'scripts', 'run.js'), 'utf8'), 'console.log("hi")\n');
  assert.equal(readFileSync(join(dir, 'references', 'notes.md'), 'utf8'), '# 笔记\n');

  // 扫描器认它 = 这个技能真的存在（信任门那一关是另一条事件的事，见下一条）
  const scanned = new SkillManager({ baseRoot: rig.dir }).scan().candidates;
  assert.ok(scanned.some((candidate) => candidate.name === 'morning-review'), '扫描器要认得它');
});

test('③b 已存在同名目录 ⇒ **不覆盖**（那可能是人写了很久的东西）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  mkdirSync(join(rig.dir, 'skills', 'morning-review'), { recursive: true });
  writeFileSync(join(rig.dir, 'skills', 'morning-review', SKILL_FILE_NAME), '人写的原件\n', 'utf8');
  writeGrantFile(rig.dir, 's-1', installFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-1', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'skipped-invalid');
  assert.match(applied.failure ?? '', /已经存在/u);
  assert.equal(
    readFileSync(join(rig.dir, 'skills', 'morning-review', SKILL_FILE_NAME), 'utf8'),
    '人写的原件\n',
    '原件一个字节都不许动',
  );
});

test('③c 删除：整目录进回收站（可逆），内容一个字节不改', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  const dir = join(rig.dir, 'skills', 'old-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE_NAME), '---\nname: old-skill\ndescription: 旧的\n---\n\n正文\n', 'utf8');

  writeGrantFile(rig.dir, 's-2', { kind: 'skill-remove', name: 'old-skill', reason: '不用了' });
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const events = await eventsOf(rig);
  const requested = events.find((event) => event.type === 'grant/requested')!;
  assert.equal(requested.data.kind, 'skill-remove');
  assert.match(events.find((event) => event.type === 'human/asked')!.data.question, /批准删掉技能「old-skill」/u);

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-2', requestedHash: requested.data.contentHash,
    skillsRoot: rig.dir, now: () => new Date('2026-10-11T02:30:45.123Z'),
  });
  assert.equal(applied.state, 'ok');
  assert.equal(existsSync(dir), false, '原目录必须已经不在了');
  assert.ok(applied.landed !== undefined && existsSync(applied.landed), '搬进回收站的那一份要在');
  assert.match(applied.landed!, /trash/u);
  // 内容一个字节不改（可逆的那条承诺）
  assert.match(readFileSync(join(applied.landed!, SKILL_FILE_NAME), 'utf8'), /^---\nname: old-skill/u);
});

test('③d 要删的技能不在 ⇒ 拒执行（"有人先删过"与"本来就没有"都如实说）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-3', { kind: 'skill-remove', name: 'never-existed' });
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-3', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'skipped-invalid');
  assert.match(applied.failure ?? '', /没有叫 never-existed 的目录/u);
});

test('③e 单子在审阅期间被改过（指纹对不上）⇒ 拒执行，一个文件都不动', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-4', installFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  // 她把 description 改了（要落地的那份字节因此变了）
  writeGrantFile(rig.dir, 's-4', installFile({ description: '换成另一句话' }));

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-4', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'skipped-stale');
  assert.equal(existsSync(join(rig.dir, 'skills', 'morning-review')), false, '拒执行 = 一个文件都不建');
});

// ──────────────────── ④ 通知与回执：**与 MCP 那一条同一处代码路径** ────────────────────

/** 台子上那条 `wake/manual{via:'grant'}`（没有时失败——否则下面的断言会静默测空气） */
function grantWakeOf(events: readonly AppEvent[]): { note: string; via: string; dedupeKey: string } {
  const found = events.filter(
    (event) => event.type === 'wake/manual' && (event.data as { via?: unknown }).via === 'grant',
  );
  assert.equal(found.length, 1, '一次决定恰好一条 via=grant 的唤醒');
  return found[0]!.data as { note: string; via: string; dedupeKey: string };
}

test('④a 批准装：通知走的是**与 MCP 同一条**路（wake/manual · via=grant），措辞是技能那一支', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-1', installFile({
    files: [{ path: 'scripts/run.js', content: 'console.log(1)\n' }],
  }));
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const exec = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-1', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(exec.state, 'ok');

  // **与 `grant-decide` 端点逐字同一个调用**（那条路也是 wakeForGrant → appendSync wake/manual model）
  const facts = {
    id: 's-1',
    kind: 'skill-install' as const,
    name: 'morning-review',
    outcome: 'approved' as const,
    reason: null,
    exec,
    scriptCount: requested.data.skillScriptNames?.length ?? 0,
  };
  const seq = wakeForGrant({
    facts,
    nowMs: Date.parse('2026-10-11T03:00:00.000Z'),
    append: (data) => rig.append('wake/manual', data).seq,
    onError: (message) => assert.fail(`唤醒不该发不出去：${message}`),
  });
  assert.equal(typeof seq, 'number', '她必须真的被叫醒一次（不许只在日志里留一行）');

  const wake = grantWakeOf(await eventsOf(rig));
  assert.equal(wake.via, 'grant', '与 MCP 批准同一条 via（界面据此渲染成框架卡片）');
  assert.match(wake.dedupeKey, /^grant-/u, '幂等键与 MCP 那条同一种形状（决定的身份 + 5 秒时间片）');
  // 技能那一支的措辞：说清落地在哪、信任门、**索引什么时候变**、脚本有没有被跑
  assert.match(wake.note, /装一个技能「morning-review」/u);
  assert.match(wake.note, /已被批准并且执行成功/u);
  assert.match(wake.note, /skill\/installed/u, '信任门那条凭据要说清（不写它等于装了但看不见）');
  assert.match(wake.note, /下一次归集/u, '索引什么时候变要与 MCP 同一口径（缓存保护）');
  assert.match(wake.note, /没有执行/u, '它带脚本 ⇒ 必须说清框架一个都没跑（用户点名的安全项）');
  assert.equal(wake.note.includes('MCP server'), false, '技能那一支不许说成 MCP server（同一入口、不同措辞）');
  // 回执那一行（HTTP 应答里那一格）是同一件事的一行版
  const receipt = grantReceiptLine(facts);
  assert.match(receipt, /装进技能根/u);
  assert.match(receipt, /信任门/u);

  // ── 同一处代码路径的**正面证据**：MCP 那一支喂同一个 `wakeForGrant`，产出同形状的 via/键 ──
  const mcpSeq = wakeForGrant({
    facts: {
      id: 'g-1', kind: 'mcp-add', name: 'obscura', outcome: 'approved',
      reason: null, exec: { state: 'ok', landed: 'obscura' },
    },
    nowMs: Date.parse('2026-10-11T03:00:00.000Z'),
    append: (data) => rig.append('wake/manual', data).seq,
    onError: (message) => assert.fail(`唤醒不该发不出去：${message}`),
  });
  assert.equal(typeof mcpSeq, 'number');
  const events = await eventsOf(rig);
  const grantWakes = events.filter(
    (event) => event.type === 'wake/manual' && (event.data as { via?: unknown }).via === 'grant',
  );
  assert.equal(grantWakes.length, 2, '两条决定各一条唤醒（via 都是 grant：同一处代码路径）');
  assert.match((grantWakes[1]!.data as { note: string }).note, /加 MCP server「obscura」/u);
  // 三态都有话说：驳回 / 成功 / 失败
  const failed = grantWakeNoteOf({ ...facts, exec: { state: 'failed', failure: '写技能目录失败：EACCES' } });
  assert.match(failed, /已被批准，但执行没有成功/u);
  assert.match(failed, /EACCES/u);
});

test('④b 驳回：有回执且**不装**（那句话是人的决定，不是"没人理"）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-5', installFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const facts = {
    id: 's-5', kind: 'skill-install' as const, name: 'morning-review',
    outcome: 'rejected' as const, reason: '不想让它常驻', exec: { state: 'not-applicable' as const },
  };
  const seq = wakeForGrant({
    facts,
    nowMs: Date.parse('2026-10-11T03:05:00.000Z'),
    append: (data) => rig.append('wake/manual', data).seq,
    onError: (message) => assert.fail(`唤醒不该发不出去：${message}`),
  });
  assert.equal(typeof seq, 'number');
  const wake = grantWakeOf(await eventsOf(rig));
  assert.match(wake.note, /装一个技能「morning-review」.*被驳回了/u);
  assert.match(wake.note, /他写的理由是：「不想让它常驻」/u);
  assert.match(wake.note, /这是否决/u, '要说清"别再自己做"（与 MCP 那一支逐字同款的那句）');
  assert.match(grantReceiptLine(facts), /人驳回了这张申请单，理由是：不想让它常驻/u);
  // 驳回 = 一个文件都不建（"有回执"与"真没装"两半都要在）
  assert.equal(existsSync(join(rig.dir, 'skills', 'morning-review')), false);
});

test('④c 她申请 ⇒ 落"待批准"；批准之前，她读到的技能索引里没有它', async (t) => {
  const rig = await makeRealWakeRig({
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
  });
  t.after(rig.dispose);
  // 先有一个过了信任门的技能（索引里那一行），再让她申请装一个新的
  const alphaDir = join(rig.dir, 'skills', 'alpha-search');
  mkdirSync(alphaDir, { recursive: true });
  const alphaText = '---\nname: alpha-search\ndescription: 先有的那个技能：搜网页与站内内容，查资料时用。\n---\n\n正文。\n';
  writeFileSync(join(alphaDir, SKILL_FILE_NAME), alphaText, 'utf8');
  rig.append('skill/installed', {
    name: 'alpha-search', path: 'skills/alpha-search', by: 'human', contentHash: sha256Hex(alphaText),
  });
  writeGrantFile(rig.dir, 's-6', installFile());

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  // ① 待批的记录在（她递的单子被框架拾起来了），并且**只有**待批这一半
  const requested = events.find((event) => event.type === 'grant/requested')!;
  assert.equal(requested.data.kind, 'skill-install');
  assert.equal(requested.data.by, 'agent');
  assert.ok(events.some((event) => event.type === 'human/asked'), '用户界面上那张卡在');
  assert.equal(events.some((event) => event.type === 'grant/resolved'), false, '还没批 ⇒ 没有结局');
  // ② 批准之前，她那一眼（长期记忆层里的技能索引）里没有它。
  //    只看**索引那一段**：待批那条提问本身会作为「她在等一个人点头」进她的上下文
  //    （`human/asked` 是 model 可见），所以"名字出现在整份 input 里"是正常的——
  //    判据是"索引里没有它"，不是"她不知道自己在等什么"。
  const request = rig.requests[0]!.request;
  const first = (request.input as Array<{ role?: string; content?: unknown }>)[0]!;
  const layer = typeof first.content === 'string' ? first.content : '';
  const at = layer.indexOf(CATALOG_HEADER);
  const segment = at < 0 ? '' : (layer.slice(at).split('\n\n')[0] ?? '');
  assert.match(segment, /- alpha-search: /u, '已生效的那个技能要在索引里（否则这条断言是空的）');
  assert.equal(segment.includes('morning-review'), false, '批准之前她读到的技能索引里没有它');
  // ③ 盘上也没有（"待批准 ≠ 装上了"）
  assert.equal(existsSync(join(rig.dir, 'skills', 'morning-review')), false);
  // ④ 快照里同样没有（索引的字节由快照决定，两处一起说清）
  const snapshot = events.find((event) => event.type === 'skill/index');
  assert.ok(snapshot !== undefined);
  assert.equal((snapshot.data as { text: string }).text.includes('morning-review'), false);
});

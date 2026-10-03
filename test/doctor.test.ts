/**
 * doctor 自检测试 — src/runtime/doctor.ts（CLI `doctor` 命令）
 *
 * 验收口径（docs/milestones.md M6-7、docs/schema.md §12、docs/operations.md §6）：
 *   **手工破坏一处不变量 → doctor 报告该条且退出码非 0**。
 *
 * 本套件的 fixtures 是**直接写分片文件**的：EventLog 的正常写入路径不可能造出重复 seq、
 * 双 turn/end、悬空 tool/call 这类违规日志——而那恰恰是 doctor 存在的理由。用写死字节的
 * 违规日志当输入，才是对自检本身的检验。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCli, type CliContext, type CliIO } from '../src/cli.ts';
import type { AppEvent } from '../src/log/types.js';
import { sha256Hex } from '../src/persona/versions.ts';
import { runDoctor } from '../src/runtime/doctor.ts';
import { PROJECTION_CACHE_FILE } from '../src/state/projection-cache.ts';
import { fold } from '../src/state/fold.ts';

const T0 = '2026-05-01T00:00:00.000Z';
const STATE_CONTENT = '# 当前状态\n\n待命中。\n';
const REASONING = '先看一眼待办清单，再决定这一刻要不要说话，沉默也是正常动作。';

// ──────────────────────────────── fixture ────────────────────────────────

interface Fixture {
  dir: string;
  /** 覆写事件集后重写分片（模拟"手工破坏一处不变量"） */
  rewrite: (events: AppEvent[]) => void;
  /** 追加一段原始字节（制造半行等磁盘级破坏） */
  appendRaw: (text: string) => void;
  events: () => AppEvent[];
}

function event(
  seq: number,
  type: string,
  data: unknown,
  visibility: 'model' | 'internal' = 'internal',
): AppEvent {
  return { seq, ts: T0, type, data, visibility, origin: 'test/doctor' } as unknown as AppEvent;
}

/** 一份"处处合规"的日志：I1..I11 全部应当通过 */
function healthyEvents(diffHash: string): AppEvent[] {
  return [
    event(1, 'session/start', {
      pid: 4242, cwd: 'C:/tmp', version: '0.1.0', schemaVersion: '1', configHash: 'cfg-1',
    }),
    event(2, 'persona/updated', { file: 'STATE.md', diffHash, by: 'agent' }),
    event(3, 'wake/manual', { note: '看看今天有什么', dedupeKey: 'k1' }, 'model'),
    event(4, 'turn/start', { turn: 1 }),
    event(5, 'input/claimed', { turn: 1, wakeSeqs: [3], claimCounts: [0] }),
    event(6, 'step/start', {
      turn: 1, step: 1, model: 'fake-heavy', lane: 'heavy', renderVersion: '1', personaHash: 'ph-1',
    }),
    event(7, 'message/reasoning', { turn: 1, step: 1, text: REASONING }),
    event(8, 'message/assistant', { text: '看了一眼，没事。', toolCalls: [] }, 'model'),
    event(9, 'tool/call', {
      turn: 1, step: 1, callId: 'call_1', name: 'read_file',
      arguments: '{"file_path":"a.txt"}', sideEffect: 'none',
    }, 'model'),
    event(10, 'tool/result', {
      turn: 1, step: 1, callId: 'call_1', callSeq: 9, status: 'ok', content: '内容若干',
    }, 'model'),
    event(11, 'budget/consumed', {
      turn: 1, step: 1, lane: 'heavy', model: 'fake-heavy',
      inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20,
      durationMs: 12, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 120,
    }),
    event(12, 'step/end', { turn: 1, step: 1, toolCalls: 1 }),
    event(13, 'turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true }),
    event(14, 'timer/set', { timerId: 't1', at: '2026-05-02T00:00:00.000Z', payload: { note: '明天提醒' } }),
  ];
}

function makeFixture(t: TestContext, events: AppEvent[] = healthyEvents(sha256Hex(STATE_CONTENT))): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-doctor-'));
  const eventsDir = join(dir, 'events');
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(join(dir, 'persona'), { recursive: true });
  writeFileSync(join(dir, 'persona', 'STATE.md'), STATE_CONTENT, 'utf8');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const shard = join(eventsDir, '000000000001.jsonl');
  const write = (list: AppEvent[]): void => {
    writeFileSync(shard, `${list.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  };
  write(events);

  return {
    dir,
    rewrite: write,
    appendRaw: (text) => writeFileSync(shard, text, { encoding: 'utf8', flag: 'a' }),
    events: () => events,
  };
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

// ──────────────────────────────── ① 全绿 ────────────────────────────────

test('doctor ①：合规日志上 11 条不变量全绿，退出码 0', async (t) => {
  const fx = makeFixture(t);
  const report = await runDoctor(fx.dir);

  const failed = report.checks.filter((check) => check.status === 'fail');
  assert.deepEqual(failed.map((check) => `${check.id}: ${check.detail}`), []);
  assert.equal(report.failures, 0);

  // 11 条不变量一条都不能少（schema §12 的编号就是认领清单）
  for (let index = 1; index <= 11; index++) {
    assert.ok(report.checks.some((check) => check.id === `I${index}`), `缺少不变量 I${index}`);
  }
  // 运行面四项（operations.md §6 的 doctor 行）
  for (const id of ['OPS-log', 'OPS-lock', 'OPS-blob', 'OPS-timers', 'OPS-projection']) {
    assert.ok(report.checks.some((check) => check.id === id), `缺少运行面检查 ${id}`);
  }

  const cli = collector();
  assert.equal(await runCli(['doctor'], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /结论：全部通过/);
  assert.match(cli.lines.join('\n'), /✓ I9/);
});

// ──────────────────────────────── ② 逐条破坏 ────────────────────────────────

test('doctor ②：I1 破坏（重复 seq）被抓且退出码非 0', async (t) => {
  const fx = makeFixture(t);
  const events = fx.events();
  fx.rewrite([...events, event(8, 'message/assistant', { text: '重复编号', toolCalls: [] }, 'model')]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I1');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /seq 8/);
  assert.ok(report.failures > 0);
});

test('doctor ②：I2 破坏（callSeq 指不到 tool/call）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite(fx.events().map((item) =>
    item.type === 'tool/result'
      ? event(10, 'tool/result', { ...item.data, callSeq: 999 }, 'model')
      : item,
  ));

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I2');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /callSeq=999/);
});

test('doctor ②：I3 破坏（同一 turn 两条 turn/end）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite([...fx.events(), event(15, 'turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true })]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I3');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /turn 1 有 2 条 turn\/end/);
});

test('doctor ②：I4 破坏（两个未闭合 turn）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'turn/start', { turn: 2 }),
    event(16, 'turn/start', { turn: 3 }),
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I4');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /未闭合 turn：2、3/);
});

test('doctor ②：I7 破坏（tokensTodayAccum 与折叠不符）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite(fx.events().map((item) =>
    item.type === 'budget/consumed' ? event(11, 'budget/consumed', { ...item.data, tokensTodayAccum: 999 }) : item,
  ));

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I7');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /tokensTodayAccum=999/);
});

test('doctor ②：I9 破坏（turn 已关闭却留下悬空 tool/call）被抓且退出码 1', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'tool/call', {
      turn: 1, step: 1, callId: 'call_x', name: 'http_post',
      arguments: '{"url":"https://example.test/"}', sideEffect: 'destructive',
    }, 'model'),
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I9');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /call_x/);

  // M6-7 的验收口径：报告该条 + 退出码非 0
  const cli = collector();
  assert.equal(await runCli(['doctor'], cli.io, { dataDir: fx.dir }), 1);
  const text = cli.lines.join('\n');
  assert.match(text, /✗ I9 /);
  assert.match(text, /call_x/);
  assert.match(text, /退出码 1/);
});

test('doctor ②：I10 破坏（人格文件被改动却无 persona/updated）被抓', async (t) => {
  const fx = makeFixture(t);
  writeFileSync(join(fx.dir, 'persona', 'STATE.md'), '# 当前状态\n\n人类直接改的。\n', 'utf8');

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I10');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /STATE\.md/);
});

test('doctor ②：I11 破坏（internal 事件被塞进模型可见内容）被抓', async (t) => {
  const fx = makeFixture(t);
  const timerEvent = fx.events().find((item) => item.type === 'timer/set')!;
  // 把一条 internal 事件的整条 JSON 放进 user 消息：这正是"internal 进了模型请求"
  fx.rewrite(fx.events().map((item) =>
    item.type === 'message/assistant'
      ? event(8, 'message/assistant', { text: `我把这条抄进来了：${JSON.stringify(timerEvent)}`, toolCalls: [] }, 'model')
      : item,
  ));

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I11');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /timer\/set\(seq 14\)/);
});

test('doctor ②：OPS-log 破坏（半截行）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.appendRaw('{"seq":15,"ts":"2026-05-01T00:00:00.000Z","type":"turn/en');

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'OPS-log');
  assert.equal(check?.status, 'fail');
  assert.equal(report.badLines, 1);
});

// ──────────────────────────────── ③ 边界 ────────────────────────────────

test('doctor ③：空数据目录（无日志无 persona）不误报，persona 检查报"跳过"', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-doctor-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const report = await runDoctor(dir);
  assert.equal(report.failures, 0);
  assert.equal(report.events, 0);
  const persona = report.checks.find((item) => item.id === 'I10');
  assert.equal(persona?.status, 'skip');
  const internal = report.checks.find((item) => item.id === 'I11');
  assert.equal(internal?.status, 'skip');
});

test('doctor ③：版本库快照内容与文件名不符 → I10 报 ✗（内容寻址是硬约束）', async (t) => {
  const fx = makeFixture(t);
  const versionsDir = join(fx.dir, '.versions', 'STATE.md');
  mkdirSync(versionsDir, { recursive: true });
  // 文件名声称是这份内容的 sha256，内容却是别的
  writeFileSync(join(versionsDir, `${sha256Hex('声称的内容')}.md`), '实际内容', 'utf8');

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I10');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /内容哈希 .* 与文件名不符/);
});

test('doctor ③：--json 输出可被机器消费（含 failures 与逐条结论）', async (t) => {
  const fx = makeFixture(t);
  const cli = collector();
  const ctx: CliContext = { dataDir: fx.dir };
  assert.equal(await runCli(['doctor', '--json'], cli.io, ctx), 0);

  const parsed = JSON.parse(cli.lines.join('\n')) as { failures: number; checks: Array<{ id: string; status: string }> };
  assert.equal(parsed.failures, 0);
  assert.equal(parsed.checks.length, 16);
});

// ──────────────────────────────── ④ 投影缓存（OPS-projection） ────────────────────────────────

/** 把一份投影写成缓存文件（信封 lastSeq 与 state.lastSeq 必须一致，否则先被加载层拒掉） */
function writeCache(fx: Fixture, state: unknown, lastSeq: number): void {
  writeFileSync(join(fx.dir, PROJECTION_CACHE_FILE), JSON.stringify({ lastSeq, state }), 'utf8');
}

test('doctor ④：缓存里的 watermark 是运行期游标，与折叠不一致不算损坏', async (t) => {
  const fx = makeFixture(t);
  const events = fx.events();
  const maxSeq = events[events.length - 1]!.seq;
  // 运行期会把水位推进到日志末尾（loop.ts），而 fold 只累计 lastSeq、永不推进水位（recover.ts 的
  // M1 简化）——这是两者的**合法差异**，不是缓存损坏。剔除它比对，这一项才不会每次报红。
  writeCache(fx, { ...fold(events), watermark: maxSeq }, maxSeq);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'OPS-projection');
  assert.equal(check?.status, 'ok');
  assert.match(check?.detail ?? '', new RegExp(`watermark ${maxSeq} 为运行期游标`));
  assert.equal(report.failures, 0);
});

test('doctor ④：缓存内容真的不同时仍报损坏（剔掉 watermark 不等于关掉检查）', async (t) => {
  const fx = makeFixture(t);
  const events = fx.events();
  const maxSeq = events[events.length - 1]!.seq;
  writeCache(fx, { ...fold(events), watermark: maxSeq, failStreak: 9 }, maxSeq);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'OPS-projection');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /缓存损坏/);
});

test('I11：工具输出里的日志原文不算泄漏——她自己翻日志是常事', async (t) => {
  // 一次实测误报（2026-10-01 turn 20）：她跑 doctor，列出五条"整条 internal 事件出现在请求体里"
  // 的 LEAK（budget/rollover、turn/start、step/start…），照着追了一遍，全是假的。
  // 根因是这条不变量把**工具输出**也算进了"请求体文本"——而她 rg_search / safe_read
  // 读事件日志时，日志原文（含整行 internal 事件）会合法地进上下文。判据该问的是
  // "渲染层有没有把 internal 事件当成上下文内容放进去"，与她用工具读到了什么无关。
  const diffHash = 'a'.repeat(64);
  const base = healthyEvents(diffHash);
  const turnStart = base.find((e) => e.seq === 4)!;
  // 动态序列化：拿真实对象的 JSON 去比对，保证与 doctor 的判据逐字节同形
  const serialized = JSON.stringify(turnStart);
  const withLog = base.map((e) => (e.seq === 10 && e.type === 'tool/result'
    ? ({ ...e, data: { ...e.data, content: `events/000000000001.jsonl:4: ${serialized}` } } as unknown as AppEvent)
    : e));
  const fx = makeFixture(t);
  fx.rewrite(withLog);
  const report = await runDoctor(fx.dir);
  const check = report.checks.find((c) => c.id === 'I11');
  assert.ok(check !== undefined);
  assert.equal(check.status, 'ok', `工具读过日志不该被判成泄漏：${check.detail}`);
});
/**
 * CLI 观测命令与启动告警测试 — src/cli.ts 的 tail / review / budget 与 src/alert/startup.ts
 *
 * 覆盖 docs/operations.md §6 的 CLI 表（tail / review list / review resolve / budget 四行）、
 * docs/milestones.md M4 交付物 4 与 5、docs/design.md §4.9 触发点清单首条
 * （启动时发现上一次是非正常退出）。
 *
 * 三条测试纪律：
 *   1. 一个用例一个独立临时目录——`review resolve` 写日志、`recover` 拿锁都要求"没有第二个写者"，
 *      共用目录会让用例之间通过磁盘互相干扰（那类失败最难查）；
 *   2. 断言首选"日志里有什么"，其次才是命令输出文本：输出是给人看的，日志才是事实；
 *   3. 时间全部钉死在假时钟上——告警分片文件名（alarms/YYYY-MM-DD.log）与 30 分钟限流窗都依赖它。
 */

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ALERT_DIR_NAME, createNotifier, fingerprintOf } from '../src/alert/notifier.ts';
import { interruptedRepairs, notifyStartupRecovery } from '../src/alert/startup.ts';
import { buildReviewList, runCli, summarizeEvent, type CliContext, type CliIO } from '../src/cli.ts';
import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import { LOCK_FILE_NAME } from '../src/runtime/instance-lock.ts';
import { recover } from '../src/runtime/recover.ts';
import { fold } from '../src/state/fold.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-02-14T10:00:00.000Z');
const DAY = '2026-02-14';

interface Fixture {
  dir: string;
  eventsDir: string;
  log: EventLog;
  /** 写一条事件（承诺类，与运行期同一纪律：落盘后才返回） */
  append: (type: string, data: unknown, ts?: string) => AppEvent;
  /** 关掉写句柄：CLI 的只读扫描与 resolve 都假定"主进程已停" */
  close: () => void;
}

async function setup(t: TestContext): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-cli-observe-'));
  const eventsDir = join(dir, 'events');
  const log = await EventLog.open(eventsDir);
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (type: string, data: unknown, ts: string = T0.toISOString()): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts,
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/cli-observe',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return event;
  };

  return {
    dir,
    eventsDir,
    log,
    append,
    close: () => {
      log.close();
    },
  };
}

/** 读回日志全部事件（open→读→close；测试里没有第二个写者，安全） */
async function readAll(dir: string): Promise<AppEvent[]> {
  const log = await EventLog.open(join(dir, 'events'));
  try {
    const events: AppEvent[] = [];
    for await (const event of log.readAll()) events.push(event);
    return events;
  } finally {
    log.close();
  }
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

/** 造一个"有活着的持有者"的锁文件：review resolve 必须据此拒绝写 */
function writeActiveLock(dir: string, pid: number): void {
  writeFileSync(
    join(dir, LOCK_FILE_NAME),
    JSON.stringify({ pid, startedAt: T0.toISOString(), heartbeatAt: T0.toISOString() }),
    'utf8',
  );
}

// ──────────────────────────────── tail ────────────────────────────────

test('cli tail：按类型前缀过滤，摘要压成一行并如实给出域', async (t) => {
  const fx = await setup(t);
  fx.append('wake/manual', { note: '起来看看\n第二行' });
  fx.append('turn/start', { turn: 1 });
  fx.append('tool/call', {
    turn: 1, step: 1, callId: 'call_1', name: 'http_post',
    arguments: '{"url":"https://example.test/x"}', sideEffect: 'destructive',
  });
  fx.append('tool/result', {
    turn: 1, step: 1, callId: 'call_1', callSeq: 3, status: 'ok', content: 'done',
  });
  fx.append('budget/consumed', {
    turn: 1, step: 1, lane: 'heavy', model: 'fake-heavy',
    inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20,
    durationMs: 5, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 120,
  });
  fx.close();

  const all = collector();
  assert.equal(await runCli(['tail', '--limit', '3'], all.io, { dataDir: fx.dir }), 0);
  assert.match(all.lines[0]!, /日志尾部 3 条/);
  // 最后三条 = tool/call、tool/result、budget/consumed（tail 是尾部，不是头部）
  assert.match(all.lines[1]!, /tool\/call · http_post\(call_1\) \[destructive\] \{"url"/);
  assert.match(all.lines[2]!, /tool\/result · call_1 · ok/);
  assert.match(all.lines[3]!, /budget\/consumed · heavy 120 tok（in 100 \/ out 20 · hit 80 \/ miss 20）· completed/);
  assert.ok(all.lines.every((line) => !line.includes('\n')), '摘要必须压成单行，否则 tail 的行数不可信');

  // 域过滤：只留 tool/ 域的两条
  const tool = collector();
  assert.equal(await runCli(['tail', '--type', 'tool/', '--limit', '10'], tool.io, { dataDir: fx.dir }), 0);
  assert.match(tool.lines[0]!, /过滤 tool\/\*/);
  assert.equal(tool.lines.slice(1).length, 2);
  assert.ok(!tool.lines.some((line) => line.includes('turn/start')));
  assert.match(tool.lines[1]!, /call_1/);

  // 先过滤再凑数：`--type wake/ --limit 1` 给的是最近一条 wake 事件，不是"最近 1 条恰是 wake"
  const wake = collector();
  assert.equal(await runCli(['tail', '--type', 'wake/', '--limit', '1'], wake.io, { dataDir: fx.dir }), 0);
  assert.match(wake.lines[1]!, /手动唤醒：起来看看 ⏎ 第二行/);

  // 参数错误一律退出码 2，且不猜意图
  const bad = collector();
  assert.equal(await runCli(['tail', '--limit', '0'], bad.io, { dataDir: fx.dir }), 2);
  assert.equal(await runCli(['tail', '--limit', 'abc'], bad.io, { dataDir: fx.dir }), 2);
  assert.equal(await runCli(['tail', '--nope'], bad.io, { dataDir: fx.dir }), 2);
  assert.ok(bad.errors.some((line) => line.includes('--limit 必须是')));
});

test('cli tail：跳过无法解析的尾行并如实计数（主进程正追加时读到半行）', async (t) => {
  const fx = await setup(t);
  fx.append('turn/start', { turn: 1 });
  // 活动分片是延迟创建的：先写一条，才拿得到分片文件名
  const shard = fx.log.shardFiles[0]!;
  fx.close();
  // 模拟"写了一半就崩"的尾行：只读扫描不修复它，只把它算进 badLines
  appendFileSync(join(fx.eventsDir, shard), '{"seq":2,"ts":', 'utf8');

  const out = collector();
  assert.equal(await runCli(['tail', '--limit', '5'], out.io, { dataDir: fx.dir }), 0);
  assert.match(out.lines[0]!, /日志尾部 1 条/);
  assert.match(out.lines[1]!, /turn\/start · turn 1/);
  assert.ok(
    out.lines.some((line) => line.includes('跳过 1 行无法解析的内容')),
    out.lines.join('\n'),
  );
});

test('summarizeEvent：未知形状也不抛，退化成 JSON 摘要', () => {
  const fake = {
    seq: 9, ts: T0.toISOString(), type: 'future/unknown-thing',
    data: { a: 1 }, visibility: 'internal',
  } as unknown as AppEvent;
  assert.equal(summarizeEvent(fake), '{"a":1}');
});

// ──────────────────────────────── review ────────────────────────────────

test('cli review：list 打印待确认明细，resolve 写 review/resolved 后待确认清除', async (t) => {
  const fx = await setup(t);
  fx.append('turn/start', { turn: 7 });
  fx.append('tool/call', {
    turn: 7, step: 2, callId: 'call_unknown', name: 'http_post',
    arguments: '{}', sideEffect: 'destructive',
  });
  fx.append('tool/result', {
    turn: 7, step: 2, callId: 'call_unknown', callSeq: 2, status: 'unknown',
    content: 'Its outcome is unknown.',
    error: { message: '进程在调用执行期间退出', code: 'recovered-unknown' },
  });
  fx.close();

  const list = collector();
  assert.equal(await runCli(['review', 'list'], list.io, { dataDir: fx.dir }), 0);
  assert.match(list.lines[0]!, /待确认调用 1 条/);
  assert.match(list.lines[1]!, /call_unknown · http_post · 2026-02-14T10:00:00\.000Z · turn 7 · step 2/);

  const ctx: CliContext = { dataDir: fx.dir, now: () => T0 };
  const resolve = collector();
  assert.equal(
    await runCli(
      ['review', 'resolve', 'call_unknown', '--outcome', 'succeeded', '--note', '外部接口查过，确实发出去了'],
      resolve.io, ctx,
    ),
    0,
  );
  assert.ok(resolve.lines.some((line) => line.includes('已结案：call_unknown → succeeded')));

  // 事件层：一条 review/resolved，字段完整，可见性按 schema 表（model）
  const events = await readAll(fx.dir);
  const resolved = events.filter(
    (event): event is Extract<AppEvent, { type: 'review/resolved' }> => event.type === 'review/resolved',
  );
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0]!.data, {
    callId: 'call_unknown', outcome: 'succeeded', note: '外部接口查过，确实发出去了', by: 'human',
  });
  assert.equal(resolved[0]!.visibility, 'model');
  assert.equal(resolved[0]!.seq, Math.max(...events.map((event) => event.seq)), '结案事件必须落在日志末尾');

  // 投影层：结案即从待确认列表消失（fold 的口径，不是 CLI 自己记的账）
  assert.equal(fold(events).needsReview.length, 0);
  assert.equal(buildReviewList(fx.dir).length, 0);
  const after = collector();
  assert.equal(await runCli(['review', 'list'], after.io, { dataDir: fx.dir }), 0);
  assert.match(after.lines[0]!, /待确认调用 0 条/);

  // 闸门①：拼错的 callId 不写日志（退出码 2）
  const typo = collector();
  assert.equal(await runCli(['review', 'resolve', 'call_typo', '--outcome', 'failed'], typo.io, ctx), 2);
  assert.ok(typo.errors.some((line) => line.includes('不在待确认列表里')));

  // 闸门②：outcome 只认三个值
  const badOutcome = collector();
  assert.equal(await runCli(['review', 'resolve', 'call_unknown', '--outcome', 'maybe'], badOutcome.io, ctx), 2);
  assert.equal(await runCli(['review', 'resolve', 'call_unknown'], badOutcome.io, ctx), 2);
  assert.equal(await runCli(['review', 'nope'], badOutcome.io, ctx), 2);

  // 闸门③：主进程活着就绝不写日志（退出码 3）——两个进程撞 seq 会让下次启动拒绝启动
  writeActiveLock(fx.dir, process.pid);
  const busy = collector();
  assert.equal(await runCli(['review', 'resolve', 'call_unknown', '--outcome', 'failed'], busy.io, ctx), 3);
  assert.ok(busy.errors.some((line) => line.includes('主进程正在运行')));
  assert.equal((await readAll(fx.dir)).filter((event) => event.type === 'review/resolved').length, 1, '被拒绝时不得落任何新事件');
});

// ──────────────────────────────── budget ────────────────────────────────

test('cli budget：heavy/light 分列、缓存命中率、距软/硬阈值比例与加注后的有效上限', async (t) => {
  const fx = await setup(t);
  fx.append('budget/consumed', {
    turn: 1, step: 1, lane: 'heavy', model: 'fake-heavy',
    inputTokens: 600, outputTokens: 400, cacheHitTokens: 800, cacheMissTokens: 200,
    durationMs: 5, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 1000,
  });
  fx.append('budget/consumed', {
    turn: 1, step: 2, lane: 'light', model: 'fake-light',
    inputTokens: 100, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 100,
    durationMs: 3, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 1100,
  });
  fx.append('budget/topped-up', { layer: 'daily', addedTokens: 1000, by: 'cli-tester' });
  fx.close();

  const ctx: CliContext = {
    dataDir: fx.dir,
    budget: { ...defaultConfig(fx.dir).budget, dailyTokens: 2000, taskTokens: 500, softRatio: 0.8 },
  };

  const out = collector();
  assert.equal(await runCli(['budget'], out.io, ctx), 0);
  const text = out.lines.join('\n');
  assert.match(text, /今日消耗: 1,100 token（heavy 1,000 · light 100）/);
  assert.match(text, /缓存: 命中 800 \/ 未命中 300 · 命中率 72\.7%/);
  assert.match(text, /单任务累计: 1,100 token/);
  assert.match(text, /人工加注: daily \+1,000/);
  // 有效硬上限 = 配置 2000 + 加注 1000 = 3000；已用 1100 → 36.7%；软阈值 2400 → 45.8%
  assert.match(text, /每日\(daily\): 已用 1,100 \/ 硬上限 3,000 token（36\.7%） · 软阈值 2,400（45\.8%）/);
  // task 层：1100 / 500 已越线，软阈值 400
  assert.match(text, /单任务\(task\): 已用 1,100 \/ 硬上限 500 token（220\.0%） · 软阈值 400（275\.0%） · 已越线/);

  const today = collector();
  assert.equal(await runCli(['budget', '--today'], today.io, ctx), 0);
  const todayText = today.lines.join('\n');
  assert.match(todayText, /今日口径（仅每日层）:/);
  assert.ok(!todayText.includes('单步(step)'), todayText);

  const bad = collector();
  assert.equal(await runCli(['budget', '--task'], bad.io, ctx), 2);
  assert.ok(bad.errors.some((line) => line.includes('无法识别的参数')));
});

test('cli budget：没有样本时的命中率是「无样本」，不是 0%', async (t) => {
  const fx = await setup(t);
  fx.append('budget/rollover', { date: DAY });
  fx.close();

  const out = collector();
  assert.equal(await runCli(['budget'], out.io, { dataDir: fx.dir, budget: defaultConfig(fx.dir).budget }), 0);
  const text = out.lines.join('\n');
  assert.match(text, /命中率 无样本/);
  assert.match(text, /人工加注: 无/);
});

// ──────────────────────────────── 启动异常退出告警 ────────────────────────────────

test('启动告警：recover 结算 interrupted 后发 warn 级告警（指纹 startup-recovery），同类限流', async (t) => {
  const fx = await setup(t);
  fx.append('wake/manual', { note: '崩溃前的输入' });
  fx.append('turn/start', { turn: 1 });
  fx.append('input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [0] });
  fx.close(); // 模拟崩溃：turn 未闭合，也没有 session/end

  const recovery = await recover({ dataDir: fx.dir });
  t.after(() => {
    recovery.lock.release();
  });

  // 与 runtime/recover.ts 的文本契约：文案一改，这条断言立刻红——告警不会静默失效
  assert.ok(
    interruptedRepairs(recovery.repairs).length > 0,
    `repairs 应含 interrupted 结算，实际：${JSON.stringify(recovery.repairs)}`,
  );
  assert.ok(recovery.repairs.some((repair) => repair.includes('turn/end{interrupted}')));

  const emitted: AppEvent[] = [];
  const notifier = createNotifier({
    config: { rateLimitMin: 30 },
    dataDir: fx.dir,
    emit: (type, data, visibility) => {
      emitted.push({
        seq: emitted.length + 1, ts: T0.toISOString(), type, data, visibility,
      } as unknown as AppEvent);
    },
    now: () => T0,
  });

  const receipt = await notifyStartupRecovery(notifier, {
    repairs: recovery.repairs, dataDir: fx.dir, pid: 4242,
  });
  assert.equal(receipt?.ok, true);

  const fingerprint = fingerprintOf('startup-recovery');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.type, 'alarm/sent');
  assert.equal(emitted[0]!.data.fingerprint, fingerprint);
  assert.equal(emitted[0]!.data.level, 'warn');
  assert.match(emitted[0]!.data.title, /启动恢复：上一次运行异常退出/);

  // 文件档是永远可用的那一档：告警必须落在 alarms/YYYY-MM-DD.log
  const logPath = join(fx.dir, ALERT_DIR_NAME, `${DAY}.log`);
  assert.ok(existsSync(logPath), '告警文件档缺失');
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /\[warn\]/);
  assert.ok(text.includes(fingerprint));
  assert.match(text, /上一次运行异常退出/);

  // 限流：同一类启动告警 30 分钟内只发一次（守护脚本反复拉起不该刷屏）
  const again = await notifyStartupRecovery(notifier, { repairs: recovery.repairs, dataDir: fx.dir });
  assert.equal(again?.ok, true, '被限流不是失败');
  assert.equal(emitted.length, 1, '第二次被限流丢弃，不写 alarm/sent');

  // 正常退出：repairs 里没有 interrupted，就不发告警——不制造"出事了"的假事实
  const normal = await notifyStartupRecovery(notifier, {
    repairs: ['水位恢复：待处理输入 1 条（manual×1）', '恢复定时器：1 条来自投影，已布防 1 个在途句柄'],
  });
  assert.equal(normal, null);
  assert.equal(emitted.length, 1);
});

test('启动告警：正常退出的恢复清单（无 interrupted）不发任何告警', async (t) => {
  const fx = await setup(t);
  fx.append('session/start', {
    pid: 111, cwd: fx.dir, version: '0.1.0', schemaVersion: '1', configHash: 'deadbeef',
  });
  fx.append('session/end', { reason: 'shutdown' });
  fx.close();

  const recovery = await recover({ dataDir: fx.dir });
  t.after(() => {
    recovery.lock.release();
  });

  assert.deepEqual(interruptedRepairs(recovery.repairs), []);

  const emitted: AppEvent[] = [];
  const notifier = createNotifier({
    config: { rateLimitMin: 30 },
    dataDir: fx.dir,
    emit: (type, data, visibility) => {
      emitted.push({
        seq: emitted.length + 1, ts: T0.toISOString(), type, data, visibility,
      } as unknown as AppEvent);
    },
    now: () => T0,
  });

  assert.equal(await notifyStartupRecovery(notifier, { repairs: recovery.repairs, dataDir: fx.dir }), null);
  assert.equal(emitted.length, 0);
  assert.equal(existsSync(join(fx.dir, ALERT_DIR_NAME, `${DAY}.log`)), false, '不该产生告警文件');
});

/**
 * 记忆整理单元测试（design.md §4.17、persona.md §3）
 *
 * 被测对象是 src/persona/memory-maintain.ts 本身，纪律：
 *   1. 时钟全注入（`now`）：TTL 判定、episode 年龄、日记文件名都对"今天"敏感，真时钟会让断言变成偶发失败。
 *   2. 事实从文件与日志断言：facts.md 是记忆的现场，事件日志是记账的真相源——不读内存态结论。
 *   3. 模型是脚本替身（light lane），它返回的四操作枚举就是写入路径与存储之间的稳定接口。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe, type TestContext } from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.ts';
import type { DsOutputItem, DsRequest, DsResponse, DsUsage } from '../src/model/ds-client.ts';
import {
  EPISODE_TTL_DAYS, diaryDir, ensureMemorySeeds, maintainMemory, memoriesDir,
  type MaintainMemoryOptions, type MemorySummarizer,
} from '../src/persona/memory-maintain.ts';
import { applyOne, fold } from '../src/state/fold.ts';

// ──────────────────────────────── 常量与夹具 ────────────────────────────────

/** 固定"今天"：2026-02-14（UTC 日期段，与 budget/rollover 同口径） */
const NOW = '2026-02-14T10:00:00.000+08:00';
const TODAY = '2026-02-14';
const ZERO_USAGE: DsUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };

interface Harness {
  dataDir: string;
  memDir: string;
  log: EventLog;
  projection: Projection;
  requests: DsRequest[];
  /** 模型脚本：按调用顺序返回 generate 结果（抛出用 { throws } 表达） */
  ds: MemorySummarizer;
  options: (patch?: Partial<MaintainMemoryOptions>) => MaintainMemoryOptions;
  events: () => Promise<AppEvent[]>;
  ofType: <T extends AppEvent['type']>(type: T) => Promise<Array<Extract<AppEvent, { type: T }>>>;
  writeEpisode: (date: string, body: string) => string;
  readFacts: () => string;
  close: () => void;
}

type ScriptItem =
  | { text: string; usage?: Partial<DsUsage> }
  | { throws: unknown };

function messageItem(text: string): DsOutputItem {
  return { type: 'message', id: 'm-memory', text };
}

async function makeHarness(t: TestContext, script: ScriptItem[]): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'irmia-memory-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  t.after(() => { void log.close(); });
  const projection = fold([]);
  const requests: DsRequest[] = [];
  const queue = [...script];
  const ds: MemorySummarizer = {
    modelFor: () => 'fake-light',
    generate: async (request: DsRequest): Promise<DsResponse> => {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error('脚本耗尽：模型调用次数超出预期');
      if ('throws' in next) throw next.throws;
      return {
        status: 'completed',
        outputItems: [messageItem(next.text)],
        usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20, ...(next.usage ?? {}) },
        incompleteReason: null,
        model: 'fake-light',
        responseId: 'resp_memory',
        durationMs: 7,
      };
    },
  };
  const memDir = memoriesDir(dataDir);
  const eventsFn = async (): Promise<AppEvent[]> => {
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };
  const ofTypeFn = async <T extends AppEvent['type']>(type: T): Promise<Array<Extract<AppEvent, { type: T }>>> => {
    const all = await eventsFn();
    return all.filter(e => e.type === type) as Array<Extract<AppEvent, { type: T }>>;
  };
  return {
    dataDir, memDir, log, projection, requests, ds,
    options: (patch = {}) => ({
      ds, now: () => new Date(NOW), log, projection, turn: 3, ...patch,
    }),
    events: eventsFn,
    ofType: ofTypeFn,
    writeEpisode: (date, body) => {
      const dir = join(memDir, 'episodes');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${date}.md`);
      writeFileSync(path, body, 'utf8');
      return path;
    },
    readFacts: () => readFileSync(join(memDir, 'facts.md'), 'utf8'),
    close: () => { log.flush(); },
  };
}

/** 整理模型返回的四操作载荷（写入路径与存储之间的稳定接口） */
function opsPayload(ops: Array<Record<string, unknown>>, summary = '这几天没什么大事。'): string {
  return JSON.stringify({ operations: ops, summary });
}

function diaryPayload(text: string): string {
  return JSON.stringify({ diary: text });
}

// ──────────────────────────────── M7-6 的单元面 ────────────────────────────────

describe('memory-maintain 种子与结构', () => {
  test('首启写出 MEMORIES/ 结构，重复调用幂等', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'irmia-memory-seed-'));
    t.after(() => { rmSync(root, { recursive: true, force: true }); });
    const dataDir = join(root, 'data');

    const created = ensureMemorySeeds(dataDir);
    assert.deepEqual(created.sort(), [
      'MEMORIES/aliases.md', 'MEMORIES/assets.md', 'MEMORIES/facts.md',
      'MEMORIES/jargon.md', 'MEMORIES/style-notes.md',
    ]);
    const memDir = memoriesDir(dataDir);
    assert.equal(existsSync(join(memDir, 'episodes')), true, 'episodes/ 必须存在（agent 自主写流水账的落点）');
    assert.equal(existsSync(diaryDir(dataDir)), true, 'workspace/diary/ 必须存在');

    const facts = readFileSync(join(memDir, 'facts.md'), 'utf8');
    for (const title of ['## 置顶（pinned）', '## 约定与承诺', '## 稳定事实', '## 观察', '## 归档（已失效/已过期，不注入）']) {
      assert.ok(facts.includes(title), `facts.md 分区模板缺少 ${title}`);
    }

    // 幂等：再跑一次不再创建，且已存在的文件内容一字不改（记忆是 agent 自主资产）
    const again = ensureMemorySeeds(dataDir);
    assert.deepEqual(again, []);
    assert.equal(readFileSync(join(memDir, 'facts.md'), 'utf8'), facts);
  });
});

describe('memory-maintain 合并与四操作', () => {
  test('8 天前 episode 合并进 facts.md、原文件移入 archive/、过期条目入归档区、diary 与 light 记账齐全', async (t) => {
    const h = await makeHarness(t, [
      {
        text: opsPayload([
          { op: 'ADD', section: 'stable', entry: '用户每周三晚上做备份演练' },
          { op: 'UPDATE', section: 'observation', target: '开会老迟到', entry: '用户开会通常迟到十分钟' },
          { op: 'INVALIDATE', section: 'observation', target: '旧咖啡机', reason: '已换新机器' },
          { op: 'NOOP', reason: '寒暄不算记忆' },
        ], '这三天做了备份演练，换掉了咖啡机。'),
      },
      { text: diaryPayload('今天把三天的流水账收拢成事实，顺手送走了一条已经不准的旧结论。') },
    ]);

    // 8 天前（2026-02-06）该被合并；7 天前（2026-02-07）不该动
    h.writeEpisode('2026-02-06', '# 2026-02-06\n\n- 用户说周三晚上做备份演练\n- 旧咖啡机坏了，换了新的\n');
    h.writeEpisode('2026-02-07', '# 2026-02-07\n\n- 开会老迟到十分钟，他自己也知道\n');

    // 既有记忆：一条会被 UPDATE 命中、一条会被 INVALIDATE 命中、一条已过期、一条置顶且已过期
    const memDir = h.memDir;
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'facts.md'), [
      '# Facts',
      '',
      '## 置顶（pinned）',
      '- [!pinned] [valid 2026-01-01 ~ 2026-02-01] (source: turn 3) 用户对花生过敏',
      '## 约定与承诺',
      '## 稳定事实',
      '## 观察',
      '- [valid 2026-01-20] (source: turn 9) 用户开会老迟到，旧咖啡机在旁边',
      '- [valid 2026-01-20] (source: seq 99) 旧咖啡机在角落，随时能用',
      '- [valid 2026-01-01 ~ 2026-02-01] (source: turn 4) 项目 deadline 已过',
      '## 归档（已失效/已过期，不注入）',
      '',
    ].join('\n'), 'utf8');

    const result = await maintainMemory(h.dataDir, h.options());

    // 四操作计数：ADD1 / UPDATE1 / INVALIDATE1（模型）+ 1（TTL 过期项） / NOOP1
    assert.deepEqual(result.ops, { add: 1, update: 1, invalidate: 2, noop: 1 });
    assert.deepEqual(result.merged, ['2026-02-06.md']);
    assert.deepEqual(result.archived, ['2026-02-06.md']);
    assert.equal(result.expiredEntries, 1);

    // 原文件已移入 archive/，episodes/ 下只剩未到期的 7 天前那份
    const episodesDir = join(memDir, 'episodes');
    assert.deepEqual(readdirSync(episodesDir).sort(), ['2026-02-07.md', 'archive']);
    assert.equal(readFileSync(join(episodesDir, 'archive', '2026-02-06.md'), 'utf8'), '# 2026-02-06\n\n- 用户说周三晚上做备份演练\n- 旧咖啡机坏了，换了新的\n');

    const facts = h.readFacts();
    assert.ok(facts.includes('用户每周三晚上做备份演练'), 'ADD 的条目必须落进 facts.md');
    assert.ok(facts.includes('(source: episode 2026-02-06)'), 'ADD 条目要留溯源来源');
    assert.ok(facts.includes('用户开会通常迟到十分钟'), 'UPDATE 要改写命中条目');
    assert.ok(!facts.includes('旧咖啡机在旁边'), 'UPDATE 之后不该同时留着旧说法');
    assert.match(facts, /\[invalid 2026-02-14 →\].*旧咖啡机在角落/, 'INVALIDATE 的条目要标注失效并保留在归档区');
    assert.match(facts, /\[invalid 2026-02-14 →\].*项目 deadline 已过/, 'TTL 过期条目要移入归档区');
    assert.match(facts, /- \[!pinned\] \[valid 2026-01-01 ~ 2026-02-01\] \(source: turn 3\) 用户对花生过敏/, '!pinned 永不归档');
    // 归档区之外不该再出现过期条目
    const [active, archive] = facts.split('## 归档（已失效/已过期，不注入）');
    assert.ok(!(active ?? '').includes('项目 deadline 已过'), '过期条目必须离开注入区');
    assert.ok((archive ?? '').includes('项目 deadline 已过'));

    // 日记产出 + light 记账（两次调用都进当日预算账本）
    assert.equal(result.diaryFile, join(diaryDir(h.dataDir), `${TODAY}.md`));
    const diary = readFileSync(result.diaryFile ?? '', 'utf8');
    assert.ok(diary.includes('今天把三天的流水账收拢成事实'), '日记正文取模型的叙事输出');
    assert.equal(result.lightCalls, 2, '合并 1 次 + 日记 1 次');
    assert.equal(result.lightTokens, 240, '两次调用各 120 token');
    assert.equal(result.modelFailures, 0);

    const consumed = await h.ofType('budget/consumed');
    assert.equal(consumed.length, 2);
    for (const event of consumed) {
      assert.equal(event.data.lane, 'light', '整理只花 light 车道的钱');
      assert.equal(event.data.turn, 3);
      assert.equal(event.data.finishReason, 'completed');
    }
    assert.equal(consumed[1]?.data.tokensTodayAccum, 240, '记账累进到当日总额');

    // 整理留痕：事件里的计数与返回值一致
    const maintained = await h.ofType('memory/maintained');
    assert.equal(maintained.length, 1);
    assert.equal(maintained[0]?.visibility, 'internal');
    assert.deepEqual(maintained[0]?.data.ops, result.ops);
    assert.equal(maintained[0]?.data.mergedCount, 1);
    assert.equal(maintained[0]?.data.expiredCount, 1);
    assert.equal(maintained[0]?.data.lightTokens, 240);

    // 再来一次：没有到期 episode，零模型调用、facts.md 字节不变（幂等）
    const before = h.readFacts();
    const second = await maintainMemory(h.dataDir, h.options());
    assert.equal(second.ran, false);
    assert.equal(second.lightCalls, 0);
    assert.equal(h.requests.length, 2, '第二次整理不该再调模型');
    assert.equal(h.readFacts(), before, '无操作时 facts.md 逐字节不变');
  });

  test('7 天及以内的 episode 不动（TTL 边界）', async (t) => {
    const h = await makeHarness(t, [{ text: opsPayload([], '') }, { text: diaryPayload('无事。') }]);
    h.writeEpisode('2026-02-07', '7 天前：留到明天再整理。\n');
    h.writeEpisode('2026-02-13', '昨天：今天的流水账。\n');
    const result = await maintainMemory(h.dataDir, h.options());
    assert.equal(result.ran, false);
    assert.deepEqual(result.merged, []);
    assert.deepEqual(readdirSync(join(h.memDir, 'episodes')).sort(), ['2026-02-07.md', '2026-02-13.md']);
    assert.equal(h.requests.length, 0);
    assert.equal(EPISODE_TTL_DAYS, 7);
  });

  test('模型不可用时退化为确定性合并：记忆不丢、原件照样归档', async (t) => {
    const h = await makeHarness(t, [
      { throws: new Error('light 通道 503') },
      { throws: new Error('light 通道 503') },
    ]);
    h.writeEpisode('2026-02-05', '- 用户决定把部署窗口挪到周六凌晨\n');
    const result = await maintainMemory(h.dataDir, h.options());

    assert.equal(result.ran, true);
    assert.equal(result.modelFailures, 2);
    assert.equal(result.ops.add, 1, '回退路径也要把内容记下来');
    const facts = h.readFacts();
    assert.ok(facts.includes('部署窗口挪到周六凌晨'), '回退条目必须落在 facts.md 里');
    assert.ok(facts.includes('(source: episode 2026-02-05)'));
    assert.deepEqual(readdirSync(join(h.memDir, 'episodes')).sort(), ['archive']);
    assert.notEqual(result.diaryFile, null, '日记走回退正文，仍然产出');
    assert.ok(readFileSync(result.diaryFile ?? '', 'utf8').includes('没有可用的模型通道'));

    const consumed = await h.ofType('budget/consumed');
    assert.equal(consumed.length, 2);
    for (const event of consumed) {
      assert.equal(event.data.finishReason, 'failed', '失败也记账（否则 light 坏了 failStreak 永远为 0）');
      assert.equal(event.data.lane, 'light');
    }
  });

  test('归档区条目与 invalid 条目不参与 TTL 判定（可回放、不二次移动）', async (t) => {
    const h = await makeHarness(t, [{ text: opsPayload([], '') }, { text: diaryPayload('无事。') }]);
    mkdirSync(h.memDir, { recursive: true });
    writeFileSync(join(h.memDir, 'facts.md'), [
      '# Facts',
      '',
      '## 置顶（pinned）',
      '## 约定与承诺',
      '## 稳定事实',
      '## 观察',
      '- [invalid 2026-02-10 →] [valid 2026-01-01 ~ 2026-02-01] (source: turn 7) 已经作废的旧结论',
      '## 归档（已失效/已过期，不注入）',
      '- [invalid 2026-02-10 →] [valid 2026-01-01 ~ 2026-02-01] (source: turn 8) 早就归档的条目',
      '',
    ].join('\n'), 'utf8');
    // 只有"到期但没有 episode"这一种情况：ran=false，但 TTL 修剪照样要能跑
    const result = await maintainMemory(h.dataDir, h.options({ force: true }));
    assert.equal(result.ran, true);
    assert.equal(result.expiredEntries, 0);
    const facts = h.readFacts();
    assert.equal((facts.match(/已经作废的旧结论/g) ?? []).length, 1, 'invalid 条目不重复标注');
    assert.equal((facts.match(/早就归档的条目/g) ?? []).length, 1, '归档区条目不二次移动');
  });
});

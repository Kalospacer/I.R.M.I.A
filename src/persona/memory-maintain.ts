/**
 * Irmia Agent — 记忆整理（design.md §4.17、persona.md §3）
 *
 * MEMORIES/ 是长期记忆，但**文件不会自己变有序**。无人值守意味着记忆的增长、合并、修剪
 * 必须由机制驱动：本模块就是那个机制（"做梦"），由每日定时任务触发（real-loop 注册 cron）。
 *
 * 三件事，顺序不可颠倒：
 *   ① **合并**：`episodes/` 里超过 7 天的流水账调 light 模型提炼成 facts.md 条目
 *      （保留决策与结论，丢弃过程），**新 facts 落盘成功之后**才把原文件移进 `episodes/archive/`
 *      ——反顺序会在崩溃时造成"原件没了、结论也没写进去"的静默丢失。
 *   ② **修剪**：facts.md 里 `[valid 起~止]` 且截止日已过、且不是 `!pinned` 的条目移入 `## 归档` 区。
 *      不删除：invalidate 是可回放的遗忘（硬删除会丢溯源链），归档区不参与注入但可恢复。
 *   ③ **消化**：产出一份日记 `workspace/diary/YYYY-MM-DD.md`（叙事，light 模型）。
 *      整理是归档，日记是消化——它不参与召回注入，只在她自省时被自己重读。
 *
 * 写入路径与存储之间的稳定接口是 Mem0 的操作枚举：**ADD / UPDATE / INVALIDATE / NOOP**。
 * 计数进返回值（`ops`），同时写一条 `memory/maintained`（internal）事件留痕。
 *
 * 记账口径：本任务自己做的两次 light 调用各写一条 `budget/consumed{lane:'light'}`，
 * 与 injection-judge 的判定账同一份口径（失败也记账，否则 light 通道坏了 failStreak 永远为 0）。
 *
 * 刻意没做的部分（不编造来源）：访问强化（"近期召回命中的条目往前提"）——它需要召回命中数据，
 * 本模块没有这条输入；`MEMORIES/aliases.md` 的别名维护同理，由 agent 用文件工具自主写。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

import type { BudgetConsumed, MemoryMaintained, Projection } from '../log/types.js';
import type { EventLog } from '../log/event-log.js';
import type { DsClient, DsRequest, DsResponse, DsTextFormat } from '../model/ds-client.js';
import { applyOne, finalizePressure } from '../state/fold.ts';
import { ensureAssetsSeed, ASSETS_FILE_NAME } from './assets.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 记忆根目录名（在 `<dataDir>/workspace/` 之下，persona.md §3 的资产表） */
export const MEMORY_DIR_NAME = 'MEMORIES';
/** 流水账目录（按日期一文件，agent 用普通文件工具自主写） */
export const EPISODE_DIR_NAME = 'episodes';
/** 流水账归档目录（整理后的原件存放处，可人工回溯） */
export const EPISODE_ARCHIVE_DIR_NAME = 'archive';
/** 日记目录 */
export const DIARY_DIR_NAME = 'diary';
/** episode 的 TTL（天）：超过它就被合并进 facts.md（design §4.17：默认 7 天） */
export const EPISODE_TTL_DAYS = 7;
/** 每日整理任务在定时器 payload 里的标识（real-loop 据此走整理而非普通 turn） */
export const MEMORY_MAINTAIN_PAYLOAD_KIND = 'memory-maintain';
/** 事件 origin */
export const MEMORY_ORIGIN = 'persona/memory-maintain';
/** 单次合并注入模型的正文上限（字符；零依赖估算，与 design §4.12 同口径） */
const MERGE_INPUT_MAX_CHARS = 16_000;
/** 单个 episode 注入上限（字符） */
const EPISODE_MAX_CHARS = 4_000;
/** facts 摘要注入上限（字符）：给模型看现有条目以便 UPDATE / INVALIDATE 定位 */
const FACTS_HINT_MAX_CHARS = 4_000;

/** 分区顺序即 facts.md 的渲染顺序（"时间序即文件序"的载体） */
const SECTION_ORDER = ['pinned', 'promise', 'stable', 'observation', 'archive'] as const;
type AnySection = (typeof SECTION_ORDER)[number];
/** 可写入的分区（归档区只由机制写入） */
type WriteSection = Exclude<AnySection, 'archive'>;

const SECTION_TITLES: Record<AnySection, string> = {
  pinned: '## 置顶（pinned）',
  promise: '## 约定与承诺',
  stable: '## 稳定事实',
  observation: '## 观察',
  archive: '## 归档（已失效/已过期，不注入）',
};

const ALIASES_SEED = `# 身份别名

平台给的身份标识对不上人时，在这里给他起个名字。一行一条：\`<sid> = <名字>\`。
备注可以写在名字后的括号里，会作为备注显示、不计入名字。

sid 就在你每轮上下文里那份「外部会话」清单上（形如 \`qq:c2c:<openid>\`）。
写了名字，下次他来就用这个名字显示——**QQ 不提供昵称**，认人只能靠你自己记。

# 群成员（openid，不是 sid；只在认人时用）

群里的人不是会话（他可能从没私聊过你），所以单起一段：\`<openid> = <名字>\`——**键是裸 openid**，
不带 \`qq:c2c:\` 那种前缀（\`#\` 开头那一行是段标题，不是条目）。这一段的用途是**在群里 @ 人**：
你在 \`speak\` / \`report\` 的正文里写 \`[@名字]\`，框架就照这一段把名字换成官方 @ 形态
（\`<qqbot-at-user id="…" />\`）再发出去。三条边界：
括号里是备注、**不算名字**；同名对应两个 openid 时框架**拒绝**（重名不猜），那种情况直接写 \`<@<openid>>\`；
名字认不出来时**那一条不会发出去**，并把这一段现有的名字回给你——照它改一个字再发。
openid **按群隔离**（只有你在同一个群里见过的那个才管用），别把别处抄来的 id 填在这儿。

`;

const FACTS_SEED = `# Facts

（关于世界与用户的稳定事实。每条一行：有效性区间 + 来源 + 内容。
 例：\`- [valid 2026-02-14] (source: turn 12) 用户周五下午通常开例会\`。
 每日整理任务会把过期条目移进归档区；\`[!pinned]\` 条目永不衰减、永不归档。）

${SECTION_TITLES.pinned}
${SECTION_TITLES.promise}
${SECTION_TITLES.stable}
${SECTION_TITLES.observation}
${SECTION_TITLES.archive}
`;

const JARGON_SEED = `# 黑话与含义

（用户用的黑话、缩写、圈内词，一条一行，写清"他怎么用、指什么"。）

- （示例）"老地方" = 他常说的那个会议室，不是地点。
`;

const STYLE_NOTES_SEED = `# 表达风格观察

（他对表达方式的偏好与反感，一条一行。这里记"见过什么"，skill 记"会做什么"。）

- （示例）他讨厌"首先/其次/最后"这种八股过渡。
`;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 四操作计数（Mem0 实证的写入路径与存储之间的稳定接口） */
export interface MemoryOps {
  add: number;
  update: number;
  invalidate: number;
  noop: number;
}

export interface MaintainMemoryResult {
  /** 是否真的执行了整理（false = 本次无事可做，含"没有到期的 episode"） */
  ran: boolean;
  /** ran=false 时是跳过原因；ran=true 时是一句执行摘要 */
  reason: string;
  ops: MemoryOps;
  /** 被合并的 episode 文件名（不含路径） */
  merged: string[];
  /** 已移入 episodes/archive/ 的文件名 */
  archived: string[];
  /** 因 TTL 过期移入归档区的条目数 */
  expiredEntries: number;
  /** 日记文件绝对路径（模型与回退路径都会产出）；写失败为 null */
  diaryFile: string | null;
  /** 本任务的 light lane 消耗（input+output 合计） */
  lightTokens: number;
  lightCalls: number;
  modelFailures: number;
}

/** 整理任务只需要模型的这两个能力（DsClient 天然满足） */
export type MemorySummarizer = Pick<DsClient, 'generate' | 'modelFor'>;

export interface MaintainMemoryOptions {
  ds: MemorySummarizer;
  now?: () => Date;
  /** 事件日志；给了就写 `memory/maintained` 与 `budget/consumed` 留痕 */
  log?: EventLog | null;
  /** 投影（记账口径：tokensTodayAccum）；与 log 同时给出才记账 */
  projection?: Projection | null;
  /** 记账挂到的 turn 号（默认 0：表示不在某个 turn 内） */
  turn?: number;
  out?: (line: string) => void;
  /** episode TTL 覆盖点（测试注入）；默认 EPISODE_TTL_DAYS */
  episodeMaxAgeDays?: number;
  /** 强制走一遍整理流程（即使没有到期的 episode），用于手动补整理 */
  force?: boolean;
}

// ──────────────────────────────── 目录与种子 ────────────────────────────────

export function memoriesDir(dataDir: string): string {
  return join(dataDir, 'workspace', MEMORY_DIR_NAME);
}

export function diaryDir(dataDir: string): string {
  return join(dataDir, 'workspace', DIARY_DIR_NAME);
}

/**
 * 首启初始化 MEMORIES/ 结构：`facts.md`（分区模板）/ `jargon.md` / `style-notes.md` / `episodes/`。
 * 幂等：已存在的文件一个字节都不动（记忆是 agent 自主资产，机制只负责保证结构存在）。
 * 返回相对 `workspace/` 的创建记录，供启动摘要与测试断言。
 *
 * `assets.md`（数字资产清单）也在这里落种子，但它**不进记忆索引**（见 `persona/assets.ts`：
 * 那份清单要的是"不主动进入"，只在她被叫去干活时由 light 挑几条露一次面）。
 * 种子逻辑在 assets 模块里（与它自己的说明放在一起），这里只调一次——**只在文件不存在时写**，
 * 所以既有工作区不会因为这次改动凭空多出一个文件。
 */
export function ensureMemorySeeds(dataDir: string): string[] {
  const memDir = memoriesDir(dataDir);
  mkdirSync(join(memDir, EPISODE_DIR_NAME), { recursive: true });
  mkdirSync(diaryDir(dataDir), { recursive: true });
  const created: string[] = [];
  const files: Array<[string, string]> = [
    ['facts.md', FACTS_SEED],
    ['jargon.md', JARGON_SEED],
    ['style-notes.md', STYLE_NOTES_SEED],
    ['aliases.md', ALIASES_SEED],
  ];
  for (const [name, content] of files) {
    const path = join(memDir, name);
    if (!existsSync(path)) {
      writeFileSync(path, content, 'utf8');
      created.push(`${MEMORY_DIR_NAME}/${name}`);
    }
  }
  // 数字资产清单：种子文本住在 assets 模块（那里同时是解析与选取的实现）
  if (ensureAssetsSeed(dataDir)) created.push(`${MEMORY_DIR_NAME}/${ASSETS_FILE_NAME}`);
  return created;
}

// ──────────────────────────────── facts.md 解析 ────────────────────────────────

/** 一条记忆条目（行内格式：`- [!pinned] [valid 起 ~ 止] (source: …) 内容`） */
interface MemoryEntry {
  /** 原始行（无法解析出行内格式的自由文本行也保留） */
  raw: string;
  /** 是否是可解析的规范条目 */
  parsed: boolean;
  pinned: boolean;
  invalid: boolean;
  /** [valid 起] */
  start: string | null;
  /** [valid 起 ~ 止] 的止（单点 validity 为 null） */
  end: string | null;
  /** 标签之后的内容（含 `(source: …)` 前缀） */
  body: string;
}

interface FactsDoc {
  /** 一级标题与说明行（首个 `## 区` 之前的内容） */
  preamble: string[];
  sections: Record<AnySection, string[]>;
  /** 整理过程中新增的失效日期标注（渲染时用它而不是再次读时钟） */
  invalidDate: string;
}

function emptySections(): Record<AnySection, string[]> {
  return { pinned: [], promise: [], stable: [], observation: [], archive: [] };
}

function sectionOfLine(line: string): AnySection | null {
  const m = /^##\s+(.*)$/.exec(line);
  if (m === null) return null;
  const title = (m[1] ?? '').trim();
  if (title.startsWith('置顶') || title.includes('pinned')) return 'pinned';
  if (title.startsWith('约定') || title.includes('承诺')) return 'promise';
  if (title.startsWith('稳定')) return 'stable';
  if (title.startsWith('观察')) return 'observation';
  if (title.startsWith('归档')) return 'archive';
  return null;
}

function parseFacts(text: string, invalidDate: string): FactsDoc {
  const doc: FactsDoc = { preamble: [], sections: emptySections(), invalidDate };
  let current: AnySection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const hit = sectionOfLine(line);
    if (hit !== null) {
      current = hit;
      continue;
    }
    if (current === null) doc.preamble.push(line);
    else doc.sections[current].push(line);
  }
  // 去掉首尾空行，保证"无操作时渲染字节稳定"（幂等的必要条件）
  for (const key of SECTION_ORDER) doc.sections[key] = trimBlank(doc.sections[key]);
  doc.preamble = trimBlank(doc.preamble);
  return doc;
}

function trimBlank(lines: string[]): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && (lines[from] ?? '').trim() === '') from += 1;
  while (to > from && (lines[to - 1] ?? '').trim() === '') to -= 1;
  return lines.slice(from, to);
}

/** 行内格式解析：只吃认识的标签，遇到不认识的 `[..]` 就停（不吞正文） */
export function parseEntryLine(raw: string): MemoryEntry {
  const entry: MemoryEntry = {
    raw, parsed: false, pinned: false, invalid: false, start: null, end: null, body: raw.trim(),
  };
  const m = /^-\s+(.*)$/.exec(raw);
  if (m === null) return entry;
  let rest = m[1] ?? '';
  let sawTag = false;
  for (;;) {
    const tag = /^\[([^\]]*)\]\s*/.exec(rest);
    if (tag === null) break;
    const inner = (tag[1] ?? '').trim();
    if (inner === '!pinned') {
      entry.pinned = true;
      sawTag = true;
      rest = rest.slice(tag[0].length);
      continue;
    }
    const validity = /^(valid|invalid)\s+(\d{4}-\d{2}-\d{2})(?:\s*~\s*(\d{4}-\d{2}-\d{2}))?\s*(?:→|->)?$/.exec(inner);
    if (validity === null) break;
    if (validity[1] === 'invalid') entry.invalid = true;
    entry.start = validity[2] ?? null;
    entry.end = validity[3] ?? null;
    sawTag = true;
    rest = rest.slice(tag[0].length);
  }
  entry.body = rest.trim();
  entry.parsed = sawTag;
  return entry;
}

function formatEntry(e: {
  pinned: boolean; invalid: boolean; start: string | null; end: string | null; body: string;
}, invalidDate: string): string {
  const tags: string[] = [];
  if (e.pinned) tags.push('[!pinned]');
  if (e.invalid) {
    tags.push(`[invalid ${invalidDate} →]`);
    // 溯源链保留：被标注失效时把原来的有效区间一并留在行里
    if (e.start !== null) tags.push(e.end === null ? `[valid ${e.start}]` : `[valid ${e.start} ~ ${e.end}]`);
  } else if (e.start !== null) {
    tags.push(e.end === null ? `[valid ${e.start}]` : `[valid ${e.start} ~ ${e.end}]`);
  }
  const head = tags.length === 0 ? '- ' : `- ${tags.join(' ')} `;
  return `${head}${e.body}`.trimEnd();
}

function renderFacts(doc: FactsDoc): string {
  const out: string[] = [...doc.preamble];
  if (out.length > 0) out.push('');
  for (const key of SECTION_ORDER) {
    out.push(SECTION_TITLES[key]);
    const lines = doc.sections[key];
    if (lines.length > 0) out.push('', ...lines);
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 某分区里可解析的条目（保留行号，便于就地改写） */
function entriesIn(doc: FactsDoc, section: AnySection): Array<{ index: number; entry: MemoryEntry }> {
  const out: Array<{ index: number; entry: MemoryEntry }> = [];
  doc.sections[section].forEach((line, index) => {
    const entry = parseEntryLine(line);
    if (entry.parsed && /^-\s+/.test(line)) out.push({ index, entry });
  });
  return out;
}

// ──────────────────────────────── TTL 修剪 ────────────────────────────────

/** `YYYY-MM-DD` 字符串比较即时间序；end < today 且非 pinned/非 invalid 即过期 */
function isExpired(entry: MemoryEntry, today: string): boolean {
  if (!entry.parsed || entry.pinned || entry.invalid) return false;
  if (entry.end === null) return false;
  return entry.end < today;
}

/**
 * 把过期条目移入归档区（原地改写为 `[invalid …]` 标注，不删除）。
 * 归档区里的条目不会再次被移动（invalid 判定短路），所以重复整理是幂等的。
 */
function expireByTtl(doc: FactsDoc, today: string): string[] {
  const moved: string[] = [];
  for (const section of ['pinned', 'promise', 'stable', 'observation'] as const) {
    const keep: string[] = [];
    for (const line of doc.sections[section]) {
      const entry = parseEntryLine(line);
      if (isExpired(entry, today)) {
        doc.sections.archive.push(formatEntry({
          pinned: false, invalid: true, start: entry.start, end: entry.end, body: entry.body,
        }, today));
        moved.push(entry.body);
        continue;
      }
      keep.push(line);
    }
    doc.sections[section] = keep;
  }
  return moved;
}

// ──────────────────────────────── 模型调用 ────────────────────────────────

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['ADD', 'UPDATE', 'INVALIDATE', 'NOOP'] },
          section: { type: 'string', enum: ['pinned', 'promise', 'stable', 'observation'] },
          entry: { type: 'string' },
          target: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['operations'],
  additionalProperties: false,
} as const;

const DIARY_SCHEMA = {
  type: 'object',
  properties: { diary: { type: 'string' } },
  required: ['diary'],
  additionalProperties: false,
} as const;

const MERGE_INSTRUCTIONS = [
  '你在整理一台机器伙伴的长期记忆。输入是若干天前的流水账（episodes）与该伙伴已有的记忆条目。',
  '把流水账提炼成关于世界与用户的稳定事实条目，纪律如下：',
  '1. 保留决策与结论，丢弃过程、寒暄与重复。一条记忆一行，一句话说清事实。',
  '2. 不写"今天/昨天/刚才"这类相对时间——写进长期记忆的必须是绝对日期或恒定事实。',
  '3. 与已有条目矛盾时：用 INVALIDATE 标注旧条目失效（target 写旧条目里一段可唯一定位的原文），再用 ADD 写入新条目。',
  '4. 只是换个说法、信息量没有增加时用 NOOP——不要为了凑数而改写。',
  '5. 需要精简或纠正已有条目时用 UPDATE（target 定位旧条目，entry 给新正文）。',
  '6. 值得永不衰减的重要事实（过敏、姓名、底线）在 entry 开头写 [!pinned]。',
].join('\n');

const DIARY_INSTRUCTIONS = [
  '你是这台机器上常驻伙伴的日记。用第一人称写今天这一篇，不要罗列条目，不要写报告式总结。',
  '素材是今天整理的流水账摘录与记忆变化。要求：200-400 字，语气克制，既写发生的事，也说清它对她意味着什么。',
  '不写"作为 AI"这类出戏的话，不写八股过渡词。',
].join('\n');

function textFromOutputs(response: DsResponse): string {
  let text = '';
  for (const item of response.outputItems) {
    if (item.type === 'message') text += item.text;
  }
  return text;
}

/** 容错取 JSON：模型偶尔会用 ``` 围栏包一层（与 injection-judge 同口径的宽松解析） */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced === null ? trimmed : (fenced[1] ?? '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ──────────────────────────────── 四操作应用 ────────────────────────────────

interface PlannedOp {
  op: 'ADD' | 'UPDATE' | 'INVALIDATE' | 'NOOP';
  section: WriteSection;
  entry: string;
  target: string;
}

const WRITE_SECTIONS: readonly WriteSection[] = ['pinned', 'promise', 'stable', 'observation'];

function readSection(raw: unknown): WriteSection {
  return typeof raw === 'string' && (WRITE_SECTIONS as readonly string[]).includes(raw)
    ? (raw as WriteSection)
    : 'observation';
}

function readOps(value: unknown): PlannedOp[] {
  if (typeof value !== 'object' || value === null) return [];
  const list = (value as Record<string, unknown>)['operations'];
  if (!Array.isArray(list)) return [];
  const out: PlannedOp[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    const op = raw['op'];
    if (op !== 'ADD' && op !== 'UPDATE' && op !== 'INVALIDATE' && op !== 'NOOP') continue;
    out.push({
      op,
      section: readSection(raw['section']),
      entry: typeof raw['entry'] === 'string' ? raw['entry'].trim() : '',
      target: typeof raw['target'] === 'string' ? raw['target'].trim() : '',
    });
  }
  return out;
}

/** 找某分区里正文包含 target 的第一条可解析条目 */
function findByTarget(doc: FactsDoc, section: WriteSection, target: string): { index: number; entry: MemoryEntry } | null {
  if (target === '') return null;
  for (const hit of entriesIn(doc, section)) {
    if (hit.entry.body.includes(target)) return hit;
  }
  return null;
}

/**
 * 应用模型给出的操作。返回真实发生的动作计数：
 *   - ADD 的新条目统一带 `(source: episode …)`，日期取整理当天（绝对日期，不是"今天"）
 *   - UPDATE 找不到 target 时代价为 NOOP（不制造"计数与文件不一致"的假象）
 *   - INVALIDATE 在原文位置标失效并移入归档区（保留溯源链）
 */
function applyOps(
  doc: FactsDoc,
  ops: readonly PlannedOp[],
  ctx: { today: string; source: string },
): { ops: MemoryOps; added: string[]; invalidated: string[] } {
  const counts: MemoryOps = { add: 0, update: 0, invalidate: 0, noop: 0 };
  const added: string[] = [];
  const invalidated: string[] = [];

  for (const planned of ops) {
    if (planned.op === 'NOOP') {
      counts.noop += 1;
      continue;
    }
    if (planned.op === 'ADD') {
      // 模型偶尔会把标签一起写进 entry：剥掉，标签由格式层统一生成
      const parsed = parseEntryLine(`- ${planned.entry}`);
      const body = parsed.parsed ? parsed.body : planned.entry;
      if (body === '') {
        counts.noop += 1;
        continue;
      }
      const asPinned = planned.section === 'pinned' || parsed.pinned;
      const line = formatEntry({
        pinned: asPinned,
        invalid: false,
        start: ctx.today,
        end: null,
        body: `(source: ${ctx.source}) ${body}`,
      }, ctx.today);
      doc.sections[asPinned ? 'pinned' : planned.section].push(line);
      counts.add += 1;
      added.push(body);
      continue;
    }
    if (planned.op === 'UPDATE') {
      const hit = findByTarget(doc, planned.section, planned.target);
      if (hit === null) {
        counts.noop += 1;
        continue;
      }
      const parsedNew = parseEntryLine(`- ${planned.entry}`);
      const body = parsedNew.parsed ? parsedNew.body : planned.entry;
      if (body === '') {
        counts.noop += 1;
        continue;
      }
      doc.sections[planned.section][hit.index] = formatEntry({
        pinned: hit.entry.pinned,
        invalid: false,
        start: hit.entry.start,
        end: hit.entry.end,
        body,
      }, ctx.today);
      counts.update += 1;
      continue;
    }
    // INVALIDATE
    const hit = findByTarget(doc, planned.section, planned.target);
    if (hit === null) {
      counts.noop += 1;
      continue;
    }
    doc.sections[planned.section].splice(hit.index, 1);
    doc.sections.archive.push(formatEntry({
      pinned: false,
      invalid: true,
      start: hit.entry.start,
      end: hit.entry.end,
      body: hit.entry.body,
    }, ctx.today));
    counts.invalidate += 1;
    invalidated.push(hit.entry.body);
  }
  return { ops: counts, added, invalidated };
}

// ──────────────────────────────── 主流程 ────────────────────────────────

function dayOf(date: Date): string {
  // 与 budget/rollover 同口径（real-loop 用 toISOString 的日期段），避免跨时区两套"今天"
  return date.toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）`;
}

/** 待整理的 episode（按日期升序；只认 `YYYY-MM-DD.md`） */
interface EpisodeFile { name: string; date: string; text: string }

function listDueEpisodes(memDir: string, today: string, maxAgeDays: number): EpisodeFile[] {
  const dir = join(memDir, EPISODE_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const due: EpisodeFile[] = [];
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    if (m === null) continue;
    const date = m[1] ?? '';
    const age = dayDiff(date, today);
    if (age === null || age <= maxAgeDays) continue;
    due.push({ name, date, text: readText(join(dir, name)) });
  }
  due.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return due;
}

function emptyOps(): MemoryOps {
  return { add: 0, update: 0, invalidate: 0, noop: 0 };
}

function sumOps(target: MemoryOps, part: MemoryOps): void {
  target.add += part.add;
  target.update += part.update;
  target.invalidate += part.invalidate;
  target.noop += part.noop;
}

/** 异步原子写：同目录 tmp → fsync → rename（与 persona 资产同一套纪律） */
async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 把原件移进 episodes/archive/（同名已存在时加后缀，绝不覆盖既有原件） */
function archiveEpisode(memDir: string, name: string): string {
  const archiveDir = join(memDir, EPISODE_DIR_NAME, EPISODE_ARCHIVE_DIR_NAME);
  mkdirSync(archiveDir, { recursive: true });
  let target = join(archiveDir, name);
  let suffix = 1;
  while (existsSync(target)) {
    const stem = name.replace(/\.md$/, '');
    target = join(archiveDir, `${stem}.${suffix}.md`);
    suffix += 1;
  }
  renameSync(join(memDir, EPISODE_DIR_NAME, name), target);
  return basename(target);
}

/** light 调用的账（lane=light，与 injection-judge 的判定账同口径） */
interface LightAccount {
  log: EventLog | null;
  projection: Projection | null;
  turn: number;
  now: () => Date;
}

function accountLight(
  account: LightAccount,
  response: DsResponse | null,
  model: string,
  durationMs: number,
  finishReason: 'completed' | 'failed',
): void {
  const { log, projection } = account;
  if (log === null || projection === null) return;
  const usage = response?.usage ?? null;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheHitTokens = Math.max(0, Math.min(usage?.cachedTokens ?? 0, inputTokens));
  const event: BudgetConsumed = {
    seq: log.nextSeq(),
    ts: account.now().toISOString(),
    type: 'budget/consumed',
    data: {
      turn: account.turn,
      step: 0,
      lane: 'light',
      model,
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens),
      // 思维链 token：**每次都写**（没产思维链就是 0），见 log/types.ts 的字段注释
      reasoningTokens: usage?.reasoningTokens ?? 0,
      durationMs,
      retryCount: 0,
      finishReason,
      tokensTodayAccum: projection.budget.tokensToday + inputTokens + outputTokens,
    },
    // 观测类：step 边界 flush；本模块在收尾统一 flush
    visibility: 'internal',
    origin: MEMORY_ORIGIN,
  };
  log.append(event, { sync: false });
  applyOne(projection, event);
  finalizePressure(projection, event.ts);
}

/** 一次 light 调用的结果（失败即抛错的包装：调用方决定回退策略） */
async function callLight(
  opts: MaintainMemoryOptions,
  account: LightAccount,
  request: DsRequest,
  counters: { calls: number; tokens: number; failures: number },
): Promise<unknown> {
  const startedAt = account.now().getTime();
  counters.calls += 1;
  try {
    const response = await opts.ds.generate(request);
    counters.tokens += response.usage.inputTokens + response.usage.outputTokens;
    const duration = response.durationMs > 0 ? response.durationMs : Math.max(0, account.now().getTime() - startedAt);
    accountLight(account, response, response.model, duration, 'completed');
    return response;
  } catch (err) {
    counters.failures += 1;
    accountLight(account, null, opts.ds.modelFor('light'), Math.max(0, account.now().getTime() - startedAt), 'failed');
    throw err;
  }
}

/**
 * 每日整理任务的核心逻辑。返回四操作计数与本次实际发生的事情（供调用方写事件/日志/测试断言）。
 * 任何一步失败都不抛给调用方（整理是后台自维护动作，不能因为模型抽风把循环拖崩）：
 * 模型不可用时退化为**确定性合并**（把流水账正文按日期附进观察区），记忆不丢、原件照样归档。
 */
export async function maintainMemory(dataDir: string, opts: MaintainMemoryOptions): Promise<MaintainMemoryResult> {
  const now = opts.now ?? (() => new Date());
  const write = opts.out ?? (() => undefined);
  ensureMemorySeeds(dataDir);
  const memDir = memoriesDir(dataDir);
  const today = dayOf(now());
  const maxAge = opts.episodeMaxAgeDays ?? EPISODE_TTL_DAYS;
  const counters = { calls: 0, tokens: 0, failures: 0 };
  const account: LightAccount = {
    log: opts.log ?? null,
    projection: opts.projection ?? null,
    turn: opts.turn ?? 0,
    now,
  };

  const episodes = listDueEpisodes(memDir, today, maxAge);
  const result: MaintainMemoryResult = {
    ran: false,
    reason: '',
    ops: emptyOps(),
    merged: [],
    archived: [],
    expiredEntries: 0,
    diaryFile: null,
    lightTokens: 0,
    lightCalls: 0,
    modelFailures: 0,
  };

  const factsPath = join(memDir, 'facts.md');
  const doc = parseFacts(readText(factsPath), today);
  const before = renderFacts(doc);

  let summary = '';
  if (episodes.length > 0 || opts.force === true) {
    result.ran = true;
    result.merged = episodes.map(e => e.name);
    const hint = clip(renderFacts(doc), FACTS_HINT_MAX_CHARS);
    const body = clip(
      episodes
        .map(e => `=== episodes/${e.name} ===\n${clip(e.text, EPISODE_MAX_CHARS)}`)
        .join('\n\n'),
      MERGE_INPUT_MAX_CHARS,
    );
    const prompt = `${MERGE_INSTRUCTIONS}\n\n已有记忆（现状，供定位与去重）：\n${hint === '' ? '（空）' : hint}`
      + `\n\n待整理的流水账：\n${body === '' ? '（空）' : body}`;
    const text: DsTextFormat = { type: 'json_schema', name: 'memory_operations', schema: MERGE_SCHEMA };
    let parsedOps: PlannedOp[] = [];
    let modelUsed = false;
    try {
      const response = await callLight(opts, account, {
        lane: 'light',
        input: prompt,
        text,
        // 思考强度：**用户的口径（2026-10-06）—— light 一律 `low`，不提供更改**
        // （另一档 heavy 一律 `high`，唯一落点是 `runtime/agent-loop.ts` 的 `toDsRequest`）。
        // **别给这里加配置项**：config.json 里没有、也不许长出能改它的字段——
        // 判据钉在 `test/thinking-effort-invariant.test.ts`（想加旋钮，那条测试要先红）。
        reasoning: { effort: 'low' },
      }, counters);
      const payload = extractJson(textFromOutputs(response as DsResponse));
      parsedOps = readOps(payload);
      const rawSummary = (payload as Record<string, unknown> | null)?.['summary'];
      summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
      modelUsed = parsedOps.length > 0 || summary !== '';
    } catch (err) {
      write(`[记忆整理] light 合并失败，改用确定性合并：${err instanceof Error ? err.message : String(err)}`);
    }

    if (modelUsed) {
      const source = episodes.length === 0 ? `maintain ${today}` : `episode ${episodes.map(e => e.date).join(',')}`;
      const applied = applyOps(doc, parsedOps, { today, source });
      sumOps(result.ops, applied.ops);
    } else {
      // 回退：不丢内容。原件正文按日期成条落进观察区，等下一次整理再让模型提纯。
      for (const episode of episodes) {
        const bodyText = clip(episode.text.trim(), EPISODE_MAX_CHARS);
        if (bodyText === '') continue;
        doc.sections.observation.push(formatEntry({
          pinned: false, invalid: false, start: episode.date, end: null,
          body: `(source: episode ${episode.date}) ${bodyText.replace(/\n+/g, ' ⏎ ')}`,
        }, today));
        result.ops.add += 1;
      }
    }
  } else {
    result.reason = '没有超过 TTL 的 episode，本次无需合并';
  }

  // ② TTL 修剪（与合并同一次落盘完成）
  const expired = expireByTtl(doc, today);
  result.expiredEntries = expired.length;
  result.ops.invalidate += expired.length;

  // ③ 落盘 facts.md（先落结论，再动原件）
  const after = renderFacts(doc);
  if (after !== before) {
    await writeAtomic(factsPath, after);
  }

  // ④ 原件归档
  for (const episode of episodes) {
    try {
      result.archived.push(archiveEpisode(memDir, episode.name));
    } catch (err) {
      write(`[记忆整理] 归档 ${episode.name} 失败（原件保留在 episodes/，下次重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ⑤ 日记（一次 light 调用；失败走回退正文，日记文件仍产出）
  //    只在真的整理过时才写：没有素材的日记是纯浪费，而"今天已经整理过"不该再花一次 light
  if (result.ran) {
    const diaryText = await writeDiary(dataDir, today, {
      opts, account, counters, summary, episodes, facts: after,
    });
    result.diaryFile = diaryText.file;
  }

  result.lightCalls = counters.calls;
  result.lightTokens = counters.tokens;
  result.modelFailures = counters.failures;
  if (result.reason === '') {
    result.reason = `合并 ${result.merged.length} 份流水账、归档 ${expired.length} 条过期记忆、`
      + `操作 ADD${result.ops.add}/UPDATE${result.ops.update}/INVALIDATE${result.ops.invalidate}/NOOP${result.ops.noop}`;
  }

  // ⑥ 留痕（internal：整理过程不进上下文）
  appendMaintained(opts, {
    date: today,
    ops: result.ops,
    mergedCount: result.merged.length,
    archivedCount: result.archived.length,
    expiredCount: result.expiredEntries,
    diaryFile: result.diaryFile === null ? null : result.diaryFile,
    lightTokens: result.lightTokens,
  });

  return result;
}

function appendMaintained(opts: MaintainMemoryOptions, data: MemoryMaintained['data']): void {
  const log = opts.log ?? null;
  const projection = opts.projection ?? null;
  if (log === null) return;
  const now = opts.now ?? (() => new Date());
  const event: MemoryMaintained = {
    seq: log.nextSeq(),
    ts: now().toISOString(),
    type: 'memory/maintained',
    data,
    visibility: 'internal',
    origin: MEMORY_ORIGIN,
  };
  log.append(event, { sync: true });
  if (projection !== null) applyOne(projection, event);
  log.flush();
}

/** 日记：叙事产出（design §4.17：整理是归档，日记是消化） */
async function writeDiary(
  dataDir: string,
  today: string,
  ctx: {
    opts: MaintainMemoryOptions;
    account: LightAccount;
    counters: { calls: number; tokens: number; failures: number };
    summary: string;
    episodes: readonly EpisodeFile[];
    facts: string;
  },
): Promise<{ file: string | null; text: string }> {
  const dir = diaryDir(dataDir);
  const path = join(dir, `${today}.md`);
  const materialParts: string[] = [];
  if (ctx.summary !== '') materialParts.push(`整理的结论：${ctx.summary}`);
  if (ctx.episodes.length > 0) {
    materialParts.push(...ctx.episodes.map(e => `=== episodes/${e.name} ===\n${clip(e.text, EPISODE_MAX_CHARS)}`));
  }
  if (materialParts.length === 0) materialParts.push(`今天的记忆现状：\n${clip(ctx.facts, FACTS_HINT_MAX_CHARS)}`);
  const material = clip(materialParts.join('\n\n'), MERGE_INPUT_MAX_CHARS);
  const prompt = `${DIARY_INSTRUCTIONS}\n\n今天：${today}\n\n素材：\n${material}`;

  let narrative = '';
  try {
    const response = await callLight(ctx.opts, ctx.account, {
      lane: 'light',
      input: prompt,
      text: { type: 'json_schema', name: 'diary_entry', schema: DIARY_SCHEMA },
      // 思考强度：用户的口径—— light 一律 `low`，不提供更改（判据与上面那次合并同一条：
      // `test/thinking-effort-invariant.test.ts`；两处都写死，不要加配置项）。
      reasoning: { effort: 'low' },
    }, ctx.counters);
    const payload = extractJson(textFromOutputs(response as DsResponse));
    const raw = (payload as Record<string, unknown> | null)?.['diary'];
    narrative = typeof raw === 'string' ? raw.trim() : '';
  } catch (err) {
    (ctx.opts.out ?? (() => undefined))(
      `[记忆整理] 日记 light 调用失败，写回退正文：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (narrative === '') {
    narrative = '（这次整理没有可用的模型通道，先把素材原样落在这里，等下一次整理时再消化。）\n\n'
      + material.split('\n').map(line => `> ${line}`).join('\n');
  }
  const content = `# ${today}\n\n${narrative.trimEnd()}\n`;
  try {
    await writeAtomic(path, content);
    return { file: path, text: content };
  } catch (err) {
    (ctx.opts.out ?? (() => undefined))(
      `[记忆整理] 日记写入失败：${err instanceof Error ? err.message : String(err)}`,
    );
    return { file: null, text: content };
  }
}

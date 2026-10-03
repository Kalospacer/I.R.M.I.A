/**
 * Irmia Agent — 记忆索引与注入（B2：2026-10-04）
 *
 * 与 `docs/memory-injection.md` 逐条对齐。三件事，各管一段：
 *
 *   ① **索引**（`MEMORIES/INDEX.md`）：一份**指针表**——每条只有「相对路径:行号 + 一行摘要 +
 *      有没有 `!pinned`」。正文一个字都不在里面。它是机制生成的（归属写在文件头），
 *      渲染进请求的**长期记忆层**（与技能目录同处，跨轮稳定）。
 *   ② **选材**（`selectMemory`）：一轮选哪几条、为什么不选其余——纯函数，输入只有索引与
 *      本轮唤醒来源，输出写成 `memory/selected` 事件（可重放的地基，见 docs/memory-injection.md §4）。
 *   ③ **正文装配**（`renderSelectedMemory`）：把选中条目对应的**正文**从盘上取出来，
 *      装成"本轮固定块"里的那一段（一轮一次，块内逐字节不变）。
 *
 * 为什么正文只走这两条路（索引 + 本轮固定块）：正文要是进长期记忆层，那就是每轮都在付；
 * 进此刻层，那就是每步都在付（改造前的样子）。按需 read（`safe_read`）落进工具结果，
 * 天然成为历史、天然可缓存；固定块里的那几条是"这一轮确实相关"的最小集合。
 *
 * 归属与边界（硬约束）：
 *   • 本模块**只读**她自己的记忆资产（`facts.md` / `jargon.md` / `style-notes.md` /
 *     `aliases.md` / `episodes/`），一个字节都不改写；
 *   • 唯一写的文件是索引自己（`INDEX.md`），且按内容**幂等**：渲染结果与盘上相同就不写盘
 *     ——"一次重启打掉一次缓存"这种冤枉事不该发生；
 *   • **不引入任何价格 / 货币 / 计费口径**（用户的明确要求）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { estimateTokens } from '../tools/registry.ts';
import { MEMORY_DIR_NAME, parseEntryLine } from './memory-maintain.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 索引文件名（在 `MEMORIES/` 之下）。大写是刻意的：它是**机制生成**的资产，与她自己写的
 * 小写文件（facts.md / jargon.md …）在目录里一眼分得开。 */
export const MEMORY_INDEX_FILE = 'INDEX.md';

/**
 * 一条摘要的字符上限。
 *
 * 为什么这么短：索引待在**常驻层**——它按字符折算 token（中文约 1.5 字/token），
 * 40 字 ≈ 27 token；四十条就是 1100 token 上下的常驻开销。摘要是**钩子**不是正文：
 * 它的用途只是让她判断"要不要去读那一条"，读正文是 `safe_read` 的事。
 */
export const ENTRY_SUMMARY_MAX_CHARS = 40;

/**
 * 索引整体的 token 预算（软上限：按整条取舍，不截半句）。
 *
 * 它约束的是**常驻开销**——索引每轮都在请求里（这是"正文不进上下文"的必要代价，
 * 见 docs/memory-injection.md §7）。超出预算时先砍摘要长度、再按下面的优先级从低往高丢条目，
 * 并在尾部如实写明还有几条没展开。`!pinned` 条目**永不因为超预算被丢**：置顶的语义就是"永远在场"。
 */
export const INDEX_TOKEN_BUDGET = 900;

/**
 * 文件在索引里的出现顺序 = 注入顺序（确定性的一部分：同一份记忆永远印出同一份索引）。
 *
 * facts.md 排第一是刻意的：它是"关于世界与用户的稳定事实"，也是唯一带分区与
 * `!pinned` 标记的文件。其余三份按**用途的紧迫度**排，不按字母序——
 * 黑话（听不懂就会答错）、表达风格（答对了语气不对）、别名（认人）。
 */
const INDEX_FILES = ['facts.md', 'jargon.md', 'style-notes.md', 'aliases.md'] as const;

/**
 * facts.md 的分区优先级（与 `memory-maintain.ts` 的 SECTION_ORDER 同源，但**不含归档区**）。
 *
 * 归档区的语义是"已失效 / 已过期"（`SECTION_TITLES.archive` 写着"不注入"），
 * 所以它一条都不进索引：指针指向一条已经作废的记忆，比不指还糟。
 */
const FACTS_SECTION_TITLES = ['## 置顶（pinned）', '## 约定与承诺', '## 稳定事实', '## 观察'] as const;

// ──────────────────────────────── 类型 ────────────────────────────────

/** 索引里的一条：**指针**（路径 + 行号）+ 一行摘要 + 置顶标记。没有正文。 */
export interface MemoryIndexEntry {
  /** 相对工作根的 posix 路径（如 `MEMORIES/facts.md`）——`safe_read` 的 `path` 参数就用它 */
  path: string;
  /** 条目在文件里的行号（1 起）。**与 `safe_read` 回显的行号同一口径**（它无条件带行号） */
  line: number;
  /** 一行摘要（已截断到 {@link ENTRY_SUMMARY_MAX_CHARS}） */
  summary: string;
  /** `!pinned`：永不衰减、永不归档，心跳轮与超预算时也照样注入 */
  pinned: boolean;
}

/** 一份建好的索引：条目 + 因预算被丢掉的条数（如实报告，不假装齐全） */
export interface MemoryIndex {
  entries: MemoryIndexEntry[];
  /** 预算丢掉的条数（0 = 全都在）。尾部那句"另有 N 条未展开"用它 */
  dropped: number;
}

// ──────────────────────────────── 路径 ────────────────────────────────

/** 索引文件的绝对路径（`<dataDir>/workspace/MEMORIES/INDEX.md`） */
export function memoryIndexPath(dataDir: string): string {
  return join(dataDir, 'workspace', MEMORY_DIR_NAME, MEMORY_INDEX_FILE);
}

// ──────────────────────────────── 建索引 ────────────────────────────────

/**
 * 扫描记忆文件，建一份确定性的索引。
 *
 * 确定性来自三处（同一份记忆任何时刻建出同一份索引）：
 *   • 文件顺序固定（{@link INDEX_FILES}，facts.md 的分区顺序固定）；
 *   • 文件内按**行号升序**（时间序即文件序，persona.md §3）；
 *   • 摘要只做"取第一行 + 截断"，不做任何归纳。
 *
 * 读不到的单个文件按"没有"处理（她还没写过 jargon.md 是正常状态），不抛异常——
 * 索引是**尽力而为的目录**，不是校验器。
 */
export function buildMemoryIndex(dataDir: string): MemoryIndex {
  const memDir = join(dataDir, 'workspace', MEMORY_DIR_NAME);
  const entries: MemoryIndexEntry[] = [];
  for (const name of INDEX_FILES) {
    const text = readTextIfPresent(join(memDir, name));
    if (text === null) continue;
    const path = `${MEMORY_DIR_NAME}/${name}`;
    if (name === 'facts.md') entries.push(...factsEntries(text, path));
    else entries.push(...looseEntries(text, path));
  }

  // 预算：先按优先级（pinned 在前、其余按原序）算总 token，超了就**从后往前**丢非 pinned 条目。
  // 为什么从后往前：索引的顺序本身就是优先级（分区优先级 + 时间序），尾部是最不该先看的那些。
  const kept = [...entries];
  let dropped = 0;
  while (kept.length > 0 && estimateTokens(renderIndexEntries(kept, 0).text) > INDEX_TOKEN_BUDGET) {
    let victim = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i]?.pinned !== true) { victim = i; break; }
    }
    // 只剩 pinned 条目还超预算：摘要已经短到不能再短，只能照实印（置顶不许被丢）
    if (victim === -1) break;
    kept.splice(victim, 1);
    dropped += 1;
  }
  return { entries: kept, dropped };
}

/**
 * facts.md 的条目：跳过归档区，按分区优先级 + 行号升序。
 *
 * 行号是**原文件的行号**（`safe_read` 回显的就是它）：分区标题、空行、说明行都计数，
 * 所以指针指过去读到的就是那一条，不会差一行。
 */
function factsEntries(text: string, path: string): MemoryIndexEntry[] {
  const lines = text.split(/\r?\n/u);
  const out: MemoryIndexEntry[] = [];
  let sectionIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const title = FACTS_SECTION_TITLES.findIndex((t) => line.trim() === t);
    if (title !== -1) { sectionIndex = title; continue; }
    // 走到归档区（或任何别的 `##` 区）就停止收集：它后面的一切都不进索引
    if (/^##\s/u.test(line)) { sectionIndex = -1; continue; }
    if (sectionIndex === -1) continue;
    if (!/^-\s+/u.test(line)) continue;
    const entry = parseEntryLine(line);
    const summary = summaryOf(entry.body);
    if (summary === '') continue;
    out.push({ path, line: i + 1, summary, pinned: entry.pinned });
  }
  return out;
}

/**
 * 其余记忆文件（jargon / style-notes / aliases）的条目：**自由格式**，一行一条。
 *
 * 它们由她自己维护，没有 facts.md 那套行内标签——所以判据只有"非空、不是标题、不是说明行"。
 * 标题与括号开头的行是给人看的说明（种子模板里那些），当条目列出只会是噪音。
 */
function looseEntries(text: string, path: string): MemoryIndexEntry[] {
  const out: MemoryIndexEntry[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '' || raw.startsWith('#') || raw.startsWith('（') || raw.startsWith('(')) continue;
    const body = raw.replace(/^[-*]\s+/u, '');
    const summary = summaryOf(body);
    if (summary === '') continue;
    out.push({ path, line: i + 1, summary, pinned: false });
  }
  return out;
}

/**
 * 一行摘要：取正文第一行、剥掉 `(source: …)` 归属前缀、截断到字符上限。
 *
 * 为什么剥 source：那一行里 `(source: turn 123)` 占掉一半位置却没有检索价值
 * （索引已经在同一行给了路径与行号，溯源到哪一条是读正文时的事）。
 */
function summaryOf(body: string): string {
  const firstLine = body.split(/\r?\n/u)[0] ?? '';
  const withoutSource = firstLine.replace(/^\(source:[^)]*\)\s*/u, '').trim();
  if (withoutSource === '') return '';
  return withoutSource.length <= ENTRY_SUMMARY_MAX_CHARS
    ? withoutSource
    : `${withoutSource.slice(0, ENTRY_SUMMARY_MAX_CHARS)}…`;
}

// ──────────────────────────────── 渲染索引 ────────────────────────────────

/** 索引文件头（**归属声明**：这是机制生成的，不是她写的；也说明怎么用） */
const INDEX_HEADER = `# 记忆索引（机制生成，不是你的笔记）

下面每一条都是**指针**：指向你自己那份记忆里的某一行。正文不在这个文件里、也不在你的上下文里
——要看哪一条就 \`safe_read\` 那条路径，行号是现成的；读回来的内容会留在你这一轮的历史里。
这个文件每次记忆文件变化后由机制重建，**不要手改**（手改会被覆盖）。`;

/** 渲染"- `路径:行号` [!pinned] 摘要"这一种条目行 */
function entryLines(entries: readonly MemoryIndexEntry[]): string[] {
  return entries.map((e) =>
    `- \`${e.path}:${e.line}\`${e.pinned ? ' **!pinned**' : ''} ${e.summary}`);
}

/** 条目 → 文本 + token（预算判定与渲染共用，避免两处口径漂移） */
function renderIndexEntries(entries: readonly MemoryIndexEntry[], dropped: number): { text: string; tokens: number } {
  const body = entryLines(entries).join('\n');
  const tail = dropped > 0 ? `\n（另有 ${dropped} 条未展开：索引超长，按优先级截到这里。）` : '';
  const text = `${INDEX_HEADER}\n\n${body}${tail}`;
  return { text, tokens: estimateTokens(text) };
}

/**
 * 索引 → 可直接注入的文本（含文件头）。`null`/缺省表示**没有索引**，
 * 调用方（real-loop）据此让长期记忆层那一段整体不出现。
 */
export function renderMemoryIndex(index: MemoryIndex): string {
  return renderIndexEntries(index.entries, index.dropped).text;
}

// ──────────────────────────────── 落盘（幂等） ────────────────────────────────

/**
 * 保证 `MEMORIES/INDEX.md` 与记忆文件一致。**幂等**：渲染结果与盘上逐字节相同就不写盘。
 *
 * 为什么幂等是硬要求：索引待在**常驻前缀**里（长期记忆层）。每次启动无条件重写一次，
 * 就等于每次重启把整段前缀打掉一次——而重启本身并不改变任何一条记忆。
 *
 * 返回动作，供启动摘要与测试断言（'created' | 'updated' | 'unchanged'）。
 */
export function ensureMemoryIndex(dataDir: string): 'created' | 'updated' | 'unchanged' {
  const path = memoryIndexPath(dataDir);
  const text = renderMemoryIndex(buildMemoryIndex(dataDir));
  const current = readTextIfPresent(path);
  if (current === text) return 'unchanged';
  mkdirSync(join(dataDir, 'workspace', MEMORY_DIR_NAME), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return current === null ? 'created' : 'updated';
}

/**
 * 读回索引文本（注入用）。文件不在就**当场建一份**再读——首启漏了那一步时，
 * 她也不该活在一个"记忆没有目录"的世界里。
 *
 * 这是**运行期**那条路（real-loop 每轮走它）。重放与诊断走下面那条只读的：
 * 重建请求时绝不能写盘（那是副作用，"只读重建"是本仓库对 replay 的承诺）。
 */
export function readMemoryIndexText(dataDir: string): string {
  const path = memoryIndexPath(dataDir);
  if (!existsSync(path)) ensureMemoryIndex(dataDir);
  return readTextIfPresent(path) ?? '';
}

/**
 * 只读地读回索引文本（重放与诊断用）：文件不在就返回空串，**绝不创建**。
 *
 * 为什么单独一条：`buildReplayReport` 的前提是"日志已关、只读重建"。
 * 在那里顺手补建索引文件，等于让一次复盘改了盘上的东西——而且会把重建结果污染成
 * "有索引"（当时的请求里可能根本没有它）。
 */
export function readMemoryIndexTextReadOnly(dataDir: string): string {
  return readTextIfPresent(memoryIndexPath(dataDir)) ?? '';
}

// ──────────────────────────────── 选材 ────────────────────────────────

/** 一条没有被选中的原因（事后读日志的人要能回答"为什么这一轮她没看见某一条"） */
export type MemorySkipReason =
  /** 心跳轮：没有人在跟她说话，记忆正文不注入（docs/memory-injection.md §5） */
  | 'heartbeat'
  /** 非置顶条目，且本轮的条数上限已经用满 */
  | 'not-needed';

/** 选材结论：选了哪些、为什么不选其余 */
export interface MemorySelection {
  selected: MemoryIndexEntry[];
  /** 未被选中的条数（按原因归类，只记数——逐条记会让事件膨胀成索引的副本） */
  skipped: { heartbeat: number; notNeeded: number };
}

/**
 * 一轮最多注入几条正文。
 *
 * 为什么是小数字：注入的是**整条正文**（facts.md 的条目可以很长），而"相关"是她的判断不是机制的
 * 判断。机制只保证"置顶的一定在、其余按上面的顺序给最近看到的几条"，要更多她自己 `safe_read`
 * ——这条路一直在（索引就在她眼前）。
 */
export const MAX_SELECTED_ENTRIES = 8;

/**
 * 选材（纯函数）：索引 + 本轮唤醒类型 → 选哪几条。
 *
 * 判据全部是**可复算的**（这条比数字本身更要紧，见 docs/memory-injection.md §7 第 5 条）：
 *   • `!pinned` 必选——置顶的语义就是"永远在场"；
 *   • **心跳轮一条都不选**——没人在跟她说话，没有谁的上下文需要对齐；她要看就 `safe_read`；
 *   • 其余按索引顺序补足到 {@link MAX_SELECTED_ENTRIES}：置顶在前、然后是她自己在文件里
 *     排在前面的那些（文件序 = 时间序，persona.md §3）。
 *
 * 不做的事：不调模型判相关性、不看正文内容、不按会话去猜。加一层模型判断会把
 * "同一份日志重建同一份请求"这条地基挖掉。
 */
export function selectMemory(index: MemoryIndex, options: { heartbeatTurn: boolean }): MemorySelection {
  const pinned = index.entries.filter((e) => e.pinned);
  const rest = index.entries.filter((e) => !e.pinned);
  if (options.heartbeatTurn) {
    return { selected: [], skipped: { heartbeat: index.entries.length, notNeeded: 0 } };
  }
  const room = Math.max(0, MAX_SELECTED_ENTRIES - pinned.length);
  const selected = [...pinned, ...rest.slice(0, room)];
  return {
    selected,
    skipped: { heartbeat: 0, notNeeded: index.entries.length - selected.length },
  };
}

// ──────────────────────────────── 正文装配（本轮固定块） ────────────────────────────────

/** 一段被取出来的正文：哪一条、从哪一行开始、内容是什么 */
export interface MemoryExcerpt {
  path: string;
  line: number;
  pinned: boolean;
  text: string;
}

/**
 * 单条正文的字符上限。超了就截断并**如实写明**——悄悄截断会让她以为自己看完了。
 *
 * 与索引的短摘要是一对：摘要是钩子（40 字），这一段是"本轮真的要用"的正文（上限放宽）。
 */
export const EXCERPT_MAX_CHARS = 1200;

/**
 * 取出一条记忆的正文：从它那一行开始，**往上不取、往下取到下一个条目/分区为止**
 * （facts.md 的条目可以折行，折行属于同一条）。
 *
 * 找不到那一条（文件被删、行号漂了）时返回 null：调用方**跳过它**而不是印一句
 * "内容缺失"——索引与文件之间的漂移不该变成她上下文里的一段噪音。
 */
export function readExcerpt(dataDir: string, entry: MemoryIndexEntry): MemoryExcerpt | null {
  const rel = entry.path.startsWith(`${MEMORY_DIR_NAME}/`) ? entry.path.slice(MEMORY_DIR_NAME.length + 1) : entry.path;
  const abs = join(dataDir, 'workspace', MEMORY_DIR_NAME, rel);
  const text = readTextIfPresent(abs);
  if (text === null) return null;
  const lines = text.split(/\r?\n/u);
  const start = entry.line - 1;
  if (start < 0 || start >= lines.length) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isNextEntry = i > start && (/^-\s+/u.test(line) || /^#{1,6}\s/u.test(line) || /^##\s/u.test(line));
    if (isNextEntry) break;
    out.push(line);
    if (out.join('\n').length >= EXCERPT_MAX_CHARS) break;
  }
  const body = out.join('\n').trim();
  if (body === '') return null;
  const clipped = body.length <= EXCERPT_MAX_CHARS
    ? body
    : `${body.slice(0, EXCERPT_MAX_CHARS)}\n…（这一条还没完：用 safe_read 读 ${entry.path} 第 ${entry.line} 行起）`;
  return { path: entry.path, line: entry.line, pinned: entry.pinned, text: clipped };
}

/**
 * 选中的条目 → 本轮固定块里那一段文本（**带行号**，与 `safe_read` 同一口径）。
 *
 * 为什么带行号：她读到一段之后想改（`safe_edit` 的行号寻址）或接着往下读，
 * 手里得有地址。行号是免费的——`safe_read` 回显时也带它。
 *
 * 空选中（心跳轮、或索引为空）→ 返回空串：固定块里那一段整体不出现，**不写空段**。
 */
export function renderSelectedMemory(excerpts: readonly MemoryExcerpt[]): string {
  if (excerpts.length === 0) return '';
  const blocks = excerpts.map((e) => {
    const numbered = e.text.split('\n').map((line, i) => `${e.line + i}| ${line}`).join('\n');
    return `## ${e.path}:${e.line}${e.pinned ? '（!pinned）' : ''}\n${numbered}`;
  });
  return [
    '## 本轮选中的记忆（正文）',
    '（以下是索引里挑出来的几条正文，只供这一轮参考；要看别的按索引里的路径 safe_read。）',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/** 读文本；不存在 / 读不到 → null（记忆文件缺失是正常状态，不是错误） */
function readTextIfPresent(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Irmia Agent — 请求重放（M6-5、docs/operations.md §6 的 `replay <turn> <step>` 行）
 *
 * 把「某一次模型调用当时看到了什么」从日志里重建出来。可重建性是这套设计的地基
 * （schema §13：模型请求的全部内容可由 model 事件 + 人格资产版本重建），
 * 本模块是它的可执行形态——它**不重放副作用**，只重建请求体。
 *
 * 重建口径与运行期严格同源，三条都要对上，少一条就不是"当时那个请求"：
 *   ① 事件集 = `seq < step/start.seq` 的全部日志事件（agent-loop 的 syncEvents 在写
 *      step/start **之前**对齐日志，所以步内事件不在其中）；
 *   ② `wakeEvent` = 该 turn 认领的首条输入，仅第 1 步走参数通道；它同时必须从事件流里
 *      剔除，否则同一输入渲染两次（agent-loop 文件头的协同契约）；
 *   ③ 任务卡 = 认领首条输入的渲染摘要（裁剪口径来自 render.clipTaskTitle）+ 该步时点的
 *      未完成清单（对 `eventsBefore` 折叠得到，不是对当前投影）。
 *
 * 有意不重建的部分（如实报告，不假装齐全）：
 *   - **软阈值提示**（budget-guard 的 softHint）：它按设计不落库（KV 前缀的尾部插播），
 *     日志里没有它的任何痕迹，因此重建出的请求体不含它，字节对比时会恰好差这一条；
 *   - **工具清单**：日志只记 `developer/message` 的名字增减，不记定义。重建用当前装配的
 *     工具集（tools/catalog.ts）并给出摘要哈希，供人判断"是否同一份清单"。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppEvent, MemorySelected, ModelLane } from '../log/types.js';
import type { InputItem, RenderPersona, RenderedRequest } from '../model/render.js';
import { NOW_LAYER_BANNER, RENDER_VERSION, clipTaskTitle, inputContentText, wakeTitle } from '../model/render.ts';
import type { ContactFacts } from '../model/self-brief.ts';
import { collectSessions, parseAliases } from '../channel/sessions.ts';
import { CONFIG_FILE_NAME, loadConfig, systemTimezone } from '../config/config.ts';
import { readEventsReadOnly } from '../log/read-only.ts';
import { loadPersona } from '../persona/loader.ts';
import { readExcerpt, readMemoryIndexTextReadOnly, renderSelectedMemory, type MemoryExcerpt } from '../persona/memory-injection.ts';
import { relationshipForWake } from '../persona/relationship.ts';
import { catalogToolSpecs } from '../tools/catalog.ts';
import { sha256Hex } from '../persona/versions.ts';
import { fold } from '../state/fold.ts';
import { deriveRequest } from './agent-loop.ts';
import { isSlashCommandEvent } from './slash-commands.ts';
import { EVENT_LOG_DIR_NAME } from './recover.ts';

// ──────────────────────────────── 定位 ────────────────────────────────

export interface TaskCardSnapshot {
  title: string;
  turn: number;
  step: number;
  todoOpen: string[];
}

export interface ReplayPosition {
  turn: number;
  step: number;
  /** 该次调用的 step/start 事件（三指纹：renderVersion / personaHash / model+lane 都在它身上） */
  stepStart: AppEvent & { type: 'step/start' };
  /** render 的事件流：seq < step/start.seq 的全部事件，按 seq 升序 */
  eventsBefore: AppEvent[];
  /** 本步的新输入（仅第 1 步非 null）；已从 eventsBefore 里剔除 */
  wakeEvent: AppEvent | null;
  /** 该 turn 认领的全部输入 seq（批内首条即任务卡标题来源） */
  claimedWakeSeqs: number[];
  taskCard: TaskCardSnapshot;
  /** 遮蔽点：被 compaction/summary 覆盖的最大 seq（0 表示没有摘要） */
  coveredUpToSeq: number;
}

export type LocateStepResult =
  | ({ ok: true } & ReplayPosition)
  | { ok: false; reason: string };

/** 找 `(turn, step)` 对应的 step/start；事件流假定已按 seq 升序 */
export function locateStep(events: readonly AppEvent[], turn: number, step: number): LocateStepResult {
  const stepStart = events.find(
    (event): event is AppEvent & { type: 'step/start' } =>
      event.type === 'step/start' && event.data.turn === turn && event.data.step === step,
  );
  if (stepStart === undefined) {
    const steps = events
      .filter((event) => event.type === 'step/start' && event.data.turn === turn)
      .map((event) => (event.type === 'step/start' ? event.data.step : 0));
    const hint = steps.length > 0
      ? `turn ${turn} 已记录的 step：${steps.join('、')}`
      : `日志里没有 turn ${turn} 的任何 step/start`;
    return { ok: false, reason: `找不到 turn ${turn} step ${step} 的 step/start（${hint}）` };
  }

  // 归属过滤（design §4.21）：重建「这一次调用当时看到了什么」，就必须用与运行期同一份可见性——
  // 顶层 turn 的上下文里没有子代理链的事件（那是另一条 turn 链），子代理也看不见父历史
  // （它从空事件序列起）。少这一刀，重建结果会多出一批当时根本没进上下文的事件。
  //
  // 第二刀与运行期**同源**（`real-loop.ts` 的 `contextEventFilter`）：整条就是一条指令的
  // `wake/manual` 也不在她的上下文里（B1 第二步）。判据引的是同一个 `isSlashCommandEvent`，
  // 两处各写一遍迟早会漂移成"重建出来的请求比当时多一条消息"。
  const scope = stepStart.parentCallId;
  const eventsBefore = events.filter(
    (event) => event.seq < stepStart.seq
      && event.parentCallId === scope
      && !isSlashCommandEvent(event),
  );

  // 该 turn 的认领：取**第一笔**。一个 turn 可以分批认领（开头一笔 + 中途被她看见的插话各一笔，
  // 见 agent-loop 的 claimInterruption），而这里要的"本轮新输入"始终是开头那一笔；
  // 取最后一笔会把打断她的那条消息当成这一轮的任务卡标题（运行期用的是开头那条，重放就会对不上）。
  let claimedWakeSeqs: number[] = [];
  for (const event of eventsBefore) {
    if (event.type === 'input/claimed' && event.data.turn === turn) {
      claimedWakeSeqs = [...event.data.wakeSeqs];
      break;
    }
  }

  const firstWakeSeq = claimedWakeSeqs[0];
  const firstWake = firstWakeSeq === undefined
    ? null
    : eventsBefore.find((event) => event.seq === firstWakeSeq) ?? null;
  // 第 1 步之外的 step 没有"本轮新输入"：它与首步看到的是同一份历史（只多了自己产生的工具结果）
  const wakeEvent = step === 1 ? firstWake : null;

  const projection = fold(eventsBefore);
  const payloads = timerPayloadsOf(eventsBefore);
  // 标题口径必须与运行期逐字节一致（agent-loop 的 taskCard 用的是 wakeTitle，不是 renderWake）
  const title = firstWake === null ? '' : clipTaskTitle(wakeTitle(firstWake, payloads));

  let coveredUpToSeq = 0;
  for (const event of eventsBefore) {
    if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > coveredUpToSeq) {
      coveredUpToSeq = event.data.coveredUpToSeq;
    }
  }

  return {
    ok: true,
    turn,
    step,
    stepStart,
    eventsBefore,
    wakeEvent,
    claimedWakeSeqs,
    taskCard: {
      title,
      turn,
      step,
      todoOpen: projection.todoList.filter((item) => item.status !== 'completed').map((item) => item.content),
    },
    coveredUpToSeq,
  };
}

/** timerId → 最近一条 timer/set 的 payload（与 render 内部同口径：wake/timer 自身不带 payload） */
function timerPayloadsOf(events: readonly AppEvent[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === 'timer/set') map.set(event.data.timerId, event.data.payload);
    if (event.type === 'timer/cancelled') map.delete(event.data.timerId);
  }
  return map;
}

/**
 * 重建那一轮的**联络事实**（此刻层的「通道：/会话：/点名：」三项全靠它）。
 *
 * 为什么要补（2026-10-02 发现）：`rebuildRenderedRequest` 原来根本不传 `contact`，
 * 于是重放出来的此刻层少了那三项——与**当时真正发出去的请求不一致**，而"replay 必须能
 * 重建同一份请求"是本仓库的硬纪律（否则复盘的结论不算数）。
 *
 * 三样东西的来源，按能不能回到当时分：
 *   • **会话簿**：从这一刻之前的事件折（`collectSessions`）——它本来就是日志的投影，
 *     所以是**当时**的样子（比运行期那份内存副本更忠实）；
 *   • **话题**：从这一刻之前的 `channel/topic` 事件取（每个会话留最近一条）；
 *   • **唤醒的那条消息**：就是本 turn 认领的那条 `wake/channel`（`position.wakeEvent`），
 *     `mentionsMe` 也照原样带着——点名那一句正是靠它判的；
 *   • **联系人与别名**：只能拿"现在这份"（它们不在事件里），由调用方从盘上读进来。
 */
function rebuildContact(position: ReplayPosition, options: RebuildOptions): ContactFacts | null {
  const gate = options.contact;
  if (gate === undefined) return null;
  return contactFactsForReplay({
    events: position.eventsBefore,
    wakeEvent: position.wakeEvent,
    qqOfficial: gate.qqOfficial,
    onebot: gate.onebot,
    alertWebhook: gate.alertWebhook,
    ...(gate.contacts === undefined ? {} : { contacts: gate.contacts }),
    ...(gate.aliases === undefined ? {} : { aliases: gate.aliases }),
  });
}

/**
 * 重建某一刻的**联络事实**（此刻层的「通道：/会话：/点名：」三项全靠它）——CLI 与 web 两条
 * 重放路径**共用这一份**（2026-10-02：web 那条原来自己手拼渲染输入，连「会话：」「点名：」
 * 都没有；两条重放路径各拼一份，正是"重建结果不一致"的温床）。
 *
 * 三样东西的来源，按能不能回到当时分：
 *   • **会话簿**：从这一刻之前的事件折（`collectSessions`）——它本来就是日志的投影，
 *     所以是**当时**的样子（比运行期那份内存副本更忠实）；
 *   • **话题**：从这一刻之前的 `channel/topic` 事件取（每个会话留最近一条）；
 *   • **唤醒的那条消息**：就是本 turn 认领的那条 `wake/channel`，`mentionsMe` 照原样带着
 *     ——点名那一句正是靠它判的；
 *   • **联系人与别名**：只能拿"现在这份"（它们不在事件里），由调用方从盘上读进来。
 */
export function contactFactsForReplay(input: {
  events: readonly AppEvent[];
  wakeEvent: AppEvent | null;
  qqOfficial: boolean;
  onebot: boolean;
  alertWebhook: boolean;
  contacts?: ReadonlyMap<string, string>;
  aliases?: ReadonlyMap<string, string>;
}): ContactFacts {
  const sessions = collectSessions(input.events);
  const topics = new Map<string, string>();
  for (const event of input.events) {
    if (event.type === 'channel/topic' && event.data.topic.trim() !== '') {
      topics.set(event.data.sid, event.data.topic);
    }
  }

  const wake = input.wakeEvent;
  const wakeMessage = wake !== null && wake.type === 'wake/channel'
    ? {
      channel: wake.data.channel,
      chatType: wake.data.chatType,
      chatId: wake.data.chatId,
      person: wake.data.person,
      ...(wake.data.mentionsMe === true ? { mentionsMe: true } : {}),
    }
    : null;

  return {
    qqOfficial: input.qqOfficial,
    onebot: input.onebot,
    alertWebhook: input.alertWebhook,
    // 唤醒来源那一项与联络段里"这次是哪扇门"有关：有通道唤醒就带上它
    wakeChannel: wakeMessage === null ? null : { channel: wakeMessage.channel, chatType: wakeMessage.chatType },
    sessions,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    ...(input.contacts === undefined ? {} : { contacts: input.contacts }),
    wakeMessage,
    topics,
  };
}

/** `MEMORIES/aliases.md` 里的别名（重建用；读不到就是空表——她还没认过人） */
function readAliasesForReplay(dataDir: string): ReadonlyMap<string, string> {
  try {
    return parseAliases(readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8'));
  } catch {
    return new Map();
  }
}

// ──────────────────────────────── 重建 ────────────────────────────────

export interface RebuildOptions {
  persona: RenderPersona & { personaHash: string };
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  timezone: string;
  /** 时间上下文的覆盖点（--diff 的右侧渲染用当前时刻；缺省取 step/start.ts） */
  now?: string;
  /**
   * 联络事实里**只能从盘上拿**的那几样（会话簿与话题是从事件折的，见下面 rebuildContact）。
   *
   * 与人格资产同一口径：联系人与别名是"现在这份"，不是当时的快照——它们不在事件里，
   * 没法自动回到那一刻。所以报告的 notes 里要**明说**这一点（design §4.13 的重建纪律：
   * 重建不出来的东西必须自己承认，不许假装重建过）。
   */
  contact?: {
    qqOfficial: boolean;
    onebot: boolean;
    alertWebhook: boolean;
    contacts?: ReadonlyMap<string, string>;
    aliases?: ReadonlyMap<string, string>;
  };
  /**
   * 数据目录（v29/B2）：重建"本轮固定块"里那段**选中的记忆正文**时要从盘上按 `path:line` 现取。
   *
   * 不给 = 那一段不出现（与"当时没有选材事件"同一条路径）。给了它，正文与运行期同源：
   * 都是从她自己的记忆文件里、那一条所在的行读出来的。
   */
  dataDir?: string;
  /**
   * 记忆索引文本（长期记忆层那一段）。与人格资产同一条限制：它是**文件**，
   * 重建时读到的是现在这份。不给 = 那一段不出现。
   */
  memoryIndex?: string | null;
}

/**
 * 重建请求体。走 `deriveRequest`（与运行期同一个函数）而不是另写一份拼装逻辑：
 * 复制一份拼装代码，等于给"重建结果与当时一致"这个承诺留了一个必然漂移的副本。
 *
 * `now` 取 `step/start.ts`，`model`/`lane` 取该事件，二者都是运行期写进去的原值。
 */
export function rebuildRenderedRequest(
  position: ReplayPosition,
  options: RebuildOptions,
  nowOverride?: string,
): RenderedRequest {
  const events = position.wakeEvent === null
    ? [...position.eventsBefore]
    : position.eventsBefore.filter((event) => event.seq !== position.wakeEvent!.seq);

  return deriveRequest({
    persona: {
      identity: options.persona.identity,
      constitution: options.persona.constitution,
      style: options.persona.style,
      state: options.persona.state,
      personaHash: options.persona.personaHash,
      relationship: options.persona.relationship ?? null,
    },
    tools: options.tools,
    timezone: options.timezone,
    contact: rebuildContact(position, options),
    lane: position.stepStart.data.lane,
    events,
    wakeEvent: position.wakeEvent,
    taskCard: position.taskCard,
    now: nowOverride ?? options.now ?? position.stepStart.ts,
    model: position.stepStart.data.model,
    // **本轮固定块**（v29/B2）：与运行期同一形状——`[当前状态]` + 关系档案 + 本轮选中的记忆正文。
    // 前两样取**当前**人格资产（与 instructions 的重建口径一致：日志只留聚合哈希，
    // 逐文件历史不可解，所以"人格层的重建"本就是现在这份）；
    // 第三样取自 `memory/selected` 事件——那是"当时选了哪几条"的唯一记录。
    turnBlock: {
      state: options.persona.state,
      relationship: options.persona.relationship ?? null,
      memory: selectedMemoryTextOf(position, options),
    },
    // 记忆索引（长期记忆层那一段）：与人格资产同一条限制——它是个**文件**，重建读到的是现在这份。
    // 走只读那条路（readMemoryIndexTextReadOnly）：重建不能创建文件，"只读重建"是这个模块的承诺。
    memoryIndex: options.memoryIndex ?? null,
    // 软提示不落库（见文件头）：这里只能是 null，并在报告里明说
    softHint: null,
  });
}

/**
 * 本轮的固定块里那一段"选中的记忆正文"。
 *
 * 选**哪几条**：只认 `memory/selected` 事件——这是可重放的地基（docs/memory-injection.md §4）：
 * "这一轮选了哪几条"如果是运行期临时算的，事后重建就得重算一遍，而重算要看**现在**的索引文件
 * （她随时可能改自己的记忆），重建结果与当时就对不上了。
 *
 * 正文从盘上按 `path:line` 现取：与运行期同一份素材（同一条纪律——正文永远在文件里，
 * 上下文里只有指针）。取不到那一条（文件被改、行号漂了）就跳过，不臆造内容。
 */
function selectedMemoryTextOf(position: ReplayPosition, options: RebuildOptions): string | null {
  if (options.dataDir === undefined) return null;
  const selection = lastMemorySelection(position);
  if (selection === null) return null;
  const excerpts: MemoryExcerpt[] = [];
  for (const entry of selection.selected) {
    const excerpt = readExcerpt(options.dataDir, {
      path: entry.path,
      line: entry.line,
      summary: entry.summary,
      pinned: entry.pinned,
    });
    if (excerpt !== null) excerpts.push(excerpt);
  }
  const text = renderSelectedMemory(excerpts);
  return text === '' ? null : text;
}

/**
 * 取该 turn 的选材结论（**最后一条** `memory/selected`）；没有就是 null（那一轮没注入记忆）。
 *
 * 选材事件在**轮首**写下，所以正常情形下它落在 `eventsBefore` 里（seq 小于该 turn 的每个
 * step/start）。取"最后一条"与运行期的读取口径一致：崩溃后重投同一个 turn 时可能再写一条，
 * 两条里最后那条才是这一轮实际用的。
 */
export function lastMemorySelection(position: ReplayPosition): MemorySelected['data'] | null {
  let found: MemorySelected['data'] | null = null;
  for (const event of position.eventsBefore) {
    if (event.type === 'memory/selected' && event.data.turn === position.turn) {
      found = event.data as MemorySelected['data'];
    }
  }
  return found;
}

// ──────────────────────────────── 并排对照 ────────────────────────────────

export interface RequestDiff {
  identical: boolean;
  instructionsChanged: boolean;
  inputCounts: { left: number; right: number };
  /** 第一处不同的位置（逐项比较 input，按 render 的装配顺序） */
  firstDifference: { index: number; left: string | null; right: string | null } | null;
  changedItems: number;
  tools: { onlyLeft: string[]; onlyRight: string[]; changed: string[] };
  bytes: { left: number; right: number };
}

/** 逐项对照两份请求体：左 = 当时重建，右 = 当前口径（renderVersion / personaHash / 工具清单） */
export function diffRenderedRequests(left: RenderedRequest, right: RenderedRequest): RequestDiff {
  const changed = new Set<number>();
  const max = Math.max(left.input.length, right.input.length);
  let first: RequestDiff['firstDifference'] = null;
  for (let index = 0; index < max; index++) {
    const a = left.input[index];
    const b = right.input[index];
    if (sameItem(a, b)) continue;
    changed.add(index);
    if (first === null) {
      first = { index, left: a === undefined ? null : describeItem(a), right: b === undefined ? null : describeItem(b) };
    }
  }

  const leftTools = new Map(left.tools.map((tool) => [tool.name, tool]));
  const rightTools = new Map(right.tools.map((tool) => [tool.name, tool]));
  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  const changedTools: string[] = [];
  for (const [name, tool] of leftTools) {
    const other = rightTools.get(name);
    if (other === undefined) onlyLeft.push(name);
    else if (JSON.stringify(tool) !== JSON.stringify(other)) changedTools.push(name);
  }
  for (const name of rightTools.keys()) if (!leftTools.has(name)) onlyRight.push(name);

  return {
    identical: changed.size === 0
      && left.instructions === right.instructions
      && onlyLeft.length === 0 && onlyRight.length === 0 && changedTools.length === 0
      && left.model === right.model,
    instructionsChanged: left.instructions !== right.instructions,
    inputCounts: { left: left.input.length, right: right.input.length },
    firstDifference: first,
    changedItems: changed.size,
    tools: { onlyLeft, onlyRight, changed: changedTools },
    bytes: { left: jsonBytes(left), right: jsonBytes(right) },
  };
}

function sameItem(a: InputItem | undefined, b: InputItem | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 单条 input item 的单行描述：只给类型与首行摘要，避免把整段历史打到终端 */
function describeItem(item: InputItem): string {
  switch (item.type) {
    case 'message': {
      const text = inputContentText(item.content);
      // v23 起此刻层以**固定段头**两行开头（51 + 53 字的分隔线与归属说明）。它对诊断没有信息量，
      // 却会把 60 字的预览位占满——终端上于是只剩一串破折号，看不出这是哪一拍的此刻层。
      // 所以预览时剥掉段头，从第一个字段（`时刻：…`）说起。
      const body = text.startsWith(NOW_LAYER_BANNER) ? text.slice(NOW_LAYER_BANNER.length).trimStart() : text;
      const head = body.replace(/\s+/gu, ' ').slice(0, 60);
      return `message[${item.role}] ${head}${body.length > 60 ? '…' : ''}`;
    }
    case 'function_call': return `function_call ${item.name}(${item.call_id})`;
    case 'function_call_output': return `function_call_output ${item.call_id}（${item.output.length} 字符）`;
    // 思维链以 reasoning item 回传（render v3）：终端里只报字数，不进内容
    case 'reasoning': {
      const chars = item.content.reduce((sum, part) => sum + part.text.length, 0);
      return `reasoning（${chars} 字符）`;
    }
  }
}

/**
 * 请求体字节数：与发送前序列化同一口径（JSON UTF-8），缓存命中按前缀字节判定。
 *
 * 只数**发往模型的那四个键**（model / instructions / input / tools）：`RenderedRequest` 上
 * 还有 2026-10-03 加的 `context`（渲染副产物，见 model/context-audit.ts），而
 * `agent-loop` 的 `toDsRequest` 显式装配时并不会把它发出去——把它算进"请求体字节"，
 * 这个数就不再是缓存前缀的那个数了。
 */
export function jsonBytes(request: RenderedRequest): number {
  return Buffer.byteLength(JSON.stringify({
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
  }), 'utf8');
}

export function formatRequestDiff(diff: RequestDiff): string[] {
  const lines: string[] = [];
  lines.push(
    `字节：当时 ${diff.bytes.left} / 当前 ${diff.bytes.right}`
    + `${diff.identical ? '（逐字段一致）' : ''}`,
  );
  lines.push(
    `input 条数：当时 ${diff.inputCounts.left} / 当前 ${diff.inputCounts.right}`
    + `（不同 ${diff.changedItems} 条）`,
  );
  lines.push(`instructions：${diff.instructionsChanged ? '已变化（人格常驻层或任务卡不同）' : '一致'}`);
  if (diff.firstDifference !== null) {
    lines.push(`首个差异 @${diff.firstDifference.index}:`);
    lines.push(`  - 当时：${diff.firstDifference.left ?? '（无此条）'}`);
    lines.push(`  + 当前：${diff.firstDifference.right ?? '（无此条）'}`);
  }
  const toolParts: string[] = [];
  if (diff.tools.onlyLeft.length > 0) toolParts.push(`仅当时有：${diff.tools.onlyLeft.join('、')}`);
  if (diff.tools.onlyRight.length > 0) toolParts.push(`仅当前有：${diff.tools.onlyRight.join('、')}`);
  if (diff.tools.changed.length > 0) toolParts.push(`定义变化：${diff.tools.changed.join('、')}`);
  lines.push(`工具清单：${toolParts.length === 0 ? '一致' : toolParts.join('；')}`);
  return lines;
}

// ──────────────────────────────── 报告装配（CLI 的 replay 命令） ────────────────────────────────

export interface ReplayReportOptions {
  /** config.json 所在目录（默认 process.cwd()）；**只读**：不存在不创建 */
  cwd?: string;
  /** 工具清单覆盖点（测试与嵌入方注入）；缺省用当前装配（tools/catalog.ts） */
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** 工具清单视角，默认与真实循环一致（不列破坏性工具） */
  includeDestructive?: boolean | readonly string[];
  /** 时区覆盖点；缺省读 config.json，再退到系统时区 */
  timezone?: string;
  /** --diff 右侧渲染用的时刻（默认此刻）；缺省右侧 = 当时口径 */
  compareNow?: string;
}

export interface ReplayReport {
  dataDir: string;
  turn: number;
  step: number;
  stepStart: {
    seq: number;
    ts: string;
    model: string;
    lane: ModelLane;
    renderVersion: string;
    personaHash: string;
  };
  /** 三指纹比对：当时记录 vs 当前口径 */
  fingerprints: {
    renderVersion: { recorded: string; current: string; matches: boolean; note: string };
    personaHash: { recorded: string; current: string; matches: boolean; note: string };
    configHash: { recorded: string | null; current: string | null; matches: boolean | null; source: string };
  };
  tools: { count: number; digest: string; source: 'current-catalog'; problems: string[] };
  events: {
    scanned: number;
    /** 参与渲染的事件条数（= seq < step/start.seq 的条数） */
    inStream: number;
    rendered: number;
    coveredUpToSeq: number;
    wakeSeq: number | null;
    claimedWakeSeqs: number[];
    todoOpen: number;
  };
  /** 当时口径重建出来的请求体 */
  request: RenderedRequest;
  /** 与当前时刻重渲染的并排对照 */
  diff: RequestDiff;
  notes: string[];
}

export type ReplayBuildResult = { ok: true; report: ReplayReport } | { ok: false; error: string };

/**
 * 装配一份 replay 报告。人读的摘要在 `formatReplaySummary`，JSON 就是 `report.request`。
 *
 * 一条如实报告的纪律：**人格层不可从版本库自动重组**。`step/start` 只记录整份人格资产的
 * 聚合哈希，而版本库是按文件内容寻址的逐文件快照——从聚合哈希反推"四个文件当时各自的版本"
 * 是个不可解的搜索。所以人格不匹配时用当前内容重建，并在 `fingerprints.personaHash.note`
 * 里说清"这份重建的人格层是当前内容"，而不是悄悄拿错的东西冒充历史。
 */
export async function buildReplayReport(
  dataDir: string,
  turn: number,
  step: number,
  options: ReplayReportOptions = {},
): Promise<ReplayBuildResult> {
  const scan = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME));
  const located = locateStep(scan.events, turn, step);
  if (!located.ok) return { ok: false, error: located.reason };

  const stepStart = located.stepStart;
  const recordedPersonaHash = stepStart.data.personaHash;
  const recordedRenderVersion = stepStart.data.renderVersion;

  const current = loadPersona(dataDir);
  const personaMatches = current.personaHash === recordedPersonaHash;

  const toolResult = options.tools !== undefined
    ? { specs: options.tools, problems: [] as string[] }
    : options.includeDestructive === undefined
      ? await catalogToolSpecs(dataDir)
      : await catalogToolSpecs(dataDir, { includeDestructive: options.includeDestructive });
  const tools = toolResult.specs;

  // 时区：config.json → 系统时区。CLI 不造配置（loadConfig 会写默认配置，那是启动期行为）
  const cwd = options.cwd ?? process.cwd();
  let timezone = options.timezone ?? null;
  let configCurrent: string | null = null;
  let configSource = 'none';
  let contactGate: RebuildOptions['contact'];
  const configPath = join(cwd, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    try {
      const loaded = await loadConfig(cwd);
      configCurrent = loaded.configHash;
      configSource = 'config.json';
      if (timezone === null) timezone = loaded.config.timezone;
      // 联络事实里"只能从盘上拿"的那几样（联系人表、别名表、两条通道开没开）：
      // 会话簿与话题由 rebuildContact 从事件折，其余只能取**现在**这份——报告里会明说。
      contactGate = {
        qqOfficial: loaded.config.channels.qqOfficial.enabled,
        onebot: loaded.config.channels.onebot.enabled,
        alertWebhook: (loaded.config.alerts.webhookUrl ?? '') !== '',
        contacts: new Map(Object.entries(loaded.config.persona.contacts)),
        aliases: readAliasesForReplay(dataDir),
      };
    } catch (err) {
      configSource = `config.json 不可用：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (timezone === null) timezone = systemTimezone();

  // 「当时」的 configHash：取 seq ≤ step/start.seq 的最后一条 session/start 或 config/changed
  let configRecorded: string | null = null;
  for (const event of located.eventsBefore) {
    if (event.type === 'session/start') configRecorded = event.data.configHash;
    if (event.type === 'config/changed') configRecorded = event.data.configHash;
  }

  // 情景档案：与 real-loop 共用同一份路由判据（带人唤醒命中 RELATIONSHIPS/<who>.md）
  const relationship = relationshipForWake(located.wakeEvent, dataDir);
  const persona = {
    identity: current.identity,
    constitution: current.constitution,
    style: current.style,
    state: current.state,
    personaHash: current.personaHash,
    relationship,
  };

  const request = rebuildRenderedRequest(
    located,
    {
      persona, tools, timezone,
      // v29/B2：固定块里那段"选中的记忆正文"要从盘上现取（`memory/selected` 只记指针）
      dataDir,
      memoryIndex: readMemoryIndexTextReadOnly(dataDir),
      ...(contactGate === undefined ? {} : { contact: contactGate }),
    },
  );
  const compareRequest = rebuildRenderedRequest(
    located,
    {
      persona, tools, timezone,
      now: options.compareNow ?? new Date().toISOString(),
      dataDir,
      memoryIndex: readMemoryIndexTextReadOnly(dataDir),
      ...(contactGate === undefined ? {} : { contact: contactGate }),
    },
  );

  const notes: string[] = [
    '软阈值提示（budget softHint）按设计不落库，重建结果不含它——字节差异里可能恰好少这一条',
    '工具清单取自当前装配（tools/catalog.ts）：日志只记工具增减的名字，不记定义',
    `时间上下文取 step/start.ts（${stepStart.ts}）；--diff 右侧用当前时刻，状态层的时间行必然不同`,
    // 联络事实拆成两半：会话簿/话题按当时的事件重建，联系人与别名只能取现在这份
    '此刻层的「会话」「点名」按**当时**的事件重建（会话簿由 wake/channel 折、话题取 channel/topic）；'
    + '「通道」里的**联系人表与别名表用的是现在这份**（它们不在事件里），人改过名字时那一句会与当时不同',
    // 三件"只存在于运行期"的事实：它们不是事件，日志里没有。不写这一条，看重建结果的人就会把
    // 「未知」读成"当时就是这样"——那是把重建的局限当成事实。
    '此刻层的「本机」「用度」只存在于运行期（进程/磁盘/投影的瞬时值不落日志）：'
    + '重建结果里它们写「未知」或不出现，与当时的真值不同；要看真值请查 step/start 前后的 budget/consumed 事件与进程日志',
    // 本轮固定块（B2）里那一段的两半来路不同，各自说清
    '本轮固定块里的「选中的记忆正文」按 `memory/selected` **当时选的那几条**从盘上现取正文；'
    + '正文若已被她改写，读回来的是现在的内容——选中哪几条是当时的事实，正文本身取现在这份',
    '长期记忆层里的**记忆索引**（MEMORIES/INDEX.md 的渲染形态）与人格资产同一条限制：'
    + '它是个文件，重建时读到的是现在这份；索引只含指针（路径 + 一行摘要），'
    + '所以漂移的范围是那一行摘要，不是记忆正文',
  ];
  if (!personaMatches) {
    notes.push(`当时的人格资产（${recordedPersonaHash.slice(0, 8)}）与当前（${current.personaHash.slice(0, 8)}）不同：`
      + '人格层已按当前内容重建，逐文件历史请用 persona diff/log 从版本库比对');
  }
  if (recordedRenderVersion !== RENDER_VERSION) {
    notes.push(`当时的渲染模板版本 ${recordedRenderVersion} 与当前 ${RENDER_VERSION} 不同：`
      + '渲染代码只有一份，重建只能用当前模板，字节差异的根因在这里');
  }
  if (toolResult.problems.length > 0) {
    notes.push(`工具集装配有 ${toolResult.problems.length} 处问题：${toolResult.problems.slice(0, 3).join('；')}`);
  }

  return {
    ok: true,
    report: {
      dataDir,
      turn,
      step,
      stepStart: {
        seq: stepStart.seq,
        ts: stepStart.ts,
        model: stepStart.data.model,
        lane: stepStart.data.lane,
        renderVersion: recordedRenderVersion,
        personaHash: recordedPersonaHash,
      },
      fingerprints: {
        renderVersion: {
          recorded: recordedRenderVersion,
          current: RENDER_VERSION,
          matches: recordedRenderVersion === RENDER_VERSION,
          note: '模板变更 = 一次缓存全 miss；重建只能用当前模板代码',
        },
        personaHash: {
          recorded: recordedPersonaHash,
          current: current.personaHash,
          matches: personaMatches,
          note: personaMatches ? '人格与当时一致' : '人格与当时不同（用当前内容重建）',
        },
        configHash: {
          recorded: configRecorded,
          current: configCurrent,
          matches: configRecorded !== null && configCurrent !== null ? configRecorded === configCurrent : null,
          source: configSource,
        },
      },
      tools: {
        count: tools.length,
        digest: sha256Hex(JSON.stringify(tools)),
        source: 'current-catalog',
        problems: toolResult.problems,
      },
      events: {
        scanned: scan.events.length,
        inStream: located.eventsBefore.length,
        rendered: request.input.length,
        coveredUpToSeq: located.coveredUpToSeq,
        wakeSeq: located.wakeEvent?.seq ?? null,
        claimedWakeSeqs: located.claimedWakeSeqs,
        todoOpen: located.taskCard.todoOpen.length,
      },
      request,
      diff: diffRenderedRequests(request, compareRequest),
      notes,
    },
  };
}

/** 人读摘要：三指纹 + 事件规模 + 请求规模 */
export function formatReplaySummary(report: ReplayReport): string[] {
  const lines: string[] = [
    `重放 · turn ${report.turn} step ${report.step}（step/start seq ${report.stepStart.seq} @ ${report.stepStart.ts}）`,
    `模型：${report.stepStart.model}（${report.stepStart.lane}）`,
    `指纹 renderVersion：记录 ${report.stepStart.renderVersion} / 当前 ${RENDER_VERSION}`
    + ` → ${report.fingerprints.renderVersion.matches ? '一致' : '不一致'}`,
    `指纹 personaHash：记录 ${report.stepStart.personaHash.slice(0, 16)} / 当前 ${report.fingerprints.personaHash.current.slice(0, 16)}`
    + ` → ${report.fingerprints.personaHash.matches ? '一致' : '不一致'}`,
    `指纹 configHash：记录 ${short(report.fingerprints.configHash.recorded)}`
    + ` / 当前 ${short(report.fingerprints.configHash.current)}`
    + ` → ${report.fingerprints.configHash.matches === null ? '无法比对' : report.fingerprints.configHash.matches ? '一致' : '不一致'}`,
    `事件流：参与渲染 ${report.events.inStream} 条（扫描 ${report.events.scanned} 条）`
    + ` · 本轮新输入 ${report.events.wakeSeq === null ? '（无，非首步）' : `seq ${report.events.wakeSeq}`}`
    + ` · 遮蔽点 seq ${report.events.coveredUpToSeq}`,
    `请求体：${report.request.input.length} 条 input · ${jsonBytes(report.request)} 字节`
    + ` · 工具 ${report.tools.count} 件（digest ${report.tools.digest.slice(0, 12)}）`,
  ];
  for (const note of report.notes) lines.push(`注：${note}`);
  return lines;
}

function short(value: string | null): string {
  return value === null ? '（无记录）' : value.slice(0, 16);
}

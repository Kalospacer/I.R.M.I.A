/**
 * Irmia Agent — 真循环驱动（M2 骨架 + M3 刹车与告警接入）
 *
 * 与 docs/design.md §4.4 对齐：pending 有输入 → 取回 wake 事件 → runTurn → 结算结局。
 * 与 FakeLoop 同形（start/stop/writeProjectionCache），main.ts 按有无 API key 二选一。
 *
 * M3 在这里接上四件事（判定逻辑在 runtime/budget-guard.ts 与 alert/notifier.ts，动作在这里）：
 *   ① **刹车**：`checkBeforeStep` 换成 BudgetGuard 完整版（四层，撞线时由它自己写
 *      `budget/exhausted{resumable:true}`），单步工具数走 `stepCallLimit` / `onStepOverflow`；
 *      撞刹车后进入**可恢复暂停**——pending 一条不动，加注后从原地继续，绝不清空重来（§4.6）。
 *   ② **软阈值先说话**：`softHint` 直连 guard，agent-loop 把它作为尾部 developer 消息插播；
 *      历史段一个字节都不改（KV cache 前缀完好，§4.13）。
 *   ③ **唤醒门**：每日额度撞线、已撞的 task 层刹车未加注、连续模型失败达阈值——三种情况都
 *      **拒绝唤醒**：不写 turn/start、不认领输入、发告警后待机（§4.6 表格 daily 行 + §4.9）。
 *   ④ **告警出口**：预算耗尽 / 连续失败 / 水位停滞（§4.9 触发点清单里的三条）走 alert/notifier；
 *      限流窗口在启动时用 `notifier.restore(日志)` 重建，所以重启不会让一个坏接口重新刷屏（M3-10）。
 *
 * 加注（topup）是暂停的唯一出口：CLI 只写 `<dataDir>/topup/topup-<ts>.json`，本模块下一拍拾取、
 * 先落事件再删文件，然后用"配置上限 + 加注累计"重建判定器——加注抬高上限，已消耗的 token
 * 一个字节都不动（M3-5：进度不丢）。
 *
 * M5 在这里补上心跳与回复必要性门（判定逻辑在 wake/heartbeat.ts 与 runtime/necessity-gate.ts）：
 *   ⑤ **心跳**：本模块自己持有 Heartbeat（随 start/stop 布防），到点写 `wake/heartbeat`。
 *      间隔 = 基线 × min(2^idleTicks, idleBackoffMax) × (1.5 − pressure)，空拍与压力都从投影读；
 *      `noteActivity()` 只在**外部事件**到达时复位——心跳自己不复位，否则退避永远长不起来（§4.12）。
 *   ⑥ **必要性门**：心跳批次先过门（规则短路优先，light 模型兜底），判定沉默时 turn 以
 *      `turn/end{completed, spoke:false}` 收尾且零模型调用；人/定时器/文件/webhook/意图/后台
 *      这些真实事件直接进 turn——规则层不替她闭嘴（§4.11）。
 *
 * M5 在这里补上折叠快照：每天首次 + 每 SNAPSHOT_EVERY_EVENTS 条事件写一次 `data/snapshots/`，
 * 并写 `snapshot/checkpoint` 事件；恢复时 runtime/recover.ts 从最近快照起算（M5-9）。
 */

import { readFileSync, readdirSync, statfsSync, unlinkSync } from 'node:fs';
import { arch, platform as osPlatform, release as osRelease } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { AppEvent, BudgetLayer, MemorySelected, PendingInput, Projection, TurnEndReason, WakeChannel } from '../log/types.js';
import { isTopLevelEvent } from '../log/types.ts';
import { InjectionJudge, type InjectionVerdict } from '../channel/injection-judge.ts';
import { injectionNoteOf, noteForFlagged, quotesOfHints, reasonOfHints, scanForInjection } from '../channel/injection.ts';
import { TopicSummarizer } from '../channel/topic.ts';
import type { WakeEmission } from '../wake/sources.js';
import type { EventLog } from '../log/event-log.js';
import type { DsClient } from '../model/ds-client.js';
import type { ToolRegistry } from '../tools/registry.js';
import { DEFAULT_ASK_HUMAN_TIMEOUT_MIN, DEFAULT_WORKSPACE_DIR_NAME, type AppConfig } from '../config/config.ts';
import type { PersonaAssets } from '../persona/loader.js';
import { applyOne, finalizePressure, wakeSourceOf } from '../state/fold.ts';
import { saveProjectionCache } from '../state/projection-cache.ts';
import { writeSnapshot } from '../state/snapshot.ts';
import { runTurn, isHeartbeatTurn, compactionCoveredUpToSeq, handoffOptionsOf, type AgentLoopBudget, type AgentLoopDeps } from './agent-loop.ts';
// 回投能力的唯一判据在 tools/admin（speak 第三路用它）：这里读同一个函数，
// 免得「提示词告诉她能发」与「实际能不能发」变成两套口径。
import {
  collectSessions as collectSessionsFromLog, normalizeSid, parseAliases, resolveNameForSid, sidOf,
  upsertSession as upsertSessionInto, type SessionEntry as KnownSession,
} from '../channel/sessions.ts';
import type { ChannelMessageView, ChannelSpoken } from '../tools/admin.js';
import {
  CONTEXT_IMAGE_HARD_BYTES,
  ensureAttachment,
  readAttachmentDataUrl,
  readFileDataUrl,
} from '../channel/attachment-store.ts';
import { replyableWakeChannel } from '../tools/admin.ts';
import type { ContactFacts } from '../model/self-brief.ts';
import type { MachineFacts, RenderChannelContext, RenderImageRef, TurnBlockFacts, UsageFacts } from '../model/render.ts';
import {
  ASK_HUMAN_BLOCKED_BY, DEFAULT_HUMAN_TIMEOUT_MS, PlanMode,
  humanTimeoutElapsed, scanSuspension, type Suspension,
} from './plan-mode.ts';
import { relationshipForWake } from '../persona/relationship.ts';
import { BudgetGuard, DEFAULT_STALL_MS, stallOf, type StallInfo } from './budget-guard.ts';
import { createNotifier, type AlertNotifier } from '../alert/notifier.ts';
import { Heartbeat, HeartbeatSource, type HeartbeatFiring } from '../wake/heartbeat.ts';
import { NecessityGate } from './necessity-gate.ts';
import { holdsGroupBatch } from './group-batch.ts';
import type { SkillManager } from '../skill/skills.js';
import type { HookRunner } from '../hook/hooks.js';
import type { TimerStore } from '../wake/timer-store.js';
import { modelVisibilityFor, trustOfBatch, isOwnerLabel } from './trust.ts';
import { createAuthzGate, type Scenario } from './authz.ts';
import { GroupMemberBook } from '../channel/group-members.ts';
import { WarnExemptBook } from '../channel/warn-exempt.ts';
import { MEMORY_MAINTAIN_PAYLOAD_KIND, maintainMemory, memoriesDir } from '../persona/memory-maintain.ts';
import {
  buildMemoryIndex, ensureMemoryIndex, readExcerpt, renderMemoryIndex, renderSelectedMemory, selectMemory,
  type MemoryExcerpt, type MemoryIndex,
} from '../persona/memory-injection.ts';
import {
  applyTopUpEvent, emptyTopUps, foldTopUps, parseTopUpRequest, raiseLimits,
  TOPUP_FILE_PREFIX, TOPUP_WATCH_DIR_NAME, type TopUpTotals,
} from './topup.ts';
import {
  COMPACT_EMPTY_RECEIPT, COMPACT_RECEIPT, HANDOFF_EMPTY_RECEIPT, HANDOFF_RECEIPT,
  isSlashCommandEvent, parseSlashCommand, unknownCommandReply, type SlashCommand,
} from './slash-commands.ts';
import { renderHandoffNote } from '../persona/handoff-note.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 告警类别（限流指纹的类别段：同类故障 30 分钟一条，恢复通知单独成指纹） */
const CATEGORY = {
  budget: 'budget-exhausted',
  failStreak: 'model-failure',
  stall: 'stall',
  /** 人审挂起超时（design §4.21）：与预算耗尽分开成类——两类事的救法不同，不该共用限流指纹 */
  human: 'human-timeout',
} as const;

/**
 * 水位停滞阈值（毫秒，`DEFAULT_STALL_MS`，见 budget-guard）：**输入自己**等了这么久还没被处理
 * → §4.9 告警。
 *
 * 值仍是 10 分钟（design §4.9 的原口径），但计时起点从"距上次成功模型调用"改成了
 * "最早那条待处理输入的到达时刻"（见 `stallOf`）——所以它与 30 分钟的心跳基线不再冲突：
 * 安静地待着不会累积这个时长，只有真有人在等才会。
 *
 * 唯一要留意的量级约束：它必须明显大于群消息攒批窗口
 * （`channels.qqOfficial.groupBatchMinutes`，默认 3 分钟）——那段时间里输入是**有意**压着的。
 */

/** 失败刹车后的半开冷却（毫秒）：冷却期满放行一次试探，避免坏接口被反复打 */
const DEFAULT_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
/** 单拍最多认领的输入条数（与 M2 一致：一批多条时的边界固定，便于复盘） */
const BATCH_LIMIT = 8;

/**
 * 「到的是哪一档」那一句话的素材——**唯一一处**。
 *
 * `field` 是界面上那几行**字段标签的逐字**（`gui/lib/pages/settings_page.dart` 的 `_SysField`，
 * 「分区七：系统」那张卡）：人拿着告警去设置里找，标签差一个字就等于没说。
 *
 * `scope` 是这一档"数的是什么"的口径。token 那两档用的是仓库里既有的那句话
 * （与界面字段说明、`BUDGET_METRIC_NOTE` 同一口径）：数的是**未扣缓存**的 token，
 * 含缓存命中的那部分，不等于花销——第一次看到"今日用量 34599.9k"的人，反应都是"我没用这么多"。
 * 次数那两档就如实说数的是次数，不硬套 token 的话。
 */
const BUDGET_LAYER_FACTS: Record<BudgetLayer, { name: string; field: string; scope: string }> = {
  step: {
    name: '步内工具调用',
    field: '预算 · 步内工具调用上限',
    scope: '这一档数的是**工具调用次数**，不是 token',
  },
  turn: {
    name: '单 turn 步数',
    field: '预算 · 单 turn 步数上限',
    scope: '这一档数的是**一个 turn 里跑了几步**，不是 token',
  },
  task: {
    name: '任务 token',
    field: '预算 · 任务 token 上限',
    scope: '口径是**未扣缓存**的 token 数（含缓存命中的那部分），不等于花销',
  },
  daily: {
    name: '每日 token',
    field: '预算 · 每日 token 上限',
    scope: '口径是**未扣缓存**的 token 数（含缓存命中的那部分），不等于花销',
  },
};

/**
 * 进主循环上下文的事件（`AgentLoopDeps.eventFilter`）——两刀，判据都在别的模块里：
 *
 *   ① **顶层**（design §4.21）：子代理链（`parentCallId` 非空）是它自己那条 turn 链的内部过程，
 *      进了父请求就等于让父模型看见"自己"没说过的话（`isTopLevelEvent`）；
 *   ② **不是"整条就是一条指令"的 `wake/manual`**（B1 第二步，`isSlashCommandEvent`）：
 *      指令是给框架的，她该看见的是效果而不是按钮。
 *
 * 为什么它是一个模块级函数而不是内联的箭头函数：`replay` 必须用**同一份**口径重建请求
 * （`replay.ts` 的归属过滤里引的是同一个函数），否则"同一份日志重建同一份请求"就断了。
 */
function contextEventFilter(event: AppEvent): boolean {
  if (!isTopLevelEvent(event)) return false;
  return !isSlashCommandEvent(event);
}

/**
 * 附件预热一次最多回看多少条事件。
 *
 * 它是"重启后补扫"的上限，不是常规路径：平时带游标只看新来的那几条。取 200 是因为
 * 一张图从到达、渲染到真正被认领通常只隔几十条事件；再往前翻既没必要，也白读盘。
 */
const ATTACHMENT_SCAN_WINDOW = 200;

/** 每积累这么多事件写一次折叠快照（M5-9 与 design §4.12 的体量盘算：日均 5000 事件即一天一快照） */
export const SNAPSHOT_EVERY_EVENTS = 5000;

// ── 注入判定与话题概括的分寸（v32）──
//
// 两个数字都是"钱与体感"的折中，写在这里而不是散在调用点上：
//   • **一次判定最多等 6 秒**：判定是锦上添花，不能成为她开口的前置条件。攒批窗口本来就
//     让群消息延迟了几分钟，再多等几秒她能忍；而这个上限保证最坏情况不至于把 turn 拖住。
//   • **一批最多判 3 条**：一批里塞十条外部消息时，逐条问模型的代价是几十秒。
//     多出来的那些这一轮不判——它们照样出现在上下文里，字面扫描那一层也照样在渲染时生效
//     （见 model/render.ts 的 renderExternalEvent），只是少了语义那半。
const INJECTION_JUDGE_TIMEOUT_MS = 6_000;
const INJECTION_JUDGE_MAX_PER_BATCH = 3;
/** 去重集合的上界（超出整份丢掉重建：代价是极少数消息被重判一次，而无限增长是内存） */
const INJECTION_JUDGE_SEEN_MAX = 500;

/** 话题概括的门槛：未读够多、且距上次概括够久，才值得花一次 light（见 summarizeChattySessions） */
const TOPIC_MIN_UNREAD = 5;
const TOPIC_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 一次概括最多喂多少条消息（只概括最近这一段，老消息会把概括糊掉） */
const TOPIC_MAX_MESSAGES = 30;

/** 定时器 payload 是否标识"每日记忆整理"（real-loop 布防/识别与测试共用同一判定） */
/** 读定时器 payload 里的字符串标记（`by: "human"` 这类）；形状不对就给 false */
function readPayloadFlag(payload: unknown, key: string, value: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)[key] === value;
}
export function isMemoryMaintainPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)['kind'] === MEMORY_MAINTAIN_PAYLOAD_KIND;
}

/** 打断 speak 的唤醒类型：**人**开口的那三种。定时器、意图、后台任务、心跳都不算 */
const USER_SPOKE_TYPES: readonly string[] = ['wake/manual', 'wake/channel', 'wake/webhook'];

/**
 * 这条唤醒是不是"有人说话了"？是则给出可写进回执的一句话，否则 null。
 *
 * 本机对话流（`wake/manual`）与消息适配器（`wake/channel`）都算——用户的口径是
 * 「从消息适配器发消息也可打断」。看门目录的文件变化、意图到期、后台任务完成都不算：
 * 那些不是有人在跟她说话，没什么可"重新组织语言"的。
 */
export function userSpokeTextOf(emission: WakeEmission): string | null {
  return userSpokeEventTextOf(emission.type, emission.data);
}

/**
 * 同一条判据，但吃的是**裸的事件形状**（`type` + `data`）而不是 `WakeEmission`。
 *
 * 为什么要另开一个口（2026-10-03 修一个真 bug）：写「有人开口了」这条事实的**不止
 * WakeSink 一条路**。看门目录与消息适配器走 `RealLoop.wake()`，而界面聊天框与 /dream
 * 是 Web 层直接 `appendSync('wake/manual')` 落库的（`src/web/server.ts`）——
 * 它同样是一条"有人在跟她说话"，却从来没走到 `noteUserSpoke`。
 * 后果实测过一次（用户 17:38 那轮）：他在界面上插了一句话，她正一条条往外发的
 * 8 条气泡照旧发完，speak 卡一直挂到 65 秒后才结束。判据只留一份实现，两个入口共用。
 */
export function userSpokeEventTextOf(type: string, data: unknown): string | null {
  if (!USER_SPOKE_TYPES.includes(type)) return null;
  const record = (data ?? null) as Record<string, unknown> | null;
  const raw = type === 'wake/manual'
    ? (record?.['note'] ?? '')
    : type === 'wake/channel'
      ? (record?.['text'] ?? '')
      : (record?.['body'] ?? '');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  // 没有文字的消息也要如实说（纯图片、纯表情包都走这里），否则回执会显得莫名其妙
  if (type === 'wake/channel') {
    const attachments = record?.['attachments'];
    const count = Array.isArray(attachments) ? attachments.length : 0;
    return count > 0 ? `（发了 ${count} 个附件，没写字）` : '（一条空消息）';
  }
  return null;
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 平台显示名：她自己就跑在这上面，给一个读得懂的名字比给 `win32` 强 */
const PLATFORM_LABELS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * 读一个路径所在卷的剩余空间。**任何失败都返回 null**（卷没挂上、路径不存在、权限不够）：
 * 此刻层据此写"未知"，而不是替她判断"磁盘没事"——那是两件完全不同的事。
 */
function readDiskFacts(path: string): { path: string; freeBytes: number; totalBytes: number } | null {
  try {
    const fs = statfsSync(path);
    const freeBytes = fs.bsize * fs.bavail;
    const totalBytes = fs.bsize * fs.blocks;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0 || freeBytes < 0) return null;
    return { path, freeBytes, totalBytes };
  } catch {
    return null;
  }
}

export interface RealLoopDeps {
  log: EventLog;
  dataDir: string;
  projection: Projection;
  now: () => Date;
  timezone: string;
  ds: DsClient;
  registry: ToolRegistry;
  persona: PersonaAssets;
  config: AppConfig;
  out?: (line: string) => void;
  /** 轮询间隔（毫秒），默认 1000 */
  pollMs?: number;
  /** 刹车判定器覆盖点（测试注入假阈值用）；缺省按 config.budget 构造 */
  guard?: BudgetGuard;
  /** 告警出口覆盖点；缺省按 config.alerts 自建（文件档永远开，webhook 配了才开） */
  notifier?: AlertNotifier;
  /** 水位停滞阈值（毫秒），默认 10 分钟（design §4.9） */
  stallMs?: number;
  /** 失败刹车的半开冷却（毫秒），默认 30 分钟 */
  failCooldownMs?: number;
  /** 心跳覆盖点（测试注入伪时钟/假闹钟用）；缺省按 config.wake 构造 */
  heartbeat?: Heartbeat;
  /** 快照事件间隔，默认 SNAPSHOT_EVERY_EVENTS（测试注入小值以低成本覆盖该判定） */
  snapshotEveryEvents?: number;
  /**
   * 技能管理器（design §4.19）：catalog 注入状态层（渐进披露第 1 层），信任表从日志折叠。
   * 不配则没有技能索引——状态层该段整体不出现。
   */
  skills?: SkillManager;
  /**
   * 执行点钩子（design §4.19）：PreToolUse / PostToolUse 随工具执行走，Wake 跟随唤醒。
   * 不配则三个执行点都不存在——行为与未装钩子时完全一致。
   */
  hooks?: HookRunner;
  /**
   * 定时器表：每日记忆整理任务的布防与 payload 识别都读它（design §4.17）。
   * 不注入则不布防该任务，带整理 payload 的唤醒会退化为普通 turn。
   */
  timers?: TimerStore;
  /** 每日整理 cron 覆盖点（测试注入）；缺省读 config.wake.memoryMaintainCron */
  memoryMaintainCron?: string;
  /**
   * 计划模式门覆盖点（测试注入）。缺省按 `config.tools.planMode` 自建。
   * 宿主自建时**必须**与 agent-loop 用的是同一个实例：批准许可存在投影里，
   * 门与闸必须是同一双眼睛。
   */
  planMode?: PlanMode;
  /** 人审挂起超时（毫秒），默认 24h（design §4.21） */
  humanTimeoutMs?: number;
  /**
   * 她问人之后的等待线（毫秒）：超过它没人答就落一条「未批准、未拒绝」的 `human/expired`
   * （design §6.1）。缺省读 `config.tools.askHumanTimeoutMin`，再缺省 30 分钟。
   *
   * 与人审挂起超时（humanTimeoutMs）**刻意是两个数**：那一条是挂起（任务层暂停的资源决定），
   * 这一条只是"人还在不在机器旁"的事实判断——误判的代价差一个量级，不该共用一个数。
   */
  askHumanTimeoutMs?: number;
  /**
   * 当前 turn 的回投目标（M9）：本拍分派给模型的 wake 事件里，**最近一条** `wake/channel`。
   * 返回 null 表示这一轮不是由 IM 通道唤醒的——speak 的第三路就当没有地址，如实报"跳过"。
   *
   * 为什么由 real-loop 提供而不是让 speak 工具自己翻日志："哪条 wake 属于这个 turn"是
   * 循环层的事实（它刚刚把哪批事件交给了模型），只有它知道。
   */
  currentWakeChannel?: () => WakeChannel['data'] | null;
}

/**
 * 挂起线索 + 本进程的答复记账。`answeredAt` 不进 Suspension：Suspension 是能从日志折叠出来的
 * 线索，而这里只是一个「我已经探到答复了」的进程内标记，避免同一件事被反复探测。
 */
interface TrackedSuspension extends Suspension {
  answeredAt: string | null;
}

/**
 * 本批 wake 事件里最近一条 `wake/channel`（M9）。
 *
 * 取"最近一条"而不是"第一条"：同一批里可能攒了几条通道消息（她刚回来时常见），
 * 回投应当回到最后说话的那个会话——那才是她正在回应的人。
 */
function lastChannelWake(events: readonly AppEvent[]): WakeChannel['data'] | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === 'wake/channel') return event.data;
  }
  return null;
}

// ──────────────────────────────── 主体 ────────────────────────────────

export class RealLoop {
  private readonly deps: RealLoopDeps;
  private readonly notifier: AlertNotifier;
  private readonly write: (line: string) => void;
  private readonly pollMs: number;
  private readonly failCooldownMs: number;
  private readonly stallMs: number;
  private readonly failStreakMax: number;
  /** 心跳（design §4.12 空闲退避 + pressure 调制）；本模块自己持有，随 start/stop 布防 */
  private readonly heartbeat: Heartbeat;
  private readonly heartbeatSource: HeartbeatSource;
  /** 回复必要性门（design §4.11）：心跳批次先过它，真实事件直接进 turn */
  private readonly necessity: NecessityGate;
  /** 注入的判定器不重建（测试注入的假阈值必须原地生效） */
  private readonly guardIsInjected: boolean;
  private guard: BudgetGuard;
  /** 人工加注累计（启动时折叠，运行期增量维护；它是"有效上限"的来源） */
  private topUps: TopUpTotals = emptyTopUps();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** 附件预热扫到哪条事件了（重启后归零，从窗口起点补一次） */
  private attachmentScanSeq = 0;
  /**
   * 「有人插话」的**计数**（不是信号）。
   *
   * 为什么用计数而不是 AbortSignal：AbortSignal 一旦 abort 就**永远**是 aborted，而一轮里
   * 她可能说好几次话。实测的后果是她被打断一次之后，这一轮剩下的每一次 speak 都在第一片
   * 等待里被判成"又被打断"——连着十二次一句也没说出去，只能等下个 turn 才开口。
   *
   * 计数表达的是"**自你开口以来，有没有新的插话**"：每次 `noteUserSpoke` 加一，
   * speak 开始时记下当时的值，等待中只要它变了就是被打断；她重新组织语言再开口时
   * 记的是新值，于是能正常说完——除非对方又说话了。
   */
  private interruptEpoch = 0;
  /** 触发打断的那句话（写进 speak 的回执，让她知道该针对什么重新组织语言）**与是哪条唤醒** */
  private userSpokeNote: { text: string; wakeSeq: number } | null = null;
  /** 启动预热（重建限流窗口与加注累计）；幂等，只做一次 */
  private ready: Promise<void> | null = null;
  /** 失败刹车的暂停起点（null 表示未暂停） */
  private failPausedAtMs: number | null = null;
  /** 上一次放行试探的时刻（半开冷却判据） */
  private lastFailProbeMs = 0;
  // 跨天记账"上次记的是哪天"曾经存在这里，现在读投影的 budget.date——内存态活不过重启，
  // 而它决定的是"要不要把当日用量清零"，不能凭一个每次启动都为空的字段来判（见 rolloverIfNeeded）
  /** 快照事件间隔（默认 5000 条事件） */
  private readonly snapshotEveryEvents: number;
  /** 快照记账：上次写快照的日期与覆盖到的 seq（本进程态；快照是派生数据，丢了下次触发点再写） */
  private lastSnapshotDate: string | null = null;
  private lastSnapshotSeq = 0;
  /** 技能索引（design §4.19）：每 turn 装配时重扫一次，信任表在启动预热时从日志折叠 */
  /**
   * 群成员档案（自动注册的落点，见 channel/group-members.ts）。
   *
   * 惰性建：只在真的见到群消息时才碰盘——她没有群的时候，这条路径一次文件操作都不该发生。
   */
  private groupMembers: GroupMemberBook | null = null;
  /**
   * 框架预警的豁免名单（见 channel/warn-exempt.ts）。
   *
   * 默认谁都不豁免（预警开着）；用户可以在消息适配器页对**某个单聊**、或**群里某个已注册的人**
   * 开豁免。惰性建：只有真的要判定的那一拍才碰盘。
   */
  private warnExempt: WarnExemptBook | null = null;
  /** 这一批注册里有没有改动（有才落盘，避免每轮都写文件） */
  private groupMembersDirty = false;
  private readonly skills: SkillManager | null;
  /** 下一个可用 turn 号：普通 turn 由 agent-loop 分配，本模块只维护自己的记账口径 */
  private nextTurn = 1;
  /** 每日记忆整理 cron（空串 = 关闭该任务，design §4.17） */
  private readonly memoryMaintainCron: string;
  /** 计划模式门（design §4.21）：destructive 调用的事前审批，与 agent-loop 共用同一个实例 */
  private readonly planMode: PlanMode;
  /** 人审挂起超时（毫秒） */
  private readonly humanTimeoutMs: number;
  /**
   * 她问人之后的等待线（毫秒）。到点只落一条事实，**不撤卡、不做决定**（design §6.1）。
   * 判定线只影响"什么时候告诉她"，不影响任何一方的权力。
   */
  private readonly askHumanTimeoutMs: number;
  /**
   * 挂起中的人审（计划待批准；v27 之后 `human/asked` 的写入方只剩这一条）。本进程态，**事实在日志**：
   * 重启由 warmUp 用 scanSuspension 从日志重建，所以「答复在停机期间写下」那条路照样走得通。
   */
  private suspension: TrackedSuspension | null = null;
  /** 答复探测的增量游标（只扫人审相关事件，不每拍全量重读日志） */
  private humanCursor = 0;
  /**
   * 当前 turn 正在处理的唤醒批次里最近一条通道消息（M9）。
   * 生命周期与批次一致：分派前赋值、turn 收尾后清空——绝不能把它留到下一个 turn
   * （speak 的回投地址一旦指向上一轮的会话，就成了"把她上一条回复发到另一个聊天"的灾难）。
   */
  private wakeChannelData: WakeChannel['data'] | null = null;

  /**
   * 会话簿：她认人/认场景的依据（启动时折叠一次，之后每拍并入新来的通道事件）。
   *
   * 为什么**不只在认领唤醒时**并入（v32）：通道消息分两类——叫她来的（`wake/channel`）与只记账的
   * （`channel/message`，internal、不唤醒）。后者永远不会出现在 pending 里，只并入"被认领的那些"
   * 就等于**只有被叫醒过的会话才有未读**，而未读恰恰是"她还没被叫醒"的那种会话才需要的东西。
   * 所以并入点挪到**每拍扫一遍新事件**（见 foldChannelEvents）——判据只有一个：事件类型。
   */
  private sessionBook: KnownSession[] = [];

  /** 上一条已并入会话簿的通道事件 seq（每拍从水位往后扫，按类型过滤，不重扫历史） */
  private channelBookSeq = 0;

  /**
   * `messageId → 那句框架话 + 判定来源`（`injection/flagged` 折出来的）。
   *
   * 为什么要折：渲染与 `read_channel` 都是**按 messageId** 把预警贴回那一条消息旁边的，
   * 而渲染层是纯函数（只能读传进去的东西）。折成映射之后两处查同一份，重启后由
   * warmUp 的全量折叠补齐——不现扫日志，也不给渲染层开一个"自己去翻日志"的口子。
   *
   * v25 起值带上 `by`：示警那一刻要把它落进 `injection/noted`（谁判的：规则还是模型）。
   */
  /** 判定结论（含给人的 reason/quotes）：note 是给她的那句话，其余三个是给界面的 */
  private flaggedNotes = new Map<string, { note: string; by: 'rule' | 'model'; reason: string; quotes: readonly string[] }>();

  /**
   * 已经示过警的外部消息（按 messageId 去重）。
   *
   * 为什么不能只靠"一条消息只会被处理一次"：崩溃恢复会把输入退回队列（`input/requeued`），
   * 重启后同一条可能再走一遍这一拍——不记着，此刻层那段历史就会把它数成两次。
   * 与 `flaggedNotes` 同一条纪律：warmUp 全量补齐、平时按 seq 游标增量并。
   */
  private notedMessageIds = new Set<string>();

  /** 已判过的外部消息（按 messageId 去重：重投与攒批窗口都会让同一条再走一遍判定） */
  private judgedMessageIds = new Set<string>();

  /**
   * 这一轮**叫她的那条消息**（群里被提及/@；没有就是 null）——`read_channel` 靠它知道
   * "这个会话必须照给"（v28 之后她手里只有通知、没有正文，见 admin.ts 的说明）。
   *
   * 由 `foldChannelEvents` 在折叠通道事件时记下最近一条"在叫她"的群消息（判据与唤醒一致：
   * `chatType !== 'c2c'` 且平台 @ 或关键词命中）。
   */
  currentMention(): { sid: string; messageId: string } | null {
    return this.lastMention;
  }

  private lastMention: { sid: string; messageId: string } | null = null;

  /** 会话话题（`channel/topic` 折出来的最近一条）：清单那一行缀的那半句 */
  private channelTopics = new Map<string, string>();

  /**
   * sid → **上次概括覆盖到的事件 seq**（`channel/topic.toSeq`）。
   *
   * 与 `topicAt` 的分工：那个是"多久之前跑过"（内存里的节流，重启即失忆），这个是"概括到哪了"
   * ——它从日志折出来，所以重启之后仍然有效：同一段没读过的消息不会被反复概括出同一句话。
   */
  private topicSeq = new Map<string, number>();

  /** sid → 上次跑话题概括的时刻（毫秒）：节流用，防止连着几拍重复花 light */
  private topicAt = new Map<string, number>();

  constructor(deps: RealLoopDeps) {
    this.deps = deps;
    this.write = deps.out ?? ((line) => console.log(line));
    this.pollMs = deps.pollMs ?? 1000;
    this.stallMs = deps.stallMs ?? DEFAULT_STALL_MS;
    this.failCooldownMs = deps.failCooldownMs ?? DEFAULT_FAIL_COOLDOWN_MS;
    this.failStreakMax = deps.config.budget?.failStreakMax ?? 5;
    this.snapshotEveryEvents = Math.max(1, Math.trunc(deps.snapshotEveryEvents ?? SNAPSHOT_EVERY_EVENTS));
    this.skills = deps.skills ?? null;
    this.memoryMaintainCron = deps.memoryMaintainCron ?? deps.config.wake.memoryMaintainCron;
    this.humanTimeoutMs = Math.max(1, Math.trunc(deps.humanTimeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS));
    // 两个超时各读各的：挂起那条缺省 24h（plan 模式的老口径），她提问这条缺省走配置
    // （config.tools.askHumanTimeoutMin，默认 30 分钟）。配置缺失/非法（宿主自己拼的 config）
    // 时退回内置默认而不是算出 NaN——NaN 会让比较恒为假，于是这条事实**永远不落**，
    // 而"功能静默失效"比"报错"难查得多。
    const configuredAskMin = deps.config.tools.askHumanTimeoutMin;
    const askDefaultMs = Number.isFinite(configuredAskMin) && configuredAskMin > 0
      ? configuredAskMin * 60_000
      : DEFAULT_ASK_HUMAN_TIMEOUT_MIN * 60_000;
    this.askHumanTimeoutMs = Math.max(1, Math.trunc(deps.askHumanTimeoutMs ?? askDefaultMs));
    this.planMode = deps.planMode ?? new PlanMode({
      enabled: deps.config.tools.planMode,
      projection: deps.projection,
      // 与 appendSync 同一条通道：先落库再折投影，批准许可才会在本拍就被 gates 看见
      emit: (type, data, visibility) => { this.appendSync(type, data, visibility); },
      now: deps.now,
    });
    this.guardIsInjected = deps.guard !== undefined;
    this.guard = deps.guard ?? this.makeGuard();
    this.heartbeat = deps.heartbeat ?? this.makeHeartbeat();
    this.heartbeatSource = new HeartbeatSource(this.heartbeat, {
      emitHeartbeat: (data) => {
        this.appendSync('wake/heartbeat', data, 'model');
      },
    });
    this.necessity = new NecessityGate({
      ds: deps.ds,
      log: deps.log,
      projection: deps.projection,
      now: deps.now,
      out: this.write,
    });
    this.notifier = deps.notifier ?? createNotifier({
      config: deps.config.alerts,
      dataDir: deps.dataDir,
      // 告警事件走承诺类落盘：限流窗口的事实来源必须先在盘上（M3-10）
      emit: (type, data, visibility) => {
        this.appendSync(type, data, visibility);
      },
      now: deps.now,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.ensureReady();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.write(`[循环] tick 异常：${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.pollMs);
    // 心跳与主轮询无关：它是"没人说话时的呼吸"，随循环一起布防、一起停
    this.heartbeatSource.start();
    this.write(`[心跳] 已布防，基线 ${Math.round(this.heartbeat.nextDelayMs() / 60_000)} 分钟`
      + `（退避上限 ${Math.max(1, Math.trunc(this.deps.config.wake.idleBackoffMax))} 倍，压力调制，`
      + `区间 ${this.deps.config.wake.heartbeatFloorMin}~${this.deps.config.wake.heartbeatCeilMin} 分钟）`);
    void this.tick();
  }

  /** WakeSink：定时器到期记账（internal） */
  timerFired(timerId: string): void {
    this.appendSync('timer/fired', { timerId }, 'internal');
  }

  /**
   * 本 turn 的回投会话（M9）：speak 的第三路据此把发言回投到 IM 通道。
   * 不是通道唤醒的 turn 返回 null（当真循环未被当作通道宿主的装配用时就是这种情形）。
   */
  wakeChannel(): WakeChannel['data'] | null {
    return this.wakeChannelData;
  }

  /** 已知会话（会话簿）：`list_sessions` 与 `speak`/`report` 的 `to` 都读它 */
  sessions(): readonly KnownSession[] {
    return this.sessionBook;
  }

  /** WakeSink：唤醒事件（model，承诺类；返回时已在磁盘上） */
  wake(emission: WakeEmission): void {
    const logged = this.appendSync(emission.type, emission.data, 'model');
    // 任何外部事件到达即复位空拍（design §4.12）。心跳自己不走这条路：
    // 它由 HeartbeatSource 直接落库，否则每拍都会把自己复位，退避永远长不起来。
    this.heartbeat.noteActivity();
    // 有人开口了：她若正在发言，立刻打断（本机对话流与消息适配器都算，见 noteUserSpoke）。
    // 记的是**刚落的这条事件的 seq**：speak 真被打断时要拿它销账（见 claimInterruption）
    const spoke = userSpokeTextOf(emission);
    if (spoke !== null) this.noteUserSpoke(spoke, logged.seq);
  }

  /**
   * 有人说话了：如果她正在这一轮里发言，打断这一次发言。
   *
   * 为什么连消息适配器一起算（用户的口径）：她在 QQ 上一条条打着字，对方又发来一条，
   * 那就是**被插话**——不管新话是从聊天框来的还是从 QQ 来的，继续把那半截说完都不对。
   *
   * 打断的语义只是"这一次别接着说"：已经发出去的收不回来，没发的一段都不发，
   * 而 `speak` 的回执会如实告诉她说了几条、剩什么没发、对方刚说了什么。
   * 她重新组织语言**再开口是允许的**——计数只拦"开口期间来的新插话"，
   * 这一点是踩过坑才定死的：早先用 AbortSignal 时，一次打断会把她这一轮剩下的
   * 每一次发言都判成"又被打断"（实测连着十二次一句没发出去）。
   *
   * `wakeSeq` 是那条唤醒自己的 seq：只有真被打断时（见 agent-loop 的 claimInterruption）
   * 才会有人读它。**不能在这里销账**——这个方法在她没发言时同样会跑，
   * 那样会把一条她根本没看见的消息从队列里吞掉。
   */
  private noteUserSpoke(text: string, wakeSeq: number): void {
    this.userSpokeNote = { text, wakeSeq };
    this.interruptEpoch += 1;
  }

  /**
   * 「有一条**人开口**的事件刚落库（seq 是它），你记一下」——给 WakeSink 之外的写入口用。
   *
   * 只有 `src/web/server.ts` 会调它：界面聊天框与 /dream 的 `wake/manual` 是那边直接
   * `appendSync` 落的，没经过 `this.wake()`。不补这一下，那条消息在日志与队列里都齐全，
   * 唯独 `interruptEpoch` 不动——于是她**正在说的那半截话会照旧说完**，正是 17:38 那轮的现象。
   *
   * 判据与 `wake()` 共用 `userSpokeEventTextOf`：不是人开口的（定时器、意图、心跳、后台任务）
   * 返回 null，什么都不做。**必须与落库同一个同步块里调**（调用方见 WebServerDeps.noteUserSpoke）：
   * 中间插进一个 await，speak 的那片 100ms 轮询就可能先跑到，多漏一条气泡出去。
   */
  noteUserSpokeEvent(seq: number, type: string, data: unknown): void {
    const text = userSpokeEventTextOf(type, data);
    if (text !== null) this.noteUserSpoke(text, seq);
  }

  /** 本次打断是被人开口触发的吗？是则给出他说的那句**话**与那条**唤醒**（speak 据此回执与销账） */
  userSpokeNow(): { text: string; wakeSeq: number } | null {
    return this.userSpokeNote;
  }

  stop(): void {
    this.running = false;
    this.wakeChannelData = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.heartbeatSource.stop();
  }

  async writeProjectionCache(): Promise<void> {
    const p = this.deps.projection;
    saveProjectionCache(this.deps.dataDir, p, p.lastSeq);
  }

  /**
   * 跑一拍。定时器回调与测试/宿主的手工驱动走的是同一份逻辑（不查 running），顺序不可调换：
   * 跨天记账 → 拾取加注 → 健康检查（含失败暂停置位）→ 快照判定 → 唤醒门 → 处理输入。
   */
  async tickOnce(): Promise<void> {
    await this.ensureReady();
    this.rolloverIfNeeded();
    this.settleTopUpRequests();
    await this.healthCheck();
    // 图片附件：每拍补下最近到达的（**包括 turn 进行中到达的那张**——它会立刻出现在她
    // 后续 step 的历史里）。放在 busy 检查之前：她正忙的时候恰恰是图片最容易到场的时候。
    await this.prewarmRecentAttachments();
    // 会话簿与未读：同样放在 busy 之前。她正忙时新来的群消息照样得计入未读——那一轮结束后
    // 她看到的清单要是还停在开跑前的数字，等于每次忙完都少看到几条。
    this.foldChannelEvents();
    // 她问出去、一直没人答的提问（design §6.1）：到点落一条「未批准、未拒绝」的事实。
    // 放在 busy 之前是刻意的——她正在跑的那个长 turn 里，这条事实也要及时出现在她的上下文里
    // （agent-loop 每一步都重新对齐日志），而不是等她忙完才补上。
    await this.settleHumanAsks();
    // 话痨会话的话题（v32）：门槛在里面（未读 ≥ 5 且距上次 ≥ 10 分钟），不满足时**不发请求**。
    // 同样放在 busy 之前：她正忙的时候恰恰是群里聊得最热的时候，而那时她最需要"在聊什么"。
    //
    // **群里发生提及（@ 或喊她的名字）时门槛让路**（2026-10-02 用户的口径）："发生提及、at 的时候，
    // light 模型会先审计积累消息，然后给出话题 peek，然后告示进入对话流告知 agent"——
    // 提及是"有人在叫她"，这时哪怕只攒了一两条也要给一句"那边在聊什么"，
    // 否则她只能看见被叫的那一句、看不见上下文。
    await this.summarizeChattySessions(this.mentionSidOf(this.deps.projection.pending));

    if (this.busy) return;
    // 快照判定放在 busy 之后、输入处理之前：既不在 turn 中途插事件，空转拍也能落每日快照
    await this.maybeSnapshot();
    // 人审挂起（design §4.21）：答复到位就把挂起时认领的输入送回队列（本拍就能接着跑），
    // 超过时限则按预算耗尽同等语义进入可恢复暂停。必须在 pending 检查**之前**——
    // 重入队正是那个「让 pending 非空」的动作，晚一步就要白等一拍。
    await this.settleHumanSuspension();
    const p = this.deps.projection;
    if (p.pending.length === 0) return;
    // ── 人打的指令（B1 第二步：`/compact` 与 `/handoff`）──
    // 放在攒批门与唤醒门**之前**：指令是框架自己就能办的事（收紧她的上下文 / 写一份交接笔记），
    // 既不该被群消息的攒批窗口压住，也不该被预算暂停拦住——**撞上限时人恰恰更需要它**。
    await this.handleSlashCommands();
    // 指令已把队列里那几条摘走（input/claimed），可能这一拍就没别的可做了
    if (p.pending.length === 0) return;
    // 群消息攒批（design §4.24）：单聊每句都看，群聊攒够窗口再一起看
    if (this.holdsGroupBatch(p)) return;
    if (!(await this.admitWake())) return;

    this.busy = true;
    try {
      const batch = p.pending.slice(0, BATCH_LIMIT);
      // 本批开跑前的位置：挂起因时用它把「刚刚落库的 turn/start」读回来（编号不靠猜）
      const beforeSeq = p.lastSeq;
      // 每日记忆整理：机制动作，不走模型 turn（design §4.17）
      const maintainWake = this.memoryMaintainWake(batch);
      if (maintainWake !== null) {
        await this.runMemoryMaintain(maintainWake);
        return;
      }
      const wakeEvents = batch
        .map(item => this.deps.log.get(item.wakeSeq))
        .filter((e): e is AppEvent => e !== null);
      if (wakeEvents.length === 0) return;
      // 会话簿增量（v32）：扫到水位为止，把两种通道事件与已读位都并进去。放在这里而不是
      // 只挑本批的 wakeEvents——见 sessionBook 字段上的注释（只记账的那些永远不会被认领）。
      // 它同时保证了"本批 she 要看的未读"已经算进去（这批之前的事件早在那几拍就并过了）。
      this.foldChannelEvents();
      // 回投目标绑定到本批：仅当这批里确实有通道消息时才拥有回投地址（M9）
      this.wakeChannelData = lastChannelWake(wakeEvents);
      // 注入判定（v32）：**在本轮之前**跑完并落事件——渲染层是纯函数，它只能读事件；
      // 而且"当时提示过她什么"必须可复盘。有风险才写事件，没风险一个字都不写。
      // turn 号此刻还没分配（agent-loop 在自己的 runInner 里才定），所以挂 0——
      // 与 necessity-gate 的记账同一口径：这条账的用途是观测 light 用量，不是 turn 归属。
      await this.judgeChannelWakes(wakeEvents, 0);
      // 示警落库（v25）：把"框架对她说了这句话"记成事件——GUI 卡片原样贴它，此刻层那段
      // 历史数它，而"她到底看没看见"从此是可查的事实（而不是靠推断渲染时拼了什么）。
      this.noteInjectionWarnings(wakeEvents);
      let reason: TurnEndReason;
      try {
        reason = await runTurn(this.agentDeps(wakeEvents), wakeEvents);
      } finally {
        // 无论如何都解绑：下一轮的 speak 不能再回到这一轮的会话里去。
        // 插话计数**不清零**（它只增不减，speak 每次开口时重新取基准值）。
        this.wakeChannelData = null;
        this.userSpokeNote = null;
      }
      this.write(`[循环] turn 结束：${reason.kind}`);
      // 人审挂起（design §4.21）：turn 因提问/计划审批而挂起（不是完成、也不是失败）——
      // 记下这条线索。输入已被 input/claimed 摘走，等 human/answered 到达后送回队列。
      if (reason.kind === 'blocked' && reason.by === ASK_HUMAN_BLOCKED_BY) {
        await this.noteSuspension(batch, wakeEvents, beforeSeq);
      }
      // 处理完一批真实事件 = 发生过活动：空拍复位。心跳批次不复位，退避才长得起来。
      if (wakeEvents.some(event => event.type !== 'wake/heartbeat')) this.heartbeat.noteActivity();
      if (reason.kind === 'budget-exhausted') await this.notifyBudgetExhausted(reason.layer);
    } finally {
      this.busy = false;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.tickOnce();
  }

  // ──────────────────────────────── 唤醒门 ────────────────────────────────

  /**
   * 唤醒门（design §4.6 表格里"拒绝唤醒"的三条来源）。返回 false 表示本拍不处理任何输入：
   * pending 原样留着，水位原地停住——停摆本身由水位停滞告警兜底（§4.9）。
   */
  private async admitWake(): Promise<boolean> {
    const p = this.deps.projection;

    // ① 连续模型失败达阈值：暂停 + 告警（告警已在 healthCheck 里发过，此处只管拦）
    if (!this.failAdmits()) return false;

    // ② 已撞过的 task 层刹车且未加注：可恢复暂停。turn / step 层不锁循环——它们只结束本 turn，
    //    下一个 turn 从 step 0 重新开始；把它们也当成暂停会让一次刹车永久锁死整个循环。
    if (this.guard.isPaused('task', p)) {
      await this.notifyBudgetExhausted('task');
      return false;
    }

    // ③ 每日额度：拒绝唤醒 + 告警。投影里已记过这个停顿就不再写事件（同一事实只落一条）
    const daily = this.guard.statuses(p).find(st => st.layer === 'daily' && st.over);
    if (daily !== undefined) {
      if (p.lastExhausted['daily'] === undefined) {
        this.appendSync('budget/exhausted', {
          layer: 'daily', limit: daily.limit, actual: daily.used, resumable: true,
        }, 'internal');
      }
      await this.notifyBudgetExhausted('daily');
      return false;
    }

    return true;
  }

  // ──────────────────────────────── 指令（B1 第二步） ────────────────────────────────

  /**
   * 人打进来的那两条指令：`/compact` 与 `/handoff`（解析口径见 `slash-commands.ts` 的文件头）。
   *
   * **当场执行，不唤醒 turn**：人要的是"现在压一次"或"现在把交接写下来"，不是要她回话。
   * 所以这条路既不写 `turn/start` 也不调模型——它只把那条输入摘出队列、落一条留痕、
   * 把事办掉、回收据。三条边界：
   *
   *   • **只认本机对话流**（`wake/manual`）：`wake/channel` 是外面递进来的话，群里谁都能打
   *     `/compact`——让外部文字决定"她该忘掉什么"是把改她自己上下文的能力交给了外人；
   *   • **不认框架自己拼的那条**（`via: 'dream'`）：那是框架指令（见 web/server.ts 的 dream），
   *     不是人打的字。它的正文万一哪天以斜杠开头，也不该被当成人在按按钮；
   *   • **不认识的词不回给模型**：回一句"没有这个指令 <name>"并列出手上的两个
   *     （不打这句回话就等于让用户以为按钮坏了——`/dream` 那次"按了没反应"的教训）。
   *
   * 返回处理掉的条数（调用方据此判断这一拍还有没有别的活）。
   */
  private async handleSlashCommands(): Promise<number> {
    const pending = this.deps.projection.pending;
    let handled = 0;
    for (const item of pending.slice(0, BATCH_LIMIT)) {
      const wake = this.deps.log.get(item.wakeSeq);
      if (wake === null) continue;
      // 判据只有一份（`isSlashCommandEvent`：只认本机对话流里整条就是指令的那些），
      // 这里再解一次是为了拿到 kind/name/argument——短字符串，多解一次换来的是"两处不会漂移"
      if (!isSlashCommandEvent(wake)) continue;
      const command = parseSlashCommand((wake.data as { note: string }).note);
      if (command === null) continue; // 与上面同一判据，理论上到不了这里
      await this.runSlashCommand(command, item);
      handled += 1;
    }
    return handled;
  }

  /**
   * 执行一条指令：**消费输入 → 真办事 → 落留痕 → 回收据**。
   *
   * 顺序里有两处是刻意的：
   *   • **先消费再算遮蔽点**：队列里剩下的输入就是"还没轮到她看的那些"，遮蔽点必须停在它们
   *     之前（见 {@link slashCoverFloor}）。反过来的话，这一拍刚到的那句话会被自己人的
   *     `/compact` 一起遮掉；
   *   • **先算计划再落留痕**：`slash/handled.coveredUpToSeq` 要与紧随其后的
   *     `compaction/summary` 是同一个数——两个数对不上，事后读日志就得猜哪个是真的。
   */
  private async runSlashCommand(command: SlashCommand, item: PendingInput): Promise<void> {
    // ① 消费这条输入。指令不唤醒 turn，所以不写 turn/start 与 turn/end，只把它摘出队列。
    //    turn 挂 0 是既有的"这条账不是 turn 归属"口径（与 judgeChannelWakes 的先例一致）。
    //    不摘的后果很具体：下一拍它还在 pending 里，下一个 turn 会把它当普通消息送进模型，
    //    她就得对着 "/compact" 猜用户想干什么——那正是 B1 写明不许发生的事。
    this.appendSync('input/claimed', {
      turn: 0, wakeSeqs: [item.wakeSeq], claimCounts: [item.claimCount],
    }, 'internal');

    // ② 真办事。`unknown` 什么都不做；两条真指令共用**同一条落库路径**（见 planSlashCompaction）
    const plan = command.kind === 'unknown' ? null : await this.planSlashCompaction();
    const outcome = command.kind === 'unknown' ? 'rejected' : plan === null ? 'empty' : 'compacted';
    // 回执在落账**之前**定下来：它要逐字进 `slash/handled`（日志是唯一真相源，
    // 回执不能只活在告警文件里），同时也要发给用户（见下面③）。
    const receipt = command.kind === 'unknown'
      ? unknownCommandReply(command.name)
      : plan === null
        ? (command.kind === 'compact' ? COMPACT_EMPTY_RECEIPT : HANDOFF_EMPTY_RECEIPT)
        : (command.kind === 'compact' ? COMPACT_RECEIPT : HANDOFF_RECEIPT);
    const trace = this.appendSync('slash/handled', {
      kind: command.kind,
      name: command.name,
      argument: command.argument,
      outcome,
      inputSeq: item.wakeSeq,
      ...(plan === null ? {} : { coveredUpToSeq: plan.coveredUpToSeq }),
      receipt,
    }, 'internal');
    if (plan !== null) {
      // 与自动压缩写的是**同一种事件、同一份 payload**（`{coveredUpToSeq, summary}`）。
      // 可见性取 model（与 defaultVisibility('compaction/summary') 同值）：摘要要进她的上下文，
      // 这是"下一个 turn 读得到"的唯一通道（render 的 renderMemoryLayer 只认这个事件）。
      // 信封上的 origin 是 runtime/real-loop（不是 web/api），所以界面把它渲染成
      // 「上下文在此处压缩」而不是人工 reset（见 gui 的 _isManualReset）——这一次确实是压缩。
      this.appendSync('compaction/summary', plan, 'model');
      this.deps.log.flush();
    }

    // ③ 送给人。走**现有回执通道**：告警出口（文件档 + webhook + `alarm/sent` 事件）。
    //    为什么是它而不是别的：框架要"对用户说一句"的既有路径只有两条——`this.write` 只到本机
    //    控制台（她也看不见），而告警出口是唯一一条真能送到人手上的（`notifyBudgetExhausted`、
    //    `settleTopUpRequests`、人审挂起都用它）。用 `alert` 而不是 `fail`：回执不是故障，
    //    `fail` 会登记 stall 并在之后配一条莫名其妙的"已恢复"。
    //    指纹里带上留痕的 seq：**每一次按下都要有回答**——限流把回执吞掉，在界面上就是
    //    "按了没反应"（`/dream` 那次事故的教训）。人不会连按这个按钮，宁可多发一条。
    //
    //    注意 `alarm/sent` 只装 title（回执正文在文件档与 webhook 里）——所以正文另行逐字
    //    落在 `slash/handled.receipt` 上，日志自己就说得清当时回了什么。
    this.write(`[指令] /${command.name} → ${outcome}${plan === null ? '' : `（遮蔽至 seq ${plan.coveredUpToSeq}）`}`);
    await this.notifier.alert({
      category: 'slash-command',
      level: 'info',
      title: command.kind === 'unknown' ? `不认识的指令 /${command.name}` : `已执行 /${command.name}`,
      body: receipt,
      params: { kind: command.kind, seq: trace.seq },
    });
  }

  /**
   * 立刻压一次（`/compact` 与 `/handoff` **共用**这一条）：越过阈值判断，其余照抄自动压缩
   * 那条路（`agent-loop.maybeCompact`）——同一份笔记渲染、同一份遮蔽点口径、同一个事件。
   *
   * 为什么 `/handoff` 也走这里（2026-10-04 接线时才定下的事实，报告里要写清）：
   * 交接笔记**只有**写进 `compaction/summary` 才会被下一个 turn 读到。渲染层只在长期记忆层
   * 里渲染这个事件（`model/render.ts` 的 `renderMemoryLayer`），而且要求 `coveredUpToSeq`
   * 严格大于已有值——不遮蔽就不渲染。所以两条指令的效果都是"写一份交接笔记并把截至此刻的
   * 往来遮蔽掉"，区别只在**人按它的理由**：一个是"接下来要干长活，先把上下文收紧"，
   * 一个是"我要关机器了，把交接写下来"。收据文案按这个事实写（见 slash-commands.ts）。
   */
  private async planSlashCompaction(): Promise<{ coveredUpToSeq: number; summary: string } | null> {
    // 全量读日志。笔记的条目来自**全部**事件，所以这一次读是必要的——它与
    // `runMemoryMaintain` 的 `maxTurnInLog` 同一个量级，而且只在人真的按下指令时发生。
    // 自动压缩那条路用的是 turn 内的增量快照，因为它本来就每步同步一次；这里没有那个快照。
    //
    // **必须过同一把刀**（`contextEventFilter`）：自动压缩喂给笔记的是**过滤后**的事件
    // （agent-loop 的 syncEvents 走 eventFilter），两条路给笔记喂的得是同一种东西。
    // 少这一刀会漏一件很具体的事：笔记会把"用户打了 /handoff 换班"当成一条 user 消息收进去，
    // 而笔记进她的上下文——于是那条指令**绕开 eventFilter 又回到了她眼前**。
    const events: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (contextEventFilter(event)) events.push(event);
    }

    const note = renderHandoffNote(events, handoffOptionsOf({
      budgetTokens: this.deps.config.persona.handoffBudgetTokens,
      foldTokens: this.deps.config.persona.handoffFoldTokens,
    }));
    // 一条条目都装不进去就**不写**：只有标题的空摘要会把它覆盖的那段历史遮掉却不留替代品，
    // 那是净损失。如实回一句"什么都没压"，上下文原样不动。
    if (note.included === 0) return null;

    return {
      coveredUpToSeq: compactionCoveredUpToSeq(events, null, this.slashCoverFloor()),
      summary: note.text,
    };
  }

  /**
   * 手动压缩的遮蔽点**下界**（`compactionCoveredUpToSeq` 的 `floorSeq`）：
   * **队列里还没处理的输入不能被遮蔽**——它们还没轮到她看，遮掉就是吞了用户的话
   * （而且不是"进了摘要"，是连摘要都来不及收录：笔记在它们之前就渲染好了）。
   * 队列空了才允许"遮到此刻"（`projection.lastSeq`）——那正是"把到这一刻为止的往来
   * 收紧成一份笔记"的字面意思。
   */
  private slashCoverFloor(): number {
    const pending = this.deps.projection.pending;
    if (pending.length === 0) return this.deps.projection.lastSeq;
    let oldest = Number.POSITIVE_INFINITY;
    for (const item of pending) {
      if (item.wakeSeq < oldest) oldest = item.wakeSeq;
    }
    return Math.max(0, oldest - 1);
  }

  /**
   * 失败刹车放行判定：未达阈值即放行；已达阈值时只在半开冷却期满后放行一次试探——
   * 成功一次投影里的 failStreak 自然归零（fold 的口径），于是暂停自动解除。
   */
  private failAdmits(): boolean {
    if (this.deps.projection.failStreak < this.failStreakMax) return true;
    if (this.failPausedAtMs === null) return false; // 本拍刚进入暂停（healthCheck 已置位）
    const nowMs = this.deps.now().getTime();
    if (nowMs - this.failPausedAtMs < this.failCooldownMs) return false;
    if (nowMs - this.lastFailProbeMs < this.failCooldownMs) return false;
    this.lastFailProbeMs = nowMs;
    return true;
  }

  // ──────────────────────────────── 健康检查与告警 ────────────────────────────────

  /**
   * 每拍检查两条与"活不活"有关的事实（§4.9 触发点清单）：
   *   - 水位停滞：有输入进来却超过阈值没有一次成功模型调用；
   *   - 连续模型失败：达阈值即置暂停位并告警（放行动作在 failAdmits）。
   * 两条都在恢复时发"已恢复"通知（M3-7）：故障期间被限流压制，恢复时恰好说一次。
   */
  private async healthCheck(): Promise<void> {
    const p = this.deps.projection;

    const stall = this.stallReport(p);
    if (stall === null) {
      await this.notifier.ok(CATEGORY.stall, '水位恢复正常：等待中的输入已被处理。');
    } else {
      await this.notifier.fail({
        category: CATEGORY.stall,
        level: 'warn',
        title: `水位停滞：有输入等了 ${Math.floor(stall.waitedMs / 60_000)} 分钟没被处理`,
        body: `最早一条待处理的输入到于 ${stall.oldestPendingAt}，已经等了 ${Math.floor(stall.waitedMs / 60_000)} 分钟`
          + `（队列里现有 ${stall.pending} 条，循环手上没有活）。`
          + '循环可能被预算暂停卡住，或模型侧一直失败。',
        params: { pending: stall.pending > 0 },
      });
    }

    const fail = p.failStreak >= this.failStreakMax ? p.failStreak : null;
    if (fail === null) {
      this.failPausedAtMs = null;
      await this.notifier.ok(CATEGORY.failStreak, '模型调用已恢复成功：连续失败计数归零。');
    } else {
      await this.enterFailPause(fail);
    }
  }

  private async enterFailPause(actual: number): Promise<void> {
    if (this.failPausedAtMs !== null) return; // 已在暂停中：不重复告警（限流是第二道保险）
    this.failPausedAtMs = this.deps.now().getTime();
    await this.notifier.fail({
      category: CATEGORY.failStreak,
      level: 'critical',
      title: `模型连续失败 ${actual} 次：已暂停唤醒`,
      body: `连续 ${actual} 次模型调用失败（阈值 ${this.failStreakMax}）。单次调用的退避重试由模型客户端负责，`
        + `这里按刹车语义暂停唤醒：冷却 ${Math.round(this.failCooldownMs / 60_000)} 分钟后自动试探一次。`,
      params: { actual },
    });
  }

  /**
   * 撞刹车告警（§4.9「撞到任何一层刹车」）。暂停不是失败：正文里给恢复动作。
   *
   * **这是"到上限了"给人看的唯一一句话**——三条路都汇到这里（turn 收尾的结局、
   * task 层暂停、daily 层拒绝唤醒），所以它必须一次说全五件事：
   * **哪一档 + 上限多少 + 已用多少 + 这一档锁没锁住循环 + 两条出路**。
   * 只说"到上限了"等于把人扔在半路：他既不知道该去哪儿调，也不知道还能加注。
   *
   * 两条出路都是**已有的机制**，这里只是把它们说出来：
   *   ① 「设置 → 系统」里改那一档（`budget.stepTools` / `turnSteps` / `taskTokens` / `dailyTokens`，
   *      与界面上那几行的标签逐字对齐——见 {@link BUDGET_LAYER_FACTS}）；它是启动参数，
   *      改完要重启进程才生效；
   *   ② `irmia topup --layer <层> --tokens <N>`（`runtime/topup.ts` 的看门文件，循环下一拍拾取，
   *      不用重启）。加注是**抬高上限**，不是清零消耗——进度一个字节都不动。
   *
   * 标题里也带上"哪一档 + 已用 / 上限"：事件列表只显示标题（正文在告警文件与 webhook 里，
   * 界面「告警」面板读的是文件），只写"预算耗尽"就又回到了"到上限了、没有下一步"。
   * 全文不含任何价格 / 货币口径（只有 token 与次数）。
   */
  private async notifyBudgetExhausted(layer: BudgetLayer): Promise<void> {
    const status = this.guard.statuses(this.deps.projection).find(st => st.layer === layer);
    const used = status?.used ?? 0;
    const limit = status?.limit ?? 0;
    const facts = BUDGET_LAYER_FACTS[layer];
    // 这一档锁不锁循环（budget-guard 的四层语义）：step / turn 只结束本 turn，
    // task / daily 会拒绝唤醒。说错这一句，人会以为整个循环死了。
    const state = layer === 'task' || layer === 'daily'
      ? `循环已暂停唤醒：队列里现有 ${this.deps.projection.pending.length} 条输入原地留着（可恢复，不清空重来）。`
      : '这一档只结束当前 turn：下一个 turn 从第 1 步重新开始，循环没有被锁住。';
    await this.notifier.fail({
      category: CATEGORY.budget,
      level: 'critical',
      title: `预算耗尽（${facts.name}）：已用 ${used} / 上限 ${limit}`,
      body: `${facts.name}这一档到上限了：已用 ${used} / 上限 ${limit}。${state}`
        + `两条出路：① 去「设置 → 系统」把「${facts.field}」调大——${facts.scope}；`
        + '它是启动参数，改完要重启进程才生效。'
        + `② 加注：irmia topup --layer ${layer} --tokens <N> —— 不用重启，循环下一拍拾取后接着跑。`,
      params: { layer },
    });
  }

  // ──────────────────────────────── 加注 ────────────────────────────────

  /** 拾取 CLI 写下的加注看门文件：先落 `budget/topped-up` 事件，再删文件（顺序反了就是丢加注） */
  private settleTopUpRequests(): void {
    const dir = join(this.deps.dataDir, TOPUP_WATCH_DIR_NAME);
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter(name => name.startsWith(TOPUP_FILE_PREFIX) && name.endsWith('.json'))
        .sort();
    } catch {
      return; // 目录不存在：没人加注过
    }
    for (const name of names) {
      const path = join(dir, name);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const request = parseTopUpRequest(raw);
      if (request === null) {
        this.write(`[预算] 加注看门文件非法，已跳过：${name}`);
        continue;
      }
      // 走 guard.resume 写事件（预算域的 API）：它同时解除该层的暂停态并重新武装软提示
      this.guard.resume(request.layer, request.by, request.addedTokens);
      this.topUps[request.layer] += request.addedTokens;
      if (!this.guardIsInjected) this.guard = this.makeGuard();
      try {
        unlinkSync(path);
      } catch (err) {
        // 事件已落盘，文件没删掉只会导致下一拍重复加注：宁可重复也不能丢，留痕即可
        this.write(`[预算] 删除加注看门文件失败（下一拍会重复加注）：${String(err)}`);
      }
      this.write(`[预算] 已加注 ${request.layer} 层 ${request.addedTokens}（by ${request.by}），暂停态解除`);
      void this.notifier.ok(CATEGORY.budget, `已人工加注 ${request.layer} 层 ${request.addedTokens} token，恢复运行。`);
    }
  }

  /**
   * 跨天写 budget/rollover（fold 不读时钟，边界由运行时写事件）。
   *
   * **"上次记的是哪天"以投影为准，不是进程内存**。这里原来只看一个内存字段，而它每次启动
   * 都是 null —— 于是每启动一次就写一条 rollover，`fold` 收到它就把当日计数清零一次。
   * 表现是运行情况页的「今日 token」老是 0、缓存命中率显示 `-`（0/0），而同一页的 hourly
   * 曲线（从事件重算、不经过这条路径）一切正常；今天重启三次就归零三次。
   * 记账边界是事实，事实以日志为准——投影就是它的折叠结果。
   */
  private rolloverIfNeeded(): void {
    const today = this.deps.now().toISOString().slice(0, 10);
    // 投影是同步折叠的：写过之后它立刻就是 today，同一进程内也不会重复写
    if (this.deps.projection.budget.date === today) return;
    this.appendSync('budget/rollover', { date: today }, 'internal');
    // 跨天 = 日额度自然恢复：把每日层的暂停一并解除（addedTokens:0 表示不是人工加注）
    if (this.deps.projection.lastExhausted['daily'] !== undefined) {
      this.appendSync('budget/topped-up', { layer: 'daily', addedTokens: 0, by: 'rollover' }, 'internal');
    }
  }

  // ──────────────────────────────── 水位停滞 ────────────────────────────────

  /**
   * 水位停滞：队列里有输入，而**它自己**已经等了超过 stallMs 没人管。
   *
   * 判据与阈值都在 `budget-guard.ts` 的 {@link stallOf}（唯一一份实现）。这里只负责把
   * 「最早那条输入是哪一刻到的」从日志里取出来——pending 里存的是 wakeSeq，到达时刻在它
   * 对应的那条 wake 事件上（与 `holdsGroupBatch` 读 ts 是同一口径）。
   *
   * 三条刻意的否定条件：
   *   • `lastModelSuccessAt === null` 不再是"停滞"：那是"从来没成功过"，由失败刹车负责
   *     （两条判据分工不清就会在冷启动时误报）；
   *   • 循环手上有活（busy / openTurn）时不判：一个跑着工具的长 turn 里积压输入是正常背压；
   *   • 一条到达时刻都读不出来时不判：宁可漏报一次，也不拿当前时刻编一个等待时长。
   */
  private stallReport(p: Projection): StallInfo | null {
    if (p.pending.length === 0) return null;
    let oldestMs = Number.POSITIVE_INFINITY;
    let oldestAt: string | null = null;
    for (const item of p.pending) {
      const event = this.deps.log.get(item.wakeSeq);
      if (event === null) continue;
      const at = Date.parse(event.ts);
      if (Number.isFinite(at) && at < oldestMs) {
        oldestMs = at;
        oldestAt = event.ts;
      }
    }
    return stallOf({
      pending: p.pending.length,
      oldestPendingAt: oldestAt,
      busy: this.busy || p.openTurn !== null,
      now: this.deps.now(),
      stallMs: this.stallMs,
    });
  }

  // ──────────────────────────────── 她问的人没答（design §6.1） ────────────────────────────────

  /**
   * 她问出去、一直没人答的提问：落一条「**未批准、未拒绝**」的事实（`human/expired`）。
   *
   * 四条口径，每条都是刻意的：
   *   ① **超时不产生决定**：不写 `human/answered`（那等于伪造"人答过了"）、不写批准也不写拒绝、
   *      更**不撤卡**——卡还在台面上，人回来照样能答（§6.1："只是未有批准或拒绝动作"）。
   *   ② **只落一次**：判据是投影里的 `expiredAt`（由 `human/expired` 折出来），重启后从日志重建，
   *      所以停机期间不会重复落、进程内也不会。
   *   ③ **只认她问的**（source: 'agent'）：系统/计划那条挂起有自己的 24h 超时与"任务层暂停"，
   *      两条混在一起就是两套语义互相伪造。
   *   ④ **让她得知**：事件可见性 model，渲染成「人可能不在」（model/render.ts）。要不要换个方式
   *      找人是她的判断——本方法一个字都不替她决定。
   *
   * 它跑在 `busy` 检查**之前**（见 tickOnce）：她正在做的那个长 turn 里，这条事实也该及时到位
   * （agent-loop 每一步都会重新对齐日志），而不是等她忙完才出现在下一拍。
   */
  private async settleHumanAsks(): Promise<void> {
    const nowMs = this.deps.now().getTime();
    for (const ask of this.deps.projection.humanAsks) {
      if (ask.source !== 'agent') continue;
      if (ask.expiredAt !== null) continue;
      if (!humanTimeoutElapsed(ask.at, nowMs, this.askHumanTimeoutMs)) continue;
      const askedMs = Date.parse(ask.at);
      this.appendSync('human/expired', {
        askSeq: ask.seq,
        question: ask.question,
        turn: ask.turn,
        source: ask.source,
        // waitedMs 取"此刻 - 提问时刻"而不是超时线本身：事实是"到这一刻还没人答"，
        // 线只是判据。时钟读不出来（ts 坏了）时退回超时线，绝不编一个数
        waitedMs: Number.isNaN(askedMs) ? this.askHumanTimeoutMs : Math.max(0, nowMs - askedMs),
        timeoutMs: this.askHumanTimeoutMs,
      }, 'model');
      this.write(
        `[人审] 她问的「${ask.question.length > 40 ? `${ask.question.slice(0, 40)}…` : ask.question}」`
        + `超过 ${Math.round(this.askHumanTimeoutMs / 60_000)} 分钟`
        + '没人答复：已落一条「未批准、未拒绝」的事实（卡不撤，人回来照样能答）',
      );
    }
  }

  // ──────────────────────────────── 人审挂起（design §4.21） ────────────────────────────────

  /**
   * 人审挂起的两条出路，每拍在一处结算：
   *   ① **答复到达**：解除挂起留下的 task 层暂停，并把挂起 turn 认领过的输入写成
   *      `input/requeued{reason:'human-answered'}` 送回队列——它们已被 input/claimed 摘走，
   *      不送回去就再也没人叫醒它（挂起期间 pending 是空的）。
   *   ② **超时未答**：按 budget-exhausted 同等语义暂停（写 `budget/exhausted{layer:'task'}`），
   *      下一拍的唤醒门就会拦住所有输入；答复或人工加注都能解除它。
   */
  private async settleHumanSuspension(): Promise<void> {
    const s = this.suspension;
    if (s === null) return;
    if (s.answeredAt === null) s.answeredAt = await this.detectAnswer(s.askedAt);
    if (s.answeredAt === null) {
      await this.maybeTimeoutHuman(s);
      return;
    }

    // 人事已了：「挂起吃掉了 task 层」这条暂停理由不再成立，随答复一起解除。
    // addedTokens:0 = 不是人工加注（与 rollover 解除日额度同一口径，不伪造加注量）。
    if (this.deps.projection.lastExhausted['task'] !== undefined) {
      this.appendSync('budget/topped-up', { layer: 'task', addedTokens: 0, by: 'human-answer' }, 'internal');
      void this.notifier.ok(CATEGORY.human, '人审挂起已得到答复：任务层暂停已解除。');
    }
    this.appendSync('input/requeued', {
      wakeSeqs: s.wakeSeqs,
      claimCounts: s.claimCounts,
      sources: s.sources,
      reason: 'human-answered',
    }, 'internal');
    this.write(`[人审] turn ${s.turn} 的答复已到位：${s.wakeSeqs.length} 条输入已重新入队`);
    this.suspension = null;
  }

  /** 超时判定与落库。同一事实只落一条事件（投影里已有 task 层耗尽就不再写） */
  private async maybeTimeoutHuman(s: TrackedSuspension): Promise<void> {
    const p = this.deps.projection;
    if (p.lastExhausted['task'] !== undefined) return;
    if (!humanTimeoutElapsed(s.askedAt, this.deps.now().getTime(), this.humanTimeoutMs)) return;
    this.appendSync('budget/exhausted', {
      layer: 'task',
      // 上限与已用一律走预算层自己的口径：循环层凭空填数字就是伪造事实
      limit: this.guard.limitOf('task'),
      actual: this.guard.actualOf(p, 'task'),
      resumable: true,
    }, 'internal');
    const hours = Math.round(this.humanTimeoutMs / 3_600_000);
    this.write(`[人审] 挂起超过 ${hours} 小时未得到答复：任务层按预算耗尽同等语义暂停`);
    await this.notifier.fail({
      category: CATEGORY.human,
      level: 'critical',
      title: `人审挂起超过 ${hours} 小时：任务层已暂停`,
      body: `turn ${s.turn} 从 ${s.askedAt} 起一直在等人回答「${s.question}」，已超过 ${hours} 小时的挂起上限。`
        + '按预算耗尽同等语义处理：任务层暂停、pending 一条不动（resumable）。'
        + '答复（irmia answer / Web 卡片）会自动解除这个暂停；也可以直接加注解除。',
      params: { layer: 'task' },
    });
  }

  /**
   * 答复探测（增量扫日志）。返回答复时刻；还没答复返回 null。
   *
   * 为什么不看投影的 waitingHuman：写事件的路径有两条——Web 的 appendSync 会当场折投影，
   * 而 CLI 的 answer 是在停机期间写下的，只有重启后 fold 才看得见。把「人答过了」这件事实
   * 押在某个投影是否被即时更新上，会把停机期的答复误判成「还在等」，然后白暂停一次。
   */
  private async detectAnswer(askedAt: string): Promise<string | null> {
    const asked = Date.parse(askedAt);
    let found: string | null = null;
    for await (const event of this.deps.log.readRange(this.humanCursor + 1)) {
      if (event.seq > this.humanCursor) this.humanCursor = event.seq;
      if (found !== null || event.type !== 'human/answered') continue;
      if (Number.isNaN(asked) || Date.parse(event.ts) >= asked) found = event.ts;
    }
    return found;
  }

  /** turn 因人审挂起而结束：把「谁的输入在等」记成进程态线索（事实本身已在日志里） */
  private async noteSuspension(
    batch: readonly PendingInput[],
    wakeEvents: readonly AppEvent[],
    beforeSeq: number,
  ): Promise<void> {
    // 挂起的那条提问从投影的队列里取（**只认系统来源**：她自己的提问不挂起，§6.5）。
    // 不能再用 waitingHuman 那一份——它是派生视图，取不到 askSeq。
    const ask = [...this.deps.projection.humanAsks].reverse().find(item => item.source !== 'agent') ?? null;
    // 投影没折到 human/asked 时（宿主可以只 append 不折）就从日志把刚写的 turn/start 读回来：
    // turn 号是恢复期退回输入与 replay 定位的键，不能靠猜
    const turn = ask !== null ? ask.turn : await this.turnOfRun(beforeSeq);
    this.suspension = {
      turn,
      // 0 = 这一刻不知道（宿主只 append 不折投影）。它不参与任何判定：答复走 CLI/Web 时
      // 按日志现扫（answerHuman 的 scanSuspension），那里拿得到真实的 seq
      askSeq: ask?.seq ?? 0,
      askedAt: ask?.at ?? this.deps.now().toISOString(),
      question: ask?.question ?? '',
      wakeSeqs: batch.map(item => item.wakeSeq),
      claimCounts: batch.map(item => item.claimCount),
      sources: wakeEvents.map(event => wakeSourceOf(event.type)),
      answeredAt: null,
    };
    this.write(`[人审] turn ${turn} 挂起等答复（${batch.length} 条输入待重入）`);
  }

  /** 刚跑完那个 turn 的编号（从 seq > beforeSeq 的 turn/start 读回） */
  private async turnOfRun(beforeSeq: number): Promise<number> {
    let turn = 0;
    for await (const event of this.deps.log.readRange(Math.max(1, beforeSeq + 1))) {
      if (event.type === 'turn/start' && event.data.turn > turn) turn = event.data.turn;
    }
    return turn;
  }

  // ──────────────────────────────── 折叠快照（M5-9） ────────────────────────────────

  /**
   * 写快照的两个触发点（design §4.12 的体量盘算）：
   *   ① **每天首次**（含启动后第一拍与跨天第一拍）：一天一个基线，冷启动最多重放一天的事件；
   *   ② **每 snapshotEveryEvents 条事件**：跑得猛的实例不必等到第二天。
   *
   * 顺序不可颠倒：**先写快照文件、再写 `snapshot/checkpoint` 事件**。于是事件里的 upToSeq
   * 恒小于该事件自身的 seq，恢复时它会被增量重放一遍（fold 里只更新 lastArchiveAt，结果一致）；
   * 反过来先写事件再写快照，事件声明的 upToSeq 就可能落在快照覆盖范围之外。
   *
   * 写失败只留一行日志：快照是派生数据（可删可重建），它的失败不该拖垮循环。
   */
  private async maybeSnapshot(): Promise<void> {
    const p = this.deps.projection;
    if (p.lastSeq === 0) return; // 还没有任何事件：没有可快照的东西
    const today = this.deps.now().toISOString().slice(0, 10);
    const firstOfDay = this.lastSnapshotDate !== today;
    const enoughEvents = p.lastSeq - this.lastSnapshotSeq >= this.snapshotEveryEvents;
    if (!firstOfDay && !enoughEvents) return;

    try {
      const written = await writeSnapshot(this.deps.dataDir, p);
      // 记账先于写事件：即使下面这条事件写失败，本进程也不会对同一位置反复写快照
      this.lastSnapshotSeq = written.upToSeq;
      this.lastSnapshotDate = today;
      this.appendSync('snapshot/checkpoint', { upToSeq: written.upToSeq, file: written.file }, 'internal');
      this.write(`[快照] 已写 ${written.file}（覆盖至 seq ${written.upToSeq}，${written.bytes} 字节）`);
    } catch (err) {
      this.write(`[快照] 写入失败，本轮跳过（下一个触发点重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ──────────────────────────────── 启动预热 ────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (this.ready === null) this.ready = this.warmUp();
    await this.ready;
  }

  /** 从日志重建四样跨重启的东西：告警限流窗口（M3-10）、人工加注累计（M3-5）、技能信任表（§4.19）与 turn 号 */
  private async warmUp(): Promise<void> {
    const events: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) events.push(event);
    this.notifier.restore(events);
    // 会话簿：从两种通道事件（叫她的 / 只记账的）与已读位折叠——
    // warmUp 本来就要读全量日志，顺手算，零额外扫描。
    this.sessionBook = collectSessionsFromLog(events);
    // 游标跟着全量折叠一起前移：不设的话下一拍会把刚折过的历史**再折一遍**（条数翻倍）
    this.channelBookSeq = this.deps.projection.lastSeq;
    // 注入预警与话题也在这趟全量读里补齐（内存表重启后是空的，而事件还在盘上）：
    // 预警必须能贴回它那条消息，话题必须能在清单上缀出来——两样都不现扫日志。
    for (const event of events) {
      if (event.type === 'injection/flagged') {
        this.flaggedNotes.set(event.data.messageId, {
          note: noteForFlagged(event.data), by: event.data.by,
          reason: event.data.reason, quotes: event.data.quotes,
        });
      } else if (event.type === 'injection/noted') {
        this.notedMessageIds.add(event.data.messageId);
      } else if (event.type === 'channel/topic' && event.data.topic.trim() !== '') {
        this.channelTopics.set(event.data.sid, event.data.topic);
        this.topicSeq.set(event.data.sid, event.data.toSeq);
      }
    }
    // 人审挂起的重建（design §4.21）：答复常常是在实例停机期间写下的（CLI answer 与
    // review resolve 同一条纪律：两个进程各自 nextSeq 必然撞号），所以冷启动必须能从日志
    // 还原出「哪个 turn 挂着、它认领了哪些输入」，否则那些输入永远回不了队列。
    const lastSeq = events.length === 0 ? 0 : events[events.length - 1]!.seq;
    this.humanCursor = lastSeq;
    const hanging = scanSuspension(events);
    if (hanging.waiting !== null) {
      this.suspension = { ...hanging.waiting, answeredAt: null };
      this.write(`[人审] 重启时仍有挂起：turn ${hanging.waiting.turn} 等「${hanging.waiting.question}」（${hanging.waiting.wakeSeqs.length} 条输入待重入）`);
    } else if (hanging.answered !== null) {
      // 答复已写下但输入还没回到队列：直接进入「待重入」状态，下一拍就把它办完
      this.suspension = { ...hanging.answered.suspension, answeredAt: hanging.answered.at };
      this.write(`[人审] 停机期间收到答复（「${hanging.answered.answer}」）：turn ${hanging.answered.suspension.turn} 的输入将重新入队`);
    }
    this.setTopUps(foldTopUps(events));
    // 信任门的真相源是日志：重启后谁被确认过必须原样重建，否则已生效的 skill 会集体掉出 catalog
    this.skills?.setTrustEvents(events);
    for (const event of events) {
      if (event.type === 'turn/start' && event.data.turn >= this.nextTurn) this.nextTurn = event.data.turn + 1;
    }
    // 布防放在最后：它要读定时器表（表由宿主在构造前 load 过），而且只该布一次
    await this.ensureMemoryMaintainTimer();
  }

  // ──────────────────────────────── 每日记忆整理（design §4.17） ────────────────────────────────

  /**
   * 布防每日整理任务（§4.22 的 cron 语义）。幂等靠定时器表本身：重启后表里已有同类条目
   * 就不再注册——否则每启动一次多一个条目，整理任务会越跑越密。
   * cron 只在启动时读一次：它决定"什么时候做后台维护"，不是运行期要热更的开关。
   */
  private async ensureMemoryMaintainTimer(): Promise<void> {
    const timers = this.deps.timers;
    if (timers === undefined) return;
    const cron = this.memoryMaintainCron.trim();
    if (cron === '') {
      this.write('[记忆整理] wake.memoryMaintainCron 为空：每日整理任务未布防');
      return;
    }
    const existing = timers.list().find(entry => isMemoryMaintainPayload(entry.payload));
    if (existing !== undefined) {
      this.write(`[记忆整理] 每日整理已在表里（${existing.cron ?? existing.at ?? '无到期时刻'}，id=${existing.timerId}）`);
      return;
    }
    const result = await timers.set({ cron, payload: { kind: MEMORY_MAINTAIN_PAYLOAD_KIND } });
    if (!result.ok) {
      this.write(`[记忆整理] 布防失败（cron=${cron}）：${result.error}`);
      return;
    }
    this.write(`[记忆整理] 已布防每日整理（cron=${cron}，id=${result.id}）`);
  }

  /**
   * 本批输入里是不是"每日整理"定时器唤醒：是就把它摘出来单独处理，不混进模型 turn。
   *
   * **先认事件里带的 payload，再回退查表**。只查表是不够的：`at` 型定时器触发后条目就被
   * 删了，`timers.get(timerId)` 拿到 null，于是它的 payload 判不出来——`/dream` 排的唤醒
   * 会跑成普通 turn，她自己 `set_timer` 布的"到点提醒我做什么"也一并失效。
   * cron 型条目触发后保留，所以回退那半仍然有用（也兼容旧日志）。
   */
  private memoryMaintainWake(batch: readonly PendingInput[]): AppEvent | null {
    for (const item of batch) {
      const event = this.deps.log.get(item.wakeSeq);
      if (event === null || event.type !== 'wake/timer') continue;
      if (isMemoryMaintainPayload(event.data.payload)) return event;
      if (this.deps.timers === undefined) continue;
      const entry = this.deps.timers.get(event.data.timerId);
      if (entry !== null && isMemoryMaintainPayload(entry.payload)) return event;
    }
    return null;
  }

  /**
   * 跑一次整理。事件骨架与普通 turn 同形（turn/start → input/claimed →
   * memory/maintained → turn/end），崩溃恢复的口径因此完全一致：未闭合时 recover 补
   * turn/end{interrupted} 并把这条唤醒退回队列，下一拍重试整理——episode 已归档则无事可做，天然幂等。
   */
  private async runMemoryMaintain(wake: AppEvent): Promise<void> {
    const p = this.deps.projection;
    // 普通 turn 的号由 agent-loop 分配，这里取"两者较大值"，避免与它撞号（日志仍是唯一真相源）
    const turn = Math.max(this.nextTurn, (await this.maxTurnInLog()) + 1);
    this.nextTurn = turn + 1;
    const item = p.pending.find(candidate => candidate.wakeSeq === wake.seq);
    this.appendSync('turn/start', { turn }, 'internal');
    this.appendSync('input/claimed', {
      turn, wakeSeqs: [wake.seq], claimCounts: [item?.claimCount ?? 0],
    }, 'internal');
    let reason: TurnEndReason = { kind: 'completed' };
    try {
      // **人主动要的那次要 force**（2026-10-04 修的「/dream 按了没反应」）：
      // 常规整理只挑 `episodes/` 里**超过 7 天**的流水账（"过期才并"是设计），而 `/dream`
      // 的语义是"现在就做一次"——不 force 的话，只要没有过期流水账它就安静地空转
      // （`ops` 全 0、`diaryFile: null`），用户那边看起来就是按了没反应。判据用 payload 里的
      // `by: "human"`（web 那条路排的定时器带这个标记，见 web/server.ts 的 dream 动作）。
      const wakePayload = wake.type === 'wake/timer' ? (wake.data as { payload?: unknown }).payload : undefined;
      const requestedByHuman = readPayloadFlag(wakePayload, 'by', 'human');
      const result = await maintainMemory(this.deps.dataDir, {
        ds: this.deps.ds,
        now: this.deps.now,
        log: this.deps.log,
        projection: p,
        turn,
        out: this.write,
        ...(requestedByHuman ? { force: true } : {}),
      });
      this.write(`[记忆整理] ${result.reason}`);
      if (result.diaryFile !== null) this.write(`[记忆整理] 日记：${result.diaryFile}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reason = { kind: 'error', message, code: 'memory-maintain-failed' };
      this.write(`[记忆整理] 失败：${message}`);
    } finally {
      // 无论成败都结清这一 turn：整理是后台维护，一次失败不该卡住恢复流程
      this.appendSync('turn/end', { turn, reason, spoke: false }, 'internal');
    }
  }

  /** 日志里已出现的最大 turn 号（普通 turn 由 agent-loop 分配，本模块只读它来保持编号连续） */
  private async maxTurnInLog(): Promise<number> {
    let max = 0;
    for await (const event of this.deps.log.readAll()) {
      if (event.type === 'turn/start' && event.data.turn > max) max = event.data.turn;
    }
    return max;
  }

  private setTopUps(totals: TopUpTotals): void {
    this.topUps = totals;
    if (this.guardIsInjected) return;
    this.guard = this.makeGuard();
  }

  /**
   * 判定器工厂：有效上限 = config.budget + 人工加注累计。
   * 加注抬高上限而不是清零消耗，所以"已消耗的 token"这条事实在任何时候都不被改写。
   */
  private makeGuard(): BudgetGuard {
    return new BudgetGuard({
      config: raiseLimits(this.deps.config.budget, this.topUps),
      projection: this.deps.projection,
      emit: (type, data, visibility) => {
        this.appendSync(type, data, visibility);
      },
      now: this.deps.now,
    });
  }

  // ──────────────────────────────── 依赖装配 ────────────────────────────────

  private agentDeps(wakeEvents: readonly AppEvent[]): AgentLoopDeps {
    const d = this.deps;
    // 场合：最高档 = GUI/本机唤醒、官 bot 上用户 id 的会话（单聊与群聊都算）、她自己。
    // 其余（群里别人、陌生单聊、webhook）都是"软件里遇到的人"→ guest。
    const scenario: Scenario = this.scenarioOf(wakeEvents);
    // 本轮固定块的素材（B2）：**在这里读一次**，整轮共用同一份（见 turnBlockFacts）。
    // 读一次是这段代码的全部要点：`deriveRequest` 每步都会重新读 deps，而 deps 里的这份
    // 是**轮首快照**——一轮之内它逐字节不变，"不必每步重新编码"才成立。
    const turnBlock = this.turnBlockFacts();
    // 记忆索引（B2）：也在这里建/读一次。选材与注入用的是**同一份**索引——两处各读一次盘，
    // 就可能在"记忆刚好被改动"的那一拍选出与正文对不上的指针。
    const index = this.ensureMemoryIndexSafely();
    const authzGate = createAuthzGate({
      scenario,
      hardRefusal: d.config.tools.groupSceneHardRefusal === true,
      onDenied: (call) => {
        this.appendSync('authz/denied', {
          turn: call.turn,
          step: call.step,
          tool: call.tool,
          scenario,
          reason: call.reason,
          code: call.code,
        }, 'internal');
      },
    });
    return {
      log: d.log,
      ds: d.ds,
      registry: d.registry,
      projection: d.projection,
      // persona 用 **getter** 而不是拷快照：deriveRequest 每步都会重新读这些字段，
      // 而本方法每 turn 只装配一次。
      //
      // **B2 起 state 是例外**：它改由 `turnBlock` 携带（轮首读一次的快照）。
      // 原先这里也是 getter，于是她在 turn 内用 write_persona 改了自己的 STATE，本 turn 的
      // 后续 step 立刻能读到——代价是"状态"跟着此刻层每步重发（实测整份 STATE.md
      // 约 3845 token/步，占那几天账单的 28.6%）。缓存前缀的纪律优先于"同轮立刻可见"：
      // 改动现在**下一轮**才进她的上下文（取舍记在 docs/memory-injection.md §2）。
      // 哈希仍取实时值：它是缓存破坏哨兵与 step/start 的指纹，本来就该反映"此刻盘上是什么"。
      persona: {
        get identity() { return d.persona.identity; },
        get constitution() { return d.persona.constitution; },
        get style() { return d.persona.style; },
        get state() { return d.persona.state; },
        get personaHash() { return d.persona.personaHash; },
        relationship: this.relationshipForCurrentWake(),
      },
      // 进模型清单的工具口径（§4.10 第三级门）：destructive 工具有没有「全开」或进名单，
      // 由配置说了算——以前这里恒为空对象，界面上把 destructive 打开也不会有任何效果。
      //
      // 现在再叠一层：**按本轮的可信级别收紧**（runtime/trust.ts）。群里任何人 @ 她都会叫醒
      // 她，而那条消息本身就是输入；配置里"图方便全开"不能等于"群里谁都能使唤她"。
      // 取更严的那份——外部来源只看到 speak/report/read_channel/vision_read 四件。
      // **工具清单恒定**（2026-10-04 用户定稿）：不再按信任级增减件数。
      //
      // 依据是实测：清单随会话变，会让"它之后的那整段历史"前缀缓存全部失效
      // （同签名命中 85.2%、换签名 41.2%，最差 2%）。所以能力的收窄挪到**执行期**，
      // 见下面的 authzGate——清单不再承担权限表达。
      modelVisibility: { includeDestructive: d.config.tools.destructiveEnabled },
      now: () => d.now().toISOString(),
      timezone: d.timezone,
      budget: this.budgetHook(),
      // 上下文隔离（design §4.21）：主循环的上下文只有顶层事件。子代理链（parentCallId 非空）
      // 是它自己那条 turn 链的内部过程，进了父请求就等于让父模型看见"自己"没说过的话。
      //
      // 第二刀（B1 第二步）：**整条就是一条指令的 `wake/manual` 不进她的上下文**
      // （`/compact`、`/handoff`、以及打错的那些）。判据在 `isSlashCommandEvent`（唯一一份），
      // `replay` 用同一条重建，所以两边看到的仍是同一份事件。理由：指令是给框架的，
      // 不是对她说的话——少了这一刀，打错的 `/clear` 会在下一个 turn 的历史里当成一条
      // user 消息出现在她眼前，她就得去猜"用户是不是想清空什么"（B1 写明不许发生的事）。
      eventFilter: contextEventFilter,
      // 大结果外置（§4.12）：阈值与预览长度走 blob-store 的默认口径（估算 8k token / 2k 字符）
      blobOffload: { dataDir: d.dataDir },
      necessityGate: (wakeText, wakeEvents) => this.gateAdmits(wakeText, wakeEvents ?? []),
      // 压缩点（persona.md §4、design §4.13 铁律 5）：turn 结束且可见历史估算超过 config 阈值时，
      // 由循环层写一份交接笔记作为 compaction/summary（历史只遮蔽、不改写）
      compaction: {
        thresholdTokens: d.config.persona.compactionThresholdTokens,
        budgetTokens: d.config.persona.handoffBudgetTokens,
        foldTokens: d.config.persona.handoffFoldTokens,
      },
      // 技能索引（§4.19）：每 turn 重扫一次技能根，信任门未放行的不进 catalog
      skillCatalog: this.skills?.catalogText() ?? null,
      // 记忆索引（B2）：`MEMORIES/INDEX.md` 的渲染形态——只有指针（路径 + 一行摘要 + !pinned），
      // 正文要她按需 safe_read。每 turn 重建一次索引文件（幂等：内容没变就不写盘），
      // 因为上一轮里她可能刚写过新记忆。见 persona/memory-injection.ts。
      memoryIndex: renderMemoryIndex(index),
      // 本轮固定块（B2）：轮首读一次的状态 / 关系档案。记忆那一段由**循环层**在轮首补上
      // （`memory/selected` 与它同一时刻定下，见 agent-loop 的 selectMemoryForTurn）——
      // 那样"选了哪几条"与"注入了什么"是同一份结论，不会两处各算一遍。
      turnBlock,
      // 记忆选材（B2）：宿主给判据与正文，循环层在轮首写 `memory/selected` 事件。
      // 心跳轮（只有 wake/heartbeat）返回零条——没人在跟她说话，正文不注入（docs §5）。
      memorySelector: ({ wakeEvents: turnWakes }) => this.planMemorySelection(index, turnWakes),
      // 联络方式（装置自述的状态层那一半）：配置事实 + 本轮唤醒来源
      contact: this.contactFacts(),
      // 本机与用度（此刻层 `本机：` / `用度：` 两份素材）：**只能在这里算**——os/fs 与投影都
      // 在宿主手上，而渲染层是纯函数（不读环境值，缓存铁律 1）。一 turn 算一次。
      machine: this.machineFacts(),
      usage: this.usageFacts(),
      // 缓存破坏哨兵的阈值（config.contextAudit）：观测阈值，只决定"要不要记一条 cacheBreak"
      cacheBreakThresholds: {
        idleMs: this.deps.config.contextAudit.cacheBreakIdleMin * 60_000,
        hitDrop: this.deps.config.contextAudit.cacheBreakHitDrop,
      },
      // 通道消息的显示名（v32）：名字的真源在她的别名表与人的联系人表里，render 是纯函数，
      // 所以由这里算好递进去——本轮那条消息才是要回的那条，名字必须先带上。
      ...(this.channelRenderContext() === undefined ? {} : { channelRender: this.channelRenderContext() }),
      // 「有人插话」的计数读取器：speak 开口时取基准，等待中比它有没有变。
      // 用**函数**而不是当前值——打断发生在 speak 执行途中，那一刻的值才是要用的值。
      interruptEpoch: () => this.interruptEpoch,
      // 图片直通（design §4.20 的图片两条途径之一）：把附件引用换成 data URL，让模型亲眼看。
      // 渲染层拿不到字节，这条能力只能由宿主注入。关掉（config.vision.imagesToContext=false）
      // 就是"一张都不进上下文"——只剩消息里的地址与 vision_read 的文字转述。
      ...(d.config.vision.imagesToContext
        ? {
          loadImage: (ref: RenderImageRef) => (ref.source === 'file'
            // 工作目录内的文件：与文件工具同源（agent-loop 的 workspaceRoot 默认值就是 cwd）。
            // 等"工作根该是什么"定下来之后，这里跟工具一起收口成同一个显式配置。
            ? readFileDataUrl(
              isAbsolute(ref.key) ? ref.key : resolve(process.cwd(), ref.key),
              ref.mime,
              CONTEXT_IMAGE_HARD_BYTES,
            )
            : readAttachmentDataUrl(d.dataDir, ref, CONTEXT_IMAGE_HARD_BYTES)),
        }
        : {}),
      maxContextImages: d.config.vision.imagesToContext ? d.config.vision.maxContextImages : 0,
      // 执行点钩子（§4.19）：三个执行点都在循环与执行器内部，装配一次即可全生效
      ...(d.hooks !== undefined ? { hooks: d.hooks } : {}),
      // **场景鉴权门**（2026-10-04 用户定稿）：清单恒定之后，"客人能不能碰这台机器"在这里判。
      // 与 plan 模式共用同一个挂点：场景先判（这是安全问题），过了再看要不要请人批准。
      planGate: {
        intercept: (call) => authzGate.intercept(call) ?? this.planMode.intercept(call),
      },
    };
  }

  /**
   * 此刻的联络事实（装置自述的状态层那一半，见 model/self-brief.ts）。
   *
   * 三个来源都是事实，不做推测：通道开关读生效配置；告警出口看 webhookUrl 是否为空；
   * 「本轮能否回投」用 admin 的 `replyableWakeChannel`——与 speak 第三路同一个判据，
   * 因此提示词里说能发的时候，speak 一定真的发得出去。
   */
  private contactFacts(): ContactFacts {
    const config = this.deps.config;
    return {
      qqOfficial: config.channels.qqOfficial.enabled,
      onebot: config.channels.onebot.enabled,
      alertWebhook: (config.alerts.webhookUrl ?? '').trim() !== '',
      wakeChannel: replyableWakeChannel(this.wakeChannelData),
      // 外部会话清单：她要指定对象时手里得有 sid，而这是唯一一处告诉她"外面有谁"的地方
      sessions: this.sessionBook,
      // 别名每轮现读：那是她自己维护的文件，改完下一轮就该生效（小文件，一 turn 读一次）
      aliases: this.readAliases(),
      // 联系人表：人声明的事实（谁是用户、这个群是什么），优先于她自己的别名
      contacts: new Map(Object.entries(config.persona.contacts)),
      // 本轮唤醒的那条通道消息：只用来判"这轮是不是群里有人 @ 了我"。
      // 取的是**原始唤醒数据**而不是 `replyableWakeChannel` 的结论：那个判据问的是"能不能
      // 回投"（只认 c2c/group-at），而这里问的是"谁点了我的名"——将来的 `group` 全量模式
      // 也该能 @ 她。少一层转手，两个问题就不会被同一个判据绑在一起。
      wakeMessage: this.wakeChannelData,
      // 各会话"在聊什么"（信箱模型的中间那层）：清单那一行缀的半句
      topics: this.channelTopics,
    };
  }

  /**
   * 本机事实（此刻层 `本机：`）：系统平台 · 进程已运行多久 · 工作根 · 磁盘剩余。
   *
   * 为什么由这里算、而不是在 render 里读：渲染层是纯函数（不读 os、不读 fs，缓存铁律 1），
   * 这些值只有宿主拿得到。四项里磁盘那一项最要紧——**存续**：日志、快照、记忆都写在 dataDir
   * 这个卷上，写满就出事，而她得在出事之前看见它。读不到就如实空着，不猜。
   *
   * `uptimeMs` 取的是**本进程**的已运行时间（`process.uptime`）：她据此知道自己重启过没有
   * （重启会打断一个 turn，那是她会困惑的事）。系统开机时长是另一回事，不混进来。
   */
  private machineFacts(): MachineFacts {
    const workspaceRoot = join(this.deps.dataDir, DEFAULT_WORKSPACE_DIR_NAME);
    return {
      platform: `${PLATFORM_LABELS[osPlatform()] ?? osPlatform()} ${osRelease()} ${arch()}`,
      uptimeMs: Math.round(process.uptime() * 1000),
      workspaceRoot,
      // 工作根与 dataDir 在同一个卷上（同一棵树），先问工作根；它还没建出来时退回 dataDir
      disk: readDiskFacts(workspaceRoot) ?? readDiskFacts(this.deps.dataDir),
    };
  }

  /**
   * 用度事实（此刻层 `用度：`）：今日 token 与生效日上限、缓存命中样本、连续失败数。
   *
   * 数全部来自投影（它是日志的折叠结果，不另扫日志）；上限取 `guard.limitOf('daily')`——
   * 那正是刹车实际用的那个数（配置 + 人工加注），所以"占了多少"与她会不会被拒绝唤醒同源。
   * 一拍一算（与 contact 同节奏）：这是"今日累计"，不必精确到每一个 step。
   */
  private usageFacts(): UsageFacts {
    const p = this.deps.projection;
    return {
      tokensToday: p.budget.tokensToday,
      dailyLimit: this.guard.limitOf('daily'),
      cacheHitTokens: p.budget.cacheHitToday,
      cacheMissTokens: p.budget.cacheMissToday,
      failStreak: p.failStreak,
      failStreakMax: this.deps.config.budget?.failStreakMax ?? null,
    };
  }

  /**
   * 把最近到达的图片附件补落到本地（`<dataDir>/blobs/images/<sha256(url)>`）。
   *
   * 为什么不能只在"认领时预热本批唤醒"：图片经常在**她正忙着一个 turn** 的时候到达。
   * 那个 turn 认领的是更早的一条消息，而新到的 `wake/channel` 会立刻作为后续 step 的
   * 历史出现在她眼前（事件流只追加）。实测就是这样：她看见了文件名与临时链接、画面没进来，
   * 只好自己 `http_download` 下来才看到——因为那张图的落盘只覆盖"本轮认领的唤醒"，
   * 而它还在队列里没被认领。
   *
   * 所以扫的是**事件**（每拍补一次新来的，带游标），而不是队列：队列里那条迟早会被认领，
   * 但**在她看见它的那一刻**字节就得在。重启后游标归零，从窗口起点补一次。
   *
   * 为什么必须先落盘：QQ 的富媒体是**临时直链**（带 rkey），过期之后服务端拒绝下载，
   * 而那条消息永远留在历史里——直链进上下文等于给那条历史判了无期 400
   * （详见 channel/attachment-store.ts）。失败只意味着这张图这一轮进不了上下文：
   * 消息里的地址还在，她照样能用 http_download 自己取、或者让 vision_read 转述。
   */
  private async prewarmRecentAttachments(): Promise<void> {
    const lastSeq = this.deps.projection.lastSeq;
    if (lastSeq <= this.attachmentScanSeq) return;
    // 从游标往后扫，首次（或重启后）最多回看一个窗口——不为了几张图把整份日志翻一遍
    const from = Math.max(this.attachmentScanSeq + 1, lastSeq - ATTACHMENT_SCAN_WINDOW + 1);
    const urls: string[] = [];
    for (let seq = from; seq <= lastSeq; seq += 1) {
      const event = this.deps.log.get(seq);
      if (event === null || event.type !== 'wake/channel') continue;
      for (const attachment of event.data.attachments ?? []) {
        if (typeof attachment.url !== 'string' || attachment.url === '') continue;
        if (!attachment.type.startsWith('image/')) continue;
        urls.push(attachment.url);
      }
    }
    this.attachmentScanSeq = lastSeq;
    for (const url of urls) {
      const outcome = await ensureAttachment(this.deps.dataDir, url);
      const label = url.length > 72 ? `${url.slice(0, 72)}…` : url;
      if (outcome.outcome === 'failed') {
        this.write(`[图片] 附件取不回来（${outcome.reason}）：${label}`);
      } else if (outcome.outcome === 'skipped') {
        this.write(`[图片] 这张不进上下文（${outcome.reason}）：${label}`);
      }
    }
  }

  /**
   * 建/读一次索引（幂等）。读盘或写盘失败（磁盘满、权限）时照常按现有文件建一份内存索引，
   * 绝不让这一轮发不出去——记忆索引是**便利**，不是存续的前提；她自己的记忆文件才是真源。
   */
  private ensureMemoryIndexSafely(): MemoryIndex {
    try {
      ensureMemoryIndex(this.deps.dataDir);
    } catch {
      // 写不进去：下面仍按盘上现有内容建索引
    }
    return buildMemoryIndex(this.deps.dataDir);
  }

  /**
   * 本轮的记忆选材（B2，docs/memory-injection.md §4）：判据是纯函数，正文在这里现取。
   *
   * 三件事：
   *   ① **判心跳轮**：本轮唤醒只有 `wake/heartbeat` → 一条都不选（没人在跟她说话，
   *      没有谁的上下文需要对齐；她要看就按索引 `safe_read`）；
   *   ② **选哪几条**：`selectMemory`（pinned 必选 + 按索引顺序补足到条数上限）；
   *   ③ **取正文**：按 `path:line` 从盘上现读那一条（与 `safe_read` 同一份素材、同一口径）。
   *
   * 取正文失败的条目**跳过**（文件被删、行号漂了）：选材账里照记它被选中过（那是当时的判据结论），
   * 但正文那一段里不出现——不臆造内容，也不让一条读不到的指针把整块搞没。
   */
  private planMemorySelection(index: MemoryIndex, wakeEvents: readonly AppEvent[]): {
    injection: 'human' | 'heartbeat';
    selected: MemorySelected['data']['selected'];
    notSelected: MemorySelected['data']['notSelected'];
    indexSize: number;
    text: string;
  } {
    const heartbeatTurn = isHeartbeatTurn(wakeEvents);
    const selection = selectMemory(index, { heartbeatTurn });
    const excerpts: MemoryExcerpt[] = [];
    for (const entry of selection.selected) {
      const excerpt = readExcerpt(this.deps.dataDir, entry);
      if (excerpt !== null) excerpts.push(excerpt);
    }
    return {
      injection: heartbeatTurn ? 'heartbeat' : 'human',
      selected: selection.selected.map((entry) => ({
        path: entry.path,
        line: entry.line,
        summary: entry.summary,
        pinned: entry.pinned,
      })),
      notSelected: {
        heartbeat: selection.skipped.heartbeat,
        notNeeded: selection.skipped.notNeeded,
      },
      indexSize: index.entries.length,
      text: renderSelectedMemory(excerpts),
    };
  }

  /**
   * 本轮固定块的素材（B2）：**这一轮里不会再变**的状态与关系档案。
   *
   * 这个函数在 `agentDeps()` 里被调用**一次**（一轮一次），返回的是一份**快照**。
   * 循环层每步原样转手，所以：
   *   • `[当前状态]`（`STATE.md`）在这一轮的任何一步里逐字节相同——不必每步重新编码；
   *   • 她在 turn 内用 `write_persona` 改的 STATE 要到**下一轮**才进上下文。
   *     这是有意的取舍（改前是 getter，同轮立刻可见但每步重发整份 STATE，
   *     实测约 3845 token/步），理由与代价都写在 docs/memory-injection.md §2。
   *
   * 关系档案与此刻层用的是**同一个判据**（`relationshipForCurrentWake`）：
   * 一次唤醒一个人，所以"本轮命中谁"在一轮内是常量。
   *
   * 记忆那一段**不在这里**：它由循环层在轮首按 `memory/selected` 的**同一份**结论补上
   * （见 agent-loop 的 `selectMemoryForTurn`）——两处各算一遍就是给漂移留门。
   */
  private turnBlockFacts(): TurnBlockFacts {
    return {
      state: this.deps.persona.state,
      relationship: this.relationshipForCurrentWake(),
      memory: null,
    };
  }

  /** 读 `MEMORIES/aliases.md`（她给外部会话起的名字）；读不到就当没有，不报错 */
  private readAliases(): Map<string, string> {
    try {
      const path = join(memoriesDir(this.deps.dataDir), 'aliases.md');
      return parseAliases(readFileSync(path, 'utf8'));
    } catch {
      return new Map();
    }
  }

  // ──────────────────────────────── 会话簿与未读（v32） ────────────────────────────────

  /**
   * 对会叫醒她的那些外部消息跑一次注入判定，有迹象就落 `injection/flagged`。
   *
   * 三条分寸（与用户给的接线口径一致，也决定了它为什么长这样）：
   *   • **只判 `wake/channel`**：群里的普通消息进信箱、不唤醒，也就不必花这次判定
   *     ——判定的钱要花在"她真会看到的那几条"上；
   *   • **有风险才写事件**：判 `risky: false` 时一个字都不落。没迹象还写一条事件，等于
   *     每轮都在日志里留一行"这条消息没问题"，那是纯噪音（而且要她读）；
   *   • **不阻塞、不抛**：判定本身已经有超时与兜底（见 InjectionJudge），这里再包一层
   *     宽度上限与去重——最坏情况是"这次没判出来"，绝不是"她开不了口"。
   *
   * 去重按 `messageId`：同一条消息可能因为重投、或者被攒批窗口重复认领而走两遍这条路，
   * 那次判定已经落过事件了，不必再花一次钱、也不必写第二条一样的预警。
   */
  private async judgeChannelWakes(wakeEvents: readonly AppEvent[], turn: number): Promise<void> {
    // 没有可用的模型通道就不判：`ds` 是必须注入的依赖，但测试与窄路径上给的可能只是个空壳
    // （对象在、`generate` 不在）。一条注入判定绝不该让循环在中途炸掉——宁可不判。
    if (typeof this.deps.ds?.generate !== 'function') return;
    // 豁免名单（用户 2026-10-04 的口径：单聊按会话、群里按人）：豁免 = **不扫描也不提示**。
    // 为什么选"不扫描"而不是"照扫只是不说"：这条判定存在的唯一意义就是提醒她；
    // 人已经判定"这个人可信"之后，再花一次 light 调用算一遍、算完又不告诉她，纯属白花钱，
    // 还会在日志里留下一堆没人看的标记。省掉的正是下面那次 judge。
    this.warnExempt ??= new WarnExemptBook(this.deps.dataDir);
    this.warnExempt.refresh();
    const exempt = this.warnExempt;
    const targets = wakeEvents
      .filter((e): e is AppEvent & { type: 'wake/channel' } => e.type === 'wake/channel')
      .filter((e) => !this.judgedMessageIds.has(e.data.messageId))
      .filter((e) => !exempt.isExempt(e.data))
      .slice(0, INJECTION_JUDGE_MAX_PER_BATCH);
    if (targets.length === 0) return;
    // 去重集合的体量：给它一个上界（超出就整份丢掉重建）——它只是"最近判过哪些"，
    // 丢掉重建的代价是极少数消息被重判一次，而无限增长的代价是长跑进程的内存。
    if (this.judgedMessageIds.size > INJECTION_JUDGE_SEEN_MAX) this.judgedMessageIds.clear();
    const judge = new InjectionJudge({
      ds: this.deps.ds,
      now: this.deps.now,
      log: this.deps.log,
      projection: this.deps.projection,
      turn,
      timeoutMs: INJECTION_JUDGE_TIMEOUT_MS,
    });
    for (const event of targets) {
      this.judgedMessageIds.add(event.data.messageId);
      let verdict: InjectionVerdict;
      try {
        verdict = await judge.judge(event.data.text);
      } catch (err) {
        // judge 自己承诺不抛；真抛了也只当没判出来（不拦她开口）
        this.write(`[注入判定] 判定失败，按无迹象处理：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!verdict.risky) continue;
      const d = event.data;
      const note = noteForFlagged(verdict);
      // **当场**写进内存表：本轮渲染按 messageId 取这句话（render 的 channelNotesOf），
      // 而它是纯函数、只看得见事件——所以后面那一趟 noteInjectionWarnings 会把它落成
      // `injection/noted`，两条路给的必须是同一串字节（这里与那里共用 noteForFlagged）。
      // 只等下一拍的 foldChannelEvents 来补，就意味着这一轮她看到的仍是"没有预警"的原文。
      this.flaggedNotes.set(d.messageId, {
        note, by: verdict.by, reason: verdict.reason, quotes: verdict.quotes,
      });
      this.appendSync('injection/flagged', {
        messageId: d.messageId,
        sid: sidOf(d.channel, d.chatType, d.chatId),
        by: verdict.by,
        reason: verdict.reason,
        quotes: verdict.quotes,
        person: d.person,
        chatType: d.chatType,
      }, 'internal');
      // 启动日志里留一行：这是**框架的**动作（不是她的），排障时要知道它发生过
      this.write(`[注入判定] 外部消息 ${d.messageId}（${d.person}）有迹象（${verdict.by}）：${verdict.reason}`);
    }
  }

  /**
   * 把"框架示了警"这件事落成事件（`injection/noted`，v25）——**逐条**，一条消息一次。
   *
   * 为什么要单独立一条（而不是复用 `injection/flagged`）：预警还有一条**没有判定结论**的路
   * ——规则层字面命中、判定超时没跑成、一批里超出判定上限的那些（`INJECTION_JUDGE_MAX_PER_BATCH`）。
   * 那条路今天只在渲染时现拼一句话："她到底看没看见"就永远查不出来；而且 GUI 要**原样**贴出
   * 那句话，那是渲染层的文案，界面侧算不出同一串字节——只有落成事件才贴得出。
   *
   * 为什么在这个时刻写：这一批消息正要进她的上下文（判定已跑完、turn 还没起）。写的时机
   * 与"她看见"是同一刻，而不是判定那一刻——判了却没能送进去（turn 没跑起来）不算示警。
   *
   * 去重按 messageId：重投与攒批窗口会让同一条再走一遍这一拍（见 notedMessageIds）。
   */
  private noteInjectionWarnings(wakeEvents: readonly AppEvent[]): void {
    for (const event of wakeEvents) {
      if (event.type !== 'wake/channel') continue;
      const d = event.data;
      if (this.notedMessageIds.has(d.messageId)) continue;
      // 判过的用它那句（含语义级），没判过的现扫字面——与渲染层同一个判据、同一段文案
      const flagged = this.flaggedNotes.get(d.messageId);
      const hints = flagged === undefined ? scanForInjection(d.text) : [];
      const note = flagged?.note ?? injectionNoteOf(hints);
      if (note === null) continue;
      this.notedMessageIds.add(d.messageId);
      const sid = sidOf(d.channel, d.chatType, d.chatId);
      this.appendSync('injection/noted', {
        messageId: d.messageId,
        sid,
        person: d.person,
        chatType: d.chatType,
        // 名字是**当时**解析出来的：此刻层那段历史要按人列，而渲染层查不了联系人表。
        // 解析不出就退回那串 id（宁可难看，不可编一个名字）。
        who: this.resolveChannelName(sid) ?? d.person ?? d.chatId,
        note,
        // 给人的那一半：判过的用判定结论，规则命中的用规则自己那句"在做什么"
        reason: flagged?.reason ?? reasonOfHints(hints),
        quotes: [...(flagged?.quotes ?? quotesOfHints(hints))],
        ...(flagged === undefined ? {} : { by: flagged.by }),
      }, 'internal');
    }
  }

  /**
   * 那条外部消息的框架话（渲染层把它附在框外；没判出迹象就是 null）。
   *
   * 查的是 `flaggedNotes`——它在折叠里维护（`foldChannelEvents` 见过 `injection/flagged`
   * 就记一条），所以重启后由 warmUp 的全量折叠补齐，**不现扫日志**。
   */
  private flaggedNoteFor(messageId: string): string | null {
    return this.flaggedNotes.get(messageId)?.note ?? null;
  }

  /**
   * 把新来的通道事件并进会话簿（两种事件 + 已读位，共用 sessions.ts 的一份折叠）。
   *
   * **为什么要扫事件而不是只在认领唤醒时并**：`channel/message` 是 internal、不进 pending，
   * 永远不会出现在本批唤醒里——只在认领时并，那些"只记账"的会话就永远长不出未读，
   * 而未读恰恰是它们唯一的存在形式。
   *
   * 代价被限制在"上一拍水位之后的新事件"上（`channelBookSeq` 游标）：平时每拍几条到几十条，
   * 判一个字符串相等而已；重启后游标归零、由 warmUp 的全量折叠兜住，不会重复计入条数
   * （warmUp 之后把游标设到当刻水位，见那里的注释）。
   */
  /**
   * 从一条通道事件里收群成员（只认群：单聊的人不需要"群成员"这层身份，他有 sid）。
   *
   * 触发条件按用户的口径：**这条消息发生过 @/提及**（@ 了她，或者 @ 了群里别人）。
   * 那时把两类人都注册：发言的人、被 @ 到的人。没 @ 过的普通闲聊不注册——免得把群里
   * 每个冒过泡的人都灌进档案，那反而看不出"谁跟她打过交道"。
   */
  private registerGroupMembers(event: AppEvent): void {
    if (event.type !== 'wake/channel' && event.type !== 'channel/message') return;
    const data = event.data;
    if (data.chatType !== 'group' && data.chatType !== 'group-at') return;
    // **只认 @ 她/提及她**（用户 2026-10-04 的口径）：被 @ 的其他人一概不管。
    // group-at 本身就是 @ 她；全量群消息模式下看 mentionsMe（适配器算好的那个标志）。
    if (data.mentionsMe !== true) return;
    this.groupMembers ??= new GroupMemberBook(this.deps.dataDir);
    this.groupMembers.refresh();
    const groupSid = sidOf(data.channel, data.chatType, data.chatId);
    // 已经有名字的人（用户手写的联系人表、或她自己在别名表里认过的）**不进档案**：
    // 这里是给"还没名字的人"准备的。实测踩过：用户 35 次在群里 @ 她，全被注册成了群友。
    const isKnown = (openid: string): boolean => this.humanSourceNameOf(openid) !== null;
    const at = event.ts;
    // 发言人：已经有名字的（用户）跳过；昵称有就用（官方只在部分事件里给 username）
    if (isKnown(data.person)) return;
    if (this.groupMembers.register({
      openid: data.person,
      groupSid,
      ...(data.nickname === undefined || data.nickname === '' ? {} : { nickname: data.nickname }),
      at,
    })) this.groupMembersDirty = true;
  }

  private foldChannelEvents(): void {
    const lastSeq = this.deps.projection.lastSeq;
    if (lastSeq <= this.channelBookSeq) return;
    for (let seq = this.channelBookSeq + 1; seq <= lastSeq; seq += 1) {
      const event = this.deps.log.get(seq);
      if (event === null) continue; // 崩溃留下的空洞：跳过，不猜
      if (event.type === 'channel/topic') {
        // 话题只留最近一条：清单那一行只缀得下一句，历史话题在日志里（可复盘）
        if (event.data.topic.trim() !== '') {
          this.channelTopics.set(event.data.sid, event.data.topic);
          this.topicSeq.set(event.data.sid, event.data.toSeq);
        }
        continue;
      }
      if (event.type === 'injection/flagged') {
        this.flaggedNotes.set(event.data.messageId, {
          note: noteForFlagged(event.data), by: event.data.by,
          reason: event.data.reason, quotes: event.data.quotes,
        });
        continue;
      }
      if (event.type === 'injection/noted') {
        this.notedMessageIds.add(event.data.messageId);
        continue;
      }
      if (event.type !== 'wake/channel' && event.type !== 'channel/message' && event.type !== 'channel/read') continue;
      // 这一轮叫她的那条消息（群里被提及/@）：`read_channel` 靠它知道"这个会话必须照给"
      //（v28 之后她手里只有通知、没有正文，而那条又是 wake/channel、不计入未读——见 admin.ts）
      if (event.type === 'wake/channel'
        && event.data.chatType !== 'c2c'
        && event.data.mentionsMe === true) {
        this.lastMention = {
          sid: sidOf(event.data.channel, event.data.chatType, event.data.chatId),
          messageId: event.data.messageId,
        };
      }
      this.sessionBook = upsertSessionInto(this.sessionBook, event);
      // 群成员自动注册（2026-10-04 用户的口径）：**发生过 @/提及**的群消息里，把发言人
      // 本身、以及被 @ 到的人都记进档案——"见过谁"就是这么攒出来的。QQ 官方没有查成员的
      // 接口（要内邀白名单），所以只能靠消息事件。
      this.registerGroupMembers(event);
    }
    if (this.groupMembersDirty) {
      this.groupMembers?.save();
      this.groupMembersDirty = false;
    }
    this.channelBookSeq = lastSeq;
  }

  /**
   * `read_channel` 的读取口：取某个会话最近的若干条消息（时间正序）。
   *
   * 两种事件都算这个会话的消息——`wake/channel` 是"叫她"的那条、`channel/message` 是只记账的
   * 那条，但对"这个会话里都说过什么"来说它们是同一件事。漏掉前者会让她读到一段缺了 @ 的对话。
   *
   * 全量扫日志（不是只扫尾部）：`readTailEvents` 的早停对"按类型过滤"是安全的，但在她读一个
   * 冷清会话时会白读一大片别人的消息。这里取的是**每轮至多一次**的交互式调用（她主动点开），
   * 与"逐轮渲染"不是一个量级的开销，宁可实现简单、结论确定。
   */
  // 公开（不是 private）：这两个是**宿主接口**——main.ts 装配 catalog 时把它们递给
  // `read_channel`（工具层不读日志、不读别名表）。写成 private 就没法从 main 接线，
  // 而在 main 里另写一份"取最近 N 条"等于让同一件事有两份实现（v27/v30 记过同款坑）。
  async readChannelMessages(sid: string, limit: number): Promise<ChannelMessageView[]> {
    const hits: ChannelMessageView[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
      const d = event.data;
      if (sidOf(d.channel, d.chatType, d.chatId) !== sid) continue;
      const flagged = this.flaggedNoteFor(d.messageId);
      hits.push({
        sid,
        channel: d.channel,
        chatType: d.chatType,
        chatId: d.chatId,
        person: d.person,
        // 平台昵称/群名片：**只用于显示**（认人用）；身份永远按 id 判（见 admin 的 ChannelMessageView）
        ...(d.nickname === undefined ? {} : { nickname: d.nickname }),
        text: d.text,
        messageId: d.messageId,
        msgSeq: d.msgSeq,
        ts: event.ts,
        ...(d.attachments === undefined ? {} : { attachments: d.attachments }),
        // 判过的消息**回放时也要带预警**：那句话她可能正是在"翻旧账"这一刻才看到的，
        // 而预警落在事件里、与她翻不翻无关——这正是把预警落成事件、而不是只在唤醒那一次
        // 渲染里拼一句的理由（换个时刻看同一条消息，结论不该变）。
        ...(flagged === null ? {} : { flaggedNote: flagged }),
      });
    }
    return hits.slice(-limit);
  }

  /**
   * `read_channel` 的第二个读取口：**她在这个会话里说过的话**（"她读群时知道自己已经回过什么"）。
   *
   * 为什么要宿主来读（2026-10-04）：她说出去的话本身是**逐段**落进 `message/assistant` 的
   * （一次 151 字的发言在 IM 上发了 13 条，内容就在那 13 条里），但那些事件**没有会话坐标**
   * ——同一段历史里混着好几个通道的消息，逐段对上哪个群是不可能的。所以由 `speak` 在**IM 那一路
   * 真发出去**的那一刻补一条带 `sid` 的 `speak/sent`：那是"她说出去过"的凭据（失败/被拒没有它）。
   *
   * 归并成**一次 speak 一行**：切分是投递的属性，而 read_channel 的硬预算是行数——她的 13 条气泡
   * 在那边只占一行（用户 2026-10-04："不过不切分节省行数"）。归并键是 **`callId`**（"一次工具调用"
   * 的本征标识，与 `tool/call` 同源）：一次 speak 的多条气泡并成一行，而同一个 turn 里她连着说的
   * 两段各占一行——按 turn 并会把那两段读成一段。
   *
   * 只认带 `text` 的那些：旧日志（这个字段之前）读不回来——不是缺陷，是"日志只增不改"的必然。
   */
  // 公开理由同 `readChannelMessages`（宿主接口：main.ts 把它递给 read_channel）
  async readChannelSpoken(sid: string): Promise<ChannelSpoken[]> {
    /** 归并键 → 那一段话（旧事件没有 callId 时退回按 turn、再退回"各自一行"） */
    const bySpoken = new Map<string, ChannelSpoken>();
    let counter = 0;
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'speak/sent') continue;
      const d = event.data;
      // 三道闸：只有真的送到某个会话的那条回执带 text 与 sid（本机对话流那条、
      // 投递失败/被拒的那些都不带——"没发出去"不算"她说过"）
      if (d.channel !== 'reply-url' || d.text === undefined || d.sid === undefined) continue;
      // 归一之后再比：`speak` 的 `to` 与唤醒派生的回投地址同形，但历史日志里可能有
      // `group-at` 那种旧写法（归一之前），不归一会让她的发言在群里凭空消失
      if (normalizeSid(d.sid) !== sid) continue;
      const atMs = Date.parse(event.ts);
      const key = d.callId !== undefined
        ? `c\u0000${d.callId}`
        : d.turn === undefined ? `\u0000${counter++}` : `t\u0000${d.turn}`;
      const prev = bySpoken.get(key);
      const parts = d.spokenParts ?? 1;
      bySpoken.set(key, prev === undefined
        // 第一次发言取回执自己的时刻（第一次投递那一刻）
        ? { text: d.text, ts: event.ts, parts, seq: event.seq, atMs }
        // 同一次发言的下一段：接在她那口气后面，时刻推到最后一次（读起来是"这一段说到这时"）
        : {
            text: prev.text + d.text,
            ts: event.ts,
            parts: prev.parts + parts,
            seq: event.seq,
            atMs,
          });
    }
    // 升序交给调用方（read_channel 合批时自己排），这里保持日志顺序即可
    return [...bySpoken.values()];
  }

  /**
   * 会话显示名（sid → 名字）：给人声明的联系人表最高优先，其次是她自己的别名表。
   *
   * 与 `contactFacts` 里那份清单**同一个判据**（`resolveSessionName`）：两处各写一套的代价
   * 是她读消息时看到的名字与清单上的对不上——而名字正是"这条是谁说的"唯一的凭据。
   */
  // 公开的理由同上（宿主接口：read_channel 的渲染要用它解析名字）
  resolveChannelName(sid: string): string | null {
    const contacts = this.deps.config.persona.contacts;
    // 归一之后查（旧联系人表里可能还是 `qq:group-at:<群id>` 的写法）：名字是"这条消息是谁说的"
    // 唯一的凭据，改口径那一刻不该让它失效
    const named = resolveNameForSid(sid, new Map(Object.entries(contacts)), this.readAliases());
    return named === null ? null : named;
  }

  /**
   * 本轮通道消息的渲染上下文（谁在哪个会话里说的）。
   *
   * 只服务本轮那个会话：`render.ts` 的 `channelRender` 是**一个**上下文（渲染层不查会话簿，
   * 它是纯函数），而一段历史里可能混着好几个通道的消息——那些更早的通道事件按"没有名字"渲染
   * （退回 openid）。这是刻意的取舍：给每条历史消息都配上当时的名字，等于让渲染层持有一份
   * 会随她改别名而变的表，缓存前缀就再也稳不住（铁律 1）。本轮那条最重要——她要回的就是它。
   */
  private channelRenderContext(): RenderChannelContext | undefined {
    const wake = this.wakeChannelData;
    if (wake === null) return undefined;
    const sid = sidOf(wake.channel, wake.chatType, wake.chatId);
    const named = this.resolveChannelName(sid);
    // **发言人**的名字按 person 查，不是会话名（2026-10-03 上下文审计浮出来的）：
    // 原来把 `resolveChannelName(sid)` 同时当会话名与发言人名用——私聊里两者恰好同一个，
    // 群里就错了（那条会写成"摸鱼群：…"，看起来像群在说话）。查不到就不给，
    // 由渲染层退回那串 id（她至少能靠它认人）。
    const speaker = this.personNameOf(wake.person);
    // 预警**不在这里**给（v25）：它是"哪一条消息"的属性，不是"这一轮上下文"的属性——
    // 按 messageId 各自取自己的那一句，见 render 的 channelNotesOf
    return {
      sid,
      sessionLabel: named ?? wake.chatId,
      ...(speaker === null ? (named === null ? {} : { personLabel: named }) : { personLabel: speaker }),
    };
  }

  /**
   * 会话话题（sid → "在聊什么"）：清单那一行缀的那半句。
   *
   * 由 `channel/topic` 事件折来（`foldChannelEvents`）——概要是 light 跑出来、落成事件的，
   * 渲染层只读结论。**读不到就不缀**：编一个话题比没有话题更坏（她会照着一个不存在的事去接话）。
   */
  private channelTopicOf(sid: string): string | null {
    return this.channelTopics.get(sid) ?? null;
  }

  /**
   * 待办里有没有"群里有人叫她"的那一条：有就返回那个会话的 sid（否则 null）。
   *
   * 判据与 `channel/inbox.ts` 的唤醒判据同源：`group-at`（平台 @）或 `mentionsMe`（关键词命中
   * 或平台 mentions）。**私聊不算**——私聊里没人"提及"她，那是一对一在说话。
   *
   * 从日志里找那几条待办事件（投影的 pending 只有 seq/source，没有消息内容）。
   */
  private mentionSidOf(pending: readonly { wakeSeq: number }[]): string | null {
    const wanted = new Set(pending.map((item) => item.wakeSeq));
    if (wanted.size === 0) return null;
    for (const seq of wanted) {
      const event = this.deps.log.get(seq);
      if (event === null || event.type !== 'wake/channel') continue;
      const d = event.data;
      const mentioned = d.chatType === 'group-at' || d.mentionsMe === true;
      if (mentioned && d.chatType !== 'c2c') return sidOf(d.channel, d.chatType, d.chatId);
    }
    return null;
  }

  /**
   * 话痨会话的话题概括（v32）：**只为"攒够了一批新消息"的会话跑**。
   *
   * 两个阈值都定在这里，理由是它们一起决定"值不值得花一次 light"：
   *   • **未读 ≥ 5**：一两条不构成"话题"（顶多是"有人说了句话"，未读数已经说清了）；
   *   • **距上次概括 ≥ 10 分钟**：群里连着发二十条，不必每拍都重新概括一遍——
   *     话题是给人扫一眼用的，它的价值在"大概在聊什么"，不在实时。
   *
   * `mentionSid`（2026-10-02 加）是用户的口径：**群里有人叫她的时候，未读门槛让路**——
   * "发生提及、at 的时候，light 模型会先审计积累消息，然后给出话题 peek，然后告示进入
   * 对话流告知 agent"。所以那条路上只要攒了 ≥ 1 条就概括；10 分钟那道闸照旧
   * （同一段对话里连着叫两声，第二声不必再花一次 light——话题还是那个话题）。
   *
   * 三条不许：**不许阻塞**（`await` 在每拍里，但失败立刻返回）、**不许抛**（summarize 自己
   * 承诺不抛，这里再包一层）、**不许写假话题**（失败/空串就不落事件，清单上那一行照旧不缀）。
   *
   * 平时只跑一个会话（本轮未读最多的那个）：一次 tick 花一份 light 就够了，剩下的下一拍再说。
   */
  private async summarizeChattySessions(mentionSid: string | null = null): Promise<void> {
    if (typeof this.deps.ds?.generate !== 'function') return;
    const floor = mentionSid === null ? TOPIC_MIN_UNREAD : 1;
    const wanted = this.sessionBook.filter((entry) => entry.unread >= floor);
    // 提及那条优先（用户在叫她了）；没有提及就照旧挑未读最多的那个
    const candidate = (mentionSid === null ? undefined : wanted.find((entry) => entry.sid === mentionSid))
      ?? wanted.sort((a, b) => b.unread - a.unread)[0];
    if (candidate === undefined) return;
    const lastAt = this.topicAt.get(candidate.sid);
    const nowMs = this.deps.now().getTime();
    if (lastAt !== undefined && nowMs - lastAt < TOPIC_MIN_INTERVAL_MS) return;
    // 先记账再跑：概括失败也不该每拍重试同一个会话（那会变成一台烧钱的空转机）
    this.topicAt.set(candidate.sid, nowMs);
    // 上次概括覆盖到哪一条（事件 seq）：它落在日志里，重启后由 warmUp/fold 折回来，
    // 所以"同一段不重复概括"这条在重启之后照样成立（内存里的 topicAt 做不到这一点）
    const sinceSeq = this.topicSeq.get(candidate.sid) ?? 0;
    const messages: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
      const d = event.data;
      if (sidOf(d.channel, d.chatType, d.chatId) !== candidate.sid) continue;
      // **只收"她还没看过"的那些**（msgSeq > 已读位，与会话簿算未读同一个判据）。
      //
      // 为什么必须这么收（2026-10-02 实测）：原来取"最近 30 条"，而这个群一共只有 28 条
      // ——于是**整个群的历史**（跨 2.5 小时，含前面那些测试串和私密往来）被一起喂了进去，
      // light 给出的概括成了「测试弥亚小姐能否选择不回复消息」这种**元判断**，
      // 而当时真正在说的是"用户要出门补课、让她自己待着"。
      // 话题是"那边**现在**在说什么事"，喂进去的东西必须是**新话**。
      if (d.msgSeq <= candidate.readUpToSeq) continue;
      // 再挡一道：**上次概括过的那一段不重复概括**（用户："每个总结竟然都是一样的，反复刷新？"）。
      // 判据用事件 seq（`channel/topic.toSeq` 记的就是它）：它落在日志里，所以重启之后仍然有效
      // ——原来的节流只有内存里那个 `topicAt`，一重启就归零，于是同一段没读过的消息会被反复
      // 概括出同一句话，白花 light 还让界面上的卡片看起来在"反复刷新"。
      if (event.seq <= sinceSeq) continue;
      messages.push(event);
    }
    // 再按条数收一道口：新话很多时只喂最近这一批（再多只会得一个更糊的概括）
    const recent = messages.slice(-TOPIC_MAX_MESSAGES);
    if (recent.length < floor) return;
    try {
      await new TopicSummarizer({
        ds: this.deps.ds,
        now: this.deps.now,
        log: this.deps.log,
        projection: this.deps.projection,
        turn: 0,
      }).summarize(candidate.sid, recent, { nameOf: (person) => this.personNameOf(person) });
    } catch (err) {
      this.write(`[话题概括] 失败（不影响任何判断）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 发言人（openid）→ 名字：给话题概括用。
   *
   * 名字的真源只有两处（联系人表、她自己的别名表），而**两张表的键都是 sid**——所以能直接
   * 认出来的只有"单聊会话的对方"：`qq:c2c:<openid>` 里的 openid 就是那个人的 id。
   * 群里发言的人没有单独的键，但只要他有过单聊（用户就是这样），两处一拼就认出来了：
   * 用户 11:03 在群里发的那几句，概括里该写"用户（OWNER）"而不是"甲"。
   * 认不出的返回 null，由概括那边退成 甲/乙/丙（不编名字）。
   */
  /** 工具层的口：发言人 → 名字（`read_channel` 每行那个"谁"用） */
  resolvePersonName(person: string): string | null {
    return this.personNameOf(person);
  }

  /**
   * 只从**人写的**两处取名字（用户手写的联系人表、她自己的别名表），不含群成员档案。
   *
   * 与 `personNameOf` 的区别就是"不含档案"：注册前要用它判断"这人已经有名字了吗"，
   * 若把自己也算进去，就会得出"他已有名字（我刚发的占位号）"而永远不再更新。
   */
  private humanSourceNameOf(person: string): string | null {
    if (person === '') return null;
    for (const namespace of ['qq', 'onebot']) {
      const sid = `${namespace}:c2c:${person}`;
      const named = this.resolveChannelName(sid);
      if (named !== null && named !== '') return named;
    }
    return null;
  }
  /**
   * **已知是用户的 id**：官 bot 上那个**单聊会话的 openid**——联系人表里标成用户名字的那条。
   *
   * 用户 2026-10-04 定稿：**官 bot 上用户身份的唯一来源就是这一条**，群成员不参与标记
   * （"其他群成员不能标记为用户"）。之所以还要一个集合：同一个 openid 出现在群里时，
   * 那一轮也该算最高档——实测他在群里的 member_openid 与单聊 openid 就是同一个值，
   * 所以这条规则天然覆盖了"用户在群里说话"。
   */
  private ownerIds(): Set<string> {
    const d = this.deps;
    const ids = new Set<string>();
    for (const [sid, name] of Object.entries(d.config.persona.contacts)) {
      const parts = sid.split(':');
      if (parts[1] === 'c2c' && parts.length >= 3 && isOwnerLabel(name, d.config.persona.owner)) {
        ids.add(parts.slice(2).join(':'));
      }
    }
    return ids;
  }

  /** 这一轮的场合（owner = 自己家；guest = 软件里遇到的人）。认不出按 guest 算（从严） */
  private scenarioOf(wakeEvents: readonly AppEvent[]): Scenario {
    const d = this.deps;
    const trust = trustOfBatch(
      wakeEvents,
      new Map(Object.entries(d.config.persona.contacts)),
      d.config.persona.owner,
      wakeEvents.length === 0 ? new Set<string>() : this.ownerIds(),
    );
    return trust === 'owner' || trust === 'self' ? 'owner' : 'guest';
  }
  private personNameOf(person: string): string | null {
    if (person === '') return null;
    // ① 用户手写的联系人表 / 她自己的别名表（都按 c2c 会话键查）：认得出就直接用。
    //    这两处**优先于**自动档案——人写的永远压过机器攒的。
    for (const namespace of ['qq', 'onebot']) {
      const sid = `${namespace}:c2c:${person}`;
      const named = this.resolveChannelName(sid);
      if (named !== null && named !== '') return named;
    }
    // ② 群成员档案（2026-10-04）：群里的人可能**从没私聊过她**，没有 c2c 会话键，
    //    上面那一步永远查不到——那正是"自动注册"要解决的问题。
    if (this.groupMembers === null) return null;
    this.groupMembers.refresh();
    return this.groupMembers.nameOf(person);
  }

  // ──────────────────────────────── 心跳与必要性门 ────────────────────────────────

  /**
   * 心跳节律：基线 × min(2^idleTicks, idleBackoffMax) × (1.5 − pressure)。
   * 空拍数与压力都从投影读（日志的折叠结果），本模块不另立一份账。
   */
  private makeHeartbeat(): Heartbeat {
    const minutes = (value: number): number | undefined =>
      Number.isFinite(value) && value > 0 ? value * 60_000 : undefined;
    const baseMs = minutes(this.deps.config.wake.heartbeatBaselineMin);
    const floorMs = minutes(this.deps.config.wake.heartbeatFloorMin);
    const ceilMs = minutes(this.deps.config.wake.heartbeatCeilMin);
    return new Heartbeat({
      projection: this.deps.projection,
      ...(baseMs !== undefined ? { baselineMs: baseMs } : {}),
      backoffMax: this.deps.config.wake.idleBackoffMax,
      ...(floorMs !== undefined ? { floorMs } : {}),
      ...(ceilMs !== undefined ? { ceilMs } : {}),
      now: this.deps.now,
      policy: () => this.heartbeatPolicy(),
      onDebug: this.write,
      onFire: (firing) => this.noteHeartbeat(firing),
    });
  }

  /**
   * 节律策略（热更点）：返回 'skip' 表示此刻不心跳。判据只有一条——
   * **队列里已经压着一整批没处理完的输入**时不再往里塞心跳：那种情况下循环本来就要忙起来，
   * 再插心跳只会把真实输入挤到批次之外。策略绝不去读日志做重活（它在定时器回调里跑）。
   */
  private heartbeatPolicy(): 'fire' | 'skip' {
    if (this.deps.projection.pending.length >= BATCH_LIMIT) return 'skip';
    return 'fire';
  }

  /**
   * 群消息攒批门（design §4.24）：pending 里**只有**群聊通道消息、且最早一条还没到窗口时，
   * 本拍不起 turn——群里的一条 @ 常常只是半句话，逐条起 turn 既贵又容易答错。
   *
   * 判据本体在 group-batch.ts 的纯函数里（四种不攒的情形逐条钉在那边）：这里只负责
   * 给它三个输入——队列、日志句柄、当前时刻与窗口。窗口到点不需要额外定时器：
   * 主轮询（pollMs）下一拍这个门就返回 false，积攒的消息一起被认领。
   */
  private holdsGroupBatch(p: Projection): boolean {
    return holdsGroupBatch({
      pending: p.pending,
      getEvent: (seq) => this.deps.log.get(seq),
      nowMs: this.deps.now().getTime(),
      windowMs: this.deps.config.channels.qqOfficial.groupBatchMinutes * 60_000,
    });
  }

  /** 心跳落地：事件已在 HeartbeatSource 里写盘（appendSync），这里只留一行可读的诊断 */
  private noteHeartbeat(firing: HeartbeatFiring): void {
    this.write(`[心跳] 安静 ${firing.quietSeconds}s，空拍 ${firing.idleTicks}，`
      + `压力 ${firing.pressure.toFixed(2)}，下一拍 ${Math.round(this.heartbeat.nextDelayMs() / 60_000)} 分钟后`);
  }

  /**
   * 必要性门接线（design §4.11）：**只有心跳批次过门**。人/定时器/文件/webhook/意图/后台
   * 这些都是真实发生的事，直接进 turn，由她在 turn 里决定怎么回应——规则层不替她闭嘴。
   * 判定结论落在日志里：沉默 turn 的事件序列是 `turn/start → input/claimed →
   * turn/end{completed, spoke:false}`（由 agent-loop 的收尾路径写），零模型调用。
   */
  private async gateAdmits(wakeText: string, wakeEvents: readonly AppEvent[]): Promise<boolean> {
    void wakeText;
    if (!this.necessity.appliesTo(wakeEvents)) return true;
    // turn 号取自 openTurn：agent-loop 在过门之前已写完 turn/start（记账要挂到本 turn 上）
    const turn = this.deps.projection.openTurn?.turn ?? 0;
    const verdict = await this.necessity.judge({ wakeEvents, turn });
    return verdict.shouldReply;
  }

  /** 刹车钩子（agent-loop 每 step 边界调用）：判定与事件写入都在 budget-guard 里 */
  private budgetHook(): AgentLoopBudget {
    return {
      checkBeforeStep: (p) => this.guard.checkBeforeStep(p),
      softHint: (p) => this.guard.softHint(p),
      stepCallLimit: () => this.guard.stepCallLimit(),
      onStepOverflow: (actual) => this.guard.noteStepOverflow(actual),
    };
  }

  /**
   * 唤醒路由（persona.md §3）：本拍首个唤醒若「带人」就注入对应关系档案。
   *
   * 带人的来源有三处：webhook 与 manual 自带 `person` 字段（手动唤醒由 GUI/CLI 填
   * `config.persona.owner`）；**通道消息**（QQ / OneBot）的 `person` 是发送者标识——
   * 私聊是 `user_openid`，群里是 `member_openid`（同一个人的两个不同值，所以同一个人
   * 可能对应两份档案）。文件不存在就当没这个人，不注入也不报错。
   *
   * 判据与事后重放**共用一份实现**（persona/relationship.ts）：两处各写一份的代价不是冗余，
   * 是重放出来的请求与当时对不上，而重放的全部意义就在"一模一样"。
   */
  private relationshipForCurrentWake(): { who: string; content: string } | null {
    const first = this.deps.projection.pending[0];
    if (!first) return null;
    return relationshipForWake(this.deps.log.get(first.wakeSeq), this.deps.dataDir);
  }

  /** 落一条承诺类事件。**返回它**：调用方偶尔要那个 seq（如"有人开口"要记下是哪条唤醒） */
  private appendSync(type: string, data: unknown, visibility: 'model' | 'internal'): AppEvent {
    const event = {
      seq: this.deps.log.nextSeq(),
      ts: this.deps.now().toISOString(),
      type, data, visibility,
      origin: 'runtime/real-loop',
    } as unknown as AppEvent;
    this.deps.log.append(event, { sync: true });
    applyOne(this.deps.projection, event);
    finalizePressure(this.deps.projection, event.ts);
    // 信任事件就地折入（不等下一拍）：确认后本拍就能生效，不必重启
    this.skills?.applyTrustEvent(event);
    return event;
  }
}

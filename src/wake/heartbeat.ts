/**
 * Irmia Agent — 心跳与空闲退避（docs/design.md §4.11/§4.12、docs/persona.md §6、milestones M5-3/M5-14）
 *
 * 心跳是"她自己的呼吸"：没有人说话时，按时间自己醒一拍，看一眼有没有该做的事。
 * 它的两个目标互相拉扯，算法就是这对拉扯的解：
 *   - **不能睡死**：外部事件可能一直不来，得靠心跳把"到期意图、未完成待办、待确认"捞起来；
 *   - **不能空烧**：无人活动时最该发生的事就是什么都不发生，频率要往下掉。
 *
 * 退避公式（照 Cortico heartbeat.ts 的指数退避 + exagent 的 pressure 调制）：
 *
 *     间隔 = 基线 × min(2^idleTicks, idleBackoffMax) × (1.5 − pressure)
 *
 * 三项各自的职责不许混淆：
 *   - `2^idleTicks`：连续空拍翻倍，封顶 `idleBackoffMax`（默认 8 倍）——纯代数退避；
 *   - `(1.5 − pressure)`：压力调制，压力高（有待确认 / 有挂起输入 / 有到期意图 / 很久没说话）
 *     时把这个乘数压向 0.5，也就是**有牵挂时睡不沉**；压力低时约 1.45 倍，睡得更沉；
 *   - 时钟与基线：`nextDelayMs()` 只读投影里的 `idleTicks` / `pressure`，不读环境时钟
 *     （除注入的 now），因此同一份日志折叠出的间隔可复现。
 *
 * 谁负责复位：只有 **外部事件**（任何 wake/* 经 WakeSink 进来）调用 `noteActivity()`。
 * 心跳自己**不复位**——fire 时把 idleTicks +1 落进事件，于是下一拍更慢；这是退避成立的前提。
 *
 * `policy` 是节律策略（热更点）：fire 时先求值一次，返回 null 表示"此刻不心跳"，
 * 事件与回调都不产生，30 分钟后重新求值——配置/人格改动不必重启进程即可生效。
 * 策略缺失时退化为 `() => 'fire'`，即心跳永远照常。
 *
 * 事件写入由调用方负责（`policy` 求值与事件组装在本模块，落库在 HeartbeatSource）：
 * 本模块不认识 EventLog，与 wake/sources.ts 同一条边界纪律。
 *
 * 约定：值导入写 `.ts`（--experimental-strip-types 只擦类型不改路径），纯类型导入写 `.js`。
 */

import type { Projection, WakeHeartbeat } from '../log/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 基线间隔兜底（毫秒）：配置缺省或写坏时用它，不让心跳变成"永不" */
export const DEFAULT_BASELINE_MS = 30 * 60 * 1000;

/** 间隔下限：10 分钟。公式自己算不到这么短，它是防连爆的安全网 */
export const DEFAULT_HEARTBEAT_FLOOR_MS = 10 * 60 * 1000;

/** 间隔上限：60 分钟。再安静也不该超过一小时不露面——“她还在”的体感就靠这个 */
export const DEFAULT_HEARTBEAT_CEIL_MS = 60 * 60 * 1000;

/** 退避倍数上限兜底（基线 ×8，design §4.12） */
export const DEFAULT_BACKOFF_MAX = 8;

/**
 * 策略否决后的重查间隔（毫秒）——design §4.12：策略是热更点，
 * 被否决的这拍不产生任何事件，30 分钟后重新求值。
 */
export const POLICY_RECHECK_MS = 30 * 60 * 1000;

/** 兜底下限：即使是压力满格的 1 分钟基线，也不允许退化成热循环 */
const MIN_DELAY_MS = 1_000;

/** 间隔上限（约 30 天）：防止基线配置荒谬时 setTimeout 溢出成"立刻触发" */
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 一拍心跳的节律结论 */
export type HeartbeatDecision = 'fire' | 'skip';

/** 本次心跳的原因；'policy' 表示策略主动降频 */
export type HeartbeatReason = 'fire' | 'policy';

/** 节律策略：返回 null/'skip' 表示此刻不心跳；异常按 'fire' 处理（心跳不可被策略 bug 掐死） */
export type HeartbeatPolicy = () => HeartbeatDecision | null;

/**
 * 一次心跳的事实（尚未分配 seq）。`quietSeconds` 从投影算：
 * 优先 `lastAssistantAt`（她上次开口），其次 `lastWake`（上次被唤醒）。
 */
export interface HeartbeatFiring {
  quietSeconds: number;
  idleTicks: number;
  pressure: number;
}

/** 心跳节拍器选项 */
export interface HeartbeatOptions {
  /** 投影：idleTicks / pressure / lastAssistantAt / lastWake 的唯一来源 */
  projection: Projection;
  /** 基线间隔（毫秒），默认 30 分钟 */
  baselineMs?: number;
  /** 退避倍数上限，默认 8 */
  backoffMax?: number;
  /**
   * 间隔下限（毫秒，默认 10 分钟）。
   *
   * 公式自己不会算出比它更短的值（基线 30 × 乘数下限 0.5 = 15），所以它是**安全网**：
   * 谁把基线改小、或压力项以后改得更激进，也不会把心跳变成连爆。
   */
  floorMs?: number;
  /**
   * 间隔上限（毫秒，默认 60 分钟）。
   *
   * 为什么要它：纯退避算下去，安静久了会慢到 6 小时（30×8×1.45）——那个尺度上
   * "她还在"的体感就没了。超过一小时不露面，人会觉得她睡着了。
   */
  ceilMs?: number;
  /** 节律策略（热更点） */
  policy?: HeartbeatPolicy | null;
  /**
   * 每拍的交付回调（已通过策略求值）。**只管交付事实，不做写入**：
   * 组装与落库在 HeartbeatSource。缺省时空实现，供纯算法测试使用。
   */
  onFire?: (firing: HeartbeatFiring) => void;
  /** 时钟注入：定时器布防与 quietSeconds 参照时刻都用它 */
  now?: () => Date;
  /** 定时器注入（测试用假闹钟）；给出时必须同时给出 clearTimer */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 诊断输出 */
  onDebug?: (line: string) => void;
}

// ──────────────────────────────── 心跳 ────────────────────────────────

/**
 * 心跳节拍器。它只管"什么时候该醒"与"这一拍的事实是什么"，
 * 不管"醒了往哪写"（那是 HeartbeatSource 的事），也不管"醒了要不要说话"（必要性门的事）。
 */
export class Heartbeat {
  private readonly projection: Projection;
  private readonly now: () => Date;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly emitDebug: (line: string) => void;
  /** 交付回调：构造时给一份默认空实现，HeartbeatSource 装好之后再换掉它 */
  private fireCallback: (firing: HeartbeatFiring) => void;
  /** 基线间隔与退避上限都是配置热更点（operations.md §1 白名单）：非 readonly，走 setter */
  private baselineMs: number;
  private backoffMax: number;
  private floorMs: number;
  private ceilMs: number;
  private policy: HeartbeatPolicy | null;
  private handle: unknown = null;
  private running = false;
  /** 进程内累计的心跳拍数（诊断用；权威计数在投影的 idleTicks 与日志） */
  private beat = 0;

  constructor(options: HeartbeatOptions) {
    this.projection = options.projection;
    this.baselineMs = normalizeBaseline(options.baselineMs ?? DEFAULT_BASELINE_MS);
    this.backoffMax = normalizeBackoff(options.backoffMax ?? DEFAULT_BACKOFF_MAX);
    this.floorMs = options.floorMs ?? DEFAULT_HEARTBEAT_FLOOR_MS;
    this.ceilMs = Math.max(this.floorMs, options.ceilMs ?? DEFAULT_HEARTBEAT_CEIL_MS);
    this.policy = options.policy ?? null;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    });
    this.emitDebug = options.onDebug ?? (() => undefined);
    this.fireCallback = options.onFire ?? (() => undefined);
  }

  /** 本进程已发出的心跳拍数 */
  get beatCount(): number {
    return this.beat;
  }

  /** 当前是否已布防 */
  get armed(): boolean {
    return this.running;
  }

  /** 配置热更点：改基线/上限不必重启进程（下一拍按新值算） */
  setPolicy(policy: HeartbeatPolicy | null): void {
    this.policy = policy;
  }

  /** 当前基线间隔（毫秒）：启动摘要、热更验证与诊断读它 */
  get currentBaselineMs(): number {
    return this.baselineMs;
  }

  /** 当前退避倍数上限 */
  get currentBackoffMax(): number {
    return this.backoffMax;
  }

  /**
   * 配置热更点：改心跳基线不必重启（wake.heartbeatBaselineMin 在白名单内）。
   * 已布防的那一拍不打断——新的基线在下一拍排期时生效，否则热更会变成一次额外的唤醒。
   */
  setBaselineMs(ms: number): void {
    this.baselineMs = normalizeBaseline(ms);
  }

  /** 配置热更点：改退避倍数上限（wake.idleBackoffMax 在白名单内），下一拍按新值算 */
  setBackoffMax(value: number): void {
    this.backoffMax = normalizeBackoff(value);
  }

  /** 交付回调替换点：HeartbeatSource 装配时把自己接上（未装配时心跳只记诊断） */
  setOnFire(onFire: (firing: HeartbeatFiring) => void): void {
    this.fireCallback = onFire;
  }

  /** 当前空闲拍数（取自投影，不额外记账） */
  idleTicks(): number {
    return Math.max(0, Math.trunc(this.projection.idleTicks));
  }

  /**
   * 这一拍到下一拍该等多久。公式见文件头；压力项下界 0（pressure 封顶 1 时乘数 0.5）。
   * 结果一律夹进 [floorMs, ceilMs]——退避再深也不超过一小时，压力再大也不短于十分钟。
   */
  nextDelayMs(): number {
    const pressure = clamp01(this.projection.pressure);
    const factor = Math.min(2 ** this.idleTicks(), this.backoffMax);
    return clampDelay(Math.min(this.ceilMs, Math.max(this.floorMs, this.baselineMs * factor * (1.5 - pressure))));
  }

  /** 布防首拍：按基线等价间隔算（不是"立刻来一拍"——刚启动就有心跳会把冷启动变成噪声） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm(this.baselineDelayMs());
  }

  stop(): void {
    this.running = false;
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }

  /**
   * 外部事件到达：空拍归零并重新按基线计时（design §4.12「任何外部事件到达即复位」）。
   * 必须由**外部事件**的接收路径调用；心跳自己绝不调用它，否则退避永远长不起来。
   */
  noteActivity(): void {
    if (!this.running) return;
    this.arm(this.baselineDelayMs());
  }

  /**
   * 立即求值一次节律（不等待定时器）。返回 null 表示策略否决：**什么也不产生**——
   * 没有事件、没有回调、没有 idleTicks 变化，只把重查排到 30 分钟后。
   * 定时器到点与测试手工驱动走的是同一份逻辑。
   */
  fireNow(): HeartbeatFiring | null {
    const decision = this.evaluatePolicy();
    if (decision === 'skip') {
      this.emitDebug(`[心跳] 节律策略否决本次心跳（${Math.round(POLICY_RECHECK_MS / 60_000)} 分钟后重查）`);
      if (this.running) this.arm(POLICY_RECHECK_MS);
      return null;
    }
    this.beat += 1;
    return {
      quietSeconds: this.quietSeconds(),
      // 空拍只在这里递增：+1 落进事件，投影回读后成为下一拍的退避依据
      idleTicks: this.idleTicks() + 1,
      pressure: clamp01(this.projection.pressure),
    };
  }

  // ── 内部 ──

  /**
   * 策略求值的容错：策略抛错按 'fire' 处理。心跳是常驻体的活性保障，
   * 让一个策略 bug 把心跳掐死，是最不能接受的失败方向。
   */
  private evaluatePolicy(): HeartbeatDecision {
    const policy = this.policy;
    if (policy === null) return 'fire';
    try {
      const decision = policy();
      if (decision === 'skip' || decision === null) return 'skip';
      return 'fire';
    } catch (err) {
      this.emitDebug(`[心跳] 节律策略抛错，按照常心跳处理：${err instanceof Error ? err.message : String(err)}`);
      return 'fire';
    }
  }

  /** 基线等价间隔：只保留压力调制的乘数，不带空拍退避（复位语义） */
  /** 复位后与首拍的间隔：同样夹在范围内（刚启动就有心跳会把冷启动变成噪声） */
  private baselineDelayMs(): number {
    const raw = this.baselineMs * (1.5 - clamp01(this.projection.pressure));
    return clampDelay(Math.min(this.ceilMs, Math.max(this.floorMs, raw)));
  }

  private arm(ms: number): void {
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
    const wait = clampDelay(ms);
    this.handle = this.setTimer(() => {
      this.handle = null;
      const firing = this.fireNow();
      if (firing === null) return; // 策略否决：重查已排好
      this.emitDebug(
        `[心跳] 第 ${this.beat} 拍（安静 ${firing.quietSeconds}s，空拍 ${firing.idleTicks}，p=${firing.pressure.toFixed(2)}）`,
      );
      this.firingHandler(firing);
      if (this.running) this.arm(this.nextDelayMs());
    }, wait);
  }

  /** 交付一拍：回调本身抛错不能带崩定时器链（下一拍必须照常布防） */
  private firingHandler(firing: HeartbeatFiring): void {
    try {
      this.fireCallback(firing);
    } catch (err) {
      this.emitDebug(`[心跳] 交付回调抛错：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 安静时长（秒）：优先"距她上次开口"，其次"距上次被唤醒"。
   * 两者都缺（全新实例）时取 0，而不是拿环境时钟硬算——渲染出"已安静 0 秒"是可读的，
   * 而凭空造一个巨大数字会让必要性门误判成"很久没说话"。
   */
  private quietSeconds(): number {
    const reference = this.projection.lastAssistantAt ?? this.projection.lastWake?.at ?? null;
    if (reference === null) return 0;
    const at = Date.parse(reference);
    if (Number.isNaN(at)) return 0;
    return Math.max(0, Math.floor((this.now().getTime() - at) / 1000));
  }
}

// ──────────────────────────────── 唤醒源适配 ────────────────────────────────

/** 心跳源需要的循环侧能力（与 wake/sources.ts 的 WakeSink 同形，此处只声明用得到的那一条） */
export interface HeartbeatSink {
  /** 落库一条 wake/heartbeat（model 可见；返回时必须在磁盘上） */
  emitHeartbeat(data: WakeHeartbeat['data']): void;
}

/**
 * 心跳唤醒源（与 TimerWakeSource / ManualWatchSource 同款 adapter）。
 *
 * 为什么它不复用 `WakeSink.wake()`：那条路径属于"外部事件"，real-loop 在上面挂
 * `noteActivity()` 复位退避。心跳若走那条路，就会每拍把自己复位，退避永远长不起来。
 * 所以源只把事实交给 `HeartbeatSink.emitHeartbeat`，复位与不复位各走各的门。
 */
export class HeartbeatSource {
  readonly name = 'heartbeat';

  private readonly heartbeat: Heartbeat;
  private readonly sink: HeartbeatSink;

  constructor(heartbeat: Heartbeat, sink: HeartbeatSink) {
    this.heartbeat = heartbeat;
    this.sink = sink;
    // 装配点：心跳只交付事实，如何成帧与落库留在本类（事件写入的同一处纪律）
    heartbeat.setOnFire((firing) => {
      sink.emitHeartbeat({
        quietSeconds: firing.quietSeconds,
        idleTicks: firing.idleTicks,
        pressure: firing.pressure,
      });
    });
  }

  start(): void {
    this.heartbeat.start();
  }

  stop(): void {
    this.heartbeat.stop();
  }

  /** 当前实际间隔（毫秒）：启动摘要与 status 用它说明"下一次大约什么时候醒" */
  nextDelayMs(): number {
    return this.heartbeat.nextDelayMs();
  }
}
// ──────────────────────────────── 工具 ────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeBackoff(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_BACKOFF_MAX;
  return Math.trunc(value);
}

/**
 * 基线的合法性校验必须在**乘算之前**：把 0 留给 clampDelay 会让它先被抬到 1 秒，
 * 再乘 1.45，于是"配错一个 0"就变成一个 1.45 秒的热循环。
 */
function normalizeBaseline(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_BASELINE_MS;
  return clampDelay(ms);
}

/** 间隔一律落在 [1s, 30d]：下限挡热循环，上限挡 setTimeout 溢出 */
function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_BASELINE_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}

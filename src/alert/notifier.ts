/**
 * Irmia Agent — 告警出口（M3，docs/design.md §4.9 全文 / docs/milestones.md M3-6、M3-7、M3-10）
 *
 * 职责：无人值守时，出问题得有人知道。三个框架都只写日志，这是必须自己补的洞。
 *
 * 三档实现，按"永远可用"排序：
 *   ① **文件档**（默认，永远可用）：`<alertDir>/YYYY-MM-DD.log` 追加一行人类可读记录。
 *      它是最后一道防线：磁盘在就在，不依赖网络、不依赖对端。
 *   ② **Webhook 档**：POST JSON `{ level, title, body, ts, fingerprint }` 到 `alerts.webhookUrl`。
 *      没配就不出口（不写这个字段即代表不用）。
 *   ③ IM 消息档复用同一出口（admin.ts 的 notify/speak 第二路注入的正是这里的 AlertNotifier）。
 *
 * 三条刻意的语义：
 * **限流（§4.9「同一类告警 30 分钟内只发一次」）**：指纹 = 类别 + 关键参数的哈希。
 *   内存 Map 负责短期判定，`foldAlarms(events)` / `AlarmIndex` 是恢复入口——限流窗口从
 *   `alarm/sent` 事件折叠重建，所以重启进程不会让一个坏掉的接口重新刷屏（M3-10）。
 *   被限流不是失败：消息被**有意丢弃**，`sent: false` + `reason: 'rate-limited'`，不计入失败。
 *
 * **stall 恢复通知（§4.9 参照 Cortico）**：告警发出时按"故障键"登记（首次时刻 + 连续次数），
 *   恢复（连续失败后首次成功）时发一条"已恢复"再清除登记——同一串故障不重复告警，
 *   也不会在故障期间刷屏。恢复通知的指纹与故障本身不同（`…:recovered`），
 *   所以不会被故障那 30 分钟窗口连坐。没有登记时不发（不制造"恢复了什么"的假事实）。
 *
 * 两种对外形状（同一份实现，双方接口都保留）：
 *   - `new Notifier({ alertDir, rateLimitMin, now, history, record, webhookUrl })`
 *     ：`send(level, title, body)` / `recover({ level, title }, note)`，宿主自己写事件；
 *   - `createNotifier({ config, dataDir, emit, now })`
 *     ：任务接口（`send(message)` 兼容 admin.ts 的 Notifier，另带 alert/fail/ok/restore）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppConfig } from '../config/config.js';
import type { AppEvent, Visibility } from '../log/types.js';
import { defaultVisibility } from '../log/types.ts';
import type { Notifier as AdminNotifier, NotifyMessage, NotifyOutcome } from '../tools/admin.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 告警日志目录名（operations.md §2 的目录结构：<dataDir>/alarms/） */
export const ALERT_DIR_NAME = 'alarms';
/** 限流窗口兜底（分钟）：config.alerts.rateLimitMin 缺失或非法时用它 */
export const DEFAULT_RATE_LIMIT_MIN = 30;
/** 指纹展示长度：完整 sha256 太长，前 16 位足够区分且便于人眼比对 */
export const FINGERPRINT_CHARS = 16;
/** Webhook 超时：无人值守场景下，一个不回话的端点不能拖住调用方 */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** 被限流时的原因串（调用方据此区分"丢掉了"与"失败了"） */
export const RATE_LIMITED = 'rate-limited';

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 告警级别（与 admin.ts 的 NotifyMessage 同源） */
export type AlertLevel = NotifyMessage['level'];

/** 事件写入口（注入）：宿主实现为「分配 seq → append → 落日志」 */
export type AlertEmitter = (type: string, data: unknown, visibility: Visibility) => void;

export interface AlertInput {
  /** 告警类别（如 `budget-exhausted`、`model-failure`）：同类同参数共用指纹 */
  category: string;
  level: AlertLevel;
  title: string;
  body: string;
  /** 参与指纹的关键参数（layer、callId、endpoint…）；变参数即变指纹 */
  params?: Record<string, string | number | boolean> | undefined;
}

/** 一次告警的送达回执：是否发出、指纹、落盘文件 */
export interface AlertDelivery {
  /** 真的发出去了（被限流或全通道失败时为 false） */
  sent: boolean;
  fingerprint: string;
  /** 文件档路径（即使写入失败也给出目标路径，便于人去看） */
  file: string;
  reason?: string | undefined;
}

export interface AlertStats {
  /** 真正发出去的条数 */
  sent: number;
  /** 被限流丢弃的条数 */
  suppressed: number;
  /** 所有通道都失败的条数 */
  failed: number;
}

/** 写进日志的告警事实（限流窗口的唯一来源） */
export interface AlertRecord {
  fingerprint: string;
  level: AlertLevel;
  title: string;
}

export interface NotifierOptions {
  /** 告警日志目录（调用方给的通常是 join(dataDir, ALERT_DIR_NAME)） */
  alertDir: string;
  /** 同类告警限流窗口（分钟） */
  rateLimitMin: number;
  /** 时钟注入 */
  now: () => Date;
  /** 告警发出后的回调：宿主据此写 `alarm/sent` 事件与更新索引 */
  record?: ((record: AlertRecord) => void) | undefined;
  /** 限流窗口的既有索引（启动恢复；同一实例会被持续更新） */
  history?: AlarmIndex | undefined;
  /** Webhook 出口；不配即只落文件 */
  webhookUrl?: string | undefined;
  /** fetch 注入（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch | undefined;
}

/** 任务接口：文件档 + Webhook 档 + 限流 + stall 恢复（admin.ts 的 Notifier 形状 + 扩展） */
export interface AlertNotifier extends AdminNotifier {
  alert(input: AlertInput): Promise<NotifyOutcome>;
  fail(input: AlertInput): Promise<NotifyOutcome>;
  ok(category: string, body?: string | undefined): Promise<NotifyOutcome>;
  /** 恢复入口：把历史 alarm/sent 折进限流窗口（M3-10 跨重启限流） */
  restore(events: Iterable<AppEvent>): void;
  /** 当前限流窗口快照：指纹 → 最近一次发送时刻（毫秒） */
  windows(): Map<string, number>;
  stats(): AlertStats;
  /** 配置热更点（alerts.rateLimitMin 在白名单内）：下一拍按新窗口判定，不等重启 */
  setRateLimitMin(min: number): void;
  /** 配置热更点（alerts.webhookUrl 属于告警开关）：不传即关闭 webhook 出口 */
  setWebhookUrl(url: string | undefined): void;
}

export interface CreateNotifierOptions {
  /** 生效配置的告警段（AppConfig['alerts']） */
  config: AppConfig['alerts'];
  /** 数据根目录：告警日志写到 `<dataDir>/alarms/` */
  dataDir: string;
  /** 事件写入口：每发出一条告警写 `alarm/sent`（限流的事实来源） */
  emit: AlertEmitter;
  /** 时钟注入 */
  now: () => Date;
  /** fetch 注入（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch | undefined;
  /** 启动恢复：已有事件流，折进限流窗口后再开张 */
  history?: Iterable<AppEvent> | undefined;
}

// ──────────────────────────────── 指纹与折叠 ────────────────────────────────

/**
 * 指纹 = 类别 + 关键参数哈希（§4.9；review.md 缺陷 9）。
 * 参数按键名排序后拼接，所以 `{a:1,b:2}` 与 `{b:2,a:1}` 是同一个指纹。
 */
export function fingerprintOf(
  category: string,
  params?: Record<string, string | number | boolean> | undefined,
): string {
  const keys = params === undefined ? [] : Object.keys(params).sort();
  const tail = keys.map((key) => `${key}=${String(params?.[key] ?? '')}`).join('&');
  return createHash('sha256').update(`${category}|${tail}`, 'utf8').digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * 从日志折叠限流窗口（M3-10）：指纹 → 最近一次 `alarm/sent` 的时刻（毫秒）。
 * 纯函数：时间只取事件自带的 ts，不读时钟、不碰文件；同一指纹取最晚一次。
 */
export function foldAlarms(events: Iterable<AppEvent>): Map<string, number> {
  const windows = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'alarm/sent') continue;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) continue;
    const previous = windows.get(event.data.fingerprint);
    if (previous === undefined || at > previous) windows.set(event.data.fingerprint, at);
  }
  return windows;
}

/**
 * 告警限流索引：指纹 → 最近一次发出时刻（毫秒）。
 * 跨重启由日志重建：宿主把 `alarm/sent` 事件喂给 apply()，把实例作为 `history` 交给 Notifier。
 */
export class AlarmIndex {
  private readonly marks = new Map<string, number>();

  apply(event: AppEvent): void {
    if (event.type !== 'alarm/sent') return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    const previous = this.marks.get(event.data.fingerprint);
    if (previous === undefined || at > previous) this.marks.set(event.data.fingerprint, at);
  }

  merge(events: Iterable<AppEvent>): void {
    for (const event of events) this.apply(event);
  }

  /** 该指纹在窗口内是否已发过 */
  suppressed(fingerprint: string, nowMs: number, windowMs: number): boolean {
    const last = this.marks.get(fingerprint);
    return last !== undefined && nowMs - last < windowMs;
  }

  entries(): Map<string, number> {
    return new Map(this.marks);
  }
}

// ──────────────────────────────── 工厂（任务接口） ────────────────────────────────

export function createNotifier(options: CreateNotifierOptions): AlertNotifier {
  const webhookUrl = options.config?.webhookUrl;
  const core = new Notifier({
    alertDir: join(options.dataDir, ALERT_DIR_NAME),
    rateLimitMin: pickRateLimitMin(options.config?.rateLimitMin),
    now: options.now,
    // 限流状态的唯一来源：事件先落盘（由宿主保证承诺类 fsync），内存索引跟上
    record: (record) => {
      options.emit(
        'alarm/sent',
        { fingerprint: record.fingerprint, level: record.level, title: record.title },
        defaultVisibility('alarm/sent'),
      );
    },
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (options.history !== undefined) core.restore(options.history);
  return {
    send: (message) => core.sendMessage(message),
    alert: (input) => core.alert(input),
    fail: (input) => core.fail(input),
    ok: (category, body) => core.ok(category, body),
    restore: (events) => {
      core.restore(events);
    },
    windows: () => core.windows(),
    stats: () => core.stats(),
    setRateLimitMin: (min) => {
      core.setRateLimitMin(min);
    },
    setWebhookUrl: (url) => {
      core.setWebhookUrl(url);
    },
  };
}

// ──────────────────────────────── 实现 ────────────────────────────────

/** 一次故障的连续窗口（stall 机制：恢复通知的依据） */
interface StallRecord {
  /** 首次失败时刻（毫秒） */
  since: number;
  /** 连续失败次数（含首次） */
  count: number;
  /** 首次失败用的指纹：恢复通知的正文里如实引用它 */
  fingerprint: string;
}

export class Notifier {
  private readonly alertDir: string;
  /** 限流窗口（毫秒）是配置热更点：非 readonly，走 setRateLimitMin */
  private rateLimitMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  /** webhook 出口属于"告警开关"，同在白名单内：非 readonly，走 setWebhookUrl */
  private webhookUrl: string | undefined;
  private readonly record: ((record: AlertRecord) => void) | undefined;

  /** 限流窗口：指纹 → 最近一次成功发出（含落盘）的时刻 */
  private readonly windowsMap = new Map<string, number>();
  /** 处于故障中的故障键 → 连续失败窗口 */
  private readonly stalling = new Map<string, StallRecord>();
  private readonly counters: AlertStats = { sent: 0, suppressed: 0, failed: 0 };
  /** 目录只创建一次；创建失败不拦发送（appendFile 会再报一次，行为一致） */
  private dirReady = false;

  constructor(options: NotifierOptions) {
    this.alertDir = options.alertDir;
    this.rateLimitMs = Math.round(pickRateLimitMin(options.rateLimitMin) * 60_000);
    this.now = options.now;
    this.webhookUrl = options.webhookUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.record = options.record;
    if (options.history !== undefined) {
      for (const [fingerprint, at] of options.history.entries()) {
        const previous = this.windowsMap.get(fingerprint);
        if (previous === undefined || at > previous) this.windowsMap.set(fingerprint, at);
      }
    }
  }

  // ── 宿主形状：send / recover（宿主自己写事件） ──

  /** 配置热更：改同类告警限流窗口（分钟）。已发出的窗口不回溯，新窗口从下一拍起生效 */
  setRateLimitMin(min: number): void {
    this.rateLimitMs = Math.round(pickRateLimitMin(min) * 60_000);
  }

  /** 配置热更：开/关/改 webhook 出口（undefined = 关闭外呼，只落文件档） */
  setWebhookUrl(url: string | undefined): void {
    this.webhookUrl = url === undefined || url.trim() === '' ? undefined : url;
  }

  /**
   * 发一条告警并按故障键登记 stall（故障期间重复调用同一标题即被限流，不刷屏）。
   * 返回回执：`sent` 为 false 时看 `reason` 区分"被限流"与"通道失败"。
   */
  async send(level: AlertLevel, title: string, body: string): Promise<AlertDelivery> {
    return this.deliver(
      { category: 'alert', level, title, body, params: { title } },
      fingerprintOf('alert', { title }),
      `alert:${title}`,
    );
  }

  /**
   * 故障恢复通知：该故障键处于 stall 时发一条 info 并清除登记；没有登记返回 null
   * （调用方据此决定要不要打"已恢复"日志——不制造假事实）。
   */
  async recover(spec: { level: AlertLevel; title: string }, note: string): Promise<AlertDelivery | null> {
    const key = `alert:${spec.title}`;
    const stall = this.stalling.get(key);
    if (stall === undefined) return null;
    this.stalling.delete(key);
    const seconds = Math.max(0, Math.round((this.now().getTime() - stall.since) / 1000));
    return this.deliver(
      {
        category: 'alert:recovered',
        level: 'info',
        title: `已恢复：${spec.title}`,
        body: `${note}（同类故障连续 ${stall.count} 次，持续 ${seconds} 秒）`,
        params: { title: spec.title },
      },
      // 恢复通知单独成指纹，不被故障那 30 分钟窗口连坐
      fingerprintOf('alert:recovered', { title: spec.title }),
      null,
    );
  }

  // ── 任务形状：admin 兼容 + alert / fail / ok ──

  /** admin.ts 的 Notifier 形状：消息类告警，以标题为关键参数（同标题半小时只提醒一次） */
  async sendMessage(message: NotifyMessage): Promise<NotifyOutcome> {
    return this.alert({
      category: 'notify',
      level: message.level,
      title: message.title,
      body: message.body,
      params: { title: message.title },
    });
  }

  /** 带类别与参数指纹的告警（不登记 stall：普通告警不是故障） */
  async alert(input: AlertInput): Promise<NotifyOutcome> {
    return toOutcome(await this.deliver(input, fingerprintOf(input.category, input.params), null));
  }

  /** 故障上报：登记 stall + 投递；重复调用只累计次数（告警被限流） */
  async fail(input: AlertInput): Promise<NotifyOutcome> {
    this.markStall(`category:${input.category}`, fingerprintOf(input.category, input.params));
    return toOutcome(await this.deliver(input, fingerprintOf(input.category, input.params), null));
  }

  /** 恢复上报：处于 stall 时发一条"已恢复"并清除登记；不在 stall 时什么都不做 */
  async ok(category: string, body?: string | undefined): Promise<NotifyOutcome> {
    const key = `category:${category}`;
    const stall = this.stalling.get(key);
    if (stall === undefined) return { ok: true };
    this.stalling.delete(key);
    const seconds = Math.max(0, Math.round((this.now().getTime() - stall.since) / 1000));
    const input: AlertInput = {
      category: `${category}:recovered`,
      level: 'info',
      title: `已恢复：${category}`,
      body: body ?? `同类故障连续 ${stall.count} 次后首次成功，已恢复（故障持续 ${seconds} 秒）。`,
      params: { category },
    };
    return toOutcome(await this.deliver(input, fingerprintOf(input.category, input.params), null));
  }

  /** 恢复入口：把历史 alarm/sent 折进限流窗口（M3-10 跨重启限流） */
  restore(events: Iterable<AppEvent>): void {
    for (const [fingerprint, at] of foldAlarms(events)) {
      const previous = this.windowsMap.get(fingerprint);
      if (previous === undefined || at > previous) this.windowsMap.set(fingerprint, at);
    }
  }

  windows(): Map<string, number> {
    return new Map(this.windowsMap);
  }

  stats(): AlertStats {
    return { ...this.counters };
  }

  // ── 投递 ──

  private async deliver(
    input: AlertInput,
    fingerprint: string,
    stallKey: string | null,
  ): Promise<AlertDelivery> {
    const at = this.now();
    const nowMs = at.getTime();
    const ts = at.toISOString();
    const file = this.filePath(ts);

    const last = this.windowsMap.get(fingerprint);
    if (last !== undefined && nowMs - last < this.rateLimitMs) {
      // 有意丢弃：不是失败，是限流。故障仍在持续，stall 登记照旧推进
      this.counters.suppressed += 1;
      if (stallKey !== null) this.markStall(stallKey, fingerprint);
      return { sent: false, fingerprint, file, reason: RATE_LIMITED };
    }

    const fileOutcome = await this.appendLine(file, ts, fingerprint, input);
    const webhookOutcome = await this.postWebhook({ ts, fingerprint, input });

    // 两件事要分开：
    //   · 存档（限流窗口的推进依据）＝ 任一通道成功。只要落盘了就推进窗口，
    //     否则一个挂掉的 webhook 会在每一拍被重试（刷屏 + 无谓外呼）；
    //   · 送达（返回的 sent）＝ 真正给人的通道成功：配了 webhook 就只看它，
    //     没配才由文件档担当。
    const fileOk = fileOutcome === null;
    const webhookOk = webhookOutcome !== null && webhookOutcome.ok;
    const archived = fileOk || webhookOk;
    if (archived) {
      this.counters.sent += 1;
      this.windowsMap.set(fingerprint, nowMs);
      if (stallKey !== null) this.markStall(stallKey, fingerprint);
      this.record?.({ fingerprint, level: input.level, title: input.title });
    } else {
      this.counters.failed += 1;
      if (stallKey !== null) this.markStall(stallKey, fingerprint);
    }

    const reasons: string[] = [];
    if (fileOutcome !== null) reasons.push(fileOutcome.reason);
    if (webhookOutcome !== null && !webhookOutcome.ok) reasons.push(webhookOutcome.reason);
    const delivered = this.webhookUrl === undefined ? fileOk : webhookOk;
    if (delivered) return { sent: true, fingerprint, file };
    return { sent: false, fingerprint, file, reason: reasons.join('；') || '所有通道均失败' };
  }

  /** 文件档：追加一行。失败不抛——告警出口自己崩掉比漏一条更糟 */
  private async appendLine(
    file: string,
    ts: string,
    fingerprint: string,
    input: AlertInput,
  ): Promise<{ ok: false; reason: string } | null> {
    try {
      if (!this.dirReady) {
        await mkdir(this.alertDir, { recursive: true });
        this.dirReady = true;
      }
      await appendFile(file, formatLine(ts, fingerprint, input), 'utf8');
      return null;
    } catch (err) {
      return { ok: false, reason: `告警日志写入失败：${describeError(err)}` };
    }
  }

  /** Webhook 档：未配置返回 null（"没有这一档"与"这一档失败"是两件事） */
  private async postWebhook(args: {
    ts: string;
    fingerprint: string;
    input: AlertInput;
  }): Promise<{ ok: true } | { ok: false; reason: string } | null> {
    const url = this.webhookUrl;
    if (url === undefined) return null;
    const payload = JSON.stringify({
      level: args.input.level,
      title: args.input.title,
      body: args.input.body,
      ts: args.ts,
      fingerprint: args.fingerprint,
    });
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, reason: `Webhook 返回 HTTP ${response.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Webhook 投递失败：${describeError(err)}` };
    }
  }

  private markStall(key: string, fingerprint: string): void {
    const existing = this.stalling.get(key);
    if (existing === undefined) {
      this.stalling.set(key, { since: this.now().getTime(), count: 1, fingerprint });
      return;
    }
    existing.count += 1;
  }

  /** 告警日志按 UTC 日期分片（与 budget/rollover 的"今日"口径一致） */
  private filePath(ts: string): string {
    return join(this.alertDir, `${ts.slice(0, 10)}.log`);
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/** 内部回执 → admin 形状的结局：被限流不是失败（有意丢弃） */
function toOutcome(delivery: AlertDelivery): NotifyOutcome {
  if (delivery.sent) return { ok: true };
  if (delivery.reason === RATE_LIMITED) return { ok: true };
  return { ok: false, reason: delivery.reason ?? '告警未送达' };
}

/** 人类可读一行（换行转义，保证一条告警恒占一行，便于 tail/grep） */
function formatLine(ts: string, fingerprint: string, input: AlertInput): string {
  const body = input.body.replace(/\r?\n/gu, ' ⏎ ');
  return `${ts} [${input.level}] fp=${fingerprint} ${input.title} | ${body}\n`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pickRateLimitMin(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RATE_LIMIT_MIN;
}

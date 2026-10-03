/**
 * Irmia Agent — 启动异常退出告警（docs/design.md §4.9 触发点清单首条、docs/milestones.md M4 交付物 5）
 *
 * 判据只有一个：**恢复流程的补偿清单里出现了「上一次运行异常退出」**。
 * 这条事实由 runtime/recover.ts 第四步（settleOpenTurn）产生——它发现上一个进程留下未闭合的
 * turn 时补写 `turn/end{interrupted}`，并把这句事实记进 repairs。本模块不自己再判定一次
 * 「是否异常退出」：判定分散到第二处，就必然出现一处说异常、一处说正常的两个口径。
 *
 * 交付纪律（§4.9）：
 *   - 级别 warn，走 alert/notifier.ts 的统一出口（文件档永远在，webhook 配了才走）；
 *   - 指纹类别固定为 `startup-recovery`，不带参数——于是「同一类启动告警 30 分钟内只发一次」
 *     对守护脚本有效：反复拉起一个必然崩溃的进程，人只会收到一条，而不是被刷屏。
 *
 * 约定：纯类型导入写 `.js`。零外部依赖：只用 node: 标准库。
 */

import type { NotifyOutcome } from '../tools/admin.js';
import type { AlertInput, AlertNotifier } from './notifier.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 告警类别（指纹的类别段）：同类启动告警共用一个 30 分钟限流窗口 */
export const STARTUP_RECOVERY_CATEGORY = 'startup-recovery';

/**
 * recover 标记异常退出的字样。与 runtime/recover.ts 的 settleOpenTurn 文本契约绑定
 * （`上一次运行异常退出：turn N 补写 turn/end{interrupted}`），该契约由 test/cli-observe.test.ts
 * 用真实 recover 的输出锁定——文案一改，测试立刻红，不会静默失去这条告警。
 */
export const INTERRUPTED_REPAIR_MARK = 'interrupted';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface StartupRecoveryInput {
  /** recover 返回的补偿清单（RecoverResult.repairs） */
  repairs: readonly string[];
  /** 数据目录（写进正文，便于人定位是哪个实例） */
  dataDir?: string | undefined;
  /** 本次启动的进程 pid（写进正文） */
  pid?: number | undefined;
}

// ──────────────────────────────── 判定 ────────────────────────────────

/** 挑出「上一次运行异常退出」相关的补偿项；返回空数组即上次是正常退出，不必告警 */
export function interruptedRepairs(repairs: readonly string[]): string[] {
  return repairs.filter((repair) => repair.includes(INTERRUPTED_REPAIR_MARK));
}

/**
 * 组装启动告警；上次正常退出返回 null（**不制造"出事了"的假事实**）。
 * 正文里把恢复补偿逐条列出来：收到告警的人第一眼要看到的是"系统自己做了什么"，
 * 而不是一句"上次崩了"——补偿清单决定了他是去看 review list 还是直接放心。
 */
export function buildStartupRecoveryAlert(input: StartupRecoveryInput): AlertInput | null {
  const hits = interruptedRepairs(input.repairs);
  if (hits.length === 0) return null;

  const where = input.dataDir === undefined ? '' : `（数据目录 ${input.dataDir}）`;
  const who = input.pid === undefined ? '' : `，本次启动 pid ${input.pid}`;
  const body = [
    `启动时发现上一次运行不是正常退出${where}${who}：${hits.join('；')}。`,
    `本次启动完成 ${input.repairs.length} 项恢复补偿：未闭合的 turn 已按 interrupted 结算，`
      + '被它认领过的输入已退回队列等待重新认领，有副作用的悬空调用一律标为 unknown 并进入待确认。',
    '请用 `irmia review list` 核对 unknown 调用后再用 `irmia review resolve` 结案。',
  ].join('');

  return {
    category: STARTUP_RECOVERY_CATEGORY,
    level: 'warn',
    title: `启动恢复：上一次运行异常退出（补偿 ${input.repairs.length} 项）`,
    body,
    // 刻意不带 params：参数会进指纹，参数一变就绕开限流窗口，等于给刷屏开门
  };
}

/**
 * 发一条启动告警并返回回执；上次正常退出返回 null。
 * 用 alert 而非 fail：异常退出是一次性事实，不是正在持续的故障——fail 会在 notifier 里
 * 登记一个永远等不到「已恢复」的故障窗口。
 */
export async function notifyStartupRecovery(
  notifier: AlertNotifier,
  input: StartupRecoveryInput,
): Promise<NotifyOutcome | null> {
  const alert = buildStartupRecoveryAlert(input);
  if (alert === null) return null;
  return notifier.alert(alert);
}

/**
 * Irmia Agent —— 人在消息里打的那两个指令（B1）：`/compact` 与 `/handoff`。
 *
 * ## 为什么要有"手动触发"这条路
 *
 * 压缩与交接本来都是**自动**的：上下文估算越过阈值就压一次，会话结束时留一份交接笔记。
 * 但有两件事只有人知道、框架猜不到：
 *   • "这一轮接下来要干一件很长的事，现在先把上下文收紧"；
 *   • "我要关机器了 / 要换一班人接手，现在就把交接写下来"。
 * 等阈值自己撞上来，往往已经晚了——所以给两个能**当场**触发的指令。
 *
 * ## 为什么不让她自己调
 *
 * 它们是**改她自己上下文**的动作，不是对外说话（与 `speak` / `report` 不是一类）：
 * 压缩会让她"忘掉"细节（原文被摘要替代），这是不可逆的取舍，得由人拍。
 * 所以这两条走"人打的字"这条路（本机对话流的输入），而不是工具。
 *
 * ## 解析口径（严格，宁可不认）
 *
 * 只认**整条消息以指令词开头**这一种形态：
 *   `/compact`               → 压缩（可跟一句理由：`/compact 上下文太长了`）
 *   `/handoff`               → 写交接笔记
 *   `/compact` 之外的斜杠词   → `unknown`（上层据此回一句"没有这个指令"，
 *                              **不要**当成普通消息发给她——那会让她去猜"用户是不是在说别的"）
 * 一句话中间出现的 `/compact`（例如"我说的是 /compact 那个功能"）**不认**：
 * 那是在谈论这个功能，不是在用它。
 *
 * 全角斜杠（`／`）也认：中文输入法下打出全角斜杠是常事，为此让人重打一遍没道理。
 *
 * ## 与接线的关系（当前边界）
 *
 * 这个文件只做**纯解析**与文案：把一个字符串变成"要做什么 + 理由"。真的去压缩 / 真的去写
 * 交接笔记在 `real-loop.ts`（`handleSlashCommands`）。
 *
 * **两条指令共用同一条落库路径**（2026-10-04 接完线才知道的事，值得写在最前面）：
 * 效果都是"写一份交接笔记作为 `compaction/summary`"。因为那是**唯一**一条"下一个 turn
 * 读得到"的路——渲染层只认这个事件（`model/render.ts` 的 `renderMemoryLayer`），
 * 而且要求 `coveredUpToSeq` 严格大于已有值才会被渲染出来。所以 `/handoff` 也会遮蔽历史，
 * 与 `/compact` 的区别只在**人按它的理由**，不在机制。收据文案（下面两句）按这个事实写，
 * **不许**让它替实现圆场。
 */

/** 识别出来的指令种类 */
export type SlashCommandKind = 'compact' | 'handoff' | 'unknown';

export interface SlashCommand {
  kind: SlashCommandKind;
  /** `unknown` 时是被打出来的那个词（回话时点名用），其余为指令名 */
  name: string;
  /** 指令后面跟的那句话（理由）；没有就是空串 */
  argument: string;
}

/** 两个指令词（小写比对；这里同时是"哪些词算指令"的唯一名单） */
const COMMANDS: readonly string[] = ['compact', 'handoff'];

/**
 * "像一个指令词"的形状：字母开头，只含字母/数字/下划线/连字符。
 *
 * 为什么要这一条而不是"斜杠开头的都算"：`/home/user 这个路径`、`/tmp/a.txt` 这类
 * **以路径开头的正常消息**会被当成"不认识的指令"，然后回一句"没有这个指令 home/user"——
 * 那等于把她的日常输入吃掉。所以认不出来时也要先问一句"这长得像指令吗"。
 * 打错字的 `/compcat` 满足这个形状，仍会被当成"不认识的指令"报回去（这才是我们要的）。
 */
const COMMAND_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/**
 * 解析一条输入。
 *
 * 返回 null = 这不是指令（照普通消息走）。
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  // 全角斜杠先归一：下面只认一种形状，省得每处判断都写两遍
  const normalized = trimmed.startsWith('／') ? `/${trimmed.slice(1)}` : trimmed;
  if (!normalized.startsWith('/')) return null;

  // 指令词 = 斜杠之后到第一个空白之前
  const body = normalized.slice(1);
  const match = /^(\S+)([\s\S]*)$/u.exec(body);
  if (match === null) return null; // 只有一个斜杠：不是指令
  const raw = match[1]!;
  const rest = match[2]!.trim();
  const word = raw.toLowerCase();

  if (COMMANDS.includes(word)) {
    return { kind: word as SlashCommandKind, name: word, argument: rest };
  }
  // 形状不像指令词（路径、网址……）：不是指令，照普通消息走
  if (!COMMAND_SHAPE.test(raw)) return null;
  // 像指令词但不在名单里：**明确**报回去，不当普通消息（见文件头）
  return { kind: 'unknown', name: raw, argument: rest };
}

/**
 * 两个指令各一句话（回话与文档共用一处文案：措辞只有一份，改的时候不会漏掉一处）。
 * 顺序与 {@link COMMANDS} 一致。
 */
const COMMAND_HELP: readonly string[] = [
  '/compact —— 立刻压缩一次上下文（截至此刻的往来换成摘要，原文仍在事件日志里）',
  '/handoff —— 立刻写下交接笔记（它会成为下一个 turn 的「早期历史摘要」）',
];

/**
 * 这条事件是不是"整条就是一条指令"的 `wake/manual`（给框架的，不是对她说的话）。
 *
 * **两个地方必须用同一个判据**（这就是它被导出的全部理由）：
 *   • `real-loop` 的 `eventFilter`：指令不进她的上下文。她该看见的是指令的**效果**
 *     （摘要 / 交接笔记），不是用户按的那个按钮。少了这一刀，打错的那个词
 *     （`/clear` 这种）会在**下一个 turn** 的历史里作为一条 user 消息出现在她眼前——
 *     她又得去猜"用户是不是想清空什么"，正是文件头写明不许发生的事；
 *   • `replay` 的归属过滤：重建必须与运行期看到的是同一份事件，
 *     否则"同一份日志重建同一份请求"这条承诺就断了。
 *
 * `via` 有值（框架替 `/dream` 拼的那条）**不算**指令：那条 note 是**对她说的话**
 * （"该做梦了……"），必须进她的上下文。
 *
 * 纯函数：同一条事件在任何时刻给出同一个结论（重建纪律）。解析口径本身只有一份
 * （{@link parseSlashCommand}），这里不重写一遍。
 */
export function isSlashCommandEvent(event: { type: string; data: unknown }): boolean {
  if (event.type !== 'wake/manual') return false;
  const data = (event.data ?? {}) as { note?: unknown; via?: unknown };
  if (data.via !== undefined) return false;
  return typeof data.note === 'string' && parseSlashCommand(data.note) !== null;
}

/**
 * 认不出来的斜杠词的回话。
 * 为什么必须**点名**那个词、并且**列出**可用的两个：打了 `/clear` 的人下一步要么改成正确的词，
 * 要么去提需求；只说"不认识的指令"他得自己猜有什么。（**不**把这条消息当成普通消息发给她——
 * 那会让她去猜"用户是不是在说别的"，见文件头。）
 */
export function unknownCommandReply(name: string): string {
  return `没有这个指令 ${name}。可用的有：${COMMAND_HELP.join('；')}。`;
}

/**
 * 压缩的收据（接线时随动作一起回给用户）。
 *
 * 说的是四件事实：**已经压了**、**哪一段不再逐字进上下文**、**没处理完的输入没被动**、
 * **原文仍在日志里**（可查可回放）。最后一句不是安慰话：事件日志是唯一真相源，压缩只是
 * 渲染层的遮蔽——不说清楚，人会以为"原文被删了"而不敢用这个指令。
 *
 * 2026-10-04 逐字核对过一遍（B1 第二步）：遮蔽点不是"此刻"这个模糊界限，而是
 * `max(已有摘要, 上一个已结束 turn 的 turn/end, 队列里最早那条待处理输入 − 1)` 取大
 * （见 `agent-loop.ts` 的 `compactionCoveredUpToSeq`）。所以文案说的是"**截至此刻的往来**
 * （队列里还没轮到处理的输入除外）"——两个边界都点到了，没有一个字是替实现圆场的。
 */
export const COMPACT_RECEIPT =
  '已经强制压缩：截至此刻的往来（队列里还没轮到处理的输入除外）换成摘要进上下文，'
  + '那一段不再逐字进。'
  + '原文仍然逐条留在事件日志里（可查、可回放），但**这一步不可逆**——遮蔽已经生效，摘要已经代替了它。';

/**
 * 交接的收据（B1 第二步改过一次，改的是**事实**不是措辞）。
 *
 * 改之前的第二句是"本轮之前的原文照旧留在日志与历史里，这一步不改写任何已发生的事情"——
 * 那句话是**错的**：`/handoff` 与 `/compact` 共用同一条落库路径（写一份交接笔记作为
 * `compaction/summary`，那是**唯一**一条"下一个 turn 读得到"的路：渲染层只认这个事件，
 * 而且 `coveredUpToSeq` 必须大于已有值才会被渲染），所以交接笔记一写下去，
 * 它覆盖的那一段**就不再逐字进上下文**了。现在的三句分别对应三件真事：
 *   ① 笔记写下了、下一个 turn 带着它开始；
 *   ② 截至此刻的历史会被这份摘要遮蔽（原文仍在事件日志里）；
 *   ③ 不可逆。
 * 说不清楚这件事，人会以为"交接"只是留了张便条——而实际效果是压缩。
 */
export const HANDOFF_RECEIPT =
  '已经写下交接笔记：它作为「早期历史摘要」跟着下一个 turn 开始（写给"接手的那个我"看）。'
  + '为此**截至此刻的历史会被这份摘要遮蔽**——那一段不再逐字进上下文'
  + '（原文仍逐条留在事件日志里，可查、可回放）。'
  + '**这一步不可逆**：遮蔽已经生效，与 /compact 是同一套机制。';

/**
 * 没有可写内容时的收据（`outcome: 'empty'`）。
 *
 * 为什么宁可什么都不做：写一份只有标题的空摘要，会把它覆盖的那段历史遮掉却不留下替代品
 * ——那是净损失。没有内容就如实说没有。
 */
export const COMPACT_EMPTY_RECEIPT =
  '这一次什么都没压：日志里没有能写进交接笔记的内容，不写空摘要（那会把历史遮掉却不留替代品）。';

/** `/handoff` 的同一条：没有内容就不落笔记，如实说一句 */
export const HANDOFF_EMPTY_RECEIPT =
  '交接笔记一个字都没写：日志里没有能写进笔记的内容。什么都没改，上下文也没动。';

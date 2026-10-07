/**
 * Irmia Agent — 通道消息分流器（design §4.24 的姊妹件：那边管"什么时候看"，这边管"要不要看"）
 *
 * **模型（用户定的）**：QQ 对她来说应该是"手边一个可以点开的软件"，不是推给她的消息流。
 * 除了用户与她自己标记为关注的会话，其他私聊/群聊消息**不强制注入**：框架照收照留
 * （写一条 `channel/message`，见 log/types.ts 那段注释），她只是**知晓**"某某会话积累了多少条"，
 * 可以选择看，也可以不看——不看也不会丢（已经到了我们这里的那些）。
 *
 * 在这之上只有一条硬提高优先级的路径：**@ 她 / 提到她**。那条进消息流并唤醒她，
 * 提示里写清"某群有人提到你，那里积累了 N 条"（见 model/self-brief.ts 的 renderMentionNote），
 * 剩下是她自己的决定：翻全部（大部分时候没用）还是只看 @ 附近（`read_channel`）。
 *
 * **为什么是纯函数**（不读配置、不碰日志、不查会话簿）：
 *   • 它决定的是一件有后果的事（要不要打断她），而后果要靠断言钉住——四种情形逐条可测，
 *     不必搭一整个循环；
 *   • 接线（谁来算 `watchedSids`、谁来写 `channel/message`）留在宿主（main.ts）里：
 *     本模块只回答"这条消息该不该叫她"，不替宿主决定从哪儿知道"谁被关注"。
 */

import type { WakeChannel } from '../log/types.js';
import { sidOf } from './sessions.ts';

/**
 * 复用会话层的 `sidOf`（`qq:c2c:<openid>` / `onebot:group-at:<id>`）。
 *
 * 为什么在这里再导出一次而不是让调用方去 import sessions：分流器的**全部**判断都基于 sid
 * （它要拿 sid 去比对 `watchedSids`，而 `watchedSids` 里的值又来自会话簿）。谁用分流器，
 * 谁就必须用同一个 sid 算法——两处各拼一次串，代价是"关注了 A 却永远不唤醒"这种查不出来的错。
 */
export { sidOf };

/**
 * 与 `wake/channel` 同形的数据 → sid。叫法与返回值都与会话簿一致。
 *
 * 只吃三个字段而不是整个 data：这样"哪些字段决定 sid"是一眼可读的，
 * 而且调用方不必为了算一个 sid 去凑齐一条完整消息。
 */
export function sidOfChannelData(data: Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId'>): string {
  return sidOf(data.channel, data.chatType, data.chatId);
}

/**
 * **什么算"关注"**（`watchedSids` 该装哪些 sid）——这份清单是口径，实现在宿主（main.ts）。
 *
 * 三条来源，取并集（**只管私聊**，见 `shouldWakeForChannelMessage` 的 ③）：
 *   ① **用户**：`config.persona.contacts` 里显式声明过名字的那些 sid——人声明的事实最优先
 *      （它同时也告诉框架"这个会话是谁"，`resolveSessionName` 用的就是同一张表）。
 *      用户的 c2c 会话必须在这里，否则他说话她不会醒。
 *   ② **她自己标的**：`MEMORIES/aliases.md` 里出现过的 sid（她认出来的人）。
 *      理由是把"关注"这件判断交回给她的资产：她写一行 `sid = 名字` 就等于说"这个人我要看"。
 *   ③ 将来若加显式配置（如 `channels.watch: []`），也并进同一份 —— 但**不要**在这里替
 *      宿主去读文件或配置：本模块是纯函数，读盘是宿主的事。
 *
 * 刻意**不**包含的东西：群。给群起名字（联系人表 / 别名表里那一行）是"让她认得这个会话"，
 * 不是"订阅这个群的每句话"——2026-10-02 实测踩到过：用户给群填了名字，于是他在群里发的
 * 四个字、几个数字全被送进她的上下文。群里只有**叫到她**（@ 或喊她的名字）才进对话流，
 * 其余进信箱（未读照算）。
 *
 * ⚠️ **"进信箱"有一个我们控制不了的前提**：消息得先由官方 Bot **推给我们**（平台侧的消息权限 /
 * 订阅设置）。我们这一侧只有这一条路——平台没推的，我们收不到、也存不进信箱。所以这里**不说**
 * "一条不丢"（那句话把前提说成了结果）：**平台推给我们的，照旧进信箱**。2026-10-04 的现场核查
 * （`docs/unread-and-inbox-check.md`）就是因为这句失真的话被追问过：25 小时里一条非 @ 群消息都没到，
 * 而根因在平台侧的权限，不在这条分流逻辑里。
 */
export const WATCHED_SESSION_SOURCES = ['config.persona.contacts', 'MEMORIES/aliases.md'] as const;

/**
 * 这条通道消息该不该**唤醒**她（true = 进消息流并起 turn；false = 进信箱，只记账）。
 *
 * 判据四条，**顺序即优先级**（读代码的人应当一眼看出"叫她的路优先于关注"）：
 *   ① `chatType === 'group-at'`，或适配器给出的 `mentionsMe === true`（群里 @ 了她）→ **true**。
 *      这是平台层面"有人直接叫到她"的路径。
 *   ② 正文里出现了**她被怎么称呼**里的词（`mentionKeywords`，2026-10-02 用户拍板）→ **true**。
 *      为什么要有这一条：群里的人常常不打 @ 而直接喊名字，平台不会把那种句子标成"提到了机器人"
 *      ——实测用户在群里连喊两声"弥亚小姐"，四条消息全进了信箱，她一条都没听见。
 *      代价与分寸见 config.ts 的 `mentionKeywords`（关键词匹配，不做语义判断）。
 *   ③ **私聊**且会话 sid 在 `watchedSids` 里（用户 / 她关注的**人**）→ **true**。
 *   ④ 其余 → **false**（进信箱）。
 *
 * **③ 只对私聊生效**（2026-10-02 用户报的一个岔子）：群聊**不再**因为"被关注"而整体唤醒。
 * 之前 `watchedSids` 对群也生效，而"关注名单"就是联系人表 ∪ 她的别名表——于是**给群起一个名字**
 * 这个动作顺手把这个群订阅了：群里每句闲话都进对话流（实测用户给群填了名字之后，他在群里发的
 * 四个字、几个数字全被送进她的上下文），而那显然不是"起名字"的意思。
 * 现在群里的规矩很干净：**只有叫到她（@ 或喊她的名字）才进对话流，其余进信箱**——
 * 未读照样累计，她 `read_channel` 现取（前提同上：那条消息得先被平台推给我们）。
 *
 * 关于 `mentionsMe`：适配器"给得出就填"（官方通道在 `GROUP_MESSAGE_CREATE` 里看 `mentions`
 * 数组里有没有机器人开头的项），它是**平台级的事实**，所以认它。但它与 `chatType === 'group-at'`
 * 不冲突——适配器把 @ 归类为 `group-at` 时顺带填它，两处信息同源。
 */
export function shouldWakeForChannelMessage(
  data: WakeChannel['data'],
  criteria: WakeCriteria,
): boolean {
  if (data.chatType === 'group-at') return true;
  if (data.mentionsMe === true) return true;
  if (mentionsKeyword(data.text, criteria.mentionKeywords)) return true;
  // 关注名单只管私聊：群里"被关注"不等于"每句都叫我"（见上面 ③ 的说明）
  if (data.chatType !== 'c2c') return false;
  return criteria.watchedSids.has(sidOfChannelData(data));
}

/** 唤醒判据的两个外部输入：都来自宿主（配置与她的别名表），本模块只读结论 */
export interface WakeCriteria {
  /** 用户 / 她关注的会话（键已归一，见 sessions.ts 的 normalizeSid） */
  watchedSids: ReadonlySet<string>;
  /** 「她被怎么称呼」：正文里出现就当作在叫她。空数组 = 只认平台的 @ */
  mentionKeywords: readonly string[];
}

/**
 * 正文里有没有人在叫她（关键词匹配）。
 *
 * 三条刻意的规则：
 *   • **大小写不敏感**：英文名（Irmia / irmia）不该因为大小写漏掉；
 *   • **空词忽略**：列表里混进空串不该让每条消息都命中；
 *   • **只匹配正文**：附件名、消息 id 不参与——那些不是"人在叫她"。
 *
 * 不做词边界判断（中文没有词边界，做了反而更糟）：代价是"伊尔弥亚的粉丝"这类也会命中，
 * 而那正是"她在群里被提到"的常见形态——多醒一次比漏听一句便宜。
 */
export function mentionsKeyword(text: string, keywords: readonly string[]): boolean {
  if (text === '' || keywords.length === 0) return false;
  const haystack = text.toLowerCase();
  return keywords.some((word) => {
    const needle = word.trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}

/**
 * 落库时这条消息的 `msgSeq`：**平台给不出真序号（0）就填事件 seq**。
 *
 * 为什么必须补：未读的判据是 `msgSeq > readUpToSeq`（见 `sessions.ts` 的 fold）。平台给不出
 * 序号的那两类——OneBot 没 @ 的群消息、官方全量群消息（事件体里压根没有这个字段）——如果
 * 原样落 0，每一条都是 0，她读一次之后未读**永远是 0**，于是"某群积累了 N 条"再也显示不出来，
 * 正好把这个信箱废掉。事件 seq 单调、重放稳定，正是这里要的那个数（约定写在 sessions.ts 那段）。
 *
 * 给得出真序号的（OneBot 带 message_seq 的那些）原样留着——那是平台自己的编号，量纲别混。
 *
 * **2026-10-07：唤醒那条路（`wake/channel`）也走它**（原来只有信箱那条走）。理由是同一个判据
 * 在**两处**读同一个字段：
 *   • 信箱：未读 `msgSeq > readUpToSeq`；
 *   • 唤醒：「这一条你还没看过」，`wakeEvent.data.msgSeq > entry.readUpToSeq`
 *     （`agent-loop.ts` 的 `contactWithWakeStamp`）。
 * 唤醒那条原先不补，于是 OneBot 群里 @ 她的那一轮 `0 > 0` 恒假——通知里**永远**不出现
 * 「（这一条你还没看过）」，她会读成"又是上一次那条"而选择不回（报告 §3.4；那正是用户
 * 2026-10-02 踩过的那个坑，这段代码存在的唯一理由就是修它）。
 * 两条路走**同一个函数**（唤醒那条是 `runtime/real-loop.ts` 的 `withMsgSeqFallback`，
 * 它调的也是这里）⇒ 同一个数、同一套量纲，"信箱说 5 条、唤醒说没看过"这种自相矛盾
 * 从源头不可能出现。
 */
export function msgSeqOf(data: { msgSeq?: number | undefined }, eventSeq: number): number {
  const platform = data.msgSeq ?? 0;
  // 非正数一律当"平台没给"：0 是"没有这个字段"的既有写法，负数不是合法序号
  return platform > 0 ? platform : eventSeq;
}

/**
 * 旧名字（信箱那条路的调用点用惯了）。逐字节等价于 `msgSeqOf`——留它是为了**不让这次
 * 语义扩大变成一次改名**：改名会让 review 分不清"哪些是行为变化、哪些只是重命名"。
 */
export const inboxMsgSeqOf = msgSeqOf;

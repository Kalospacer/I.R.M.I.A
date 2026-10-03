/**
 * Irmia Agent — 会话簿（她认识"在哪儿说话、跟谁说话"的唯一依据）
 *
 * 三件事：
 *   ① **sid**：会话标识，形如 `qq:c2c:<openid>` / `qq:group-at:<group_openid>` /
 *      `onebot:c2c:<user_id>`。它与回投地址（tools/admin.ts 的 `replyUrlForWake`）
 *      **同形同源**——她说"发给谁"和系统"往哪发"必须是同一个东西，否则就会出现
 *      「她以为发给了张三、实际发到了群里」这种最难查的错。
 *   ② **会话簿**：从 `wake/channel` 与 `channel/message` **两种事件**折叠出来的已知会话
 *      （谁来过、什么时候、说过什么、她读到哪了）。零新增状态：日志仍是唯一真相源，
 *      这里只是它的一个投影。
 *   ③ **场景认知**：本机对话流不是一个"会话"（它没有 sid，也不来自任何通道），
 *      所以它单独标注——她得能分清"我在自己屋里自言自语/跟用户当面说话"与
 *      "我拿起电话打给某个人"。
 *
 * **为什么两种事件必须共用一份折叠实现**（下面 `applyChannelEvent` 只有一处）：
 *   • `wake/channel` 是「叫她」的那条路——@ 她、或关注/用户的会话，进消息流、唤醒 turn；
 *   • `channel/message` 是「手边软件在响」——群里/别人发来的普通消息，只记账、不唤醒。
 *   两者描述的是**同一件事**（某会话里某人说了一句），差别只在"要不要叫她"。折叠写两套的代价
 *   不是冗余：启动时从全量日志折叠（走 wake）与运行期逐条并入（走 message）会慢慢变成两份
 *   不同的记忆，而"她以为群里只来过三条"这种错在界面上看不出来。
 */
import type { AppEvent, ChannelMessage, ChannelRead, WakeChannel } from '../log/types.js';

/** 通道显示名：与 GUI 频道页、web/pages/channels.js 同一套词 */
export const CHANNEL_LABELS: Record<string, string> = {
  'qq-official': 'QQ 官方 Bot API',
  onebot: 'OneBot 11',
};

/** 会话类型显示名：与频道页的 `_chatTypes` 同一套词 */
export const CHAT_TYPE_LABELS: Record<string, string> = {
  c2c: '单聊',
  'group-at': '群聊@',
  group: '群聊',
  guild: '频道',
  dm: '频道私信',
};

/** 会话标识的命名空间：与回投 scheme 共用一套（qq: / onebot:） */
export function sidNamespaceOf(channel: string): string {
  return channel === 'onebot' ? 'onebot' : 'qq';
}

/**
 * 一条消息的 chatType → **会话身份**里的那一段。
 *
 * **群聊的 @ 与非 @ 是同一个会话**（2026-10-02 用户拍板"会话身份归一"）：以前 sid 直接把
 * chatType 拼进去，于是同一个群裂成两个会话——`qq:group-at:<群id>`（@ 过她的那些）与
 * `qq:group:<群id>`（其余消息）。代价是三件事一起歪：
 *   • 联系人表里给群起的名字只贴在 @ 的那一份上，非 @ 的那份显示 openid（看着像陌生群）；
 *   • "关注这个群"（联系人/别名 = 关注名单）只覆盖 @ 的那一份，非 @ 的消息照样进信箱
 *     ——实测用户给群起了名字、以为关注上了，结果不 @ 就永远叫不醒她；
 *   • 会话清单里同一个群出现两行，"2 个群聊"其实是 1 个。
 *
 * 现在 chatType 只是**这一条消息**的属性（它 @ 没 @ 我），会话身份与它无关。
 * 回投地址跟着归一（`qq:group:<群id>`）：官方那条 API 的群发路径与 @ 与否无关，
 * 差别只在带不带 `msg_id`（被动回复），而那是**每条消息**的事，不是会话的事。
 */
export function sidKindOf(chatType: string): string {
  return chatType === 'group-at' ? 'group' : chatType;
}

/** 组一个 sid。chatId 里若含 `:`（不该有，但外部数据不可信）会被 parseSid 原样还原 */
export function sidOf(channel: string, chatType: string, chatId: string): string {
  return `${sidNamespaceOf(channel)}:${sidKindOf(chatType)}:${chatId}`;
}

/**
 * 把**别人写下的** sid（配置里的联系人、她自己写的别名、旧日志里的 `channel/read`）归一到
 * 同一个口径。形态不认得就原样返回（不猜）。
 *
 * 为什么读的时候也要归一：归一之前落盘的 sid 里带着 `group-at`，那些记录还在用——
 * 联系人表里 `qq:group-at:<群id>` 是用户自己填的，别名表里可能有她认的群，日志里还有
 * 一批 `channel/read`。**改口径不该把人已经写下的东西变成废纸**。
 */
export function normalizeSid(sid: string): string {
  const parsed = parseSid(sid);
  if (parsed === null) return sid;
  return `${parsed.namespace}:${sidKindOf(parsed.chatType)}:${parsed.chatId}`;
}

export interface ParsedSid {
  namespace: string;
  chatType: string;
  chatId: string;
}

/** 解一个 sid；形态不对返回 null（不猜） */
export function parseSid(sid: string): ParsedSid | null {
  const first = sid.indexOf(':');
  const second = sid.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === sid.length - 1) return null;
  const namespace = sid.slice(0, first);
  const chatType = sid.slice(first + 1, second);
  const chatId = sid.slice(second + 1);
  if (chatId === '') return null;
  return { namespace, chatType, chatId };
}

/** sid 的命名空间反查通道名（`qq` → `qq-official`：回投 poster 按这个选通道） */
export function channelForNamespace(namespace: string): string {
  return namespace === 'onebot' ? 'onebot' : 'qq-official';
}

export interface SessionEntry {
  sid: string;
  /** 通道名（`qq-official` / `onebot`） */
  channel: string;
  chatType: string;
  chatId: string;
  /** 最近跟她说话的人：私聊是对方，群里是那位发言者（QQ 给的就是 openid） */
  person: string;
  /** 最近一条消息的片段（她认人用，不是全文） */
  lastText: string;
  lastSeenAt: string;
  /** 这个会话里她一共收到过多少条 */
  messages: number;
  /**
   * 别名：`MEMORIES/aliases.md` 里给这个会话起的名字（她自己维护的资产）。
   *
   * 为什么必须有它：QQ **不提供**单聊/群聊用户的昵称（隐私限制），她拿到的 `person`
   * 就是一串 openid。没别名时她只能靠"只有一个私聊会话"这种旁证猜人，猜错的代价是认错人。
   */
  label: string | null;
  /**
   * 她**读到**这个会话的哪一条了（`channel/read` 折叠；0 = 一条都没读过）。
   *
   * 比的是 `msgSeq` 而不是事件 seq：msgSeq 是"这条消息是这个会话里的第几条"，
   * 未读的语义正落在它上面（见 `unread` 的注释）。
   */
  readUpToSeq: number;
  /**
   * 这个会话里 `msgSeq > readUpToSeq` 的条数 = **她还没看的**。
   *
   * 为什么按"最近一次已读位置"算、而不是维护一个自减计数：计数会被重启、丢事件、并发写
   * 各掰一次，错了也没人看得出来；而"读到哪一条"是一个位置，重放日志必然算出同一个数
   * ——这正是本仓库"日志是唯一真相源"的用法。
   *
   * 已知偏差（刻意留着）：平台给不出真 msgSeq 时调用方填事件 seq，而两种值的量纲不同——
   * 一条老消息（事件 seq 很大）之后再来一条新消息（msgSeq 从 1 重新数）会让未读**偏小**。
   * 宁可偏小也不偏大：偏小 = 她少看几条（`read_channel` 现取的永远是最近的，不丢），
   * 偏大 = 每次都催她去看一屏其实看过的旧话。
   */
  unread: number;
}

/**
 * 会进会话簿的两种事件。它们唯一的实质差别是"要不要叫她"，折叠口径完全相同。
 *
 * 写成联合而不是交叉：交叉类型（`A & B`）在窄化到具体一种事件之后会被收成 never
 * （两个字面量 type 不可能同时成立），折叠函数里就一个字段都读不出来。
 */
export type ChannelEvent =
  | (AppEvent & { type: 'wake/channel' })
  | (AppEvent & { type: 'channel/message' });

/** 这条事件要不要并进会话簿（唯一判据，collect 与 upsert 共用一处） */
function isChannelEvent(event: AppEvent): event is ChannelEvent {
  return event.type === 'wake/channel' || event.type === 'channel/message';
}

/**
 * 从事件流折叠会话簿（按最后说话时间倒序）。
 *
 * 认两种事件：`wake/channel`（叫她来的那些）与 `channel/message`（只记账的那些）；
 * `channel/read` 再叠上"她读到哪了"。她不认识的会话就是没来过，不猜、不编——
 * 想给人发消息得先有过往来（或者人先来找她）。
 */
export function collectSessions(events: readonly AppEvent[]): SessionEntry[] {
  const map = new Map<string, SessionEntry>();
  for (const e of events) {
    if (isChannelEvent(e)) applyChannelMessage(map, e);
    else if (e.type === 'channel/read') applyChannelRead(map, e);
  }
  return sortSessions(map);
}

/**
 * 把一条通道事件并入会话簿（增量更新用）。
 *
 * 运行期不可能每轮重扫全量日志：real-loop 在启动时用 `collectSessions` 折叠一次，
 * 之后每收到一条就调这里。两者共用 `applyChannelMessage` / `applyChannelRead` 与
 * `sortSessions`——**一份实现**，否则"启动时算的"与"运行期长的"会慢慢变成两份不同的记忆。
 *
 * 不是通道事件就原样返回（会话簿只记"外面有人跟她说话"这一件事）。
 */
export function upsertSession(book: readonly SessionEntry[], event: AppEvent): SessionEntry[] {
  const map = new Map<string, SessionEntry>(book.map((entry) => [entry.sid, entry]));
  if (event.type === 'channel/read') applyChannelRead(map, event);
  else if (isChannelEvent(event)) applyChannelMessage(map, event);
  return sortSessions(map);
}

/** 通道数据 → sid（她读哪个会话、`channel/read` 记在谁头上，都得是同一个算法） */
export function sidOfChannelData(data: {
  channel: string; chatType: string; chatId: string;
}): string {
  return sidOf(data.channel, data.chatType, data.chatId);
}

/** 两种通道事件共有的那段负载（折叠唯一需要的字段；`mentionsMe` 之类刻意不在其中） */
export interface ChannelMessageFields {
  channel: string;
  chatType: string;
  person: string;
  chatId: string;
  text: string;
  messageId: string;
  msgSeq: number;
}

/**
 * 取一条通道事件的共有字段。
 *
 * 为什么不直接用 `event.data`：两种事件的 data 键集不同（一个带 `dedupeKey`、一个带
 * `mentionsMe`），联合类型下 TS 会把不相交的属性收成 never。折叠**只该读这几个字段**——
 * 把口径收成一份显式的清单，也顺手挡住了"顺手多读一个字段"的漂移。
 */
export function channelDataOf(event: ChannelEvent): ChannelMessageFields {
  return event.data;
}

/**
 * 一条通道消息并入会话簿（**唯一实现**：collect 与 upsert 都走它）。
 *
 * 三件事在同一份数据上落：
 *   ① 新消息覆盖"最近一条"、累计条数（既有语义，一个字没动）；
 *   ② `msgSeq` 超过已读位置就是没看过的，未读 +1——**未读在这里算，不另立一处**；
 *      于是"重启后剩下的未读"与"运行期长出来的未读"必然一致（日志重放得同一个数）；
 *   ③ 已读位置只增不减（见 applyChannelRead）。
 */
function applyChannelMessage(map: Map<string, SessionEntry>, event: ChannelEvent): void {
  // 联合类型在这里窄化不了（两种事件都是 AppEvent，data 的键集不同），所以取一次共有字段。
  // 只读这几个字段是**有意的**：fold 不该关心"这条是不是 @ 了我"——那是分流器的事。
  const d = channelDataOf(event);
  const sid = sidOf(d.channel, d.chatType, d.chatId);
  const prev = map.get(sid);  const readUpToSeq = prev?.readUpToSeq ?? 0;
  /**
   * 这条算不算"未读的积累"——**只有进信箱的才算**。
   *
   * 判据是事件类型，而不是"@ 没 @ 我"（那确实是分流器的事，fold 不该管）。区别在另一处：
   * `wake/channel` 是**已经送进她上下文**的那条，她当场看到了（哪怕选择不理，也是看过了）；
   * `channel/message` 才是攒在信箱里、等她哪天想翻再翻的。
   *
   * 两者混在一起数的后果是外部会话清单给她报一批**假未读**：实测用户那个单聊显示
   * "18 条没看"，而那些消息她全都看过、也回过。她会为了这批假数字去 `read_channel`
   * 翻一遍——白花一轮，还把自己刚说过的话重读一遍。
   *
   * （`messages` 那个总数仍然两种都计：它答的是"这个会话来过多少条"，与看没看过无关。）
   */
  const accrues = event.type === 'channel/message';
  map.set(sid, {
    sid,
    channel: d.channel,
    // 会话的类型取**会话口径**（群聊一律 group）：它答的是"这是个什么会话"，
    // 而不是"这一条 @ 没 @ 我"——后者属于消息，记在事件上
    chatType: sidKindOf(d.chatType),
    chatId: d.chatId,
    person: d.person,
    lastText: d.text.replace(/\s+/gu, ' ').trim().slice(0, 60),
    lastSeenAt: event.ts,
    messages: (prev?.messages ?? 0) + 1,
    // 别名不在这里查：折叠只管事实（谁在什么时候说了什么），名字是单独的、可以随时改的一份表
    label: prev?.label ?? null,
    readUpToSeq,
    unread: (prev?.unread ?? 0) + (accrues && d.msgSeq > readUpToSeq ? 1 : 0),
  });
}

/**
 * 折叠一条 `channel/read`：把已读位置推高，并按新位置重算未读。
 *
 * **只增不减**：读一条更早的记录（重放日志、或者她翻完历史又回头看了一段）不该让未读弹回来
 * ——"已读"在人的直觉里也是一次性的，退回去只会让她被同一批旧话反复叫住。
 *
 * 没有对应会话条目时**什么也不做**（不凭空造一个空会话）：那说明这个 sid 从来没有消息来过，
 * 这条读位记录就是无主数据，凭空造条目会让外部会话清单里冒出一个"没说过话的会话"。
 */
function applyChannelRead(map: Map<string, SessionEntry>, event: AppEvent & { type: 'channel/read' }): void {
  // 归一之后再查：旧日志里这条事件写的是 `qq:group-at:<群id>`（归一之前的形态），
  // 而会话条目现在是 `qq:group:<群id>`——不归一就读成"这个 sid 没来过"，已读位白记
  const sid = normalizeSid(event.data.sid);
  const upToSeq = event.data.upToSeq;
  const prev = map.get(sid);
  if (prev === undefined || upToSeq <= prev.readUpToSeq) return;
  // 未读**不按"减掉读过的条数"算**（读一半、跳着读都会算错），而是按位置重算：
  // 已读位置一动，未读的定义（msgSeq > readUpToSeq 的条数）就跟着变，位置是唯一的真相。
  //
  // 折叠里没有逐条消息的清单（会话簿是投影，不是消息表），所以能推断的是上界：未读数本身
  // 就是"介于旧已读位与最新一条之间"的条数，推高已读位最多把它清零。若新旧之间实际少于未读
  // 数（跳着读、平台序号有洞），剩下的部分会在她下一次 read_channel 时被一并归零——
  // 保守留一点，不凭空多减。而 read_channel 取回的永远是最新的若干条，不会因此丢掉内容。
  map.set(sid, { ...prev, readUpToSeq: upToSeq, unread: 0 });
}

/** 排序的唯一实现：最近说话的排最前（她要的是"现在谁在那头"） */
function sortSessions(map: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
  return [...map.values()].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
}

/** 会话的人读名字：`QQ 官方 Bot API · 单聊` */
export function sessionLabelOf(entry: Pick<SessionEntry, 'channel' | 'chatType'>): string {
  const channel = CHANNEL_LABELS[entry.channel] ?? entry.channel;
  const chatType = CHAT_TYPE_LABELS[entry.chatType] ?? entry.chatType;
  return `${channel} · ${chatType}`;
}

/** 这个会话该叫什么：有别名就用别名，否则退回 openid（不编名字） */
export function sessionNameOf(entry: Pick<SessionEntry, 'label' | 'person'>): string {
  return entry.label ?? entry.person;
}

/**
 * 拿一个 sid 去"人写下的表"里查时，该试哪几个键（按顺序）。
 *
 * 两种写法都要试的理由：归一（2026-10-02）之前写下的记录还在用——用户填的联系人表里可能是
 * `qq:group-at:<群id>`，她自己写的别名同理。**改口径不该把人已经写下的东西变成废纸**，
 * 而失效的样子很难看："我给这个群起过名字"却在界面上看见一串 openid。
 */
export function sidLookupKeys(sid: string): string[] {
  const parsed = parseSid(sid);
  if (parsed === null) return [sid];
  const kind = sidKindOf(parsed.chatType);
  const keys = [`${parsed.namespace}:${kind}:${parsed.chatId}`];
  // 群聊再补一次旧形态；其余类型没有第二种写法
  if (kind === 'group') keys.push(`${parsed.namespace}:group-at:${parsed.chatId}`);
  return keys;
}

/** 在表里按 [sidLookupKeys] 的顺序查第一份命中（查不到返回 undefined，不编） */
export function lookupBySid(
  table: ReadonlyMap<string, string> | undefined,
  sid: string,
): string | undefined {
  if (table === undefined) return undefined;
  for (const key of sidLookupKeys(sid)) {
    const hit = table.get(key);
    if (hit !== undefined && hit !== '') return hit;
  }
  return undefined;
}

/**
 * 单个 sid 的名字（联系人表优先，其次别名表）：给"只拿到一个 sid"的调用方用。
 *
 * 与 `resolveSessionName` 同一套查找（含新旧两种写法的兼容），差别只是输入不是会话条目。
 * real-loop 渲染一条通道消息、以及 `read_channel` 解析名字，都走这里——**一处实现**，
 * 否则"消息旁边显示 openid、清单上显示名字"这种不一致迟早出现。
 */
export function resolveNameForSid(
  sid: string,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: ReadonlyMap<string, string> | undefined,
): string | null {
  return lookupBySid(contacts, sid) ?? lookupBySid(aliases, sid) ?? null;
}

/**
 * 名字优先级：**框架联系人表**（人声明的事实）> 她自己的别名 > openid。
 *
 * 为什么人声明的优先：她可能认错人，而联系人表是"这个会话是谁"的权威来源——
 * 一个认错用户的 agent，后面所有判断都是歪的。
 */
export function resolveSessionName(
  entry: Pick<SessionEntry, 'sid' | 'label' | 'person'>,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: ReadonlyMap<string, string> | undefined,
): string {
  return lookupBySid(contacts, entry.sid) ?? lookupBySid(aliases, entry.sid) ?? entry.label ?? entry.person;
}

/**
 * 会话的**可读称呼**：名字真源查不到时，退回"一个群聊（…CA7E1C）"，**不摆 openid**。
 *
 * 为什么（2026-10-02 实测误导）：用户新开了一个群，联系人表里还没有它的名字，于是
 * `resolveSessionName` 退到 `entry.person`——那句通知成了
 * 「有人在 A1B2C3D4E5F60718293A4B5C6D7E8F90 里提到了你」。她读到的既不是群名、也看不出那是
 * "群里"（长得像个人名），接着就把这条通知当成**上一轮那条旧消息**，选择不回复。
 * openid 是给人（与日志）对号用的，不该出现在"叫她"的那句话里。
 */
export function readableSessionName(
  entry: Pick<SessionEntry, 'sid' | 'label' | 'person' | 'chatType'>,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: ReadonlyMap<string, string> | undefined,
): string {
  const named = lookupBySid(contacts, entry.sid) ?? lookupBySid(aliases, entry.sid) ?? entry.label;
  if (named !== null && named !== undefined && named.trim() !== '') return named.trim();
  const kind = entry.chatType === 'c2c' ? '一个单聊' : '一个群聊';
  const tail = entry.sid.length <= 6 ? entry.sid : entry.sid.slice(-6);
  return `${kind}（…${tail}）`;
}

/**
 * 解析身份别名表（`MEMORIES/aliases.md`）。
 *
 * 一行一条：`<sid> = <名字>`（前面的 `-` 或 `*` 随便写，当列表写也行）。
 * 左边必须长得像 sid（含 `:`）才认——否则 markdown 正文里的等号会被当成别名。
 *
 * 它为什么是**她的资产**而不是框架配置：只有她知道"这串 openid 是谁"——
 * 可能是人告诉她的，也可能是她聊了几次之后认出来的。框架只负责读进来、显示出去。
 */
export function parseAliases(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/u, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('```')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const sid = line.slice(0, at).trim();
    const name = line.slice(at + 1).trim();
    if (sid.includes(':') && name !== '') out.set(sid, name);
  }
  return out;
}

/** 把别名贴到会话条目上（不改原数组；没别名的保持原样） */
export function applyAliases(
  entries: readonly SessionEntry[],
  aliases: ReadonlyMap<string, string>,
): SessionEntry[] {
  return entries.map((entry) => ({
    ...entry,
    label: lookupBySid(aliases, entry.sid) ?? entry.label ?? null,
  }));
}

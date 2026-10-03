/**
 * 通道消息分流测试 — src/channel/inbox.ts
 *
 * 这一轮改的是**她跟外面的关系**：QQ 从"推给她的消息流"变成"手边一个可以点开的软件"。
 * 分流器就是那条线上的闸：
 *
 *   • **@ 她 / 提到她** → 进消息流并唤醒她（唯一一条"别人能直接叫到她"的路）；
 *   • **用户 / 她关注的会话** → 唤醒；
 *   • **其余一律进信箱** → 框架照收照留（写一条 `channel/message`），只记账、不打断她。
 *
 * 判据必须是纯函数、**顺序即优先级**——"要不要打断她"是件有后果的事，靠断言钉住才敢改。
 * 文件只 import `inbox.ts`（不碰 admin/render）：这样回退实现时红的是**断言**，
 * 而不是整个文件在导入期就炸（v27 记过那个坑：那种"全红"什么都没验到）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { inboxMsgSeqOf, mentionsKeyword, sidOfChannelData, shouldWakeForChannelMessage, type WakeCriteria } from '../src/channel/inbox.ts';

/** 判据的两个输入：用例只覆盖它关心的那一维，其余留默认（没关注、没关键词） */
function criteria(
  watchedSids: ReadonlySet<string> = new Set(),
  mentionKeywords: readonly string[] = [],
): WakeCriteria {
  return { watchedSids, mentionKeywords };
}

const NO_WATCH = criteria();
const WATCH_OWNER_FAV = criteria(new Set(['qq:c2c:OWNER', 'qq:group:FAV']));

describe('通道消息分流 · 什么该叫她、什么只进信箱', () => {
  test('群里 @ 了她 → 唤醒（哪怕这个会话没被关注）', () => {
    // 这是唯一一条"别人能直接叫到她"的路径，用户的要求就是这条
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group-at', person: '张三', chatId: 'G1', text: '@她', messageId: 'm1', msgSeq: 1, mentionsMe: true },
        NO_WATCH,
      ),
      true,
    );
  });

  test('**正文里喊了她的名字**也算叫她（文本提及，2026-10-02 用户拍板）', () => {
    // 实测：群里的人不打 @ 直接喊"弥亚小姐，帮我看看"，四条全进了信箱——她一条都没听见。
    // 平台不会把那种句子标成"提到了机器人"，所以由人给几个词（channels.mentionKeywords）。
    const withNames = criteria(new Set(), ['伊尔弥亚', '弥亚小姐', 'Irmia']);
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'G1', text: '弥亚小姐，帮我看个东西', messageId: 'm1', msgSeq: 1 },
        withNames,
      ),
      true,
      '群里喊名字要叫醒她——不然她永远听不见那些没 @ 的话',
    );
    // 平台级 mentionsMe（全量群消息里 mentions 带机器人）同样算
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'G1', text: '看这个', messageId: 'm2', msgSeq: 2, mentionsMe: true },
        NO_WATCH,
      ),
      true,
      '适配器给了"这条提到了机器人"就认它——它与 chatType 是两处同源的信息',
    );
    // 大小写不敏感（英文名不该因为大小写漏掉）
    assert.equal(mentionsKeyword('IRMIA 在吗', ['irmia']), true);
    // 关键词是空的 → 一条都不命中（旧行为：只认平台的 @）
    assert.equal(mentionsKeyword('弥亚小姐在吗', []), false);
    assert.equal(mentionsKeyword('', ['弥亚']), false);
    // 词表里混进空串不该让每条消息都命中
    assert.equal(mentionsKeyword('随便一句话', ['', '   ']), false);
  });

  test('关注/用户的**私聊** → 唤醒；群聊不因为"被关注"而整体唤醒', () => {
    const watched = criteria(new Set(['qq:c2c:OWNER', 'qq:group:FAV']));
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'c2c', person: '用户', chatId: 'OWNER', text: '在吗', messageId: 'm2', msgSeq: 1 },
        watched,
      ),
      true,
      '用户的私聊必须唤醒——他说话她不醒，这个 agent 就没用了',
    );
    // 2026-10-02 用户报的岔子：给群起名字（= 进关注名单）之后，他在群里发的四个字、几个数字
    // 全被送进了她的上下文。**起名字是"让她认得这个会话"，不是"订阅这个群的每句话"**。
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'FAV', text: '群里的普通发言', messageId: 'm3', msgSeq: 1 },
        watched,
      ),
      false,
      '群里的非提及消息只入信箱：一条不丢，但不打断她',
    );
    // 同一个群里**叫到她**照样唤醒（@ 与关键词都不受"是否关注"影响）
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'FAV', text: '弥亚小姐在吗', messageId: 'm3b', msgSeq: 2 },
        criteria(new Set(['qq:group:FAV']), ['弥亚小姐']),
      ),
      true,
      '群里喊她的名字要唤醒——这正是文本提及的用意',
    );
  });

  test('其余一律进信箱（不唤醒）——群里的普通发言与陌生人的私聊', () => {
    const watched = criteria(new Set(['qq:c2c:OWNER']));
    for (const data of [
      { channel: 'qq-official', chatType: 'group' as const, person: '甲', chatId: 'G9', text: '闲聊', messageId: 'm4', msgSeq: 1 },
      { channel: 'qq-official', chatType: 'c2c' as const, person: '陌生人', chatId: 'STRANGER', text: '在吗', messageId: 'm5', msgSeq: 1 },
      { channel: 'onebot', chatType: 'group' as const, person: '乙', chatId: '12345', text: '水群', messageId: 'm6', msgSeq: 1 },
    ]) {
      assert.equal(
        shouldWakeForChannelMessage(data, watched),
        false,
        `${data.chatType}:${data.chatId} 不该叫醒她（QQ 是手边的软件，不是推给她的消息流）`,
      );
    }
  });

  test('顺序即优先级：@ 优先于"没被关注"这个事实', () => {
    // 判据写反（先查 watched 再查 group-at）时，没被关注的群里的 @ 就唤不醒她——
    // 而那正是用户要的那一条。这条用例锁的是**顺序**，不是某一条单独的返回值。
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'onebot', chatType: 'group-at', person: '丙', chatId: 'NEVER_SEEN', text: '@她', messageId: 'm7', msgSeq: 1 },
        criteria(new Set(['onebot:group-at:OTHER'])),
      ),
      true,
    );
    // 反向：关注名单里的**另一个**会话不该被这条 @ 连带唤醒（比对的是 sid，不是"有没有关注过谁"）
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'onebot', chatType: 'group', person: '丙', chatId: 'NEVER_SEEN', text: '闲话', messageId: 'm8', msgSeq: 1 },
        criteria(new Set(['onebot:group-at:OTHER'])),
      ),
      false,
    );
  });

  test('sid 与会话簿/回投地址同形（关注名单里装的必须是同一个串）', () => {
    // 两处各拼一次串的代价是"关注了 A 却永远不唤醒"——这种错在日志里长得跟正常一样
    assert.equal(sidOfChannelData({ channel: 'qq-official', chatType: 'c2c', chatId: 'X' }), 'qq:c2c:X');
    assert.equal(sidOfChannelData({ channel: 'onebot', chatType: 'group-at', chatId: '12345' }), 'onebot:group:12345');
    assert.equal(sidOfChannelData({ channel: 'qq-official', chatType: 'group', chatId: 'G' }), 'qq:group:G');
    // **归一**：群里 @ 过的那条与非 @ 的那些落在同一个 sid 上——关注名单从此一次覆盖全群
    assert.equal(
      sidOfChannelData({ channel: 'qq-official', chatType: 'group-at', chatId: 'G' }),
      sidOfChannelData({ channel: 'qq-official', chatType: 'group', chatId: 'G' }),
    );
  });

  test('信箱落库时 msgSeq 要补齐：平台给 0 就填事件 seq，别让未读永远算不出来', () => {
    // 未读的判据是 `msgSeq > readUpToSeq`。平台给不出序号的那两类（OneBot 没 @ 的群消息、
    // 官方全量群消息）原样落 0 的话，每一条都是 0——她读一次之后未读永远是 0，
    // "某群积累了 N 条"再也显示不出来，信箱就白做了。
    const group = {
      channel: 'qq-official', chatType: 'group' as const, person: '张三', chatId: 'G1',
      text: '闲话', messageId: 'm1', msgSeq: 0,
    };
    assert.equal(inboxMsgSeqOf(group, 4242), 4242, '0 = 平台没给序号 → 用事件 seq');

    // 给得出真序号的（OneBot 带 message_seq 的那些）原样留着：那是平台自己的编号，量纲别混
    const onebot = { ...group, channel: 'onebot', msgSeq: 77 };
    assert.equal(inboxMsgSeqOf(onebot, 4242), 77, '有真序号就别覆盖');
  });
});

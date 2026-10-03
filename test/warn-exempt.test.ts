/**
 * 预警豁免（用户 2026-10-04 的口径）：
 *   • 默认全都预警；
 *   • 单聊可按会话豁免；
 *   • **群聊不能整群豁免**，只能按已注册成员豁免；
 *   • 豁免 = 不扫描也不提示（所以 real-loop 那侧表现为"这条消息不进判定目标"）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WarnExemptBook } from '../src/channel/warn-exempt.ts';

function book(): { book: WarnExemptBook; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-exempt-'));
  return { book: new WarnExemptBook(dir), dir };
}

test('默认全都预警：空名单时单聊与群里都不豁免', () => {
  const { book: b } = book();
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'c2c', chatId: 'U1', person: 'U1' }), false);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'group', chatId: 'G1', person: 'P1' }), false);
});

test('单聊按会话豁免：只免那一个人，别的单聊照旧', () => {
  const { book: b } = book();
  assert.equal(b.setSession('qq:c2c:U1', true), true);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'c2c', chatId: 'U1', person: 'U1' }), true);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'c2c', chatId: 'U2', person: 'U2' }), false);
  // 幂等：重复开同一个返回 false（没有改动就不写盘）
  assert.equal(b.setSession('qq:c2c:U1', true), false);
  assert.equal(b.setSession('qq:c2c:U1', false), true);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'c2c', chatId: 'U1', person: 'U1' }), false);
});

test('群聊按人豁免：同群里别人照旧过判定', () => {
  const { book: b } = book();
  assert.equal(b.setMember('qq:group:G1', 'P1', true), true);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'group', chatId: 'G1', person: 'P1' }), true);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'group-at', chatId: 'G1', person: 'P1' }), true);
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'group', chatId: 'G1', person: 'P2' }), false);
  // 换一个群：同一个 openid 也不算（群成员的 openid 是按群隔离的）
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'group', chatId: 'G2', person: 'P1' }), false);
});

test('群聊**不能整群豁免**：就算档案里被人手写了一条群会话，也不认', () => {
  const { book: b, dir } = book();
  // 模拟"有人直接改文件，把整个群的 sid 写进 sessions"
  writeFileSync(join(dir, 'warn-exempt.json'), JSON.stringify({
    version: 1,
    sessions: ['qq:group:G1'],
    members: {},
  }));
  b.refresh();
  assert.equal(b.isExempt({ channel: 'qq-official', chatType: 'group', chatId: 'G1', person: 'P9' }), false,
    '群聊整群豁免这条路不存在——判据按 chatType 分流，不看 sid 在不在名单里');
});

test('落盘与重读：改了之后另一本书读得到（界面改、运行期读）', () => {
  const { book: b, dir } = book();
  b.setSession('qq:c2c:U1', true);
  b.setMember('qq:group:G1', 'P1', true);
  b.save();

  const again = new WarnExemptBook(dir);
  assert.equal(again.isExempt({ channel: 'qq-official', chatType: 'c2c', chatId: 'U1', person: 'U1' }), true);
  assert.equal(again.isExempt({ channel: 'qq-official', chatType: 'group', chatId: 'G1', person: 'P1' }), true);

  // 文件坏掉时按"没人豁免"（安全的那一侧）
  writeFileSync(join(dir, 'warn-exempt.json'), '{ 这不是 JSON');
  const broken = new WarnExemptBook(dir);
  assert.equal(broken.isExempt({ channel: 'qq-official', chatType: 'c2c', chatId: 'U1', person: 'U1' }), false);
  assert.ok(readFileSync(join(dir, 'warn-exempt.json'), 'utf8').includes('这不是 JSON'));
});

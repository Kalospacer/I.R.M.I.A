/**
 * OneBot 11 通道适配器测试（M9：NapCat / go-cqhttp 正向 ws 接入）
 *
 * 覆盖四块，全部走**真实链路**而不是打桩到实现内部：
 *   ① 事件解析（纯函数）：CQ 码反转义与解析、消息段归一化、私聊/群@/群非@、
 *      raw_message 与 message 段的取舍、dedupeKey、msgSeq、附件抽取；
 *   ② 链路（node:net 起假 NapCat）：握手 query 里的 access_token、get_login_info 自举 self_id、
 *      私聊与群@事件的投递、meta_event 不投递；
 *   ③ 动作与 echo 配对：send_private_msg / send_group_msg 的 action 与 params 形状、
 *      并发动作各自配对、retcode 1404 判为"不可重试且不重连"、超时与迟到响应的处理；
 *   ④ 重连退避与回投接线：断线后按退避重连、停止后不再重连、在途动作被结清、
 *      回投 URL 的 scheme 分派（onebot: 与 qq: 并行）。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里显式用 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import test, { type TestContext, describe } from 'node:test';

import type { WakeChannel } from '../src/log/types.js';
import {
  DEFAULT_ONEBOT_TOKEN_ENV, DEFAULT_ONEBOT_WS_URL, ONEBOT_CHANNEL_NAME, ONEBOT_PERMANENT_RETCODES,
  ONEBOT_REPLY_SCHEME, OneBotChannel, buildConnectUrl, classifyRetcode, createOneBotReplyPoster,
  heartbeatToReadTimeoutMs, mapEventToWakeChannel, maskAccessToken, mentionsSelf, oneBotIdOf,
  parseCqMessage, parseReplyUrl, replyUrlOf, stripCqCodes, toSegments, unescapeCqText,
  type OneBotChannelOptions,
} from '../src/channel/onebot.ts';
import { OPCODE, parseFrame } from '../src/channel/ws-client.ts';
import {
  DEFAULT_ONEBOT_ACCESS_TOKEN_ENV as CONFIG_ONEBOT_TOKEN_ENV,
  DEFAULT_ONEBOT_WS_URL as CONFIG_ONEBOT_WS_URL,
  defaultConfig,
} from '../src/config/config.ts';
import { parseReplyUrlAny, replyUrlForWake } from '../src/tools/admin.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

/**
 * 等链路真正可用。**不能用"对端看到 TCP 连接"当就绪信号**：
 * 握手完成前 `sendText` 会如实报 offline，全量并发跑时这个窗口会被放大成偶发失败。
 */
async function waitConnected(channel: OneBotChannel, label = '通道握手完成并可发动作'): Promise<void> {
  await waitFor(() => channel.snapshot().connected, 8000, label);
}

interface RecordedFrame {
  opcode: number;
  text: string;
}

interface FakeNapCat {
  url: string;
  port: number;
  /** 客户端发来的所有帧（文本帧是动作调用） */
  frames: RecordedFrame[];
  handshakes: Array<{ path: string; headers: Map<string, string> }>;
  sockets: Socket[];
  server: Server;
  /** 收到文本帧后的钩子（观察用；应答由 autoReply 或测试自己控制） */
  onText: ((text: string, index: number) => void) | null;
  /** 是否自动回成功响应（默认 true：给每个带 echo 的动作回 retcode=0） */
  autoReply: boolean;
  /** 发一条 JSON 事件给所有客户端（服务端帧：不掩码） */
  sendJson(value: unknown): void;
  /** 回一个自定义响应体（补 echo 由调用方给全） */
  replyJson(value: unknown): void;
  /** 只统计文本帧解析出的 JSON 动作 */
  actions(): Array<Record<string, unknown>>;
  dropAll(): void;
  close(): Promise<void>;
}

/** 假 NapCat：够用的一次升级 + 帧收发；服务端帧不掩码（客户端帧必须掩码） */
async function startFakeNapCat(t: TestContext): Promise<FakeNapCat> {
  const frames: RecordedFrame[] = [];
  const handshakes: Array<{ path: string; headers: Map<string, string> }> = [];
  const sockets: Socket[] = [];
  const buffers = new Map<Socket, Buffer>();
  const handshakeDone = new Set<Socket>();
  const fake: Partial<FakeNapCat> = { autoReply: true, onText: null };

  const server = createServer((socket) => {
    sockets.push(socket);
    buffers.set(socket, Buffer.alloc(0));
    socket.on('error', () => { /* 断线是测试的一部分，不当失败 */ });
    socket.on('data', (chunk) => {
      let buffer = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), chunk]);
      if (!handshakeDone.has(socket)) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          buffers.set(socket, buffer);
          return;
        }
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const lines = head.split('\r\n');
        const requestLine = lines[0] ?? '';
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const index = line.indexOf(':');
          if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
        }
        handshakes.push({ path: requestLine.split(' ')[1] ?? '', headers });
        handshakeDone.add(socket);
        const key = headers.get('sec-websocket-key') ?? '';
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'binary')
          .digest('base64');
        socket.write(Buffer.from([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'), 'utf8'));
      }

      for (;;) {
        const parsed = parseFrame(buffer, 16 * 1024 * 1024);
        if (parsed.kind !== 'frame') {
          if (parsed.kind === 'protocol-error') socket.destroy();
          break;
        }
        buffer = buffer.subarray(parsed.consumed);
        // 客户端帧必须带掩码（RFC 6455 §5.3）：假协议端顺手把这条规矩也守住
        assert.equal(parsed.header.masked, true, '客户端发出的帧必须带掩码');
        const text = parsed.header.opcode === OPCODE.text ? parsed.payload.toString('utf8') : '';
        frames.push({ opcode: parsed.header.opcode, text });
        if (parsed.header.opcode === OPCODE.close) continue;
        if (parsed.header.opcode !== OPCODE.text) continue;

        const index = frames.length - 1;
        if (fake.autoReply === true) {
          try {
            const call = JSON.parse(text) as Record<string, unknown>;
            const echo = call['echo'];
            if (echo !== undefined) {
              (fake.replyJson as (value: unknown) => void)({ status: 'ok', retcode: 0, data: {}, echo });
            }
          } catch {
            /* 非 JSON 文本帧不是 OneBot 协议的一部分，测试不关心 */
          }
        }
        fake.onText?.(text, index);
      }
      buffers.set(socket, buffer);
    });
    socket.on('close', () => {
      buffers.delete(socket);
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假协议端未能监听端口');

  const replyJson = (value: unknown): void => {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = headerFor(payload.length, OPCODE.text);
    const frame = Buffer.concat([header, payload]);
    for (const socket of sockets) socket.write(frame);
  };

  Object.assign(fake, {
    url: `ws://127.0.0.1:${address.port}`,
    port: address.port,
    frames,
    handshakes,
    sockets,
    server,
    replyJson,
    sendJson: (value: unknown) => { replyJson(value); },
    actions: () => frames
      .filter((frame) => frame.opcode === OPCODE.text)
      .map((frame) => {
        try {
          return JSON.parse(frame.text) as Record<string, unknown>;
        } catch {
          return {};
        }
      }),
    dropAll: () => {
      for (const socket of [...sockets]) socket.destroy();
    },
    close: async () => {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  });
  t.after(async () => { await (fake.close as () => Promise<void>)(); });
  return fake as FakeNapCat;
}

/** 服务端帧头：掩码位恒 0 */
function headerFor(length: number, opcode: number): Buffer {
  if (length < 126) {
    const buf = Buffer.alloc(2);
    buf.writeUInt8(0x80 | opcode, 0);
    buf.writeUInt8(length, 1);
    return buf;
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt8(0x80 | opcode, 0);
  buf.writeUInt8(126, 1);
  buf.writeUInt16BE(length, 2);
  return buf;
}

/** 起一个通道并收集它的投递（走 ChannelAdapter 的 onMessage 口，与 main 的接线同一条路径） */
function startChannel(
  cat: FakeNapCat,
  options: Partial<OneBotChannelOptions> = {},
): { channel: OneBotChannel; received: WakeChannel['data'][] } {
  const received: WakeChannel['data'][] = [];
  const channel = new OneBotChannel({ wsUrl: cat.url, ...options });
  channel.onMessage = (data) => { received.push(data); };
  channel.start();
  return { channel, received };
}

// ──────────────────────────────── ① CQ 码与消息段 ────────────────────────────────

describe('onebot：CQ 码与消息段（纯函数）', () => {
  test('反转义必须按逆序做：&#91; 之类先还原，&amp; 最后', () => {
    assert.equal(unescapeCqText('[a&#44; b]'), '[a, b]');
    assert.equal(unescapeCqText('&amp;'), '&');
    // 编码时 & 先变 &amp;，所以 "&amp;#91;" 表示字面量 "&#91;"（而不是左方括号）
    assert.equal(unescapeCqText('&amp;#91;'), '&#91;');
  });

  test('CQ 码字符串 → 消息段：文本、@、图片各归各位', () => {
    const cq = '[CQ:at,qq=1000] 你好&#44; 这是[CQ:image,file=a.jpg]与[CQ:image,file=b.png,url=http://x/y.png]';
    const segments = parseCqMessage(cq);
    assert.deepEqual(segments.map((segment) => segment.type), ['at', 'text', 'image', 'text', 'image']);
    assert.equal(segments[0]?.data['qq'], '1000');
    assert.equal(segments[1]?.data['text'], ' 你好, 这是');
    assert.equal(segments[2]?.data['file'], 'a.jpg');
    assert.equal(segments[3]?.data['text'], '与');
    assert.equal(segments[4]?.data['url'], 'http://x/y.png');
    assert.equal(stripCqCodes(cq), ' 你好, 这是与');
    assert.equal(stripCqCodes('[CQ:at,qq=1000] 早'), ' 早');
  });

  test('段数组形态与 CQ 码形态归一化到同一种结构', () => {
    const arrayForm = toSegments([
      { type: 'at', data: { qq: 1000 } },
      { type: 'text', data: { text: '你好' } },
      { type: 'image', data: { file: 'a.jpg', url: 'http://x/a.jpg' } },
    ]);
    assert.deepEqual(arrayForm, [
      { type: 'at', data: { qq: '1000' } },
      { type: 'text', data: { text: '你好' } },
      { type: 'image', data: { file: 'a.jpg', url: 'http://x/a.jpg' } },
    ]);
    assert.deepEqual(toSegments('[CQ:at,qq=1000]你好'), [
      { type: 'at', data: { qq: '1000' } },
      { type: 'text', data: { text: '你好' } },
    ]);
  });

  test('mentionsSelf：只认 @ 自己，@全体不算', () => {
    assert.equal(mentionsSelf(toSegments('[CQ:at,qq=1000]'), '1000'), true);
    assert.equal(mentionsSelf(toSegments('[CQ:at,qq=all]'), '1000'), false);
    assert.equal(mentionsSelf(toSegments('[CQ:at,qq=2000]'), '1000'), false);
    assert.equal(mentionsSelf(toSegments('[CQ:at,qq=1000]'), ''), false);
  });

  test('oneBotIdOf：安全整数给 number，超精度与非法值原样给字符串', () => {
    assert.equal(oneBotIdOf('12345'), 12345);
    assert.equal(oneBotIdOf('-1'), -1);
    // int64 超出 JS 安全整数：转成 number 会静默改值，宁可原样发字符串
    assert.equal(oneBotIdOf('12345678901234567890'), '12345678901234567890');
    assert.equal(oneBotIdOf('abc'), 'abc');
  });

  test('classifyRetcode：0/1 成功，1404 等不可重试，其余可重试', () => {
    assert.equal(classifyRetcode(0), 'ok');
    assert.equal(classifyRetcode(1), 'async');
    assert.equal(classifyRetcode(1404), 'permanent');
    assert.equal(classifyRetcode(1400), 'permanent');
    assert.ok(ONEBOT_PERMANENT_RETCODES.includes(1404), '1404（会话不存在）必须在不可重试名单里');
    assert.equal(classifyRetcode(-1), 'transient');
    assert.equal(classifyRetcode(1500), 'transient');
  });

  test('heartbeatToReadTimeoutMs：3 倍宽限且不低于 15 秒', () => {
    assert.equal(heartbeatToReadTimeoutMs(5000), 15_000);
    assert.equal(heartbeatToReadTimeoutMs(10_000), 30_000);
    assert.equal(heartbeatToReadTimeoutMs(0), 15_000);
  });

  test('buildConnectUrl / maskAccessToken：token 进 query，日志里必须打码', () => {
    assert.equal(buildConnectUrl('ws://127.0.0.1:3001', ''), 'ws://127.0.0.1:3001');
    const url = buildConnectUrl('ws://127.0.0.1:3001/ws?x=1', 'secret');
    assert.match(url, /access_token=secret/u);
    assert.match(url, /x=1/u, '原有的 query 参数必须保留');
    assert.equal(maskAccessToken(url).includes('secret'), false, 'token 不许出现在日志里');
    assert.match(maskAccessToken(url), /access_token=\*\*\*/u);
    assert.throws(() => buildConnectUrl('http://127.0.0.1:3001', 'x'), /wsUrl 非法/u);
  });

  test('回投 URL：onebot:<chatType>:<chatId>，与 qq: 各占自己的命名空间', () => {
    assert.equal(ONEBOT_REPLY_SCHEME, 'onebot:');
    assert.equal(replyUrlOf({ chatType: 'c2c', chatId: '10001' }), 'onebot:c2c:10001');
    const parsed = parseReplyUrl('onebot:group:20002');
    assert.deepEqual(parsed, { ok: true, chatType: 'group', chatId: '20002' });
    // 旧写法（归一之前的 `onebot:group-at:`）照样认——存量配置与日志里还有它
    assert.deepEqual(parseReplyUrl('onebot:group-at:20002'), { ok: true, chatType: 'group-at', chatId: '20002' });
    assert.equal(parseReplyUrl('qq:c2c:1').ok, false, 'onebot 的解析口不认 qq: 前缀');
    assert.equal(parseReplyUrl('onebot:c2c').ok, false);
  });

  test('admin 回投分派：按 wake.channel 选 scheme，写与读同一口径', () => {
    const onebotWake = { channel: ONEBOT_CHANNEL_NAME, chatType: 'group-at' as const, chatId: '20002' };
    assert.equal(replyUrlForWake(onebotWake), 'onebot:group:20002');
    const qqWake = { channel: 'qq-official', chatType: 'c2c' as const, chatId: 'openid-1' };
    assert.equal(replyUrlForWake(qqWake), 'qq:c2c:openid-1');
    assert.deepEqual(parseReplyUrlAny('onebot:group:20002'), {
      ok: true, channel: 'onebot', chatType: 'group', chatId: '20002',
    });
    assert.deepEqual(parseReplyUrlAny('qq:c2c:openid-1'), {
      ok: true, channel: 'qq-official', chatType: 'c2c', chatId: 'openid-1',
    });
    assert.equal(parseReplyUrlAny('http://x/').ok, false);
  });

  test('config 默认值与通道常量一致（两处写同一份真相，漂移要有测试兜住）', () => {
    const config = defaultConfig('.');
    assert.equal(config.channels.onebot.enabled, false, 'OneBot 通道默认关闭');
    assert.equal(config.channels.onebot.wsUrl, DEFAULT_ONEBOT_WS_URL);
    assert.equal(config.channels.onebot.tokenEnv, DEFAULT_ONEBOT_TOKEN_ENV);
    assert.equal(CONFIG_ONEBOT_WS_URL, DEFAULT_ONEBOT_WS_URL);
    assert.equal(CONFIG_ONEBOT_TOKEN_ENV, DEFAULT_ONEBOT_TOKEN_ENV);
  });
});

// ──────────────────────────────── ② 事件 → wake/channel ────────────────────────────────

describe('onebot：事件转 wake/channel', () => {
  const privateEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 4242,
    user_id: 10001,
    self_id: 30003,
    raw_message: '在吗',
    message: [{ type: 'text', data: { text: '在吗' } }],
    ...overrides,
  });

  test('私聊：c2c + person/chatId 都是 user_id，msgSeq=0，dedupeKey=onebot:<id>', () => {
    const wake = mapEventToWakeChannel(privateEvent());
    assert.deepEqual(wake, {
      channel: 'onebot',
      chatType: 'c2c',
      person: '10001',
      chatId: '10001',
      text: '在吗',
      messageId: '4242',
      msgSeq: 0,
      dedupeKey: 'onebot:4242',
    });
  });

  test('私聊：raw_message 含 CQ 码时先剥码（协议码不许喂给模型）', () => {
    const wake = mapEventToWakeChannel(privateEvent({
      raw_message: '早&#91;1&#93;[CQ:face,id=1] 好',
      message: '[CQ:face,id=1] 好',
    }));
    assert.equal(wake?.text, '早[1] 好');
  });

  test('私聊：raw_message 缺席时退回 message 段文本；附件从段里抽', () => {
    const wake = mapEventToWakeChannel(privateEvent({
      raw_message: '',
      message: [
        { type: 'text', data: { text: '看看这个' } },
        { type: 'image', data: { file: 'a.jpg', url: 'http://x/a.jpg' } },
        { type: 'image', data: { file: 'b.jpg' } },
        { type: 'file', data: { file: 'f.zip', name: '报告.zip', url: 'http://x/f.zip' } },
      ],
    }));
    assert.equal(wake?.text, '看看这个');
    // 只把真正的 http(s) 地址当 URL：image 的 file 常常只是本地文件名
    assert.deepEqual(wake?.attachments, [
      { type: 'image', url: 'http://x/a.jpg', name: 'a.jpg' },
      { type: 'image', name: 'b.jpg' },
      { type: 'file', url: 'http://x/f.zip', name: '报告.zip' },
    ]);
  });

  test('群@：chatType=group-at，chatId=group_id，person=user_id（self_id 来自事件）', () => {
    const wake = mapEventToWakeChannel({
      post_type: 'message',
      message_type: 'group',
      group_id: 20002,
      user_id: 10001,
      self_id: 30003,
      message_id: 'g-1',
      message: [
        { type: 'at', data: { qq: 30003 } },
        { type: 'text', data: { text: ' 帮我看看' } },
      ],
    });
    assert.deepEqual(wake, {
      channel: 'onebot',
      chatType: 'group-at',
      person: '10001',
      chatId: '20002',
      text: '帮我看看',
      messageId: 'g-1',
      msgSeq: 0,
      dedupeKey: 'onebot:g-1',
    });
  });

  test('群@：CQ 码形态 + self_id 只来自上下文（事件里没有）时同样成立', () => {
    const wake = mapEventToWakeChannel({
      post_type: 'message',
      message_type: 'group',
      group_id: '20002',
      user_id: 10001,
      message_id: 7,
      raw_message: '[CQ:at,qq=30003] 在吗',
      message: '[CQ:at,qq=30003] 在吗',
    }, { selfId: '30003' });
    assert.equal(wake?.chatType, 'group-at');
    assert.equal(wake?.text, '在吗');
    assert.equal(wake?.dedupeKey, 'onebot:7');
  });

  test('群消息没 @ 她：不再丢弃，标成 group 进信箱（协议端本来就推全量）', () => {
    // 以前这里一律 return null——那等于把协议端白送的能力扔掉，也让 v32 的信箱永远收不到东西
    // （当时以为"只有协议端能拿全量、官方通道只推 @ 消息"，**2026-10-02 已更正**：官方开了
    // 「接收所有消息」之后同样推全量，见 design.md §4.24。这里的改动本身与那条更正无关，
    // 它修的是"我们自己把消息丢了"）。
    // 现在的分工与官方通道一致：@ 她的标 group-at（唤醒），其余标 group（进信箱、算未读）。
    const base = {
      post_type: 'message', message_type: 'group', group_id: 20002, user_id: 10001, message_id: 1,
    };
    const plain = mapEventToWakeChannel({
      ...base, self_id: 30003, message: [{ type: 'text', data: { text: '大家好' } }],
    });
    assert.equal(plain?.chatType, 'group', '没 @ 的群消息是别人的对话——进信箱，不是丢掉');
    assert.equal(plain?.chatId, '20002');
    assert.equal(plain?.person, '10001', '进信箱也要带发言者，她翻的时候得知道是谁说的');

    const atAll = mapEventToWakeChannel({ ...base, self_id: 30003, message: '[CQ:at,qq=all] 大家好' });
    assert.equal(atAll?.chatType, 'group', '@全体不是对她说的话，同样进信箱');

    // 拿不到 self_id 就判不出有没有被 @——按"没 @ 她"处理（少叫醒一次，好过把整条扔掉）
    const noSelf = mapEventToWakeChannel({ ...base, message: '[CQ:at,qq=30003] 在吗' });
    assert.equal(noSelf?.chatType, 'group', '判不出就别猜她有没有被 @，但也别丢消息');

    // 真正的 @ 仍然走唤醒那条路
    const atMe = mapEventToWakeChannel({
      ...base, self_id: 30003,
      message: [{ type: 'at', data: { qq: '30003' } }, { type: 'text', data: { text: '在吗' } }],
    });
    assert.equal(atMe?.chatType, 'group-at');
  });

  test('非 message 事件、缺 message_id / user_id：一律忽略', () => {
    assert.equal(mapEventToWakeChannel({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null);
    assert.equal(mapEventToWakeChannel({ post_type: 'notice', notice_type: 'friend_add' }), null);
    assert.equal(mapEventToWakeChannel({ post_type: 'request', request_type: 'friend' }), null);
    assert.equal(mapEventToWakeChannel(privateEvent({ message_id: undefined })), null, '没有消息 id 就没有幂等键');
    assert.equal(mapEventToWakeChannel(privateEvent({ user_id: undefined })), null);
    assert.equal(mapEventToWakeChannel(privateEvent({ message_type: 'guild' })), null);
  });

  test('通道名可别名（多实例场景），dedupeKey 跟随通道名', () => {
    const wake = mapEventToWakeChannel(privateEvent(), { channelName: 'onebot-b' });
    assert.equal(wake?.channel, 'onebot-b');
    assert.equal(wake?.dedupeKey, 'onebot-b:4242');
  });
});

// ──────────────────────────────── ③ 真实链路：连接、事件、动作配对 ────────────────────────────────

describe('onebot：正向 ws 链路（假 NapCat）', () => {
  test('握手带 access_token；连上后自举 get_login_info 拿到机器人 QQ 号', async (t) => {
    const cat = await startFakeNapCat(t);
    // autoReply 先回一个 data:{} 的话，onText 里的这次应答会因为 echo 已结算而被忽略
    cat.autoReply = false;
    cat.onText = (text, index) => {
      const call = JSON.parse(text) as Record<string, unknown>;
      if (call['action'] === 'get_login_info') {
        cat.replyJson({ status: 'ok', retcode: 0, data: { user_id: 30003, nickname: '小代码酱' }, echo: call['echo'] });
      }
      void index;
    };
    const { channel } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });

    await waitFor(() => cat.handshakes.length === 1, 8000, '完成握手');
    assert.match(cat.handshakes[0]?.path ?? '', /access_token=secret/u);
    await waitFor(() => channel.snapshot().selfId === '30003', 8000, 'self_id 落到快照');
    assert.equal(channel.snapshot().connected, true);
    assert.ok(
      cat.actions().some((action) => action['action'] === 'get_login_info'),
      '连上后必须主动问一次 get_login_info',
    );
  });

  test('私聊与群@事件投递，群非@进信箱（group）、meta_event 不投递；自带的 self_id 也会更新快照', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel, received } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    cat.sendJson({
      post_type: 'message', message_type: 'private', message_id: 1, user_id: 10001, self_id: 30003,
      raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }],
    });
    await waitFor(() => received.length === 1, 8000, '私聊投递');
    assert.equal(received[0]?.chatType, 'c2c');
    assert.equal(channel.snapshot().selfId, '30003', '事件自带的 self_id 必须被记住');

    cat.sendJson({
      post_type: 'message', message_type: 'group', message_id: 2, group_id: 20002, user_id: 10001, self_id: 30003,
      raw_message: '[CQ:at,qq=30003] 帮我看看',
      message: '[CQ:at,qq=30003] 帮我看看',
    });
    await waitFor(() => received.length === 2, 8000, '群@投递');
    assert.equal(received[1]?.chatType, 'group-at');
    assert.equal(received[1]?.chatId, '20002');
    assert.equal(received[1]?.text, '帮我看看');

    cat.sendJson({
      post_type: 'message', message_type: 'group', message_id: 3, group_id: 20002, user_id: 10009, self_id: 30003,
      raw_message: '你们聊', message: [{ type: 'text', data: { text: '你们聊' } }],
    });
    // 群非@ 现在**要投递**：协议端推全量群消息正是我们接它的理由，投出去之后由
    // channel/inbox.ts 判它进信箱（group）还是唤醒（group-at）——适配器不该替它做这个决定。
    await waitFor(() => received.length === 3, 8000, '群非@进信箱');
    assert.equal(received[2]?.chatType, 'group');
    assert.equal(received[2]?.chatId, '20002');
    assert.equal(received[2]?.person, '10009', '进信箱也要带发言者');

    cat.sendJson({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 30003 });
    cat.sendJson({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 5000, self_id: 30003 });
    await sleep(100);
    assert.equal(received.length, 3, 'meta_event 仍然不该产生 wake');
  });

  test('sendText：动作名与 params 形状（纯文本字符串，不构造 CQ 码数组）', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    // 自动应答回的是 data:{}，先把 message_id 补上再断言
    cat.autoReply = false;
    cat.onText = (text) => {
      const call = JSON.parse(text) as Record<string, unknown>;
      cat.replyJson({ status: 'ok', retcode: 0, data: { message_id: 9001 }, echo: call['echo'] });
    };
    const private_outcome = await channel.sendText('c2c', '10001', '你好，我是小代码酱');
    assert.deepEqual(private_outcome, { ok: true, messageId: '9001', passive: false, msgSeq: 0 });

    const group_outcome = await channel.sendText('group-at', '20002', '在的');
    assert.equal(group_outcome.ok, true);

    const calls = cat.actions();
    // 连上后客户端会先自举 get_login_info（那是链路初始化，不是本次发送）
    assert.equal(calls[0]?.['action'], 'get_login_info');
    const sends = calls.filter((call) => String(call['action']).startsWith('send_'));
    assert.deepEqual(sends[0], {
      action: 'send_private_msg',
      params: { user_id: 10001, message: '你好，我是小代码酱' },
      echo: sends[0]?.['echo'],
    });
    assert.deepEqual(sends[1], {
      action: 'send_group_msg',
      params: { group_id: 20002, message: '在的' },
      echo: sends[1]?.['echo'],
    });
    // echo 必须唯一：配对全靠它
    assert.notEqual(sends[0]?.['echo'], sends[1]?.['echo']);
  });

  test('并发动作各配各的 echo：后发的先回也不串台', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    const echoes: string[] = [];
    cat.autoReply = false;
    cat.onText = (text) => {
      const call = JSON.parse(text) as Record<string, unknown>;
      echoes.push(String(call['echo']));
      if (echoes.length === 2) {
        // 刻意倒序应答：第二个请求先回，第一个请求后回
        cat.replyJson({ status: 'ok', retcode: 0, data: { message_id: 'second' }, echo: echoes[1] });
        cat.replyJson({ status: 'ok', retcode: 0, data: { message_id: 'first' }, echo: echoes[0] });
      }
    };
    const [first, second] = await Promise.all([
      channel.sendText('c2c', '1', '一'),
      channel.sendText('c2c', '2', '二'),
    ]);
    assert.deepEqual(first, { ok: true, messageId: 'first', passive: false, msgSeq: 0 });
    assert.deepEqual(second, { ok: true, messageId: 'second', passive: false, msgSeq: 0 });
  });

  test('retcode 1404：判为不可重试，且**不触发重连**', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0, reconnectBaseMs: 20 });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    cat.autoReply = false;
    cat.onText = (text) => {
      const call = JSON.parse(text) as Record<string, unknown>;
      cat.replyJson({ status: 'failed', retcode: 1404, wording: '群不存在', echo: call['echo'] });
    };
    const outcome = await channel.sendText('group-at', '99999', '在吗');
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /retcode=1404/u);
    assert.match(outcome.reason, /群不存在/u);
    // 等两个退避周期：链路没坏，不该有任何重连
    await sleep(150);
    assert.equal(cat.handshakes.length, 1, '业务错误不许升级成重连');
    assert.equal(channel.snapshot().connected, true);
  });

  test('动作超时判为可重试；迟到且无主的响应被忽略（不影响后续动作）', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel } = startChannel(cat, {
      accessToken: 'secret', readTimeoutMs: 0, actionTimeoutMs: 60,
    });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    cat.autoReply = false;
    cat.onText = () => { /* 故意不响应：走超时 */ };
    const timedOut = await channel.sendText('c2c', '10001', '在吗');
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.reason, /超时/u);
    assert.equal(channel.snapshot().pendingCalls, 0, '超时必须把登记项摘掉');

    // 乱发的 echo（对不上任何在途调用）：只忽略，不崩、不投递
    cat.sendJson({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: 'nope' });
    await sleep(50);
    assert.equal(channel.snapshot().connected, true);

    // 恢复正常应答：前一次超时不该让后续动作不可用
    cat.onText = (text) => {
      const call = JSON.parse(text) as Record<string, unknown>;
      cat.replyJson({ status: 'ok', retcode: 0, data: { message_id: 77 }, echo: call['echo'] });
    };
    const ok = await channel.sendText('c2c', '10001', '还在');
    assert.deepEqual(ok, { ok: true, messageId: '77', passive: false, msgSeq: 0 });
  });

  test('未连接时 sendText 如实报 offline（不抛异常）', async (t) => {
    const cat = await startFakeNapCat(t);
    const channel = new OneBotChannel({ wsUrl: `ws://127.0.0.1:${cat.port + 1}`, readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });
    const outcome = await channel.sendText('c2c', '10001', '在吗');
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /未连接|连接/u);
  });

  test('断线后按退避重连，重连后事件照常投递', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel, received } = startChannel(cat, {
      accessToken: 'secret', readTimeoutMs: 0, reconnectBaseMs: 20, maxReconnectDelayMs: 40,
    });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    cat.dropAll();
    await waitFor(() => cat.handshakes.length >= 2, 8000, '断线后重连（退避 20ms）');
    await waitConnected(channel, '重连后链路就绪');
    cat.sendJson({
      post_type: 'message', message_type: 'private', message_id: 11, user_id: 10001, self_id: 30003,
      raw_message: '我回来了', message: [{ type: 'text', data: { text: '我回来了' } }],
    });
    await waitFor(() => received.length === 1, 8000, '重连后仍能收到消息');

    // 停止后不许再有新连接（否则退出流程会一直被打断）
    channel.stop();
    const handshakesAtStop = cat.handshakes.length;
    await sleep(200);
    assert.equal(cat.handshakes.length, handshakesAtStop, '停止后不许重连');
    assert.equal(channel.snapshot().connected, false);
  });

  test('停止时在途动作被结清（不是挂着的 promise）', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0, actionTimeoutMs: 5000 });
    await waitConnected(channel);
    cat.autoReply = false;
    cat.onText = () => { /* 不响应 */ };

    const inFlight = channel.sendText('c2c', '10001', '在吗');
    await waitFor(() => channel.snapshot().pendingCalls === 1, 8000, '动作已发出');
    channel.stop();
    const outcome = await inFlight;
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /停止/u);
  });

  test('createOneBotReplyPoster：地址走 onebot: 前缀，通道未装配时如实报', async (t) => {
    const cat = await startFakeNapCat(t);
    const { channel } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);
    cat.autoReply = false;
    cat.onText = (text) => {
      const call = JSON.parse(text) as Record<string, unknown>;
      cat.replyJson({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: call['echo'] });
    };

    const channels = new Map([[channel.name, channel]]) as ReadonlyMap<string, OneBotChannel>;
    const poster = createOneBotReplyPoster(channels);
    const ok = await poster.post({ url: 'onebot:group:20002', idempotencyKey: 'turn-1' }, '回投的话');
    assert.deepEqual(ok, { ok: true, status: 200 });
    assert.deepEqual(cat.actions().at(-1), {
      action: 'send_group_msg',
      params: { group_id: 20002, message: '回投的话' },
      echo: cat.actions().at(-1)?.['echo'],
    });

    const wrong = await poster.post({ url: 'qq:c2c:1', idempotencyKey: 'turn-1' }, 'x');
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason, /不是 OneBot 回投地址/u);

    const unassembled = createOneBotReplyPoster(new Map());
    const none = await unassembled.post({ url: 'onebot:c2c:1', idempotencyKey: 'turn-1' }, 'x');
    assert.equal(none.ok, false);
    assert.match(none.reason, /未装配/u);
  });

  test('多实例隔离：两个通道各自只投自己链路上的事件', async (t) => {
    const catA = await startFakeNapCat(t);
    const catB = await startFakeNapCat(t);
    const a = startChannel(catA, { accessToken: 'a', readTimeoutMs: 0 });
    const b = startChannel(catB, { accessToken: 'b', readTimeoutMs: 0, channelName: 'onebot-b' });
    t.after(() => { a.channel.stop(); b.channel.stop(); });
    await waitConnected(a.channel, 'A 链路就绪');
    await waitConnected(b.channel, 'B 链路就绪');

    catA.sendJson({
      post_type: 'message', message_type: 'private', message_id: 1, user_id: 1, self_id: 9,
      raw_message: 'A', message: 'A',
    });
    catB.sendJson({
      post_type: 'message', message_type: 'private', message_id: 1, user_id: 2, self_id: 9,
      raw_message: 'B', message: 'B',
    });
    await waitFor(() => a.received.length === 1 && b.received.length === 1, 8000, '各自收到');
    assert.equal(a.received[0]?.channel, 'onebot');
    assert.equal(b.received[0]?.channel, 'onebot-b');
    assert.equal(a.received[0]?.text, 'A');
    assert.equal(b.received[0]?.text, 'B');
  });
});

  test('snapshot 报"最近一条消息是什么时候"——静默假活唯一看得见的那个数', async (t) => {
    // 协议端有一种假活：进程活着、端口在听、TCP 已建立、心跳照发，但下游几十小时收不到事件
    // （NapCat #2071）。读超时永远不触发（心跳一直重置它），所以链路层测不出来。
    // 能测出来的只有"多久没有消息了"这个事实——这里锁的就是它。
    const cat = await startFakeNapCat(t);
    const { channel, received } = startChannel(cat, { accessToken: 'secret', readTimeoutMs: 0 });
    t.after(() => { channel.stop(); });
    await waitConnected(channel);

    assert.equal(channel.snapshot().lastEventAt, null, '还没收到过必须是 null，不是 0（0 会被读成 1970 年）');

    const before = Date.now();
    cat.sendJson({
      post_type: 'message', message_type: 'private', message_id: 1, user_id: 10001, self_id: 30003,
      raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }],
    });
    await waitFor(() => received.length === 1, 8000, '私聊投递');
    const at = channel.snapshot().lastEventAt;
    assert.ok(at !== null && at >= before, `应当是刚刚那个时刻：${String(at)}`);
  });

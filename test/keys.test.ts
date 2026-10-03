/**
 * 本地密钥存储测试 — src/config/keys.ts（对齐设置页 · 模型分区那条交付路径）
 *
 * 五件事按验收口径钉住：
 *   ① 写入后可读（值按受管键名读回来，别人的键与键序都不动）；
 *   ② 环境变量优先于文件（且空值按缺失处理、envName 可被配置覆盖）；
 *   ③ 清除生效（空串删掉该键，其余键保留，清空后文件仍是个合法 `{}`）；
 *   ④ 掩码不泄漏全值（前 3 后 4，短值整体打码）；
 *   ⑤ 目录自动创建（dataDir 不存在时第一次写就建出来）。
 * 另加两条防线：文件损坏时读路径宽容失败（不抛到请求路径上）、readApiKey 真的接上了文件回退。
 * 全部在临时目录里跑，不碰仓库里的任何文件。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { readApiKey } from '../src/config/config.ts';
import {
  KEY_ENV,
  KEY_NAMES,
  isKeyName,
  keyStatus,
  keysPath,
  loadKeysFile,
  maskKey,
  readKeyFile,
  resolveKey,
  writeKeyFile,
} from '../src/config/keys.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function freshDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir);
}

/** 直接读盘上的原文档（断言键序与"文件里到底写了什么"用） */
async function rawDocument(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(keysPath(dir), 'utf8')) as Record<string, unknown>;
}

// ──────────────────────────────── ① 受管键名与环境变量名 ────────────────────────────────

test('受管键名与默认环境变量名：与 config.json 的 *_Env 字段一一对应', () => {
  assert.deepEqual([...KEY_NAMES], ['heavy', 'light', 'qqAppId', 'qqClientSecret', 'onebotToken']);
  assert.deepEqual(KEY_ENV, {
    heavy: 'IRMIA_API_KEY',
    light: 'IRMIA_LIGHT_API_KEY',
    qqAppId: 'QQ_BOT_APP_ID',
    qqClientSecret: 'QQ_BOT_CLIENT_SECRET',
    onebotToken: 'ONEBOT_ACCESS_TOKEN',
  });
  // 白名单收窄：来自 HTTP 请求体的任何值都要先过它
  assert.equal(isKeyName('heavy'), true);
  assert.equal(isKeyName('__proto__'), false, '原型链上的名字不是受管键');
  assert.equal(isKeyName(''), false);
  assert.equal(isKeyName(null), false);
});

// ──────────────────────────────── ② 写入后可读 ────────────────────────────────

test('写入后可读：值按受管键名读回来，别人的键不动、键序固定', async (t) => {
  const dir = await freshDir(t);

  assert.equal(readKeyFile(dir, 'heavy'), null, '前置：文件还不存在');

  await writeKeyFile(dir, 'onebotToken', 'token-abcdef');
  await writeKeyFile(dir, 'heavy', 'sk-abcdef1234');

  assert.equal(readKeyFile(dir, 'heavy'), 'sk-abcdef1234');
  assert.equal(readKeyFile(dir, 'onebotToken'), 'token-abcdef');
  assert.equal(readKeyFile(dir, 'light'), null);

  // 键序 = KEY_NAMES 的顺序（diff 干净、人可读），因此 heavy 排在 onebotToken 之前
  const doc = await rawDocument(dir);
  assert.deepEqual(Object.keys(doc), ['heavy', 'onebotToken']);
  assert.deepEqual(loadKeysFile(dir), { heavy: 'sk-abcdef1234', onebotToken: 'token-abcdef' });

  // 覆盖同一个键：只动它，别人的值原样
  await writeKeyFile(dir, 'heavy', 'sk-2222222222');
  assert.deepEqual(loadKeysFile(dir), { heavy: 'sk-2222222222', onebotToken: 'token-abcdef' });

  // 列表里没登记的键名进不来（文档里出现也不认）
  await writeFile(keysPath(dir), JSON.stringify({ heavy: 'sk-1', stray: 'nope' }), 'utf8');
  assert.deepEqual(Object.keys(loadKeysFile(dir)), ['heavy']);
});

// ──────────────────────────────── ③ 目录自动创建 ────────────────────────────────

test('目录自动创建：dataDir 不存在时，第一次写就把目录与文件建出来', async (t) => {
  const root = await freshDir(t);
  const dataDir = join(root, 'nested', 'data');

  assert.equal(existsSync(dataDir), false, '前置：目录确实不存在');

  await writeKeyFile(dataDir, 'heavy', 'sk-abcdef1234');

  assert.equal(existsSync(dataDir), true, '写路径必须自己建目录（首次配置时 data/ 可能还没有）');
  assert.equal(readKeyFile(dataDir, 'heavy'), 'sk-abcdef1234');
  assert.equal(existsSync(keysPath(dataDir)), true);
});

// ──────────────────────────────── ④ 环境变量优先于文件 ────────────────────────────────

test('环境变量优先于文件：两边都有值时以环境变量为准，空值按缺失处理', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-from-file-1111');
  await writeKeyFile(dir, 'light', 'sk-light-file-2222');

  assert.equal(resolveKey(dir, 'heavy', { env: { IRMIA_API_KEY: 'sk-from-env-9999' } }), 'sk-from-env-9999');
  assert.equal(resolveKey(dir, 'heavy', { env: {} }), 'sk-from-file-1111', '环境里没有值 → 回落到文件');
  assert.equal(
    resolveKey(dir, 'heavy', { env: { IRMIA_API_KEY: '   ' } }),
    'sk-from-file-1111',
    '只有空白的值按缺失处理（与 readApiKey 的历史语义一致）',
  );

  // 配置里把环境变量名改过：以调用方给的名字为准，文件回退仍按受管键名走
  assert.equal(resolveKey(dir, 'light', { env: { MY_LIGHT_KEY: 'sk-custom-3333' }, envName: 'MY_LIGHT_KEY' }), 'sk-custom-3333');
  assert.equal(resolveKey(dir, 'light', { env: { IRMIA_LIGHT_API_KEY: '   ' } }), 'sk-light-file-2222', 'light 有独立的环境变量名');

  // dataDir 传 null = 只看环境变量；name 传 null = 不认文件里的键
  assert.equal(resolveKey(null, 'heavy', { env: { IRMIA_API_KEY: 'sk-env-only' } }), 'sk-env-only');
  assert.equal(resolveKey(null, 'heavy', { env: {} }), null);
  assert.equal(resolveKey(dir, null, { env: {}, envName: 'IRMIA_API_KEY' }), null);

  // 环境变量在进程环境里也认（缺省 env = process.env）
  const envName = `IRMIA_TEST_KEYS_${process.pid}`;
  process.env[envName] = 'sk-from-process-env';
  t.after(() => {
    delete process.env[envName];
  });
  assert.equal(resolveKey(dir, 'qqAppId', { envName }), 'sk-from-process-env');
});

test('readApiKey 接上本地密钥文件：环境变量缺失时回落到 .keys.json', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-file-only-1234');

  // 这个变量名保证进程环境里没有它
  const lane = { apiKeyEnv: `IRMIA_TEST_ABSENT_${process.pid}` };
  assert.equal(readApiKey(lane, {}, dir, 'heavy'), 'sk-file-only-1234');
  assert.equal(
    readApiKey(lane, { [lane.apiKeyEnv]: 'sk-from-env' }, dir, 'heavy'),
    'sk-from-env',
    '环境变量仍然压过文件',
  );
  assert.equal(readApiKey(lane, {}, null, 'heavy'), null, '不传 dataDir 时只看环境变量（历史语义不变）');
  assert.equal(readApiKey(lane, {}), null, '不传 dataDir / name 时既不看文件也没环境值');
});

// ──────────────────────────────── ⑤ 清除生效 ────────────────────────────────

test('清除生效：空串删掉该键、其余键保留；清空后文件仍是个合法 {}', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-heavy-1111');
  await writeKeyFile(dir, 'light', 'sk-light-2222');
  await writeKeyFile(dir, 'qqAppId', '123456');

  await writeKeyFile(dir, 'heavy', '');

  assert.equal(readKeyFile(dir, 'heavy'), null, '清掉的键读不到');
  assert.equal(resolveKey(dir, 'heavy', { env: {} }), null, '清除后不回落任何东西');
  assert.deepEqual(await rawDocument(dir), { light: 'sk-light-2222', qqAppId: '123456' });
  assert.deepEqual(Object.keys(await rawDocument(dir)), ['light', 'qqAppId'], '剩下的键仍按 KEY_NAMES 排序');

  // 纯空白也算清除（界面上手滑打个空格不该变成密钥）
  await writeKeyFile(dir, 'light', '   ');
  assert.equal(readKeyFile(dir, 'light'), null);

  await writeKeyFile(dir, 'qqAppId', '');
  assert.deepEqual(loadKeysFile(dir), {});
  assert.equal((await stat(keysPath(dir))).isFile(), true, '一个键都不剩时保留一个 {} 文件（配过密钥的痕迹）');
  assert.deepEqual(await rawDocument(dir), {});
});

// ──────────────────────────────── ⑥ 掩码 ────────────────────────────────

test('掩码不泄漏全值：前 3 后 4，短于 8 位整体打码', () => {
  const secret = 'sk-abcdef1234';
  const masked = maskKey(secret);
  assert.equal(masked, 'sk-…1234');
  assert.notEqual(masked, secret);
  assert.equal(masked.includes(secret), false, '掩码里不得出现全值');
  assert.ok(masked.length < secret.length, '掩码必须比原值短');

  // 8 位起才露前 3 后 4；再短的串上"前 3 后 4"等于把原文还回去
  assert.equal(maskKey('12345678'), '123…5678');
  for (const short of ['', 'sk', 'sk-1', 'sk-1234', 'abc1234']) {
    assert.equal(maskKey(short), '…', `${JSON.stringify(short)} 太短，应当整体打码`);
    assert.equal(maskKey(short).includes(short) && short !== '', false);
  }

  // 带空白的值按 trim 后的形态打码（与取值链同一口径）
  assert.equal(maskKey('  sk-abcdef1234  '), 'sk-…1234');

  // 状态视图只给掩码：configured / mask / source / envName，**没有任何字段是值**
  assert.deepEqual(keyStatus('heavy', { env: {}, dataDir: null }), {
    configured: false,
    mask: null,
    source: null,
    envName: KEY_ENV.heavy,
  });
  const status = keyStatus('heavy', { env: { IRMIA_API_KEY: secret }, dataDir: null });
  assert.equal(status.configured, true);
  assert.equal(status.source, 'env');
  assert.equal(status.mask, 'sk-…1234');
  assert.equal(JSON.stringify(status).includes(secret), false, '状态视图序列化后不得含全值');
});

// ──────────────────────────────── ⑦ 损坏文件 ────────────────────────────────

test('密钥文件损坏时按未配置处理，且写入会把它覆盖回合法文档', async (t) => {
  const dir = await freshDir(t);

  await writeFile(keysPath(dir), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(loadKeysFile(dir), {}, '损坏文件不得让调用方炸掉');
  assert.equal(readKeyFile(dir, 'heavy'), null);
  assert.equal(resolveKey(dir, 'heavy', { env: {} }), null);

  await writeFile(keysPath(dir), '[1, 2, 3]', 'utf8');
  assert.deepEqual(loadKeysFile(dir), {}, '顶层不是对象同样当未配置');

  await writeKeyFile(dir, 'heavy', 'sk-abcdef1234');
  assert.deepEqual(await rawDocument(dir), { heavy: 'sk-abcdef1234' }, '写路径整体覆盖，坏的残留不会传染');
});

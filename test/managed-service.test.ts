/**
 * 内置协议端服务测试 —— src/services/snowluma.ts
 *
 * 这一层的价值全在"框架能不能自己把它拉起来并对上接口"上，所以测试也照这条线走：
 *   • `readEndpointFromConfig` 是纯函数，坏配置的每一种形状都该返回 null（**绝不猜端口**：
 *     猜错会连到别的本地服务上，比连不上更难查）
 *   • 端到端那条**真的 spawn 一个假协议端**（一个开 TCP 端口 + 写自己配置的小脚本），
 *     走完 拉起 → 探端口 → 读配置 → ready → stop 的全程
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WEBUI_URL, ManagedProtocolService, canConnect, readEndpointFromConfig, resolveServiceDir,
} from '../src/services/snowluma.ts';

const roots: string[] = [];
test.after(() => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-svc-'));
  roots.push(dir);
  return dir;
}

/** 写一份协议端配置（形状照 SnowLuma 的 config/onebot.json） */
function writeConfig(dir: string, body: unknown): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'onebot.json'), JSON.stringify(body), 'utf8');
}

function configWith(server: unknown): unknown {
  return { networks: { httpServers: [], httpClients: [], wsServers: [server], wsClients: [] } };
}

test('读配置：正常那份能取出 wsUrl 与 access_token', () => {
  const dir = tempDir();
  writeConfig(dir, configWith({ name: 'ws-default', host: '127.0.0.1', port: 3001, path: '/', accessToken: 'sekret' }));
  assert.deepEqual(readEndpointFromConfig(dir), { wsUrl: 'ws://127.0.0.1:3001/', accessToken: 'sekret' });
});

test('读配置：坏形状一律 null —— 绝不猜一个端口出来', () => {
  const cases: Array<[string, unknown]> = [
    ['还没有那份文件（第一次跑之前）', undefined],
    ['JSON 坏了', '{ not json'],
    ['没有 networks', { other: 1 }],
    ['wsServers 是空的', configWith(undefined)],
    ['wsServers 不是数组', { networks: { wsServers: 'nope' } }],
    ['端口不是数字', configWith({ host: '127.0.0.1', port: 'abc' })],
    ['端口越界', configWith({ host: '127.0.0.1', port: 99999 })],
  ];
  for (const [why, body] of cases) {
    const dir = tempDir();
    if (body !== undefined) {
      if (typeof body === 'string') {
        mkdirSync(join(dir, 'config'), { recursive: true });
        writeFileSync(join(dir, 'config', 'onebot.json'), body, 'utf8');
      } else {
        writeConfig(dir, body);
      }
    }
    assert.equal(readEndpointFromConfig(dir), null, why);
  }
});

test('读配置：缺 host / path 时用安全默认，token 缺了给空串（协议端可能没开校验）', () => {
  const dir = tempDir();
  writeConfig(dir, configWith({ port: 3001 }));
  assert.deepEqual(readEndpointFromConfig(dir), { wsUrl: 'ws://127.0.0.1:3001/', accessToken: '' });
});

test('canConnect：有人听就 true，没人听就 false（不握手，只探端口）', async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await canConnect(`ws://127.0.0.1:${port}/`), true);
    assert.equal(await canConnect('ws://127.0.0.1:1/'), false);
    assert.equal(await canConnect('不是个 url'), false);
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); });
  }
});

test('服务：目录里没有入口 → not-installed，并且说清该怎么办', () => {
  const dir = tempDir();
  const svc = new ManagedProtocolService({ dir });
  return svc.start().then((s) => {
    assert.equal(s.state, 'not-installed');
    assert.match(s.detail, /下载/);
  });
});

test('服务：端到端——拉起假协议端 → 探到端口 → 读出配置 → ready → 停掉', async () => {
  const dir = tempDir();
  // 一个"假协议端"：开一个 TCP 端口，并把自己的 OneBot 配置写到 config/onebot.json
  const fake = `
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const port = Number(process.env.FAKE_PORT ?? '0');
const server = createServer();
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  mkdirSync(join(process.cwd(), 'config'), { recursive: true });
  writeFileSync(join(process.cwd(), 'config', 'onebot.json'), JSON.stringify({
    networks: { wsServers: [{ name: 'ws-default', host: '127.0.0.1', port: actual, path: '/', accessToken: 'tok-from-config' }] },
  }));
  console.log('fake protocol side ready on ' + actual);
});
setInterval(() => {}, 1000);
`;
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.mjs'), fake, 'utf8');

  const logs: string[] = [];
  const svc = new ManagedProtocolService({
    dir,
    readyTimeoutMs: 15_000,
    onLog: (line) => logs.push(line),
  });
  const status = await svc.start();
  try {
    assert.equal(status.state, 'ready', `拉起失败：${status.detail}\n日志：${logs.join('\n')}`);
    assert.equal(status.endpoint?.accessToken, 'tok-from-config', '对接点必须来自它自己的配置');
    assert.match(String(status.endpoint?.wsUrl), /^ws:\/\/127\.0\.0\.1:\d+\/$/u);
    assert.equal(status.webuiUrl, DEFAULT_WEBUI_URL);
    assert.ok(status.pid !== undefined && status.pid > 0);
  } finally {
    await svc.stop();
  }
  assert.equal(svc.status().state, 'stopped');
});

test('服务目录：相对路径按给定基准解，绝对路径原样', () => {
  assert.equal(resolveServiceDir('C:/SnowLuma', 'C:/base'), 'C:/SnowLuma');
  assert.equal(resolveServiceDir('vendor/snowluma', 'C:/base'), join('C:/base', 'vendor/snowluma'));
});

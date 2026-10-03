import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EventLog } from '../src/log/event-log.ts';
import { fold } from '../src/state/fold.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config/config.ts';
import { TimerStore } from '../src/wake/timer-store.ts';

/**
 * persona-edit 命令的验收：
 * 人类在 GUI 里直编人格文件，必须走「快照 → 原子写 → persona/updated 事件」三步，
 * 且只允许四个具名文件与 RELATIONSHIPS/ 下一级。
 */

let dir: string;
let server: WebServer;
let token: string;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'irmia-persona-edit-'));
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'persona', 'RELATIONSHIPS'), { recursive: true });
  writeFileSync(join(dataDir, 'persona', 'STATE.md'), '# 当前状态\n\n旧内容\n', 'utf8');

  const loaded = await loadConfig(dir);
  const log = await EventLog.open(join(dataDir, 'events'));
  const timers = new TimerStore(join(dataDir, 'timers.json'));
  server = await startWebServer({
    log,
    projection: fold([]),
    config: loaded.config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers,
    now: () => new Date(),
    host: '127.0.0.1',
    port: 0,
    out: () => {},
  });
  token = server.token;
});

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('persona-edit', () => {
  test('直编 STATE.md：写入生效 + 旧内容进版本快照 + persona/updated 事件', async () => {
    const res = await api('/api/commands/persona-edit', {
      method: 'POST',
      body: JSON.stringify({ file: 'STATE.md', content: '# 当前状态\n\n新内容\n' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['ok'], true);
    assert.equal(body['changed'], true);
    assert.equal(body['file'], 'STATE.md');
    assert.equal(typeof body['diffHash'], 'string');

    // 文件真的变了
    const onDisk = readFileSync(join(dir, 'data', 'persona', 'STATE.md'), 'utf8');
    assert.match(onDisk, /新内容/u);

    // 事件落了（且是 by:human）
    const events = await api('/api/events?limit=20').then((r) => r.json()) as {
      events: Array<{ type: string; data: Record<string, unknown> }>;
    };
    const updated = events.events.filter((e) => e.type === 'persona/updated');
    assert.ok(updated.length >= 1, '应当写下 persona/updated 事件');
    assert.equal(updated.at(-1)?.data['by'], 'human');

    // 旧内容可在版本历史里找到（快照）
    const history = await api('/api/persona/history').then((r) => r.json());
    assert.ok(JSON.stringify(history).includes('STATE.md'), '版本历史应包含 STATE.md');
  });

  test('内容与当前一致时幂等：不写文件、不写事件', async () => {
    const current = readFileSync(join(dir, 'data', 'persona', 'STATE.md'), 'utf8');
    const res = await api('/api/commands/persona-edit', {
      method: 'POST',
      body: JSON.stringify({ file: 'STATE.md', content: current }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['changed'], false, '相同内容应报未改动');
  });

  test('拒绝越权路径与非法内容', async () => {
    const cases: Array<{ payload: Record<string, unknown>; why: string }> = [
      { payload: { file: '../escape.md', content: 'x' }, why: '路径穿越' },
      { payload: { file: 'OTHER.md', content: 'x' }, why: '不在白名单' },
      { payload: { file: 'RELATIONSHIPS/../../x.md', content: 'x' }, why: '档案区穿越' },
      { payload: { file: 'PROPOSALS/IDENTITY.md', content: 'x' }, why: '提案区不可直编' },
      { payload: { file: 'STATE.md', content: '   ' }, why: '空内容' },
      { payload: { file: 'STATE.md', content: 'x'.repeat(70 * 1024) }, why: '超长内容' },
      { payload: { file: 'STATE.md' }, why: '缺 content' },
    ];
    for (const c of cases) {
      const res = await api('/api/commands/persona-edit', {
        method: 'POST',
        body: JSON.stringify(c.payload),
      });
      assert.ok(res.status >= 400, `${c.why} 应被拒绝，实际 ${res.status}`);
    }
  });

  test('允许编辑 RELATIONSHIPS/ 下一级（不存在则创建）', async () => {
    const res = await api('/api/commands/persona-edit', {
      method: 'POST',
      body: JSON.stringify({ file: 'RELATIONSHIPS/用户.md', content: '# 用户\n\n喜欢安静。\n' }),
    });
    assert.equal(res.status, 200);
    const created = readFileSync(join(dir, 'data', 'persona', 'RELATIONSHIPS', '用户.md'), 'utf8');
    assert.match(created, /喜欢安静/u);
  });

  test('允许编辑 IDENTITY.md（核心文件本人可改）', async () => {
    const res = await api('/api/commands/persona-edit', {
      method: 'POST',
      body: JSON.stringify({ file: 'IDENTITY.md', content: '# 我是谁\n\n伊尔弥亚。\n' }),
    });
    assert.equal(res.status, 200);
    const onDisk = readFileSync(join(dir, 'data', 'persona', 'IDENTITY.md'), 'utf8');
    assert.match(onDisk, /伊尔弥亚/u);
  });
});

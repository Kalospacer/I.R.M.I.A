/**
 * 配置系统测试 — src/config/config.ts（对齐 docs/operations.md §1 与 milestones.md M6-1/M6-2）
 *
 * 覆盖四件事：默认配置生成与写回、缺失字段合并默认、apiKeyEnv 只读环境变量名、
 * configHash 的稳定性（键序无关）；外加注释键、非法输入不静默回退、迁移钩子链。
 * 全部在临时目录里跑，不碰仓库里的任何文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_MEMORY_MAINTAIN_CRON,
  applyUpgradeChain,
  canonicalConfigJson,
  configHash,
  defaultConfig,
  loadConfig,
  readApiKey,
  upgradeHooks,
  type AppConfig,
  type ConfigUpgradeHook,
  type JsonObject,
  type JsonValue,
  type ModelLaneConfig,
  MENTION_KEYWORD_MAX,
} from '../src/config/config.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function freshDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir);
}

function writeRawConfig(dir: string, value: unknown): Promise<void> {
  return writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(value, null, 2), 'utf8');
}

/** 深度逆序键名：用来验证 configHash 与键序无关（语义等价、字节序不同） */
function reorderKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => reorderKeysDeep(item));
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort().reverse()) {
      out[key] = reorderKeysDeep(value[key] as JsonValue);
    }
    return out;
  }
  return value;
}

// ──────────────────────────────── 「她被怎么称呼」 ────────────────────────────────

test('channels.mentionKeywords：默认空、数组与分隔字符串都收、去重保序', async (t) => {
  // 默认空 = 只认平台的 @（旧行为）：不填不该改变任何已有行为
  const dir = await freshDir(t);
  assert.deepEqual((await loadConfig(dir)).config.channels.mentionKeywords, []);

  await writeRawConfig(dir, { channels: { mentionKeywords: ['伊尔弥亚', ' 弥亚小姐 ', '伊尔弥亚', ''] } });
  assert.deepEqual(
    (await loadConfig(dir)).config.channels.mentionKeywords,
    ['伊尔弥亚', '弥亚小姐'],
    'trim + 去重 + 丢空串',
  );

  // 人可能只填一个词，也可能顺手写成一整串（逗号/顿号/空格都当分隔符）
  await writeRawConfig(dir, { channels: { mentionKeywords: '伊尔弥亚、弥亚小姐, Irmia' } });
  assert.deepEqual((await loadConfig(dir)).config.channels.mentionKeywords, ['伊尔弥亚', '弥亚小姐', 'Irmia']);
});

test('channels.mentionKeywords：类型错/超长/超数一律当场报错（不静默丢）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { channels: { mentionKeywords: [123] } });
  await assert.rejects(() => loadConfig(dir), /只允许字符串/u);

  await writeRawConfig(dir, { channels: { mentionKeywords: '这一串很长很长很长很长很长很长很长很长很长很长很长很长很长' } });
  await assert.rejects(() => loadConfig(dir), /太长/u);

  await writeRawConfig(dir, {
    channels: { mentionKeywords: Array.from({ length: MENTION_KEYWORD_MAX + 1 }, (_, i) => `词${i}`) },
  });
  await assert.rejects(() => loadConfig(dir), /最多/u);
});

// ──────────────────────────────── 默认配置生成 ────────────────────────────────

test('默认配置生成：空目录写出带注释的 config.json，字段齐全且无 tmp 残留', async (t) => {
  const dir = await freshDir(t);

  const loaded = await loadConfig(dir);
  assert.equal(loaded.createdDefault, true, '首次加载应报告新建了默认配置');
  assert.equal(loaded.path, join(dir, CONFIG_FILE_NAME));
  assert.deepEqual(loaded.appliedUpgradeTargets, []);
  assert.equal(loaded.configHash, configHash(loaded.config), '返回的哈希应与现算一致');

  // 写回的文本是人类可读的：2 空格缩进 + 顶层 $comment 注释
  const text = await readFile(loaded.path, 'utf8');
  assert.match(text, /\n  "\$comment": \[/, '默认配置应带 $comment 注释字段');
  assert.equal(text.endsWith('\n'), true, '文件应以换行收尾');
  const doc = JSON.parse(text) as JsonObject;
  assert.ok(Array.isArray(doc['$comment']));

  // 目录里只有 config.json：原子写的 tmp 文件已 rename 掉
  assert.deepEqual(await readdir(dir), [CONFIG_FILE_NAME]);

  const c = loaded.config;
  assert.equal(c.schemaVersion, CONFIG_VERSION);
  assert.equal(c.dataDir, join(dir, 'data'));
  assert.deepEqual(c.paths.workspaceAllowlist, [join(dir, 'workspace')]);
  assert.deepEqual(c.budget, {
    stepTools: 20, turnSteps: 30, taskTokens: 500_000,
    dailyTokens: 2_000_000, softRatio: 0.8, failStreakMax: 5,
  });
  assert.deepEqual(c.wake, {
    heartbeatBaselineMin: 30, idleBackoffMax: 8, heartbeatFloorMin: 10, heartbeatCeilMin: 60,
    memoryMaintainCron: DEFAULT_MEMORY_MAINTAIN_CRON,
  });
  assert.equal(c.tools.destructiveEnabled, false, 'destructive 必须默认关闭');
  assert.equal(c.alerts.rateLimitMin, 30);
  assert.equal(c.alerts.webhookUrl, undefined, '未配置时不产生 webhookUrl 键');
  assert.equal(c.models.degraded, undefined, '默认不启用降级链');
  assert.equal(c.models.heavy.model, c.models.light.model);
  assert.ok(c.timezone.length > 0, 'timezone 必须落定一个具体值');

  // 默认配置自己也过一遍校验：与后一次加载的结果逐字节一致
  assert.deepEqual(defaultConfig(dir), c);
  const again = await loadConfig(dir);
  assert.equal(again.createdDefault, false);
  assert.equal(again.configHash, loaded.configHash);
});

test('默认配置文件被改坏后重新加载：不覆盖用户文件，只报错', async (t) => {
  const dir = await freshDir(t);
  await loadConfig(dir);
  await writeFile(join(dir, CONFIG_FILE_NAME), '{ "budget": ', 'utf8');

  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => err instanceof ConfigError && /合法 JSON/.test((err as Error).message),
  );
  // 用户的（坏掉的）文件原样保留，便于他修
  assert.equal(await readFile(join(dir, CONFIG_FILE_NAME), 'utf8'), '{ "budget": ');
});

// ──────────────────────────────── 缺失字段合并默认 ────────────────────────────────

test('缺失字段合并默认：段内缺字段补默认，用户写过的值原样保留', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    budget: { turnSteps: 5 },
    timezone: 'Asia/Shanghai',
    models: { heavy: { model: 'custom-heavy' } },
    paths: { workspaceAllowlist: ['ws', join(dir, 'extra')] },
  });

  const { config, createdDefault } = await loadConfig(dir);
  assert.equal(createdDefault, false, '文件已存在时不应报告新建');

  assert.equal(config.budget.turnSteps, 5);
  assert.equal(config.budget.stepTools, 20, '同段内缺失字段要补默认');
  assert.equal(config.budget.dailyTokens, 2_000_000);
  assert.equal(config.timezone, 'Asia/Shanghai');

  assert.equal(config.models.heavy.model, 'custom-heavy');
  assert.equal(config.models.heavy.baseUrl, 'https://api.deepseek.com', '只写 model 时其余字段补默认');

  // 相对路径按配置文件所在目录解析为绝对路径
  assert.deepEqual(config.paths.workspaceAllowlist, [join(dir, 'ws'), join(dir, 'extra')]);
  assert.equal(config.dataDir, join(dir, 'data'), '未写 dataDir 时用默认');

  // 合并只发生在内存里：用户文件不被改写（保住他手写的注释与排版）
  const onDisk = JSON.parse(await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')) as JsonObject;
  assert.deepEqual(Object.keys(onDisk).sort(), ['budget', 'models', 'paths', 'timezone']);
});

test('心跳区间：上下限可配，空拍上限低于下限时兜到下限（不静默变成“更久不露面”）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    wake: { heartbeatBaselineMin: 5, heartbeatFloorMin: 10, heartbeatCeilMin: 3 },
    timezone: 'Asia/Shanghai',
  });

  const { config } = await loadConfig(dir);
  assert.equal(config.wake.heartbeatFloorMin, 10);
  assert.equal(config.wake.heartbeatCeilMin, 10, '上限写小于下限：取上限 = 下限，因为“静默更久”才是坏方向');
});

// ──────────────────────────────── 外部依赖（v30） ────────────────────────────────

test('deps.paths：三个键各自独立、相对路径以配置目录为基准、空串等于没写', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    deps: {
      $comment: '外部依赖的用户指定路径',
      paths: { rg: 'tools/rg.exe', es: '   ', pwsh: 'C:\\tools\\pwsh7\\pwsh.exe' },
    },
  });

  const { config } = await loadConfig(dir);
  // 相对路径解析成绝对路径（与 dataDir / paths.workspaceAllowlist 同一口径）
  assert.equal(config.deps.paths.rg, join(dir, 'tools', 'rg.exe'));
  assert.equal(config.deps.paths.pwsh, 'C:\\tools\\pwsh7\\pwsh.exe', '绝对路径原样保留');
  assert.equal(config.deps.paths.es, undefined, '只有空白等于没写（不干预），而不是把它当路径去 spawn');
});

test('deps 段整体缺省时是一个空 paths：默认值必须是"没干预"', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { timezone: 'Asia/Shanghai' });

  const { config } = await loadConfig(dir);
  // 默认值不能自己指一条路径：那样框架自装目录与 PATH 就永远轮不到
  assert.deepEqual(config.deps.paths, {});
});

test('deps.paths.<name> 类型错就报错，不静默丢掉', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { deps: { paths: { rg: 42 } } });

  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /deps\.paths\.rg 必须是字符串路径/u);
      return true;
    },
  );
});

// ──────────────────────── 内置协议端（可选开启，v34） ────────────────────────

test('channels.onebot.managed：读得回来（kind 缺省 snowluma、autoStart 缺省不物化）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    channels: { onebot: { enabled: true, managed: { dir: 'C:\\SnowLuma' } } },
  });

  const { config } = await loadConfig(dir);
  const managed = config.channels.onebot.managed;
  assert.ok(managed !== undefined, 'managed 必须能被读回来——写进去读不回来就是"配了却不生效"');
  assert.equal(managed.kind, 'snowluma', 'kind 缺省时补默认（目前只有一个取值）');
  assert.equal(managed.dir, 'C:\\SnowLuma');
  // 目录**不在解析期**解析：它有"相对 dataDir"的语义，而解析期只有配置文件所在目录
  // （归一化交给写入侧与 main.ts 的 resolveServiceDir）
  assert.equal(managed.autoStart, undefined, '没写 autoStart 就不要物化出一个 true：那样 configHash 再也分不出写没写过');
});

test('channels.onebot.managed：autoStart=false 原样保留（"只登记不自动拉起"是合法配置）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    channels: { onebot: { enabled: true, managed: { kind: 'snowluma', dir: 'vendor/snowluma', autoStart: false } } },
  });

  const { config } = await loadConfig(dir);
  assert.equal(config.channels.onebot.managed?.autoStart, false);
  assert.equal(config.channels.onebot.managed?.dir, 'vendor/snowluma', '相对路径原样留着，基准在运行期（dataDir）');
});

test('channels.onebot.managed：dir 缺失/为空当场报错，不静默丢掉整段', async (t) => {
  // 这一条是行为锁：旧实现整段 managed 都不读，写错也没有任何反馈
  for (const managed of [{ kind: 'snowluma' }, { dir: '   ' }, { dir: 42 }]) {
    const dir = await freshDir(t);
    await writeRawConfig(dir, { channels: { onebot: { enabled: true, managed } } });
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `managed=${JSON.stringify(managed)} 应报 ConfigError`);
        assert.equal((err as ConfigError).where, 'channels.onebot.managed.dir');
        return true;
      },
    );
  }
});

test('channels.onebot.managed：kind 只认 snowluma（别的名字说明他期待了另一套启动方式）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { channels: { onebot: { managed: { kind: 'napcat', dir: 'C:\\NapCat' } } } });

  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => err instanceof ConfigError
      && (err as ConfigError).where === 'channels.onebot.managed.kind'
      && /snowluma/.test((err as Error).message),
  );
});

test('channels.onebot：不写 managed 就是"用外部协议端"（默认配置里也不该凭空出现）', async (t) => {
  const dir = await freshDir(t);
  const { config } = await loadConfig(dir);
  assert.equal(config.channels.onebot.managed, undefined, '默认必须没有它——它一出现就意味着框架接管启动');
  assert.equal(config.channels.onebot.enabled, false);
});

test('注释键与未知键被忽略，不影响加载结果', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    $comment: ['这是注释'],
    '//': '手写习惯也照顾',
    budget: { $comment: '段内注释', turnSteps: 9 },
    models: { heavy: { $comment: '模型段注释', model: 'm2' } },
    futureField: { whatever: [1, 2, 3] },
  });

  const { config } = await loadConfig(dir);
  assert.equal(config.budget.turnSteps, 9);
  assert.equal(config.models.heavy.model, 'm2');
  assert.equal(Object.keys(config).some((key) => key.startsWith('$') || key === '//'), false);
  assert.equal('futureField' in config, false, '未知键不进生效配置（向前兼容但不生效）');
});

// ──────────────────────────────── 密钥教义 ────────────────────────────────

test('apiKeyEnv 只读环境变量名：配置对象与指纹里都不含密钥值', async (t) => {
  const dir = await freshDir(t);
  const envName = `IRMIA_TEST_KEY_${process.pid}`;
  const secret = 'sk-secret-value-must-not-leak';
  process.env[envName] = secret;
  t.after(() => {
    delete process.env[envName];
  });

  await writeRawConfig(dir, { models: { heavy: { apiKeyEnv: envName } } });
  const { config } = await loadConfig(dir);

  assert.equal(config.models.heavy.apiKeyEnv, envName, '配置里存的是环境变量名');
  assert.equal(JSON.stringify(config).includes(secret), false, '配置对象不得含密钥值');
  assert.equal(canonicalConfigJson(config).includes(secret), false, '指纹输入不得含密钥值');

  // 唯一的读值入口：只有它碰环境
  assert.equal(readApiKey(config.models.heavy), secret);
  assert.equal(readApiKey(config.models.heavy, {}), null, '环境变量缺失时返回 null，不抛错');
  process.env[envName] = '   ';
  assert.equal(readApiKey(config.models.heavy), null, '只有空白的值按缺失处理');

  const lane: ModelLaneConfig = { model: 'm', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'IRMIA_NOT_SET_AT_ALL' };
  assert.equal(readApiKey(lane), null);
});

test('把密钥值误填进 apiKeyEnv：加载当场报错并给出指路', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { models: { heavy: { apiKeyEnv: 'sk-abc123456789' } } });

  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => err instanceof ConfigError
      && (err as ConfigError).where === 'models.heavy.apiKeyEnv'
      && /环境变量名/.test((err as Error).message),
  );
});

// ──────────────────────────────── 指纹 ────────────────────────────────

test('configHash 稳定：键序无关、字段改动即变、格式为 sha256 hex', async (t) => {
  const dir = await freshDir(t);
  const { config } = await loadConfig(dir);

  // 同一份配置，两种键序（其一为全量逆序键）→ 同一指纹
  const shuffled = reorderKeysDeep(JSON.parse(JSON.stringify(config)) as JsonValue) as unknown as AppConfig;
  assert.notEqual(
    JSON.stringify(shuffled), JSON.stringify(config),
    '前置条件：两份对象的字节序确实不同',
  );
  assert.equal(canonicalConfigJson(shuffled), canonicalConfigJson(config));
  assert.equal(configHash(shuffled), configHash(config));
  assert.equal(configHash(config), configHash(loadedHashSource(config)), '重复计算必须一致');

  assert.match(configHash(config), /^[0-9a-f]{64}$/u);

  const changedBudget: AppConfig = { ...config, budget: { ...config.budget, turnSteps: 31 } };
  const changedTimezone: AppConfig = { ...config, timezone: 'Pacific/Kiritimati' };
  const changedTools: AppConfig = { ...config, tools: { destructiveEnabled: ['pwsh'] } };
  assert.notEqual(configHash(changedBudget), configHash(config));
  assert.notEqual(configHash(changedTimezone), configHash(config));
  assert.notEqual(configHash(changedTools), configHash(config));

  // 未设的可选字段（undefined）不进指纹：等价于"没有这个键"
  const withoutDegraded: AppConfig = { ...config, models: { ...config.models } };
  const withUndefined: AppConfig = { ...config, models: { ...config.models, degraded: undefined } };
  assert.equal(configHash(withoutDegraded), configHash(withUndefined));
});

/** 同内容不同对象身份：确认哈希按内容而非对象引用 */
function loadedHashSource(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

// ──────────────────────────────── 非法输入 ────────────────────────────────

test('非法字段值一律报 ConfigError，不静默回退默认（含易错项 softRatio=8）', async (t) => {
  const dir = await freshDir(t);
  const cases: Array<{ doc: unknown; where: string }> = [
    { doc: { budget: { softRatio: 8 } }, where: 'budget.softRatio' },
    { doc: { budget: { turnSteps: '30' } }, where: 'budget.turnSteps' },
    { doc: { budget: { turnSteps: 0 } }, where: 'budget.turnSteps' },
    { doc: { budget: { stepTools: 2.5 } }, where: 'budget.stepTools' },
    { doc: { timezone: 'Mars/Olympus' }, where: 'timezone' },
    { doc: { models: { heavy: { baseUrl: 'api.deepseek.com' } } }, where: 'models.heavy.baseUrl' },
    { doc: { models: { heavy: { model: '' } } }, where: 'models.heavy.model' },
    { doc: { models: 'heavy' }, where: 'models' },
    { doc: { tools: { destructiveEnabled: 'yes' } }, where: 'tools.destructiveEnabled' },
    { doc: { paths: { workspaceAllowlist: 'ws' } }, where: 'paths.workspaceAllowlist' },
    { doc: { paths: { workspaceAllowlist: ['ws', ''] } }, where: 'paths.workspaceAllowlist[1]' },
    { doc: { alerts: { webhookUrl: 'ftp://x' } }, where: 'alerts.webhookUrl' },
    { doc: { alerts: { rateLimitMin: -1 } }, where: 'alerts.rateLimitMin' },
  ];

  for (const item of cases) {
    await writeRawConfig(dir, item.doc);
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).where === item.where,
      `应报 ${item.where}`,
    );
  }

  // 顶层不是对象
  await writeFile(join(dir, CONFIG_FILE_NAME), '[1, 2, 3]', 'utf8');
  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => err instanceof ConfigError && /顶层必须是 JSON 对象/.test((err as Error).message),
  );
});

test('配置版本高于代码版本：明确报错而不是硬读', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { schemaVersion: CONFIG_VERSION + 1 });

  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => err instanceof ConfigError
      && /高于本程序支持/.test((err as Error).message),
  );
});

// ──────────────────────────────── 迁移钩子链 ────────────────────────────────

test('迁移钩子链：按 targetVersion 逐个触发，缺钩子即报错', () => {
  const calls: number[] = [];
  const hooks: ConfigUpgradeHook[] = [
    {
      targetVersion: 2,
      upgrade: (doc) => {
        calls.push(2);
        return { ...doc, budget: { ...(doc['budget'] as JsonObject | undefined), turnSteps: 12 } };
      },
    },
    { targetVersion: 3, upgrade: (doc) => { calls.push(3); return { ...doc, timezone: 'UTC' }; } },
  ];

  const { doc, applied } = applyUpgradeChain({ schemaVersion: 1, timezone: 'Asia/Shanghai' }, 1, 3, hooks);
  assert.deepEqual(calls, [2, 3], '每个钩子恰好触发一次且按序');
  assert.deepEqual(applied, [2, 3]);
  assert.equal(doc['schemaVersion'], 3, '版本号被归一化到目标版本');
  assert.equal((doc['budget'] as JsonObject)['turnSteps'], 12);
  assert.equal(doc['timezone'], 'UTC');

  // 已是目标版本：一个钩子都不跑
  const none = applyUpgradeChain({ schemaVersion: 3 }, 3, 3, hooks);
  assert.deepEqual(none.applied, []);
  assert.deepEqual(calls, [2, 3]);

  // 中间缺一个版本：跳步迁移必须报错，绝不猜
  assert.throws(
    () => applyUpgradeChain({ schemaVersion: 1 }, 1, 3, [hooks[1] as ConfigUpgradeHook]),
    (err: unknown) => err instanceof ConfigError && /迁移钩子/.test((err as Error).message),
  );

  // 钩子拒绝迁移
  assert.throws(
    () => applyUpgradeChain({ schemaVersion: 1 }, 1, 2, [{ targetVersion: 2, upgrade: () => null }]),
    (err: unknown) => err instanceof ConfigError && /拒绝迁移/.test((err as Error).message),
  );

  // 内置链当前为空（M6 填链），接口已在位
  assert.equal(upgradeHooks.length, 0);
});

test('旧版本配置文件：迁移前备份原文件，缺钩子时明确报错', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { schemaVersion: 0, budget: { turnSteps: 3 } });

  await assert.rejects(
    () => loadConfig(dir),
    (err: unknown) => err instanceof ConfigError && /迁移钩子/.test((err as Error).message),
  );

  const files = await readdir(dir);
  const backup = files.find((name) => name === `${CONFIG_FILE_NAME}.bak.v0`);
  assert.equal(typeof backup, 'string', `迁移前应留下备份，实际目录内容：${files.join(', ')}`);
  const backupDoc = JSON.parse(await readFile(join(dir, backup as string), 'utf8')) as JsonObject;
  assert.equal(backupDoc['schemaVersion'], 0, '备份是迁移前的原文件内容');
  assert.equal((await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')).includes('"turnSteps": 3'), true);
});

test('注入迁移钩子后旧配置可升到当前版本并生效', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { schemaVersion: 0, budget: { turnSteps: 3 } });

  const hooks: ConfigUpgradeHook[] = [{
    targetVersion: 1,
    upgrade: (doc) => ({ ...doc, dataDir: 'migrated-data' }),
  }];

  const loaded = await loadConfig(dir, { hooks });
  assert.deepEqual(loaded.appliedUpgradeTargets, [1]);
  assert.equal(loaded.config.schemaVersion, CONFIG_VERSION);
  assert.equal(loaded.config.budget.turnSteps, 3, '迁移保留用户值');
  assert.equal(loaded.config.dataDir, join(dir, 'migrated-data'));
  assert.ok((await readdir(dir)).some((name) => name === `${CONFIG_FILE_NAME}.bak.v0`));
});

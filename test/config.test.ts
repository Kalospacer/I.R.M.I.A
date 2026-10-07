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
  DEFAULT_STATE_BUDGET_BYTES,
  applyUpgradeChain,
  canonicalConfigJson,
  configHash,
  defaultConfig,
  loadConfig,
  readApiKey,
  trustBoundaryRoot,
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
  assert.deepEqual(c.budget, {
    stepTools: 20, turnSteps: 60, taskTokens: 500_000_000,
    dailyTokens: 50_000_000, softRatio: 0.8, failStreakMax: 20,
  });
  assert.deepEqual(c.wake, {
    heartbeatFloorMin: 5, heartbeatCeilMin: 60, heartbeatTickMin: 1, heartbeatTargetMeanMin: 30,
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

/**
 * 出厂日额度的**下界**：不许低于"能撑住心跳"的量级（**下界 2e6 是一条不许松的地板**，
 * 出厂值现在远在它之上：5e7）。
 *
 * 这条与上面那条用例是**两个方向**：上面钉"等于多少"（顺手改数字就能过），
 * 这条钉"**不许低于多少**"——将来有人想把日额度调小，会先在这里被拦住，
 * 并被要求回头看一眼那笔账。判据不放宽：下界写死在断言里，不是"看着差不多就行"。
 *
 * 为什么下界是这个量级（账，不是拍的；**2026-10-05 换口径后按新口径重算**）：
 * 心跳是**真实唤醒**——每一拍都真发一次 heavy 请求，并且刻意共用同一份冻结前缀去保温
 * 供方的前缀缓存（design.md §4.12）。于是心跳**自己**就有日开销：按现在这套概率分布
 * 实测均值约 15 分钟一拍 ⇒ 约 96 拍/天；每拍**非缓存**（`(input − cacheHit) + output`）
 * ≈ 未命中 0.36 万 + 输出 350 ≈ **0.4 万** ⇒ 一天 ≈ **0.35M**。
 *（口径、样本量与脚本：`_research/heartbeat-real-wake-audit.mjs`；结论记在 design.md §4.12，
 * 账记在 §4.6。旧口径那笔账是"176 万~500 万 token/天"，两者差约 25 倍，别混——那笔账判死的是
 * **旧口径下的 2M**。）
 *
 * 下界取心跳日均**上界估算**（0.5M）的 **4 倍 = 2e6**：日额度里心跳至多占 1/4，
 * 大头留给"心跳之上的真实工作"。**要调小，先来改这条注释里的账与出处，别只改数字。**
 */
test('出厂日额度：默认值不许低于能撑住心跳的量级（地板 2e6；出厂值 5e7）', async (t) => {
  const dir = await freshDir(t);
  const { config } = await loadConfig(dir);

  // 心跳真实唤醒的日均开销**上界估算**（非缓存口径；出处见上面这段注释）
  const HEARTBEAT_DAILY_HIGH = 500_000;
  // 出厂下界**写死 2e6**（= 心跳上界的 4 倍）：出厂额度里心跳只该占个零头（≤ 1/4）。
  // 写死而不是"由上面那个常量算出来"，是为了让这条判据**没法被顺手放松**：
  // 想放宽就得同时动下面那条自检，一眼能看见。
  const FACTORY_FLOOR = 2_000_000;
  assert.ok(
    FACTORY_FLOOR >= HEARTBEAT_DAILY_HIGH * 4,
    '这条用例自己也不许被放松：下界必须 ≥ 心跳日均上界的 4 倍（要改先看上面那笔账）',
  );

  assert.ok(
    config.budget.dailyTokens >= FACTORY_FLOOR,
    `出厂日额度 ${config.budget.dailyTokens} 低于能撑住心跳的量级 ${FACTORY_FLOOR}：`
      + '心跳是真实唤醒（约 96 拍/天、非缓存约 0.35M/天，见 _research/heartbeat-real-wake-audit.mjs），'
      + '调这么小会被心跳自己吃掉一大块。账与出处写在 test/config.test.ts 这条用例的注释里与 docs/design.md §4.6/§4.12。',
  );
  // 同族自洽（2026-10-05 起的方向）：**日那一层要先响**——它管"一整天"，task 只管"单个任务"。
  // 所以单任务额度不许比日额度更紧；反过来的话每个 turn 都先撞 task，日额度形同虚设。
  // （换口径前这条判据是反的：那时 task = daily = 1e8，方向刻意相反；见 config.ts 那两段注释。）
  assert.ok(
    config.budget.dailyTokens <= config.budget.taskTokens,
    '日额度不许高于单任务额度（否则 task 永远先撞线、「日」那一层轮不到）',
  );
});

/**
 * 出厂**单任务**额度的下界（**下界 5e6 是一条不许松的地板**；出厂值现在远在它之上：5e8）。
 *
 * 与日额度那条**同一条理由、同一个量级**：心跳每天约 0.35M 非缓存（上界估算 0.5M），
 * 而 task 那一层是"一个任务的累计消耗"（`tokensTask` 跨 turn 累计、到点把这个 turn 收尾）。
 * 额度定得比心跳的日均开销还小，等于每次正常任务都先撞它。
 *
 * 为什么**不**干脆写成"taskTokens 必须 == dailyTokens"：那是把两层语义焊死（task 撞线 =
 * 这次任务进待确认，daily 撞线 = 今天拒绝唤醒）。这里钉两件事：不许比心跳量级还小、
 * 且**比日额度宽**（日先响）。要调的人自己看这笔账。
 */
test('出厂单任务额度：不许低于心跳量级的 10 倍，且要比日额度宽（地板 5e6；出厂值 5e8）', async (t) => {
  const dir = await freshDir(t);
  const { config } = await loadConfig(dir);

  // 心跳日均非缓存开销的上界估算（与日额度那条同一个常量）
  const HEARTBEAT_DAILY_HIGH = 500_000;
  // 出厂下界**写死 5e6**（= 心跳上界的 10 倍，也 = 日额度下界 2e6 的 2.5 倍）
  const TASK_FLOOR = 5_000_000;
  assert.ok(
    TASK_FLOOR >= HEARTBEAT_DAILY_HIGH * 10,
    '这条用例自己也不许被放松：下界必须 ≥ 心跳日均上界的 10 倍（要改先看上面那笔账）',
  );
  assert.ok(
    config.budget.taskTokens >= TASK_FLOOR,
    `出厂单任务额度 ${config.budget.taskTokens} 低于能撑住心跳的量级 ${TASK_FLOOR}：`
      + '旧口径下的 500k 就是这么被判死的（心跳自己就把额度吃掉一大块，task 会先撞线，'
      + '把每次正常任务都变成"进待确认"）。账与出处见 src/config/config.ts 里 taskTokens 那段注释。',
  );
  assert.ok(
    config.budget.taskTokens >= config.budget.dailyTokens,
    '单任务额度不许比日额度更紧：新口径下该由「日」那一层先响',
  );
});

/**
 * `trust.workspaceRoot` 的默认值（2026-10-05 定）：**智能体自己的工作根 = 配置目录**。
 *
 * 为什么值得一条单独的用例：这个默认值决定 `mode: 'workspace'` 那一档到底是"只限工作目录"
 * 还是"把她锁在门外"。原来的默认是 `<配置目录>/workspace`，而她的记忆
 * （`<dataDir>/workspace/MEMORIES/`）与人格资产（`<dataDir>/persona/`）都在它**之外**——
 * 那一档下她连自己的记忆都读不到（实测见 `test/trust-boundary.test.ts` 的那组用例）。
 * 现在的口径干净了：**`workspace` = 今天的行为**（fs 工具族今天用的就是这个根）、
 * **`full` = 新放开的那一档**。这条断言把"默认是哪一边"钉死，免得它悄悄漂回窄的那一侧。
 */
test('trust 默认：full + 边界根 = 配置目录（= 智能体自己的工作根，不是 <dir>/workspace）', async (t) => {
  const dir = await freshDir(t);
  const c = (await loadConfig(dir)).config;

  assert.equal(c.trust.mode, 'full', '默认完全信任（用户 2026-10-04 的决定）');
  assert.equal(
    c.trust.workspaceRoot,
    resolve(dir),
    'workspace 档的边界默认 = 配置目录（她的 MEMORIES/ 与 persona/ 都在它之下）',
  );
  assert.notEqual(
    c.trust.workspaceRoot,
    join(dir, 'workspace'),
    '别再漂回那个窄口径：它落在 MEMORIES/ 与 persona/ 之外，等于把她锁在门外',
  );

  // 盘上显式写了就以盘上为准（默认只是默认）
  await writeFile(
    join(dir, CONFIG_FILE_NAME),
    JSON.stringify({ trust: { mode: 'workspace', workspaceRoot: join(dir, 'narrow') } }),
    'utf8',
  );
  const explicit = (await loadConfig(dir)).config;
  assert.equal(explicit.trust.mode, 'workspace');
  assert.equal(explicit.trust.workspaceRoot, join(dir, 'narrow'));
  // 执行器的边界读的就是这个字段（同源，不是各算一遍）
  assert.equal(trustBoundaryRoot(explicit.trust), join(dir, 'narrow'));
  assert.equal(trustBoundaryRoot(c.trust), null, "'full' 档 = 不设边界");
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
  });

  const { config, createdDefault } = await loadConfig(dir);
  assert.equal(createdDefault, false, '文件已存在时不应报告新建');

  assert.equal(config.budget.turnSteps, 5);
  assert.equal(config.budget.stepTools, 20, '同段内缺失字段要补默认');
  assert.equal(config.budget.dailyTokens, 50_000_000, '缺 dailyTokens 时补的是**新**出厂默认（单日非缓存 5e7）');
  assert.equal(config.timezone, 'Asia/Shanghai');

  assert.equal(config.models.heavy.model, 'custom-heavy');
  assert.equal(config.models.heavy.baseUrl, 'https://api.deepseek.com', '只写 model 时其余字段补默认');

  // 相对路径按配置文件所在目录解析为绝对路径
  assert.equal(config.dataDir, join(dir, 'data'), '未写 dataDir 时用默认');

  // 合并只发生在内存里：用户文件不被改写（保住他手写的注释与排版）
  const onDisk = JSON.parse(await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')) as JsonObject;
  assert.deepEqual(Object.keys(onDisk).sort(), ['budget', 'models', 'timezone']);
});

test('心跳区间：上下限可配，上限低于下限时兜到下限（不静默变成“更久不露面”）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    wake: { heartbeatFloorMin: 10, heartbeatCeilMin: 3 },
    timezone: 'Asia/Shanghai',
  });

  const { config } = await loadConfig(dir);
  assert.equal(config.wake.heartbeatFloorMin, 10);
  assert.equal(config.wake.heartbeatCeilMin, 10, '上限写小于下限：取上限 = 下限，因为“静默更久”才是坏方向');
});

/**
 * 抽签节奏不许超过下限（2026-10-04 概率模型）。
 *
 * 为什么钉这一条：`heartbeatTickMin` 是**抽签间隔**，第一次抽签落在此刻（安静 = tick）。
 * 它一旦大于下限，第一抽就会落在下限**之后**，下限（"安静不足 5 分钟绝不触发"）就不再是下限——
 * 更糟的是它还会把整个分布的支撑往下推（5~60 变成 tick~60），均值随之漂走。
 * 所以解析器直接把 tick 夹到 floor 之内，而不是留给运行期"看着不对再说"。
 */
test('抽签节奏：可配，但超过下限时夹到下限（下限必须是真下界）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    wake: { heartbeatFloorMin: 5, heartbeatCeilMin: 60, heartbeatTickMin: 30 },
    timezone: 'Asia/Shanghai',
  });

  const { config } = await loadConfig(dir);
  assert.equal(config.wake.heartbeatTickMin, 5, 'tick 写在 floor 之上：夹到 floor，不把下限推后');

  // 对照：合法范围内原样生效
  const dir2 = await freshDir(t);
  await writeRawConfig(dir2, {
    wake: { heartbeatFloorMin: 5, heartbeatCeilMin: 60, heartbeatTickMin: 2 },
    timezone: 'Asia/Shanghai',
  });
  assert.equal((await loadConfig(dir2)).config.wake.heartbeatTickMin, 2);
});

/**
 * 心跳**目标均值**（`wake.heartbeatTargetMeanMin`，2026-02-06 加）：说人话的调频旋钮。
 *
 * 为什么钉这几条：这个字段是「心跳频率没有地方可以控制吗？」的答案——它必须
 * **真的能填、填了真的生效**（解析出来就是那个数，α 由它在启动时反解，见
 * `test/heartbeat-target-mean.test.ts`），而写错的三种方式必须**当场报配置错**而不是
 * 静默夹一个值（夹过的旋钮比没有旋钮更坏：人会以为自己调过了）。
 */
test('心跳目标均值：默认 30，可配，合法值原样生效', async (t) => {
  const dir = await freshDir(t);
  assert.equal((await loadConfig(dir)).config.wake.heartbeatTargetMeanMin, 30, '默认 30 = 平均每半小时露一次面');

  const dir2 = await freshDir(t);
  await writeRawConfig(dir2, {
    wake: { heartbeatFloorMin: 5, heartbeatCeilMin: 60, heartbeatTargetMeanMin: 20 },
    timezone: 'Asia/Shanghai',
  });
  assert.equal((await loadConfig(dir2)).config.wake.heartbeatTargetMeanMin, 20, '写 20 就是 20（不夹、不舍）');

  // 边界内的两个极端也要能填：floor+1 与 ceil−1（整数分钟里最靠边的合法值）
  const dir3 = await freshDir(t);
  await writeRawConfig(dir3, {
    wake: { heartbeatFloorMin: 14, heartbeatCeilMin: 16, heartbeatTargetMeanMin: 15 },
    timezone: 'Asia/Shanghai',
  });
  assert.equal((await loadConfig(dir3)).config.wake.heartbeatTargetMeanMin, 15);
});

test('心跳目标均值 ≤ 下限 / ≥ 上限：报配置错，消息里带两个边界的值', async (t) => {
  // ① 等于下限（下限以下概率恒为 0，"平均 10 分钟醒一次但 10 分钟内绝不触发"是自相矛盾的）
  const atFloor = await freshDir(t);
  await writeRawConfig(atFloor, {
    wake: { heartbeatFloorMin: 10, heartbeatCeilMin: 60, heartbeatTargetMeanMin: 10 },
    timezone: 'Asia/Shanghai',
  });
  await assert.rejects(
    () => loadConfig(atFloor),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `必须是配置错，收到 ${String(err)}`);
      assert.equal(err.where, 'wake.heartbeatTargetMeanMin');
      assert.match(err.message, /10/, '消息要说清下限的值');
      assert.match(err.message, /60/, '以及上限的值');
      assert.match(err.message, /严格/, '说清是开区间（不能等于边界）');
      return true;
    },
  );

  // ② 等于上限（到点必然触发那一点不是"平均"，是硬边界）
  //    这里把 ceil 收到 20，让"非默认值的 20"正好落在上限上——用默认值当靶子的话，
  //    默认值一改这条用例就变成"什么都没测"（而不是失败），那是最坏的一种测试。
  const atCeil = await freshDir(t);
  await writeRawConfig(atCeil, {
    wake: { heartbeatFloorMin: 5, heartbeatCeilMin: 20, heartbeatTargetMeanMin: 20 },
    timezone: 'Asia/Shanghai',
  });
  await assert.rejects(
    () => loadConfig(atCeil),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.where, 'wake.heartbeatTargetMeanMin');
      assert.match(err.message, /5/);
      assert.match(err.message, /20/);
      return true;
    },
  );

  // ③ 只把下限调大、没写目标均值：默认 30 与 floor 冲突 ⇒ 也要报错，并说清这个 30 是**代码默认值**
  const floorOnly = await freshDir(t);
  await writeRawConfig(floorOnly, {
    wake: { heartbeatFloorMin: 40, heartbeatCeilMin: 90 },
    timezone: 'Asia/Shanghai',
  });
  await assert.rejects(
    () => loadConfig(floorOnly),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /40/, '下限的值');
      assert.match(err.message, /90/, '上限的值');
      assert.match(err.message, /代码默认值/, '要说清 30 是从哪来的，否则像是他自己填错了');
      // "能填的范围"必须是两条约束的**交**：floor<目标<ceil 给 41~89，本字段自身限定 5~60
      // ⇒ 真正能填的是 41~60。只报 41~89 会给出一个填进去照样报错的范围（实测踩过）。
      assert.match(err.message, /41~60/, '报出来的范围要取交集（41~89 ∩ 5~60 = 41~60）');
      assert.doesNotMatch(err.message, /41~89/, '不许报一条越出本字段自身范围的"出路"');
      return true;
    },
  );
});

test('心跳目标均值：外层合理范围 5~60，越界报错（与边界值无关的那一层）', async (t) => {
  for (const target of [4, 61]) {
    const dir = await freshDir(t);
    await writeRawConfig(dir, {
      wake: { heartbeatFloorMin: 1, heartbeatCeilMin: 120, heartbeatTargetMeanMin: target },
      timezone: 'Asia/Shanghai',
    });
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `${target} 必须被 5~60 那一层挡住`);
        assert.equal(err.where, 'wake.heartbeatTargetMeanMin');
        assert.match(err.message, /5\.\.60/, '报错要说清可填范围');
        return true;
      },
    );
  }
});

test('心跳目标均值：上限被夹成下限的退化区间里不做交叉校验（既有夹取语义不改）', async (t) => {
  // ceil < floor 时解析器按"上限 = 下限"夹取（更快的节律不危险）——那种区间里没有中间地带，
  // α 与目标均值都无意义，所以出厂默认值不该把一份本来能启动的配置变成起不来。
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    wake: { heartbeatFloorMin: 30, heartbeatCeilMin: 3 },
    timezone: 'Asia/Shanghai',
  });
  const { config } = await loadConfig(dir);
  assert.equal(config.wake.heartbeatFloorMin, 30);
  assert.equal(config.wake.heartbeatCeilMin, 30, '上限仍夹到下限');
  assert.equal(config.wake.heartbeatTargetMeanMin, 30, '目标均值照旧解析出来（只是这个区间里用不上它）');
});

/**
 * 删掉的两个字段**不报错、也不生效**（2026-10-04 概率模型）。
 *
 * `heartbeatBaselineMin` / `idleBackoffMax` 是旧确定性排程的参数，已随新模型删除。
 * 老配置文件里残留下来的这两个键按"逐字段读、不认识的键不进结果"处理：既不抛 ConfigError
 * （否则老用户升上来直接起不来），也不会假装生效（那比报错更难查）。
 * 这条用例把"删干净了"钉在案上——将来谁把字段加回来，这里会红。
 */
test('已删除的旧心跳字段：残留不报错、也不出现在生效配置里', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    wake: { heartbeatBaselineMin: 30, idleBackoffMax: 8, heartbeatFloorMin: 5 },
    timezone: 'Asia/Shanghai',
  });

  const { config } = await loadConfig(dir);
  assert.equal('heartbeatBaselineMin' in config.wake, false, '旧基线字段不该复活');
  assert.equal('idleBackoffMax' in config.wake, false, '旧退避字段不该复活');
  assert.equal(config.wake.heartbeatFloorMin, 5, '同段里没被删的字段照常生效');
});

// ──────────────────────────────── 外部依赖（v30） ────────────────────────────────

test('deps.paths：三个键各自独立、相对路径以配置目录为基准、空串等于没写', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    deps: {
      $comment: '外部依赖的用户指定路径',
      paths: { rg: 'tools/rg.exe', es: '   ', pwsh: 'C:\\path\\to\\pwsh.exe' },
    },
  });

  const { config } = await loadConfig(dir);
  // 相对路径解析成绝对路径（与 dataDir 同一口径）
  assert.equal(config.deps.paths.rg, join(dir, 'tools', 'rg.exe'));
  assert.equal(config.deps.paths.pwsh, 'C:\\path\\to\\pwsh.exe', '绝对路径原样保留');
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
    channels: { onebot: { enabled: true, managed: { dir: 'C:\\path\\to\\snowluma' } } },
  });

  const { config } = await loadConfig(dir);
  const managed = config.channels.onebot.managed;
  assert.ok(managed !== undefined, 'managed 必须能被读回来——写进去读不回来就是"配了却不生效"');
  assert.equal(managed.kind, 'snowluma', 'kind 缺省时补默认（目前只有一个取值）');
  assert.equal(managed.dir, 'C:\\path\\to\\snowluma');
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
  await writeRawConfig(dir, { channels: { onebot: { managed: { kind: 'napcat', dir: 'D:\\NapCat' } } } });

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

// ──────────────────────────────── 自带记忆系统总开关 ────────────────────────────────

test('persona.memoryEnabled：默认 true（现在这套自带记忆），且写进默认配置文档', async (t) => {
  const dir = await freshDir(t);
  const loaded = await loadConfig(dir);
  assert.equal(loaded.config.persona.memoryEnabled, true, '默认必须是"现在这样"：关掉是一次显式选择');
  assert.equal(defaultConfig(dir).persona.memoryEnabled, true);

  // 默认配置是给人看的：开关与它关掉什么必须落在文件里，而不是只活在类型注释里
  const doc = JSON.parse(await readFile(loaded.path, 'utf8')) as JsonObject;
  assert.equal((doc['persona'] as JsonObject)['memoryEnabled'], true, '默认文档要写出这个字段');
  assert.match(
    JSON.stringify(doc['persona']),
    /不注入任何记忆/u,
    '默认文档的注释要说清"关掉 = 框架不生成索引、不注入、不整理"',
  );
});

test('persona.memoryEnabled：false 读得回来；写别的类型当场报错（不静默当成开）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { persona: { memoryEnabled: false } });
  assert.equal((await loadConfig(dir)).config.persona.memoryEnabled, false);

  // "false" / 0 / null 都是笔误。静默当成 true 比报错坏得多：人会以为关掉了，其实框架照旧
  // 生成索引、照旧每轮注入、照旧跑整理——那是"我配了却不生效"里最难查的一类
  for (const bogus of ['false', 0, 1]) {
    await writeRawConfig(dir, { persona: { memoryEnabled: bogus } });
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => err instanceof ConfigError && /memoryEnabled/u.test((err as Error).message),
      `${JSON.stringify(bogus)} 不是合法布尔值，应当场报错`,
    );
  }

  // 没写这个字段 = 默认 true（缺字段补默认，不是"缺失即关闭"）
  await writeRawConfig(dir, { persona: { owner: 'someone' } });
  assert.equal((await loadConfig(dir)).config.persona.memoryEnabled, true);
});

// ──────────────────────────────── STATE.md 字节预算（v32） ────────────────────────────────

test('persona.stateBudgetBytes：默认 8 KB，且写进默认配置文档并说清它做什么', async (t) => {
  const dir = await freshDir(t);
  const loaded = await loadConfig(dir);
  assert.equal(DEFAULT_STATE_BUDGET_BYTES, 8 * 1024, '出厂预算就是 8 KB（用户定的口径）');
  assert.equal(loaded.config.persona.stateBudgetBytes, DEFAULT_STATE_BUDGET_BYTES);
  assert.equal(defaultConfig(dir).persona.stateBudgetBytes, DEFAULT_STATE_BUDGET_BYTES);

  // 默认配置是给人看的：这个字段干什么、为什么是 8 KB、只提醒不截断，都要落在文件里
  const doc = JSON.parse(await readFile(loaded.path, 'utf8')) as JsonObject;
  const persona = doc['persona'] as JsonObject;
  assert.equal(persona['stateBudgetBytes'], DEFAULT_STATE_BUDGET_BYTES, '默认文档要写出这个字段');
  const text = JSON.stringify(persona);
  assert.match(text, /预算超限，记得维护，将过时内容移入记忆文件或删除/u, '用户的原话要逐字写进去');
  assert.match(text, /只提醒、不截断/u, '要说清框架不动她的文件');
  assert.match(text, /8 KB/u, '要写清为什么是 8 KB');
});

test('persona.stateBudgetBytes：写多少读回多少；坏值当场报错（不静默按 8 KB 算）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { persona: { stateBudgetBytes: 4096 } });
  assert.equal((await loadConfig(dir)).config.persona.stateBudgetBytes, 4096, '人写的值要照收');

  // 单位是**字节**，"填 8 想表示 8 KB"是真实会发生的笔误：下限 1 KB 会把它当场拦下。
  // 静默接受等于让这条提醒永远不出现（8 字节的 STATE 不存在），而人会以为设过了。
  // `null` 不在这里：它按本仓库的既有语义 = "没写这个字段"（用默认值），不是坏值。
  for (const bogus of [8, '8192', 0, -1, 1.5, 64 * 1024 + 1]) {
    await writeRawConfig(dir, { persona: { stateBudgetBytes: bogus } });
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => err instanceof ConfigError && /stateBudgetBytes/u.test((err as Error).message),
      `${JSON.stringify(bogus)} 不是合法预算，应当场报错`,
    );
  }

  // 没写这个字段 = 默认值（缺字段补默认，不是"缺失即关掉提醒"）
  await writeRawConfig(dir, { persona: { owner: 'someone' } });
  assert.equal((await loadConfig(dir)).config.persona.stateBudgetBytes, DEFAULT_STATE_BUDGET_BYTES);
});

/**
 * Irmia Agent — 本地密钥存储（`<dataDir>/.keys.json`）
 *
 * 为什么要有它：operations.md §1 的密钥教义是「密钥不落配置文件」——`config.json` 里只写
 * 环境变量**名**，值只放进程环境。纯命令行场景下这条纪律够用，但「在界面上填一次 key 就生效」
 * 要求人能在前端写入密钥，而前端没有能力往**别的进程的环境变量**里塞值。于是开第二个位置：
 * `data/.keys.json`（点前缀 = 一眼看出它不该进版本库；`data/` 已在 .gitignore 里）。
 *
 * 读取链（唯一入口 `resolveKey`，全进程只有这一处解释优先级）：
 *
 *     环境变量（按 envName 查）  >  `data/.keys.json`  >  null（未配置）
 *
 * 环境变量优先是刻意的：容器/CI/临时覆盖靠它，且「环境里显式设了值」永远压过文件里的历史值。
 * 反过来，界面写入永远不会悄悄遮蔽环境变量——它只是补上一个「没有环境变量时的默认值」。
 *
 * 三条不变量：
 *   ① 值永不回显：对外只给 `maskKey()` 的掩码（`sk-…1234`）与 configured 布尔，谁都拿不到全值；
 *   ② 值与配置解耦：本模块**不读 config.ts**（反过来 config.ts 读它），不存在循环依赖；
 *   ③ 写盘原子：同目录 tmp → fsync → rename（与 config.ts 的统一写盘规则同源）。
 *
 * 读为什么是同步的：读取点就在「真正发起调用的一瞬间」（`readApiKey` 是同步函数，main.ts 与
 * 模型层按同步帧用它）。文件极小、频率极低，同步读盘代价可忽略；写是异步的（界面路径上不阻塞）。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ──────────────────────────────── 常量与类型 ────────────────────────────────

/** 密钥文件名：`<dataDir>/.keys.json` */
export const KEYS_FILE_NAME = '.keys.json';

/**
 * 受管的键名全集。**顺序即文件里的键序**（写回时按它排列，diff 干净、人可读）。
 * 与 `config.json` 的 `apiKeyEnv` / `appIdEnv` / `clientSecretEnv` / `tokenEnv` 一一对应：
 * 那些字段说「环境变量叫什么」，这里存「没有环境变量时用什么值」。
 */
export const KEY_NAMES = ['heavy', 'light', 'qqAppId', 'qqClientSecret', 'onebotToken'] as const;

export type KeyName = (typeof KEY_NAMES)[number];

/**
 * 每个键的**默认**环境变量名。之所以是「默认」：键对应的环境变量名可在配置里改
 * （`models.heavy.apiKeyEnv` / `channels.*.appIdEnv` …），此时以配置里的名字为准，
 * 本表只提供缺省值。light 有独立名字：单 key 场景下它与 heavy 都回落到 `IRMIA_API_KEY`，
 * 而 `models.light.apiKeyEnv` 缺省也指向同名环境变量，两条路都通。
 */
export const KEY_ENV: Record<KeyName, string> = {
  heavy: 'IRMIA_API_KEY',
  light: 'IRMIA_LIGHT_API_KEY',
  qqAppId: 'QQ_BOT_APP_ID',
  qqClientSecret: 'QQ_BOT_CLIENT_SECRET',
  onebotToken: 'ONEBOT_ACCESS_TOKEN',
};

/** 密钥文档：只认识受管键名；文件里出现别的键一律忽略（不猜、不报错） */
export type KeysDocument = Partial<Record<KeyName, string>>;

/** 环境变量表（测试可注入；缺省 `process.env`） */
export type KeyEnv = Record<string, string | undefined>;

/** 值的来源：环境变量 / 本地文件 */
export type KeySource = 'env' | 'file';

/** 掩码的最短长度：短于此值一律整体打码（见 `maskKey`） */
const MASK_MIN_LENGTH = 8;

/** 键名收窄：来自 HTTP 请求体的任何值都要先过它 */
export function isKeyName(value: unknown): value is KeyName {
  return typeof value === 'string' && (KEY_NAMES as readonly string[]).includes(value);
}

/** `data/.keys.json` 的绝对路径 */
export function keysPath(dataDir: string): string {
  return join(resolve(dataDir), KEYS_FILE_NAME);
}

// ──────────────────────────────── 掩码 ────────────────────────────────

/**
 * 掩码：`sk-abcdef1234` → `sk-…1234`（保留前 3 与后 4，中间省略）。
 * 短于 8 位一律整体打码为 `…`：再短的串上「前 3 后 4」等于把原文还回去，
 * 而掩码的全部意义就是**掩完之后不等于原文**。
 */
export function maskKey(value: string): string {
  const text = value.trim();
  if (text.length < MASK_MIN_LENGTH) return '…';
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

// ──────────────────────────────── 读 ────────────────────────────────

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * 解析密钥文档。**宽容失败**是刻意的、也只在这里：文件不存在 / 不是合法 JSON / 顶层不是对象
 * 一律当「未配置」，而不是抛错——密钥文件坏了不该让进程起不来。配置文件的严格校验是另一回事：
 * 那里静默回退会造出「看起来生效其实没生效」的隐形故障，而这里「未配置」是个诚实的已知状态，
 * 界面上直接显示「未配置」，人重填一次即可；写路径永远整体覆盖，坏的残留不会传染。
 */
function parseKeysDocument(text: string): KeysDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const doc = raw as Record<string, unknown>;
  const out: KeysDocument = {};
  for (const name of KEY_NAMES) {
    const value = nonEmpty(typeof doc[name] === 'string' ? (doc[name] as string) : undefined);
    if (value !== null) out[name] = value;
  }
  return out;
}

/**
 * 读整份密钥文档。文件缺失（或读不到）→ `{}`。返回的是新对象，调用方改它不影响任何内部状态。
 */
export function loadKeysFile(dataDir: string): KeysDocument {
  let text: string;
  try {
    text = readFileSync(keysPath(dataDir), 'utf8');
  } catch {
    return {};
  }
  return parseKeysDocument(text);
}

/** 读一个键的**文件值**（不看环境变量）。未配置返回 null。 */
export function readKeyFile(dataDir: string, name: KeyName): string | null {
  return loadKeysFile(dataDir)[name] ?? null;
}

export interface ResolveKeyOptions {
  /** 环境变量表；缺省 `process.env` */
  env?: KeyEnv | undefined;
  /** 该键对应的环境变量名；缺省 `KEY_ENV[name]`（配置里改过名字时由调用方传进来） */
  envName?: string | undefined;
}

/**
 * **唯一**的密钥取值入口：环境变量（按 envName 查）优先 > `data/.keys.json`。
 * 未配置返回 null，由调用方决定是报错、降级还是提示用户去配。
 *
 * `dataDir` 传 null = 只看环境变量；`name` 传 null = 只知道环境变量名、不认文件里的键
 * （给「配置里写了个自定义变量名」这类调用点留的直路）。
 */
export function resolveKey(
  dataDir: string | null,
  name: KeyName | null,
  options: ResolveKeyOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const envName = options.envName ?? (name === null ? null : KEY_ENV[name]);

  if (envName !== null) {
    const fromEnv = nonEmpty(env[envName]);
    if (fromEnv !== null) return fromEnv;
  }
  if (dataDir === null || name === null) return null;
  return readKeyFile(dataDir, name);
}

export interface KeyStatus {
  /** 该键当前是否可用（环境变量或文件里有一个非空值） */
  configured: boolean;
  /** 掩码（`sk-…1234` 形态）；未配置为 null。**永远不是全值** */
  mask: string | null;
  /** 值来自哪里；未配置为 null（界面据此说清「是环境变量给的还是这里填的」） */
  source: KeySource | null;
  /** 该键对应的环境变量名（值从环境来时的查表键，也是界面提示语的一部分） */
  envName: string;
}

export interface KeyStatusOptions extends ResolveKeyOptions {
  /** 数据目录；缺省只看环境变量（服务端会显式传 `<dataDir>`） */
  dataDir?: string | null | undefined;
}

/** 状态视图（界面用）：configured + 掩码 + 来源，**不含值** */
export function keyStatus(name: KeyName, options: KeyStatusOptions = {}): KeyStatus {
  const env = options.env ?? process.env;
  const envName = options.envName ?? KEY_ENV[name];
  const dataDir = options.dataDir ?? null;

  const fromEnv = nonEmpty(env[envName]);
  if (fromEnv !== null) {
    return { configured: true, mask: maskKey(fromEnv), source: 'env', envName };
  }

  const fromFile = dataDir === null ? null : readKeyFile(dataDir, name);
  if (fromFile !== null) {
    return { configured: true, mask: maskKey(fromFile), source: 'file', envName };
  }
  return { configured: false, mask: null, source: null, envName };
}

// ──────────────────────────────── 写 ────────────────────────────────

/** 原子写：同目录 tmp → fsync → rename 覆盖（与 config.ts 的统一写盘规则同源） */
let tmpSeq = 0;

async function writeKeysFileAtomic(path: string, text: string): Promise<void> {
  // pid + 序号：同进程并发写各自有独立 tmp，最后 rename 的都是完整内容
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq++}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp 残留不影响正确性：它的名字唯一，下一次写不会撞上 */
    }
    throw err;
  }
}

/**
 * 写一个键：整份文档「读出来 → 改一个键 → 按 `KEY_NAMES` 顺序写回」——
 * 别人的键与顺序都不动，没有局部写、没有半截文件。
 *
 * `value` 为**空串或纯空白 = 清除**该键。清除时若一个键都不剩，**保留一个 `{}` 文件**：
 * 文件在不在是「这台机器配过密钥」的可观测痕迹，也让下一次写入的路径只有一条。
 * 目录不存在则创建（首次配置时 `data/` 可能还没被别的东西建出来）。
 */
export async function writeKeyFile(dataDir: string, name: KeyName, value: string): Promise<void> {
  const dir = resolve(dataDir);
  const path = keysPath(dir);
  const current = loadKeysFile(dir);
  const incoming = value.trim();

  if ((current[name] ?? '') === incoming) return; // 没变就不落盘：不留无意义的 mtime 抖动

  const merged: KeysDocument = {};
  for (const key of KEY_NAMES) {
    const existing = key === name ? undefined : current[key];
    if (existing !== undefined) merged[key] = existing;
  }
  if (incoming !== '') merged[name] = incoming;

  // 固定键序写回：文件里的排列与 KEY_NAMES 一致，diff 里看不出「谁先配的」
  const ordered: Record<string, string> = {};
  for (const key of KEY_NAMES) {
    const existing = merged[key];
    if (existing !== undefined) ordered[key] = existing;
  }

  mkdirSync(dir, { recursive: true });
  await writeKeysFileAtomic(path, `${JSON.stringify(ordered, null, 2)}\n`);
}

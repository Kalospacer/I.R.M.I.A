/**
 * Irmia Agent — 大结果 blob 存储（docs/schema.md §4 / §11、docs/design.md §4.12）
 *
 * `data/blobs/<sha256>` 是**内容寻址**的大工具结果外置区，三条性质：
 *   1. **天然去重**：文件名即内容哈希，同一内容永远只落一份；
 *   2. **不可变**：同名必然同内容，命中已有文件即跳过，永不原地改写；
 *   3. **不可删**：它是 `events/` 之外唯一无法从日志重建的数据（operations.md §4），
 *      备份面 = `events/` + `blobs/` + `persona/` + `config.toml`。
 *
 * 阈值口径（schema §4 的字段注释）：估算 token 超阈值才外置，事件的 `content` 只留头部预览，
 * 全文靠 `contentRef.blobId` 取回（模型侧用 `read_blob` 工具分页读，见 tools/fs/read-tools.ts）。
 * token 估算走**字符启发式**（ASCII 4 字符 ≈ 1 token，非 ASCII 1 字符 ≈ 1 token）：
 * 宁可估不准也不引入 tokenizer 依赖，且这条口径只用于"要不要外置"，不参与预算记账。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ──────────────────────────────── 常量 ────────────────────────────────

/** blob 根目录名；read_blob 工具按它定位（唯一定义点，工具层从这里导入，避免两处口径漂移） */
export const BLOB_DIR_NAME = 'blobs';
/** blobId 形状：sha256 的小写十六进制。写入端与读取端共用同一条判据 */
export const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/u;
/** 默认外置阈值：估算 8k token（schema §4「超过 blob 阈值（默认估算 8k token）」） */
export const DEFAULT_BLOB_THRESHOLD_TOKENS = 8000;
/** 默认头部预览长度：2000 字符 */
export const DEFAULT_BLOB_PREVIEW_CHARS = 2000;
/** ASCII 字符折算 token 的除数：英文经验值约 4 字符/token */
const ASCII_CHARS_PER_TOKEN = 4;

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface BlobWriteResult {
  /** 内容哈希（64 位小写十六进制），即 data/blobs/ 下的文件名 */
  blobId: string;
  /** 内容字节数（UTF-8）。它是 `contentRef.bytes` 的来源，与字符数不是一回事 */
  bytes: number;
  /** true = 命中已有文件，本次没有写盘（去重生效） */
  deduped: boolean;
}

/**
 * 大结果外置选项。`agent-loop` 的 `blobOffload` 直接用它，两个阈值都可覆盖：
 * 测试要低成本构造"超大结果"，生产要按模型上下文窗口调。
 */
export interface BlobOffloadOptions {
  /** 数据根目录：blob 落在 <dataDir>/blobs/ */
  dataDir: string;
  /** 外置阈值（估算 token），默认 DEFAULT_BLOB_THRESHOLD_TOKENS */
  thresholdTokens?: number;
  /** 头部预览字符数，默认 DEFAULT_BLOB_PREVIEW_CHARS */
  previewChars?: number;
}

/** 外置结果：`contentRef` 存在即表示"事件的 content 只是预览" */
export interface BlobOffloadOutcome {
  content: string;
  contentRef?: { blobId: string; bytes: number };
}

/** 测试与宿主注入点：默认全部走 node: 标准库的真实实现 */
export interface BlobStoreDeps {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  /** 目标不存在返回 null（外置路径的正常分支，不是异常） */
  statOrNull(path: string): Promise<{ size: number } | null>;
  /** 以 wx 排他创建 tmp 并写入；绝不覆盖任何已有文件 */
  createExclusive(path: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  readFile(path: string): Promise<Buffer>;
}

// ──────────────────────────────── 默认依赖 ────────────────────────────────

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultDeps: BlobStoreDeps = {
  mkdir: async (path, options) => mkdir(path, options),
  statOrNull: async (path) => {
    try {
      const info = await stat(path);
      return { size: info.size };
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      throw err;
    }
  },
  createExclusive: async (path, data) => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(data);
      // 先让数据落盘再 rename：否则存在「名字已就位、内容仍在页缓存」的窗口
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  rm: async (path, options) => {
    await rm(path, { force: options?.force ?? false });
  },
  readFile: (path) => readFile(path),
};

/** tmp 文件名的进程内唯一序号：同进程并发写不会互相踩到对方的 tmp */
let tmpSeq = 0;

// ──────────────────────────────── 阈值判定 ────────────────────────────────

/**
 * token 估算（字符启发式）：ASCII 按 4 字符/token，非 ASCII（CJK 等）按 1 字符/token。
 * 按**码点**迭代，代理对（emoji 等）算一个字符，不会被截成半个。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide;
}

// ──────────────────────────────── 路径与哈希 ────────────────────────────────

/** blob 根目录：<dataDir>/blobs */
export function blobDirOf(dataDir: string): string {
  return join(dataDir, BLOB_DIR_NAME);
}

/** 内容的 sha256 十六进制（blobId 的唯一计算点） */
export function blobIdOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** blob 的绝对路径。blobId 必须已校验（见 BLOB_ID_PATTERN） */
export function blobPathOf(dataDir: string, blobId: string): string {
  return join(blobDirOf(dataDir), blobId);
}

// ──────────────────────────────── 写入 ────────────────────────────────

/**
 * 内容寻址写。返回 `{ blobId, bytes, deduped }`：
 *   - 目标已存在 → `deduped: true`，一个字节都不写（这就是"天然去重"）；
 *   - 不存在 → 写 `blobs/<blobId>.tmp.<pid>.<n>` 再 rename 到最终名字：
 *     内容哈希做文件名，rename 到已存在目标只会覆盖成本内容相同的文件，永远安全。
 *
 * `bytes` 恒为传入内容的 UTF-8 字节数（不取盘上文件大小）：若盘上同名文件被外部改写，
 * 那是 doctor 的完整性检查该报的事（operations.md §6），这里不修补、不静默采信坏内容。
 * 写盘失败**会抛出**：外置失败必须让调用方看见，否则全文就丢了。
 */
export async function writeBlob(
  dataDir: string,
  content: string | Buffer,
  deps: Partial<BlobStoreDeps> = {},
): Promise<BlobWriteResult> {
  const d: BlobStoreDeps = { ...defaultDeps, ...deps };
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const blobId = blobIdOf(buf);
  const bytes = buf.byteLength;
  const dir = blobDirOf(dataDir);
  const path = join(dir, blobId);

  await d.mkdir(dir, { recursive: true });

  const existing = await d.statOrNull(path);
  if (existing !== null) return { blobId, bytes, deduped: true };

  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;
  try {
    await d.createExclusive(tmp, buf);
    await d.rename(tmp, path);
  } catch (err) {
    try {
      await d.rm(tmp, { force: true });
    } catch {
      /* tmp 清理失败不留痕：下一次写入用新名字重建 */
    }
    throw new Error(`写入 blob ${path} 失败：${toErrorMessage(err)}`);
  }
  return { blobId, bytes, deduped: false };
}

// ──────────────────────────────── 读取 ────────────────────────────────

/**
 * 按 blobId 读全文。模型侧读全文走 `read_blob` 工具（带分页与白名单），
 * 这里给的是库内路径：doctor 的引用完整性检查、测试断言、复盘脚本用。
 */
export async function readBlob(
  dataDir: string,
  blobId: string,
  deps: Partial<Pick<BlobStoreDeps, 'readFile'>> = {},
): Promise<Buffer> {
  if (!BLOB_ID_PATTERN.test(blobId)) {
    throw new Error(`blobId 必须是 64 位小写十六进制 sha256，收到 ${blobId}`);
  }
  const d = { readFile: deps.readFile ?? defaultDeps.readFile };
  const path = blobPathOf(dataDir, blobId);
  try {
    return await d.readFile(path);
  } catch (err) {
    if (hasCode(err, 'ENOENT')) {
      throw new Error(`blob 不存在：${path}（blobs/ 是不可删目录，缺失说明它被删或被换过机器）`);
    }
    throw new Error(`读取 blob ${path} 失败：${toErrorMessage(err)}`);
  }
}

/** blob 是否存在（doctor 检查一条 contentRef 是否还能取回全文时用） */
export async function blobExists(
  dataDir: string,
  blobId: string,
  deps: Partial<Pick<BlobStoreDeps, 'statOrNull'>> = {},
): Promise<boolean> {
  if (!BLOB_ID_PATTERN.test(blobId)) return false;
  const d = { statOrNull: deps.statOrNull ?? defaultDeps.statOrNull };
  return (await d.statOrNull(blobPathOf(dataDir, blobId))) !== null;
}

// ──────────────────────────────── 外置判定 ────────────────────────────────

/**
 * 超阈值则外置：写 blob（先落盘，再返回预览）。**调用方必须先把事件写完再继续**——
 * `tool/result` 事件里只有预览，blob 没落盘就写事件等于丢全文。
 *
 * 返回的 `content` 是纯粹的头部切片（不加省略号装饰）：补"去哪里取全文"的提示是
 * 渲染层的事（model/render.ts 会在预览后追加 `[完整结果 N 字节，可用 read_blob 取：id]`），
 * 两处都加就会出现重复提示。
 */
export async function offloadIfLarge(
  content: string,
  options: BlobOffloadOptions,
  deps: Partial<BlobStoreDeps> = {},
): Promise<BlobOffloadOutcome> {
  const threshold = options.thresholdTokens ?? DEFAULT_BLOB_THRESHOLD_TOKENS;
  if (estimateTokens(content) <= Math.max(0, threshold)) return { content };

  const written = await writeBlob(options.dataDir, content, deps);
  const previewChars = Math.max(0, Math.trunc(options.previewChars ?? DEFAULT_BLOB_PREVIEW_CHARS));
  return {
    content: content.slice(0, previewChars),
    contentRef: { blobId: written.blobId, bytes: written.bytes },
  };
}

/**
 * Irmia Agent — 事件日志（系统唯一真相源）
 *
 * 设计依据：design.md §4.1 / §4.7、schema.md §1 / §9 / §11 / §12、review.md 缺陷 1 与缺陷 8。
 * 职责边界：本模块只负责"字节级持久化 + 位置检索 + 末行自愈"，
 * 不理解事件语义——哪个事件属于承诺类，由调用方通过 append 的 sync 显式声明（见 review.md 缺陷 1）。
 */

import {
  closeSync,
  createReadStream,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AppEvent, EventEnvelope } from './types.js';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface AppendOptions {
  /**
   * true = 承诺类事件：write + fsync 完成后才返回，调用方随后的动作才允许改变外部世界；
   * false = 观测类事件：先进内存缓冲，由 flush() 在 step 边界统一落盘。
   */
  sync: boolean;
}

export interface EventLogOpenOptions {
  /** 单分片字节上限，默认 32MB。调小是为了让测试能低成本触发轮转 */
  shardMaxBytes?: number;
  /** 稀疏索引步长：每 N 条事件一个检查点，默认 1000 */
  indexStride?: number;
}

/** 末行自愈的结果，供调用方写 `log/repaired` 事件 */
export interface LogRepair {
  /** 被截断的分片文件名 */
  file: string;
  /** 截掉的字节数（写了一半的尾行） */
  truncatedBytes: number;
  /** 修复后日志中最后一条完整事件的 seq */
  lastGoodSeq: number;
}

// ──────────────────────────────── 常量 ────────────────────────────────

export const DEFAULT_SHARD_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_INDEX_STRIDE = 1000;

/** 启动扫描的读取块 */
const SCAN_CHUNK_BYTES = 1 << 20;
/** 随机访问的读取块：一次读满整个检查点区间（1000 条 ≈ 200KB），避免多次 readSync */
const READ_CHUNK_BYTES = 1 << 18;
/** 缓冲兜底上限：调用方长期不 flush 时自动落盘，避免内存无界 */
const BUFFER_FLUSH_BYTES = 8 * 1024 * 1024;
const SHARD_NAME_RE = /^(\d{12})\.jsonl$/;
const NEWLINE = 0x0a;
/** 与 serializeEvent 的字段顺序绑定：只匹配顶层首个字段，因此读出的 seq 一定是真值 */
const FAST_SEQ_RE = /^\{"seq":(\d+),/;

// ──────────────────────────────── 内部结构 ────────────────────────────────

interface Checkpoint {
  seq: number;
  offset: number;
}

interface Shard {
  readonly file: string;
  readonly path: string;
  /** 分片首条事件的 seq，等于文件名中的数字 */
  readonly startSeq: number;
  /** 已写入字节数（= 最后一条完整行的结束偏移） */
  bytes: number;
  /** 已写入事件条数 */
  lines: number;
  readonly checkpoints: Checkpoint[];
}

interface LogLine {
  seq: number;
  line: string;
}

function shardFileName(startSeq: number): string {
  return `${String(startSeq).padStart(12, '0')}.jsonl`;
}

/**
 * 逐块切分完整行。按 0x0A 字节切分是安全的：UTF-8 续字节均 >= 0x80，不会与换行冲突，
 * 因此多字节字符跨块也不会切错行，且行起始偏移始终是精确字节偏移。
 */
class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);
  private pendingStart = 0;

  /** chunkStart 是该块在文件中的起始字节偏移；回调返回 false 表示已满足条件，剩余字节不再处理 */
  push(chunk: Buffer, chunkStart: number, onLine: (text: string, start: number) => boolean | void): boolean {
    const dataStart = chunkStart - this.pending.length;
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    let cursor = 0;
    for (;;) {
      const nl = data.indexOf(NEWLINE, cursor);
      if (nl === -1) break;
      const start = dataStart + cursor;
      const text = data.toString('utf8', cursor, nl);
      cursor = nl + 1;
      if (text.length > 0 && onLine(text, start) === false) return false;
    }
    this.pending = Buffer.from(data.subarray(cursor));
    this.pendingStart = dataStart + cursor;
    return true;
  }

  /** 收尾：返回没有以换行结束的尾行（null 表示文件以换行正常结束） */
  finish(): { text: string; start: number } | null {
    if (this.pending.length === 0) return null;
    return { text: this.pending.toString('utf8'), start: this.pendingStart };
  }
}

/**
 * 日志层的结构底线校验：只确认"这是一个带 seq/ts/type 的 JSON 对象"。
 * data 的具体形状属于 schema 层职责，日志层不与 schema 演进耦合。
 */
function parseEnvelope(text: string, where: string): EventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`事件日志损坏：${where} 不是合法 JSON`, { cause });
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`事件日志损坏：${where} 不是一个 JSON 对象`);
  }
  const envelope = value as Partial<EventEnvelope>;
  if (typeof envelope.seq !== 'number' || !Number.isInteger(envelope.seq) || envelope.seq < 1) {
    throw new Error(`事件日志损坏：${where} 的 seq 不是 >= 1 的整数`);
  }
  if (typeof envelope.ts !== 'string' || typeof envelope.type !== 'string') {
    throw new Error(`事件日志损坏：${where} 缺少 ts 或 type 字段`);
  }
  return value as EventEnvelope;
}

/**
 * 序列化时固定字段顺序（seq/ts/type/data/visibility 打头）。两个收益：
 * 1. 人工 tail 时先看到时间与类型；2. get() 能用前缀正则廉价取出 seq，省掉逐行 JSON.parse。
 * 调用方塞入的额外字段保留在末尾，不静默丢弃。
 */
function serializeEvent(event: AppEvent): string {
  const source = event as unknown as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    seq: source['seq'],
    ts: source['ts'],
    type: source['type'],
    data: source['data'],
    visibility: source['visibility'],
  };
  for (const [key, value] of Object.entries(source)) {
    if (key in normalized || value === undefined) continue;
    normalized[key] = value;
  }
  return JSON.stringify(normalized);
}

/** 快速取出规范化行的首个字段 seq；不是本模块写出的行返回 null（走完整解析兜底） */
function fastSeq(text: string): number | null {
  const matched = FAST_SEQ_RE.exec(text);
  return matched === null ? null : Number(matched[1]);
}

function looksLikeEnvelope(text: string): boolean {
  try {
    parseEnvelope(text, 'probe');
    return true;
  } catch {
    return false;
  }
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，收到 ${value}`);
  }
}

interface ShardScanResult {
  shard: Shard;
  /** 本分片最后一条完整事件的 seq（空分片为 0） */
  lastSeq: number;
  /** 本分片第一条事件的 seq（空分片为 null） */
  firstSeq: number | null;
  repaired: boolean;
  truncatedBytes: number;
}

/**
 * 扫描单个分片：建检查点索引、查重复 seq、修末行。
 *
 * 坏行的判定边界（这是本模块最需要说清的一条）：
 * - 以换行结尾的完整行解析失败 → 真故障，一律抛错（拒绝启动）；
 * - 文件末尾没有换行结尾的残行解析失败 → 写一半崩了，只在最后一个分片上自愈截断；
 * - 文件末尾残行恰好是合法事件（缺尾换行）→ 补一个换行，否则下次追加会与它粘成一行。
 */
function scanShard(
  path: string,
  file: string,
  startSeq: number,
  stride: number,
  allowRepair: boolean,
  seen: Set<number>,
): ShardScanResult {
  const size = statSync(path).size;
  const checkpoints: Checkpoint[] = [];
  let lines = 0;
  let firstSeq: number | null = null;
  let lastSeq = 0;
  let end = 0;
  let truncatedBytes = 0;
  let repaired = false;

  const accept = (text: string, lineStart: number, lineEnd: number): void => {
    const envelope = parseEnvelope(text, `${file} 偏移 ${lineStart}`);
    if (seen.has(envelope.seq)) {
      throw new Error(
        `事件日志出现重复 seq ${envelope.seq}（${file} 偏移 ${lineStart}）：日志被拼接或分片重叠，拒绝启动`,
      );
    }
    seen.add(envelope.seq);
    // 每 stride 条一个检查点，检查点必须落在行首，get() 才能从它开始顺序扫
    if (lines % stride === 0) checkpoints.push({ seq: envelope.seq, offset: lineStart });
    if (firstSeq === null) firstSeq = envelope.seq;
    lines += 1;
    lastSeq = envelope.seq;
    end = lineEnd;
  };

  const splitter = new LineSplitter();
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
  try {
    let readPos = 0;
    while (readPos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - readPos), readPos);
      if (n <= 0) break;
      splitter.push(buf.subarray(0, n), readPos, (text, start) => {
        accept(text, start, start + Buffer.byteLength(text) + 1);
      });
      readPos += n;
    }
  } finally {
    closeSync(fd);
  }

  const tail = splitter.finish();
  if (tail !== null) {
    if (looksLikeEnvelope(tail.text)) {
      const appendFd = openSync(path, 'a');
      try {
        writeFileSync(appendFd, '\n');
        fsyncSync(appendFd);
      } finally {
        closeSync(appendFd);
      }
      accept(tail.text, tail.start, tail.start + Buffer.byteLength(tail.text) + 1);
    } else if (allowRepair) {
      const truncateFd = openSync(path, 'r+');
      try {
        ftruncateSync(truncateFd, end);
        fsyncSync(truncateFd);
      } finally {
        closeSync(truncateFd);
      }
      truncatedBytes = size - end;
      repaired = true;
    } else {
      throw new Error(
        `事件日志损坏：${file} 末尾的残行不完整，但它不是最后一个分片（中间位置的坏行属于真故障）`,
      );
    }
  }

  return {
    shard: { file, path, startSeq, bytes: end, lines, checkpoints },
    lastSeq,
    firstSeq,
    repaired,
    truncatedBytes,
  };
}

// ──────────────────────────────── 主类 ────────────────────────────────

export class EventLog {
  readonly dir: string;
  /** 本次启动的末行修复记录；无修复为 null。调用方据此写 log/repaired 事件 */
  readonly repair: LogRepair | null;

  private readonly shardMaxBytes: number;
  private readonly indexStride: number;
  private readonly shards: Shard[];
  /** 随机访问复用的只读 fd，避免每次 get() 都 open/close */
  private readonly readFds = new Map<string, number>();
  /** 随机访问复用的读缓冲：避免每次 get() 重新分配并清零 256KB */
  private readonly readChunk = Buffer.alloc(READ_CHUNK_BYTES);
  /** 活动分片延迟创建：重启后不写就不产生空分片文件 */
  private shard: Shard | null = null;
  private fd = -1;
  private closed = false;
  private allocatedSeq: number;
  private lastAppendedSeq: number;
  private buffer: LogLine[] = [];
  private bufferBytes = 0;

  private constructor(
    dir: string,
    shardMaxBytes: number,
    indexStride: number,
    shards: Shard[],
    maxSeq: number,
    repair: LogRepair | null,
  ) {
    this.dir = dir;
    this.shardMaxBytes = shardMaxBytes;
    this.indexStride = indexStride;
    this.shards = shards;
    this.repair = repair;
    this.allocatedSeq = maxSeq;
    this.lastAppendedSeq = maxSeq;
  }

  /**
   * 打开事件日志：建分片索引、找最大 seq、修末行。
   * 任何"真故障"（中间坏行、重复 seq、分片被改写）都在这里抛错，拒绝启动。
   */
  static async open(dir: string, options: EventLogOpenOptions = {}): Promise<EventLog> {
    const shardMaxBytes = options.shardMaxBytes ?? DEFAULT_SHARD_MAX_BYTES;
    const indexStride = options.indexStride ?? DEFAULT_INDEX_STRIDE;
    assertPositiveInt(shardMaxBytes, 'shardMaxBytes');
    assertPositiveInt(indexStride, 'indexStride');

    mkdirSync(dir, { recursive: true });

    // 文件名定宽 12 位，字典序即数值序
    const names = readdirSync(dir)
      .filter((name) => SHARD_NAME_RE.test(name))
      .sort();

    const seen = new Set<number>();
    const shards: Shard[] = [];
    let maxSeq = 0;
    let repair: LogRepair | null = null;

    for (let i = 0; i < names.length; i++) {
      const file = names[i]!;
      const startSeq = Number(SHARD_NAME_RE.exec(file)![1]!);
      const scan = scanShard(
        join(dir, file),
        file,
        startSeq,
        indexStride,
        i === names.length - 1,
        seen,
      );
      if (scan.firstSeq !== null && scan.firstSeq !== startSeq) {
        throw new Error(
          `分片 ${file} 的首条事件 seq 为 ${scan.firstSeq}，与文件名不符：日志被外部拼接或改写，拒绝启动`,
        );
      }
      shards.push(scan.shard);
      if (scan.lastSeq > maxSeq) maxSeq = scan.lastSeq;
      if (scan.repaired) {
        repair = { file, truncatedBytes: scan.truncatedBytes, lastGoodSeq: scan.lastSeq };
      }
    }

    // 轮转只可能让"末尾"分片为空（新片建好但首条没写完就崩），中部空片意味着分片序列被破坏
    for (let i = 0; i < shards.length - 1; i++) {
      const shard = shards[i]!;
      if (shard.lines === 0) {
        throw new Error(`分片 ${shard.file} 为空且不是最后一个分片：分片序列被破坏，拒绝启动`);
      }
    }

    return new EventLog(dir, shardMaxBytes, indexStride, shards, maxSeq, repair);
  }

  /** 当前所有分片文件名（按 seq 升序），用于诊断与测试 */
  get shardFiles(): readonly string[] {
    return this.shards.map((shard) => shard.file);
  }

  /** 已 append 的最大 seq（含尚在缓冲中的事件） */
  latestSeq(): number {
    return this.lastAppendedSeq;
  }

  /** 未落盘的缓冲条数 */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * 分配下一个 seq：内存计数 = 日志最大 seq + 1，分配即消耗。
   * 分配后若该事件最终没写成（进程崩溃），就留下一个空洞——这是允许的（schema §12 不变量 1）。
   */
  nextSeq(): number {
    this.assertOpen();
    this.allocatedSeq += 1;
    return this.allocatedSeq;
  }

  append(event: AppEvent, options: AppendOptions): void {
    this.assertOpen();
    const seq = event.seq;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(`事件 seq 必须是 >= 1 的整数，收到 ${seq}`);
    }
    if (seq <= this.lastAppendedSeq) {
      throw new Error(`事件 seq 必须严格递增：收到 ${seq}，日志中已有 ${this.lastAppendedSeq}`);
    }
    let json: string;
    try {
      json = serializeEvent(event);
    } catch (cause) {
      throw new Error(`事件无法序列化为 JSON：${event.type}`, { cause });
    }

    const entry: LogLine = { seq, line: `${json}\n` };
    if (options.sync) {
      // 承诺类：先把观测类缓冲落盘，保证文件内行序恒等于 seq 升序，再单独 fsync 本条。
      // 返回时该事件已在磁盘上，"写入后才允许改变外部世界"由此成立。
      this.flushBuffer();
      this.writeEntry(entry, true);
    } else {
      this.buffer.push(entry);
      this.bufferBytes += Buffer.byteLength(entry.line);
      if (this.bufferBytes >= BUFFER_FLUSH_BYTES) this.flushBuffer();
    }
    this.lastAppendedSeq = seq;
  }

  /** 把内存缓冲统一落盘（观测类事件的 step 边界调用） */
  flush(): void {
    this.assertOpen();
    this.flushBuffer();
  }

  /**
   * 按 seq 随机读取。不存在的 seq（崩溃留下的空洞、已删除的行）返回 null。
   * 路径：缓冲 → 分片二分 → 该片检查点二分 → 从检查点顺序扫，最多扫 indexStride 条。
   */
  get(seq: number): AppEvent | null {
    this.assertOpen();
    if (!Number.isInteger(seq) || seq < 1) return null;

    const buffered = this.findBuffered(seq);
    if (buffered !== null) return parseEnvelope(buffered.line, `内存缓冲 seq ${seq}`) as AppEvent;

    const index = this.shardIndexFor(seq);
    if (index < 0) return null;
    const shard = this.shards[index]!;
    if (shard.lines === 0) return null;

    const checkpoint = lastCheckpointAtOrBefore(shard.checkpoints, seq);
    return this.scanShardForSeq(shard, checkpoint === null ? 0 : checkpoint.offset, seq);
  }

  /** 全量流式读取：按分片、按行读，不整份入内存 */
  async *readAll(): AsyncIterableIterator<AppEvent> {
    this.assertOpen();
    this.flushBuffer();
    for (const shard of this.shards) {
      if (shard.lines === 0) continue;
      yield* this.readShardLines(shard, 0);
    }
  }

  /** 从 fromSeq 起流式读取：定位到分片与检查点后顺序扫，不从头全读 */
  async *readRange(fromSeq: number): AsyncIterableIterator<AppEvent> {
    this.assertOpen();
    if (!Number.isInteger(fromSeq) || fromSeq < 1) {
      throw new Error(`readRange 的 fromSeq 必须是 >= 1 的整数，收到 ${fromSeq}`);
    }
    this.flushBuffer();

    const start = Math.max(this.shardIndexFor(fromSeq), 0);
    for (let i = start; i < this.shards.length; i++) {
      const shard = this.shards[i]!;
      if (shard.lines === 0) continue;
      let offset = 0;
      if (i === start) {
        const checkpoint = lastCheckpointAtOrBefore(shard.checkpoints, fromSeq);
        offset = checkpoint === null ? 0 : checkpoint.offset;
      }
      for await (const event of this.readShardLines(shard, offset)) {
        if (event.seq >= fromSeq) yield event;
      }
    }
  }

  /** 落盘缓冲、关闭所有 fd。关闭后任何写操作抛错 */
  close(): void {
    if (this.closed) return;
    this.flushBuffer();
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
    for (const fd of this.readFds.values()) closeSync(fd);
    this.readFds.clear();
    this.closed = true;
  }

  // ──────────────────────────────── 写路径 ────────────────────────────────

  /** 取得（必要时创建）活动分片。末尾若是崩溃留下的空分片则复用它 */
  private ensureActiveShard(nextSeq: number): Shard {
    if (this.fd >= 0 && this.shard !== null) return this.shard;
    const last = this.shards[this.shards.length - 1];
    if (last !== undefined && last.lines === 0 && last.startSeq === nextSeq) {
      const fd = openSync(last.path, 'a');
      this.shard = last;
      this.fd = fd;
      return last;
    }
    const created = this.makeShard(nextSeq);
    const fd = this.openNewShard(created);
    this.insertShard(created);
    this.shard = created;
    this.fd = fd;
    return created;
  }

  /**
   * 唯一写入点：轮转判定与执行、检查点记录、实际写盘都在这里，三者不可能错位。
   */
  private writeEntry(entry: LogLine, sync: boolean): void {
    const bytes = Buffer.byteLength(entry.line);
    let shard = this.ensureActiveShard(entry.seq);
    // 空分片永不轮转，否则单条超限时会死循环；单条超大事件独占一个分片
    if (shard.lines > 0 && shard.bytes + bytes > this.shardMaxBytes) {
      shard = this.rotate(entry.seq);
    }
    if (shard.lines % this.indexStride === 0) {
      shard.checkpoints.push({ seq: entry.seq, offset: shard.bytes });
    }
    writeFileSync(this.fd, entry.line);
    if (sync) fsyncSync(this.fd);
    shard.bytes += bytes;
    shard.lines += 1;
  }

  private rotate(nextSeq: number): Shard {
    const previousFd = this.fd;
    const shard = this.makeShard(nextSeq);
    const fd = this.openNewShard(shard);
    this.insertShard(shard);
    this.shard = shard;
    this.fd = fd;
    closeSync(previousFd);
    return shard;
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    for (const entry of pending) this.writeEntry(entry, false);
  }

  private makeShard(startSeq: number): Shard {
    const file = shardFileName(startSeq);
    return { file, path: join(this.dir, file), startSeq, bytes: 0, lines: 0, checkpoints: [] };
  }

  /** 用 O_EXCL 创建：分片文件名必须唯一，撞名说明分片被外部改写 */
  private openNewShard(shard: Shard): number {
    try {
      return openSync(shard.path, 'ax');
    } catch (cause) {
      throw new Error(`无法创建分片 ${shard.file}：文件已存在或不可写`, { cause });
    }
  }

  private insertShard(shard: Shard): void {
    const at = this.shards.findIndex((existing) => existing.startSeq > shard.startSeq);
    if (at === -1) this.shards.push(shard);
    else this.shards.splice(at, 0, shard);
  }

  // ──────────────────────────────── 读路径 ────────────────────────────────

  private async *readShardLines(shard: Shard, fromOffset: number): AsyncGenerator<AppEvent> {
    const size = shard.bytes;
    if (fromOffset >= size) return;
    const stream = createReadStream(shard.path, { start: fromOffset, end: size - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length === 0) continue;
        yield parseEnvelope(line, `${shard.file} 流式读取`) as AppEvent;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private fdForRead(path: string): number {
    const cached = this.readFds.get(path);
    if (cached !== undefined) return cached;
    const fd = openSync(path, 'r');
    this.readFds.set(path, fd);
    return fd;
  }

  private scanShardForSeq(shard: Shard, fromOffset: number, target: number): AppEvent | null {
    const fd = this.fdForRead(shard.path);
    const buf = this.readChunk;
    const splitter = new LineSplitter();
    let hit: AppEvent | null = null;
    let passed = false;

    const onLine = (text: string, start: number): boolean => {
      const hint = fastSeq(text);
      if (hint !== null) {
        // 快速路径：不解析整行，只比对首个字段
        if (hint === target) {
          hit = JSON.parse(text) as AppEvent;
          return false;
        }
        if (hint > target) {
          passed = true;
          return false;
        }
        return true;
      }
      const envelope = parseEnvelope(text, `${shard.file} 偏移 ${start}`);
      if (envelope.seq === target) {
        hit = envelope as AppEvent;
        return false;
      }
      // 文件内行序恒为 seq 升序：越过目标即说明它是空洞
      if (envelope.seq > target) {
        passed = true;
        return false;
      }
      return true;
    };

    // 命中或越过就立即停：否则会把整个分片读完（实测该项是随机访问的主要开销）
    let readPos = fromOffset;
    while (readPos < shard.bytes && hit === null && !passed) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, shard.bytes - readPos), readPos);
      if (n <= 0) break;
      if (!splitter.push(buf.subarray(0, n), readPos, onLine)) break;
      readPos += n;
    }

    if (hit === null && !passed) {
      const tail = splitter.finish();
      if (tail !== null) {
        const hint = fastSeq(tail.text);
        if (hint === target) return JSON.parse(tail.text) as AppEvent;
        if (hint === null) {
          const envelope = parseEnvelope(tail.text, `${shard.file} 尾部`);
          if (envelope.seq === target) return envelope as AppEvent;
        }
      }
    }
    return hit;
  }

  private findBuffered(seq: number): LogLine | null {
    let lo = 0;
    let hi = this.buffer.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const item = this.buffer[mid]!;
      if (item.seq === seq) return item;
      if (item.seq < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** 最大的 i 使 shards[i].startSeq <= seq；没有（seq 早于所有分片）返回 -1 */
  private shardIndexFor(seq: number): number {
    let lo = 0;
    let hi = this.shards.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.shards[mid]!.startSeq <= seq) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('事件日志已关闭');
  }
}

function lastCheckpointAtOrBefore(checkpoints: readonly Checkpoint[], seq: number): Checkpoint | null {
  let lo = 0;
  let hi = checkpoints.length - 1;
  let found: Checkpoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = checkpoints[mid]!;
    if (item.seq <= seq) {
      found = item;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

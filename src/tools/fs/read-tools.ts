/**
 * Irmia Agent — 文件系工具包：只读三件（safe_read / list_dir / read_blob）
 *
 * 三件工具都是 sideEffect none + parallel（design.md §4.18 工具清单）。
 * 只读不等于随便读，三条纪律：
 *   1. 一律先过 resolveInsideRoot 白名单（符号链接展开后再比，M4-1/M4-2）；
 *   2. 大文件不整读——按硬上限截断后如实告知，并指明下一步怎么拿（§4.18 五原则第 4 条）；
 *   3. blob 目录是第二白名单：blobId 只接受 64 位十六进制，path 只接受 blob 根内的相对路径。
 *
 * 名字是 safe_read 而不是 read_file：它与 safe_write / safe_edit / safe_rollback 是同一族
 * （devkit 原名）。v27 之前我们叫 read_file，那是移植时的漏改——同一族里三件叫 safe_*、
 * 一件不叫，模型看不出它们该配着用。
 */

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

// blob 目录名与 blobId 形状的唯一定义点在 state/blob-store.ts（写入端同源），这里只做转发
import { BLOB_DIR_NAME, BLOB_ID_PATTERN } from '../../state/blob-store.ts';
import type { FsEnv } from './env.ts';
import { resolveInsideRoot } from './path-guard.ts';
import { readDirEntries } from './search-core.ts';
import {
  decodeText,
  formatBytes,
  looksBinary,
  splitLines,
  withLineNumbers,
  type DetectedEncoding,
} from './text-codec.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  ok,
  readOptionalBool,
  readOptionalInt,
  readOptionalString,
  readString,
  toErrorMessage,
  type ToolContext,
  type ToolDefinition,
} from './types.ts';

export { BLOB_DIR_NAME, BLOB_ID_PATTERN };

/** 不设硬上限就会在无人值守时把内存吃干；超出部分靠截断 + 提示处理 */
const HARD_READ_LIMIT = 8 * 1024 * 1024;

function blobDir(env: FsEnv, ctx: ToolContext): string {
  return join(env.dataDir(ctx), BLOB_DIR_NAME);
}

type EncodingConfidence = 'certain' | 'probe' | 'fallback';

function decodeWithEncoding(
  buf: Buffer,
  requested: string | undefined,
): { text: string; encoding: DetectedEncoding; confidence: EncodingConfidence; notes: string[] } {
  if (requested === undefined || requested === 'auto') {
    const decoded = decodeText(buf);
    return { text: decoded.text, encoding: decoded.encoding, confidence: decoded.confidence, notes: decoded.notes };
  }
  const label = requested.toLowerCase();
  if (label === 'utf16be') {
    const body = buf.subarray(0, buf.length - (buf.length % 2));
    const swapped = Buffer.from(body);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', confidence: 'certain', notes: [] };
  }
  const map: Record<string, string> = {
    utf8: 'utf8',
    'utf-8': 'utf8',
    utf16le: 'utf16le',
    'utf-16le': 'utf16le',
    gbk: 'gbk',
    gb18030: 'gbk',
    latin1: 'latin1',
    binary: 'latin1',
  };
  const decoderLabel = map[label];
  if (decoderLabel === undefined) {
    const decoded = decodeText(buf);
    return {
      text: decoded.text,
      encoding: decoded.encoding,
      confidence: decoded.confidence,
      notes: [`不认识的 encoding「${requested}」，已按自动检测处理`],
    };
  }
  try {
    const text = new TextDecoder(decoderLabel).decode(buf);
    return {
      text,
      encoding: (label === 'utf-8' ? 'utf8' : label) as DetectedEncoding,
      confidence: 'certain',
      notes: [],
    };
  } catch (err) {
    return {
      text: buf.toString('utf8'),
      encoding: 'utf8',
      confidence: 'fallback',
      notes: [`按 ${requested} 解码失败（${toErrorMessage(err)}），已退回 UTF-8`],
    };
  }
}

// ──────────────────────────────── safe_read ────────────────────────────────

export function createSafeReadTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_read',
    description:
      '读取工作目录内的文本文件，**每行都带真实行号前缀**（`  12│ 内容`，safe_edit 的三种模式都认这个行号）。' +
      'offset/limit 取区间、head/tail 取两端。自动检测编码（BOM/UTF-8/GBK）。只读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作目录或绝对路径（必须在工作目录内）' },
        offset: { type: 'integer', description: '起始行号，1-based，默认 1' },
        limit: { type: 'integer', description: '最多返回多少行，默认全部（受上限保护）' },
        head: { type: 'integer', description: '只读前 N 行，与 offset/limit/tail 互斥' },
        tail: { type: 'integer', description: '只读后 N 行，与 offset/limit/head 互斥' },
        encoding: {
          type: 'string',
          enum: ['auto', 'utf8', 'utf16le', 'utf16be', 'gbk', 'latin1'],
          description: '强制指定编码，默认 auto 自动检测',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        encoding: { type: 'string' },
        total_lines: { type: 'integer' },
        shown: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_read');
      if (args === null) return invalidArgs('safe_read', '期望一个对象，例如 {"path": "src/main.ts"}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_read', '缺少 path');

      const offsetRes = readOptionalInt(args, 'offset', 1, Number.MAX_SAFE_INTEGER);
      if ('error' in offsetRes) return invalidArgs('safe_read', offsetRes.error);
      const limitRes = readOptionalInt(args, 'limit', 1, 200_000);
      if ('error' in limitRes) return invalidArgs('safe_read', limitRes.error);
      const headRes = readOptionalInt(args, 'head', 1, 200_000);
      if ('error' in headRes) return invalidArgs('safe_read', headRes.error);
      const tailRes = readOptionalInt(args, 'tail', 1, 200_000);
      if ('error' in tailRes) return invalidArgs('safe_read', tailRes.error);

      const head = headRes.value;
      const tail = tailRes.value;
      const offset = offsetRes.value;
      const limit = limitRes.value;
      if (head !== undefined && tail !== undefined) {
        return invalidArgs('safe_read', 'head 与 tail 互斥，只能给一个');
      }
      if ((head !== undefined || tail !== undefined) && (offset !== undefined || limit !== undefined)) {
        return invalidArgs('safe_read', 'head/tail 与 offset/limit 互斥；要区间就用 offset+limit，要两端就只用 head 或 tail');
      }

      const guarded = await resolveInsideRoot(ctx.workspaceRoot, pathInput, { purpose: 'safe_read' });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);

      let size = 0;
      try {
        size = (await stat(guarded.path)).size;
      } catch (err) {
        return fail(FS_ERROR_CODES.IO_ERROR, `无法读取 ${guarded.path}：${toErrorMessage(err)}`);
      }
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const readLen = Math.min(size, HARD_READ_LIMIT);
      let buf: Buffer;
      try {
        const handle = await open(guarded.path, 'r');
        try {
          buf = Buffer.allocUnsafe(readLen);
          const read = await handle.read(buf, 0, readLen, 0);
          buf = buf.subarray(0, read.bytesRead);
        } finally {
          await handle.close();
        }
      } catch (err) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.path} 失败：${toErrorMessage(err)}`);
      }

      const requestedEncoding = readOptionalString(args, 'encoding');
      if (looksBinary(buf) && requestedEncoding === undefined) {
        return fail(
          FS_ERROR_CODES.BINARY_FILE,
          `${guarded.relPath} 看起来是二进制文件（含 NUL 字节），safe_read 只处理文本。` +
            '若确实要看字节，请用 read_blob 并指定 encoding:"base64"。',
        );
      }

      const decoded = decodeWithEncoding(buf, requestedEncoding);
      const split = splitLines(decoded.text);
      const totalLines = split.lines.length;

      // 区间决议：head/tail 优先于 offset/limit（互斥已在上方挡住混用）
      let startLine = offset ?? 1;
      let endLine: number;
      if (head !== undefined) {
        startLine = 1;
        endLine = Math.min(head, totalLines);
      } else if (tail !== undefined) {
        startLine = Math.max(1, totalLines - tail + 1);
        endLine = totalLines;
      } else {
        const start = Math.min(startLine, Math.max(1, totalLines));
        startLine = start;
        endLine = limit === undefined ? totalLines : Math.min(totalLines, start + limit - 1);
      }
      if (totalLines === 0) {
        startLine = 0;
        endLine = 0;
      }

      const slice = totalLines === 0 ? [] : split.lines.slice(startLine - 1, endLine);
      const lineLimit = env.maxReadLines;
      const beyondLineLimit = slice.length > lineLimit;
      const shown = beyondLineLimit ? slice.slice(0, lineLimit) : slice;
      const shownEnd = startLine === 0 ? 0 : startLine + shown.length - 1;

      // 行号是**无条件**的，没有开关：它是 safe_edit 行号寻址（insert_at_line / delete_lines）
      // 唯一的地址来源。给模型一个 line_numbers:false 就等于给一个"关掉自己眼睛"的按钮，
      // 而唯一的收益是省几个 token——参数本身也是常驻开销，所以这里只做减法（v27 删掉了它）。
      const body = withLineNumbers(shown, startLine).join('\n');

      const truncated = size > readLen || beyondLineLimit || shown.length < slice.length;
      const header =
        `${guarded.relPath} · ${decoded.encoding}（${decoded.confidence}） · ${formatBytes(size)} · ` +
        `${totalLines} 行 · 显示 ${startLine}-${shownEnd}`;

      const hints: string[] = [];
      for (const note of decoded.notes) hints.push(`编码说明：${note}`);
      if (size > readLen) {
        hints.push(
          `文件 ${formatBytes(size)} 超过本次读取上限 ${formatBytes(HARD_READ_LIMIT)}，只解析了前 ${formatBytes(readLen)}；` +
            '要完整内容请用 offset/limit 分段读，或在 rg_search 里定位后再取区间。',
        );
      }
      if (beyondLineLimit) {
        hints.push(
          `本次区间共 ${slice.length} 行，超过单次返回上限 ${lineLimit} 行，已截断到前 ${lineLimit} 行；` +
            `继续读请用 offset=${shownEnd + 1}&limit=${lineLimit}。`,
        );
      }
      if (size > env.maxReadBytes) {
        hints.push(`提示：文件较大（${formatBytes(size)}），若这是外置的工具结果，用 read_blob 分页取更省上下文。`);
      }
      if (totalLines > 0 && shownEnd < totalLines) {
        hints.push(`文件还有 ${totalLines - shownEnd} 行未显示。`);
      }
      if (decoded.confidence === 'fallback') {
        hints.push('编码探针未能确定编码，内容可能显示为乱码；可传 encoding 参数强制指定。');
      }

      const content = truncated
        ? `${header} [截断]\n${body}${hints.length === 0 ? '' : `\n\n[续读提示]\n${hints.map((h) => `· ${h}`).join('\n')}`}`
        : `${header}\n${body}${hints.length === 0 ? '' : `\n\n[提示]\n${hints.map((h) => `· ${h}`).join('\n')}`}`;
      return ok(content, hints);
    },
  };
}

// ──────────────────────────────── list_dir ────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  directory: '[D]',
  file: '[F]',
  symlink: '[L]',
  other: '[?]',
};

export function createListDirTool(env: FsEnv): ToolDefinition {
  return {
    name: 'list_dir',
    description:
      '列出目录内容：类型（D 目录/F 文件/L 链接）、大小、修改时间。' +
      'depth 控制递归层数（默认 1，上限 5）。符号链接不跟进，不会成环。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认 "." （工作目录根）' },
        depth: { type: 'integer', description: '递归层数，1 表示只列直接子项，默认 1，上限 5' },
        max_entries: { type: 'integer', description: '最多返回多少条，默认 200' },
        include_hidden: { type: 'boolean', description: '是否包含以 . 开头的条目，默认 true' },
        sort_by: { type: 'string', enum: ['name', 'size', 'mtime'], description: '排序字段，默认 name' },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'list_dir');
      if (args === null) return invalidArgs('list_dir', '期望一个对象，例如 {"path": "."}');
      const pathInput = readOptionalString(args, 'path') ?? '.';
      const depthRes = readOptionalInt(args, 'depth', 1, 5);
      if ('error' in depthRes) return invalidArgs('list_dir', depthRes.error);
      const maxRes = readOptionalInt(args, 'max_entries', 1, 5000);
      if ('error' in maxRes) return invalidArgs('list_dir', maxRes.error);
      const depth = depthRes.value ?? 1;
      const maxEntries = maxRes.value ?? 200;
      const includeHidden = readOptionalBool(args, 'include_hidden') ?? true;
      const sortBy = readOptionalString(args, 'sort_by') ?? 'name';

      const guarded = await resolveInsideRoot(ctx.workspaceRoot, pathInput, {
        purpose: 'list_dir',
        requireDirectory: true,
      });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);

      const lines: string[] = [];
      let truncated = false;
      let dirCount = 0;
      let fileCount = 0;

      const walk = async (dir: string, level: number, relPrefix: string): Promise<void> => {
        if (truncated) return;
        if (ctx.signal.aborted) return;
        let entries = await readDirEntries(dir);
        if (entries === null) {
          lines.push(`(无法读取目录) ${relPrefix}`);
          return;
        }
        if (!includeHidden) entries = entries.filter((entry) => !entry.name.startsWith('.'));
        if (sortBy === 'size') entries.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
        else if (sortBy === 'mtime') entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
        else entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          if (lines.length >= maxEntries) {
            truncated = true;
            return;
          }
          const label = KIND_LABEL[entry.kind] ?? '[?]';
          const size = entry.kind === 'file' ? formatBytes(entry.size) : '-';
          const when = entry.mtimeMs === 0 ? '-' : new Date(entry.mtimeMs).toISOString();
          const suffix = entry.kind === 'directory' ? '/' : '';
          if (entry.kind === 'directory') dirCount += 1;
          else fileCount += 1;
          lines.push(`${label} ${relPrefix}${entry.name}${suffix}  ${size}  ${when}`);
          if (entry.kind === 'directory' && level < depth) {
            await walk(entry.path, level + 1, `${relPrefix}${entry.name}/`);
          }
        }
      };

      await walk(guarded.path, 1, '');
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const header =
        `${guarded.relPath === '' ? '.' : guarded.relPath}/ · 目录 ${dirCount} 个 / 文件 ${fileCount} 个 · ` +
        `depth=${depth}${sortBy === 'name' ? '' : ` · 按 ${sortBy} 排序`}`;
      const body = lines.length === 0 ? '(空目录)' : lines.join('\n');
      const tailNote = truncated ? `\n[已截断：上限 ${maxEntries} 条，缩小范围或用 rg_search/es_search 精确定位]` : '';
      return ok(`${header}\n${body}${tailNote}`);
    },
  };
}

// ──────────────────────────────── read_blob ────────────────────────────────

const BLOB_PAGE_DEFAULT = 64 * 1024;
const BLOB_PAGE_MAX = 1024 * 1024;

export function createReadBlobTool(env: FsEnv): ToolDefinition {
  return {
    name: 'read_blob',
    description:
      '分页读取 data/blobs/ 的内容寻址文件（工具大结果外置区）。' +
      '用 blobId（sha256）或 blob 根内相对路径；offset/limit 按字节。文本自动解码，二进制返回 base64。',
    parameters: {
      type: 'object',
      properties: {
        blobId: { type: 'string', description: '内容寻址 id（sha256 十六进制，64 位）' },
        path: { type: 'string', description: 'blob 根内的相对路径，与 blobId 二选一' },
        offset: { type: 'integer', description: '起始字节偏移，默认 0' },
        limit: { type: 'integer', description: '读取字节数，默认 65536，上限 1048576' },
        encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], description: '默认 auto（文本解码）' },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'read_blob');
      if (args === null) return invalidArgs('read_blob', '期望一个对象，例如 {"blobId": "<sha256>"}');
      const blobId = readOptionalString(args, 'blobId');
      const relPath = readOptionalString(args, 'path');
      if ((blobId === undefined || blobId === '') && (relPath === undefined || relPath === '')) {
        return invalidArgs('read_blob', 'blobId 与 path 至少给一个');
      }
      const offsetRes = readOptionalInt(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
      if ('error' in offsetRes) return invalidArgs('read_blob', offsetRes.error);
      const limitRes = readOptionalInt(args, 'limit', 1, BLOB_PAGE_MAX);
      if ('error' in limitRes) return invalidArgs('read_blob', limitRes.error);
      const offset = offsetRes.value ?? 0;
      const limit = limitRes.value ?? BLOB_PAGE_DEFAULT;
      const encoding = readOptionalString(args, 'encoding') ?? 'auto';

      const root = blobDir(env, ctx);
      let target: string;
      if (blobId !== undefined && blobId !== '') {
        if (!BLOB_ID_PATTERN.test(blobId)) {
          return invalidArgs('read_blob', 'blobId 必须是 64 位小写十六进制 sha256');
        }
        target = join(root, blobId);
      } else {
        const guarded = await resolveInsideRoot(root, relPath as string, { purpose: 'read_blob' });
        if (!guarded.ok) {
          return fail(
            guarded.code,
            guarded.reason,
          );
        }
        target = guarded.path;
      }

      let size: number;
      try {
        size = (await stat(target)).size;
      } catch {
        return fail(
          FS_ERROR_CODES.NOT_FOUND,
          `blob 不存在：${target}。blob 根为 ${root}；用 blobId 时请确认它来自某次工具结果的 contentRef。`,
        );
      }

      if (offset >= size && size > 0) {
        return fail(
          FS_ERROR_CODES.INVALID_ARGS,
          `offset ${offset} 超出 blob 长度 ${size}；请从 0 开始分页。`,
        );
      }

      const readLen = Math.min(limit, Math.max(0, size - offset));
      const buf = Buffer.allocUnsafe(readLen);
      try {
        const handle = await open(target, 'r');
        try {
          const read = await handle.read(buf, 0, readLen, offset);
          if (read.bytesRead !== readLen) {
            // 文件在读取期间被截断：以实际读到的为准，不假装读满
            return ok(
              `blob ${target} 在读取期间被修改（请求 ${readLen} 字节，实得 ${read.bytesRead} 字节）；请重新分页。`,
            );
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 blob 失败：${toErrorMessage(err)}`);
      }

      const asBase64 = encoding === 'base64' || (encoding === 'auto' && looksBinary(buf));
      const end = offset + readLen;
      const header = `blob ${relPath ?? blobId ?? ''} · ${formatBytes(size)} · 本次 ${offset}-${end} 字节${end < size ? '（还有后续）' : '（已到末尾）'}`;
      const bodyText = asBase64
        ? buf.toString('base64')
        : decodeText(buf).text;
      const footer = end < size ? `\n[续读：offset=${end}&limit=${limit}]` : '';
      return ok(`${header}\n${asBase64 ? '[base64]\n' : ''}${bodyText}${footer}`);
    },
  };
}

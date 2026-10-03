/**
 * Irmia Agent — 文件系工具包：编码检测与文本处理
 *
 * safe_read 承诺「编码检测」，这里给出确定性规则（不做统计猜测，只做可验证判定）：
 *   1. BOM 命中即定案（UTF-8 / UTF-16LE / UTF-16BE）；
 *   2. 无 BOM 时用严格 UTF-8 解码探针——能过就是 UTF-8；
 *   3. 再试 GBK（中文 Windows 文本文件的高频来源），仍走严格模式；
 *   4. 最后退到 latin1，它永不失败，保证任何字节串都能得到确定性文本。
 *
 * 二进制判定独立于编码：含 NUL 字节且没有 UTF-16/32 BOM 的，一律不当作文本。
 */

import { createHash } from 'node:crypto';

export type DetectedEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gbk' | 'latin1';

export interface DecodedText {
  text: string;
  encoding: DetectedEncoding;
  /** BOM 命中的是确定事实；后两条是探针推断 */
  confidence: 'certain' | 'probe' | 'fallback';
  /** 探针失败链，用于给模型解释为什么可能显示成乱码 */
  notes: string[];
}

export interface EncodeResult {
  buffer: Buffer;
  encoding: DetectedEncoding;
  /** 原编码无法表达内容时的降级说明（如 GBK 写不了某些字符） */
  notes: string[];
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function hasPrefix(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

/** 严格解码探针：编码不支持或字节非法都返回 null，绝不抛 */
function tryStrictDecode(buf: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function decodeText(buf: Buffer): DecodedText {
  if (hasPrefix(buf, UTF8_BOM)) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom', confidence: 'certain', notes: [] };
  }
  if (hasPrefix(buf, UTF16LE_BOM)) {
    return {
      text: buf.subarray(2).toString('utf16le'),
      encoding: 'utf16le',
      confidence: 'certain',
      notes: [],
    };
  }
  if (hasPrefix(buf, UTF16BE_BOM)) {
    // Node 没有 bswap，手工交换字节对后按 utf16le 解；奇数长度丢弃末字节
    const body = buf.subarray(2, buf.length - ((buf.length - 2) % 2));
    const swapped = Buffer.from(body);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', confidence: 'certain', notes: [] };
  }

  const utf8 = tryStrictDecode(buf, 'utf-8');
  if (utf8 !== null) {
    return { text: utf8, encoding: 'utf8', confidence: 'probe', notes: [] };
  }

  const notes: string[] = ['严格 UTF-8 解码失败'];
  const gbk = tryStrictDecode(buf, 'gbk');
  if (gbk !== null) {
    return { text: gbk, encoding: 'gbk', confidence: 'probe', notes: [...notes, '按 GBK 解码成功'] };
  }
  notes.push('GBK 解码也失败');
  return {
    text: buf.toString('latin1'),
    encoding: 'latin1',
    confidence: 'fallback',
    notes: [...notes, '已退到 latin1 单字节映射，非 ASCII 字符可能显示为乱码'],
  };
}

/** 二进制判定：含 NUL 且无 UTF-16/32 BOM。UTF-16 文本天然含 NUL，必须先排掉 */
export function looksBinary(buf: Buffer): boolean {
  if (hasPrefix(buf, UTF16LE_BOM) || hasPrefix(buf, UTF16BE_BOM)) return false;
  const window = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return window.includes(0);
}

/** 按 encode 参数把文本编回字节；'auto' 表示保留原始文件编码，由调用方传入回退编码 */
export function encodeText(text: string, encoding: DetectedEncoding): EncodeResult {
  switch (encoding) {
    case 'utf8-bom': {
      const body = Buffer.from(text, 'utf8');
      return { buffer: Buffer.concat([UTF8_BOM, body]), encoding, notes: [] };
    }
    case 'utf16le': {
      return {
        buffer: Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]),
        encoding,
        notes: [],
      };
    }
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le');
      body.swap16();
      return { buffer: Buffer.concat([UTF16BE_BOM, body]), encoding, notes: [] };
    }
    case 'gbk': {
      // Node 的 Buffer/TextEncoder 都不支持 GBK 编码方向（只有解码方向由 ICU 提供）。
      // 与其写出一串坏字节，不如改存 UTF-8 并如实告知——这个文件之后按 UTF-8 读是一致的。
      return {
        buffer: Buffer.from(text, 'utf8'),
        encoding: 'utf8',
        notes: ['原文件是 GBK；零依赖运行时没有 GBK 编码器，新内容改存为 UTF-8（内容无损）'],
      };
    }
    case 'latin1': {
      const probe = tryEncodeStrict(text, 'latin1');
      if (probe !== null) return { buffer: probe, encoding, notes: [] };
      return {
        buffer: Buffer.from(text, 'utf8'),
        encoding: 'utf8',
        notes: ['原文件是 latin1，但新内容超出单字节范围，已改存为 UTF-8'],
      };
    }
    default:
      return { buffer: Buffer.from(text, 'utf8'), encoding: 'utf8', notes: [] };
  }
}

function tryEncodeStrict(text: string, label: 'latin1'): Buffer | null {
  // 判据是「编解码往返一致」：latin1 丢字符时往返不等，即判为不可表达
  const encoded = Buffer.from(text, label);
  return tryStrictDecode(encoded, label) === text ? encoded : null;
}

// ──────────────────────────────── 行处理 ────────────────────────────────

export type Eol = '\n' | '\r\n' | '\r';

export interface SplitText {
  lines: string[];
  /** 文件主换行符，写回时保持一致 */
  eol: Eol;
  /** 原文是否以换行结尾（写回时保持） */
  trailingNewline: boolean;
}

export function splitLines(text: string): SplitText {
  if (text === '') return { lines: [], eol: '\n', trailingNewline: false };
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const crlfCount = (text.match(/\r\n/gu) ?? []).length;
  const lfOnlyCount = (text.match(/(?<!\r)\n/gu) ?? []).length;
  const crOnlyCount = (text.match(/\r(?!\n)/gu) ?? []).length;
  let eol: Eol = '\n';
  if (crlfCount > 0 && crlfCount >= lfOnlyCount && crlfCount >= crOnlyCount) eol = '\r\n';
  else if (crOnlyCount > lfOnlyCount && crOnlyCount > crlfCount) eol = '\r';

  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.split('\n'), eol, trailingNewline };
}

export function joinLines(lines: readonly string[], eol: Eol, trailingNewline: boolean): string {
  const body = lines.join(eol);
  return trailingNewline && lines.length > 0 ? body + eol : body;
}

/** 行号前缀宽度（右对齐）。与 safe_edit 的剥除正则共用同一个数 */
export const LINE_NUMBER_WIDTH = 4;

/**
 * 行号前缀：右对齐宽度 4 + `│` + 空格，例如 `  12│ const x = 1;`。
 *
 * 宽度写死 4（而不是按最大行号动态对齐）是**契约**，不是排版偏好：safe_edit 的防呆
 * 剥除要按同一个形状认前缀（模型从 safe_read 抄行号时一定会把前缀抄进 old 里），
 * 两边用同一个固定宽度，剥除规则才不需要"猜宽度"。devkit v2.6.4 用 6，我们统一到 4。
 *
 * 行号是**文件真实行号**（startLineNo 由调用方按切片起点给），不是切片内的相对号——
 * tail / offset 场景里相对号会让模型按错行去 insert_at_line / delete_lines。
 */
export function withLineNumbers(lines: readonly string[], startLineNo: number): string[] {
  if (lines.length === 0) return [];
  return lines.map((line, index) => `${String(startLineNo + index).padStart(LINE_NUMBER_WIDTH, ' ')}│ ${line}`);
}

/** 命中位置的行列（两者都是 1-based），列按 UTF-16 码元计——与编辑器显示一致 */
export interface TextPosition {
  line: number;
  column: number;
}

export function positionAt(text: string, index: number): TextPosition {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      line += 1;
      lastBreak = i;
    } else if (ch === 13) {
      line += 1;
      lastBreak = i;
      if (text.charCodeAt(i + 1) === 10) i += 1;
    }
  }
  return { line, column: index - lastBreak };
}

/** 一行的预览：去掉行首空白、截断到 limit 字符，便于模型在结果里直接读懂 */
export function previewLine(line: string, limit = 160): string {
  const trimmed = line.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

// ──────────────────────────────── glob ────────────────────────────────

/**
 * glob → 正则。支持 `**` `*` `?` `{a,b}` 与字符类 `[abc]`，
 * 路径分隔符统一成 `/` 后匹配。零依赖下刻意不实现完整 minimatch。
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replaceAll('\\', '/');
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 吃掉整段目录（含零段），`**` 单独出现时跨分隔符
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
        out += `(?:${alternatives.join('|')})`;
        i = close + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        const body = pattern.slice(i + 1, close).replaceAll('\\', '\\\\');
        out += `[${body}]`;
        i = close + 1;
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`, 'u');
}

/** glob 是否要匹配整个 relativize 后的路径（含分隔符） */
export function matchesGlob(glob: RegExp, relPath: string, baseName: string, patternHasSlash: boolean): boolean {
  if (glob.test(relPath)) return true;
  if (!patternHasSlash && glob.test(baseName)) return true;
  return false;
}

// ──────────────────────────────── 其他 ────────────────────────────────

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 时间戳：`2026-09-29T12-30-45-123Z`，字典序即时间序，可直接做备份保留排序 */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, '-');
}

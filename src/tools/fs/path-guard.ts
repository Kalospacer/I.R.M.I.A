/**
 * Irmia Agent — 文件系工具包：路径白名单守卫
 *
 * 对齐 docs/design.md §4.10 第 1 条与 docs/milestones.md M4-1 / M4-2：
 *   1. `resolve` 后做前缀比较；
 *   2. 注意符号链接——解析 realpath 之后再比一次。
 *
 * 设计要点（每条都对应一个真实绕过手法）：
 *
 *   • **前缀比较必须带分隔符**：只比 `C:\work` 会让 `C:\workspace-evil` 混进来。
 *   • **`..` 在字符串层消除**：`path.resolve` 会吃掉 `..`，而内核解析 `link/../x` 时
 *     `..` 是相对「符号链接的目标路径」的——两者语义不同。因此本模块**返回规范化后的
 *     绝对路径，调用方必须用返回值去操作文件系统**，绝不把原始输入交给 fs。
 *   • **realpath 取「最深已存在祖先」**：目标本身可能还不存在（新建文件），但它的
 *     某一级父目录可能是指向工作区外的符号链接。逐级回退到第一个真实存在的祖先，
 *     解析它，再把剩余不存在的段拼回去，就得到内核真正会访问的路径。
 *   • **Windows 特例**：盘符大小写不敏感（比较时统一小写）、保留设备名（`NUL`/`CON`
 *     /`COM1` 等会变成黑洞或设备）、尾部点与空格会被内核剥除。
 *
 * 已知边界（不在本模块解决）：检查与写入之间存在 TOCTOU 窗口。彻底关闭需要以
 * `O_NOFOLLOW` 打开后用 fstat 复核句柄，本包按「检查即用同一路径」收敛风险。
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { FS_ERROR_CODES, type FsErrorCode, toErrorMessage } from './types.ts';

export type GuardResult =
  | { ok: true; path: string; relPath: string; existed: boolean }
  | { ok: false; code: FsErrorCode; reason: string };

const IS_WINDOWS = process.platform === 'win32';

/** Windows 保留设备名：写在任何目录下都会被内核当设备，必须拒绝 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** 前缀比较用的归一化：Windows 折叠大小写与正斜杠，并去掉尾部冗余分隔符 */
export function comparisonKey(p: string): string {
  let key = p.replaceAll('/', sep);
  // Windows 内核会剥除路径末端的点与空格，比较前先剥，避免 `root\ ` 之类的等价绕过
  if (IS_WINDOWS) {
    key = key.replace(/[ .]+$/u, '');
    key = key.toLowerCase();
  }
  while (key.length > 1 && key.endsWith(sep)) key = key.slice(0, -1);
  return key;
}

/** p 是否落在 root 之内（含 root 自身）。纯字符串比较，不触盘 */
export function isInside(root: string, p: string): boolean {
  const r = comparisonKey(root);
  const t = comparisonKey(p);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * 只读区判定：相对路径是否落在某个只读前缀内。命中返回该前缀（给错误消息说明用），否则 null。
 *
 * 只读区的语义是**「模型可读、不可改」**——技能目录（design.md §4.19 信任门）就是这类资产：
 * 模型必须能 safe_read 读 SKILL.md 正文（渐进披露第二层），但目录本身只能由人确认后才变更。
 * 比较走 comparisonKey，因此 Windows 上的大小写与分隔符差异不会成为绕过口子。
 */
export function readOnlyPrefixOf(prefixes: readonly string[], relPath: string): string | null {
  const target = comparisonKey(relPath).replaceAll(sep, '/');
  for (const raw of prefixes) {
    const prefix = comparisonKey(raw).replaceAll(sep, '/');
    if (prefix === '' || prefix === '.' || prefix === '/') continue;
    if (target === prefix || target.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/**
 * 检查一个路径分量是否是 Windows 保留设备名（`NUL.txt` 也算，扩展名被内核忽略）。
 */
function hitsReservedDevice(segment: string): boolean {
  if (!IS_WINDOWS) return false;
  const dot = segment.indexOf('.');
  const stem = (dot === -1 ? segment : segment.slice(0, dot)).replace(/[ .]+$/u, '');
  return WINDOWS_RESERVED.has(stem.toUpperCase());
}

/**
 * 逐级向上找到第一个真实存在的祖先，返回 { base, rest }：
 *   base = 该祖先的 realpath（已解析全部符号链接）
 *   rest = 从 base 到目标之间尚不存在的路径分量
 */
async function deepestExisting(target: string): Promise<{ base: string; rest: string[] }> {
  const rest: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return { base: real, rest };
    } catch {
      const parent = resolve(cursor, '..');
      // 已经爬到根还找不到（盘符不存在之类）：退化为把整条路径当 rest
      if (parent === cursor) return { base: cursor, rest };
      const name = cursor.slice(parent.length).replace(/^[\\/]+/u, '');
      if (name !== '') rest.unshift(name);
      cursor = parent;
    }
  }
}

export interface GuardOptions {
  /** 允许目标不存在（写入新文件场景）；false 时目标必须已存在 */
  allowMissing?: boolean;
  /** 要求目标是目录（list_dir 用）；默认 false，即要求目标是普通文件 */
  requireDirectory?: boolean;
  /** 调用用途，用于组织错误消息，例如 'safe_edit' */
  purpose?: string;
}

/**
 * 把用户输入解析为「工作区内的规范化绝对路径」，越界即拒绝。
 * 返回的 `path` 是解析过符号链接的结果，调用方必须用它做后续 fs 操作。
 */
export async function resolveInsideRoot(
  workspaceRoot: string,
  input: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const purpose = options.purpose ?? '文件操作';

  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, code: FS_ERROR_CODES.INVALID_ARGS, reason: 'path 不能为空' };
  }
  if (input.includes('\0')) {
    return { ok: false, code: FS_ERROR_CODES.PATH_DENIED, reason: 'path 含 NUL 字节' };
  }

  for (const segment of input.replaceAll('\\', '/').split('/')) {
    if (hitsReservedDevice(segment)) {
      return {
        ok: false,
        code: FS_ERROR_CODES.PATH_DENIED,
        reason: `path 命中 Windows 保留设备名「${segment}」，拒绝访问`,
      };
    }
  }

  // 工作根自身必须是真实存在的目录，否则一切比较都失去基准
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch (err) {
    return {
      ok: false,
      code: FS_ERROR_CODES.PATH_DENIED,
      reason: `工作根不可用（${workspaceRoot}）：${toErrorMessage(err)}`,
    };
  }

  const requested = isAbsolute(input) ? resolve(input) : resolve(rootReal, input);
  const { base, rest } = await deepestExisting(requested);
  const effective = rest.length === 0 ? base : join(base, ...rest);

  if (!isInside(rootReal, effective)) {
    return {
      ok: false,
      code: FS_ERROR_CODES.PATH_DENIED,
      reason:
        `${purpose} 拒绝：解析后的真实路径 ${effective} 落在工作目录 ${rootReal} 之外` +
        '（白名单只允许工作目录内；符号链接会被展开后再比较）',
    };
  }

  let existed = true;
  let isDir = false;
  try {
    const info = await stat(effective);
    isDir = info.isDirectory();
  } catch {
    existed = false;
  }

  if (!existed && options.allowMissing !== true) {
    return { ok: false, code: FS_ERROR_CODES.NOT_FOUND, reason: `路径不存在：${effective}` };
  }
  if (existed && isDir && options.requireDirectory !== true) {
    return {
      ok: false,
      code: FS_ERROR_CODES.NOT_A_FILE,
      reason: `${effective} 是目录；查看目录内容请用 list_dir`,
    };
  }
  if (existed && !isDir && options.requireDirectory === true) {
    return { ok: false, code: FS_ERROR_CODES.NOT_A_DIRECTORY, reason: `${effective} 不是目录` };
  }

  return {
    ok: true,
    path: effective,
    relPath: relative(rootReal, effective).replaceAll('\\', '/'),
    existed,
  };
}

/** 目标是否落在给定的多个允许根之内（blob 目录等第二白名单用） */
export function insideAny(roots: readonly string[], p: string): boolean {
  return roots.some((root) => isInside(root, p));
}

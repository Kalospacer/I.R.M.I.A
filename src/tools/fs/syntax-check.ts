/**
 * Irmia Agent — 文件系工具包：写入前语法检查
 *
 * safe 家族五步链的第四步。目标是「写完不让文件进坏状态」，因此检查必须
 * 在落盘前对**待写入内容**执行，而不是写完再回头验证。
 *
 * 检查器按扩展名分派：
 *   • `.ts/.mts/.cts` → `module.stripTypeScriptTypes(code, { mode: 'transform' })`。
 *     **为什么不是 `node --check`**：实测 Node 22.19 的 `--check` 走 CJS 的
 *     `checkSyntax`，完全不认识类型注解——`const x: number = 1` 会被判成
 *     `SyntaxError: Missing initializer in const declaration`，加
 *     `--experimental-strip-types` 也一样。用它做门禁等于让所有合法 TS 回滚。
 *     `stripTypeScriptTypes` 走真正的 TS 解析器（swc），语法错误抛 SyntaxError，
 *     且 `mode: 'transform'` 连 enum/namespace 这类非可擦除语法也能正确接受。
 *   • `.js/.mjs/.cjs` → `node --check`（任务约定的检查器）。优先按原扩展名检查，
 *     失败再用 `.mjs` 复检一次：`.js` 在临时目录下没有 package.json，ESM 语法
 *     （顶层 await 之类）会被 CJS 解析器误杀，复检能区分「真语法错」与「模块类型猜错」。
 *   • `.json` → `JSON.parse`。
 *   • 其余扩展名 → 跳过（不猜，也不假装检查过）。
 */

import { rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import type { FsToolDeps } from './types.ts';
import { toErrorMessage } from './types.ts';

export type SyntaxVerdict =
  | { status: 'ok'; checker: string }
  | { status: 'skipped'; checker: string; reason: string }
  | { status: 'error'; checker: string; message: string };

const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx']);
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const JSON_EXTENSIONS = new Set(['.json']);

/** 语法错误消息可能很长（带整段栈），只保留前若干行，避免撑爆工具结果 */
function trimMessage(message: string, maxLines = 6): string {
  const lines = message.split(/\r?\n/u).filter((line) => line.trim() !== '');
  return lines.slice(0, maxLines).join('\n');
}

let tmpSeq = 0;

function tmpPathFor(extension: string): string {
  tmpSeq += 1;
  return join(tmpdir(), `irmia-syntax-${process.pid}-${tmpSeq}${extension}`);
}

async function runNodeCheck(fullPath: string, deps: FsToolDeps): Promise<{ ok: boolean; message: string }> {
  const result = await deps.runProcess(
    process.execPath,
    ['--check', fullPath],
    { timeoutMs: 10_000 },
  );
  if (result.timedOut) return { ok: false, message: 'node --check 超时' };
  if (result.failed && result.code === null) {
    return { ok: false, message: `无法启动 node --check：${result.stderr.trim() || '进程未启动'}` };
  }
  if (result.code === 0) return { ok: true, message: '' };
  return { ok: false, message: trimMessage(result.stderr.trim() || `node --check 退出码 ${result.code}`) };
}

async function checkJs(absPath: string, content: Buffer, deps: FsToolDeps): Promise<SyntaxVerdict> {
  const extension = extname(absPath).toLowerCase();
  const probe = tmpPathFor(extension === '' ? '.js' : extension);
  try {
    await writeFile(probe, content);
    const first = await runNodeCheck(probe, deps);
    if (first.ok) return { status: 'ok', checker: `node --check (${extension})` };

    // 复检：把内容当作 ESM 再看一次，区分真语法错与模块类型判定失误
    if (extension !== '.mjs') {
      const esmProbe = tmpPathFor('.mjs');
      try {
        await writeFile(esmProbe, content);
        const second = await runNodeCheck(esmProbe, deps);
        if (second.ok) return { status: 'ok', checker: 'node --check (ESM 复检)' };
      } finally {
        await rm(esmProbe, { force: true });
      }
    }
    return { status: 'error', checker: `node --check (${extension})`, message: first.message };
  } finally {
    await rm(probe, { force: true });
  }
}

function checkTs(content: Buffer): SyntaxVerdict {
  const text = content.toString('utf8');
  try {
    stripTypeScriptTypes(text, { mode: 'transform' });
    return { status: 'ok', checker: 'stripTypeScriptTypes(transform)' };
  } catch (err) {
    // swc 的 SyntaxError 消息已含行列，直接透出
    return { status: 'error', checker: 'stripTypeScriptTypes(transform)', message: trimMessage(toErrorMessage(err)) };
  }
}

function checkJson(content: Buffer): SyntaxVerdict {
  const text = content.toString('utf8');
  if (text.trim() === '') return { status: 'ok', checker: 'JSON.parse' };
  try {
    JSON.parse(text);
    return { status: 'ok', checker: 'JSON.parse' };
  } catch (err) {
    return { status: 'error', checker: 'JSON.parse', message: trimMessage(toErrorMessage(err)) };
  }
}

export async function checkSyntax(absPath: string, content: Buffer, deps: FsToolDeps): Promise<SyntaxVerdict> {
  const extension = extname(absPath).toLowerCase();
  if (TS_EXTENSIONS.has(extension)) return checkTs(content);
  if (JS_EXTENSIONS.has(extension)) return checkJs(absPath, content, deps);
  if (JSON_EXTENSIONS.has(extension)) return checkJson(content);
  return {
    status: 'skipped',
    checker: 'none',
    reason: `扩展名 ${extension === '' ? '(无)' : extension} 没有可用的零依赖语法检查器，已跳过`,
  };
}

/** 给模型的检查结果摘要，单行，便于放进工具结果头部 */
export function describeVerdict(verdict: SyntaxVerdict): string {
  switch (verdict.status) {
    case 'ok':
      return `语法检查通过（${verdict.checker}）`;
    case 'skipped':
      return `语法检查跳过：${verdict.reason}`;
    default:
      return `语法检查失败（${verdict.checker}）：${verdict.message}`;
  }
}

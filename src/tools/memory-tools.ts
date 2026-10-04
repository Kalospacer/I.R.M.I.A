/**
 * Irmia Agent — `memory_read`：按索引指针读记忆
 *
 * 形状与理由见 `src/persona/memory-access.ts` 的文件头（用户的原话、实测依据、
 * 三条职责边界都在那里）。这一层只做三件事：
 *
 *   1. **参数与白名单**：`path` 必须是 `MEMORIES/<文件名>` 这一种写法（索引里的指针就是这样），
 *      拼出来的绝对路径必须落在 `<dataDir>/workspace/MEMORIES/` 内。放开到任意路径就等于
 *      又造一个 `safe_read`（连同它的整篇读能力），而"反复把全文读入"正是它要治的病。
 *   2. **上限**：一次最多 {@link MEMORY_READ_MAX_LINES} 行，**超了就拒绝而不是夹取**
 *      ——夹取会让"我要读 200 行"静默变成"读到 40 行"，而多出来的那一步正是"读整篇"。
 *   3. **访问账**：读**成功**时写一条 `memory/read`（只放指针、不放正文），
 *      给 design §4.17 第 2 条的"访问强化"留数据。
 *
 * 副作用口径：`sideEffect: 'none'`。它**不碰任何记忆文件**（本模块只读），
 * 写出去的那一条事件是 append-only 的账，与 `memory/selected` 同级。
 */

import { join, normalize, sep } from 'node:path';

import {
  isMemoryPath,
  memoryDirAbs,
  readMemoryEntry,
  MEMORY_READ_DEFAULT_LINES,
  MEMORY_READ_MAX_LINES,
} from '../persona/memory-access.ts';
import type { MemoryRead } from '../log/types.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  ok,
  readOptionalInt,
  readString,
  type ToolContext,
  type ToolDefinition,
} from './fs/types.ts';

/**
 * 访问账的写入口。
 *
 * 形状是"宿主给一个收完整 payload 的函数"（**含 turn**），而不是在这里自己拼：
 * 事件写库要 turn 号，而"当前是哪一轮"只有循环层知道——工具层拿到的 `ctx.turn` 是
 * 派发时给的，所以由**工具层把它交出去**、由宿主决定怎么写（与 vision 的 `emit` 同一条纪律：
 * 工具只该有"写这一种事件"的能力，不该拿到任意写权限或自己去问 turn）。
 */
export type MemoryReadRecorder = (data: MemoryRead['data']) => void;

export interface MemoryToolsOptions {
  /** 数据目录（`<dataDir>/workspace/MEMORIES/` 是记忆根） */
  dataDir: string;
  /**
   * 访问账出口。省略时不记账——但**必须**在别处把这件事说清楚，
   * 而不是让它静默变成"机制设计里有、实现里没有"（§4.17 那条病）。
   */
  onAccess?: MemoryReadRecorder | undefined;
}

/**
 * 把路径拼成记忆根下的绝对路径，并确认它真的还在根内。
 *
 * 判据放在这里而不是信 `isMemoryPath`：那个函数管"写法对不对"，这个管"拼出来落在哪"。
 * 两道都要——只判写法的话，`MEMORIES/../facts.md` 这种（写法上 parts 含 `..`，已被
 * `isMemoryPath` 挡掉）与将来任何别名/符号链接的变体都得再想一遍；只判落点的话，
 * 一个绝对路径会被 `join` 悄悄接到根后面。
 */
function resolveMemoryPath(dataDir: string, relPath: string): { abs: string; rel: string } | null {
  const normalized = relPath.replace(/\\/gu, '/');
  if (!isMemoryPath(normalized)) return null;
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  const root = memoryDirAbs(dataDir);
  const abs = normalize(join(root, ...parts.slice(1)));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return { abs, rel: `${parts[0]}/${parts.slice(1).join('/')}` };
}

export function createMemoryReadTool(options: MemoryToolsOptions): ToolDefinition {
  return {
    name: 'memory_read',
    // 描述 <100 token 是硬门（registry.ts 的 MAX_DESCRIPTION_TOKENS，超了整件不注册）。
    // 这里只讲清"它吃指针、不是文件名"与"一次只给这几行"——参数说明在 schema 里。
    description:
      '按记忆索引里的指针读那一条（指针形如 `MEMORIES/facts.md:9`，路径与行号照抄索引）。'
      + '只返回从那一行起的少数几行（默认 1 行，最多 40），**不能读整篇**——'
      + '指针已失效时如实报错、不给可能对不上的正文。要看全文用 safe_read。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '指针里的路径，如 "MEMORIES/facts.md"（只能读 MEMORIES/ 下的文件）' },
        line: { type: 'integer', description: '指针里的行号（1-based），照抄索引，不要自己推算' },
        lines: { type: 'integer', description: `一共读几行，默认 ${MEMORY_READ_DEFAULT_LINES}，最多 ${MEMORY_READ_MAX_LINES}` },
      },
      required: ['path', 'line'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        lines: { type: 'integer' },
        summary: { type: 'string' },
        pinned: { type: 'boolean' },
        content: { type: 'string' },
      },
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'memory_read');
      if (args === null) {
        return invalidArgs('memory_read', '期望一个对象，例如 {"path": "MEMORIES/facts.md", "line": 9}');
      }
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('memory_read', '缺少 path');

      // line 的合法下界是 1：索引里的行号是 1-based，给 0 说明它把"没指定"和"第一行"混了
      const lineRes = readOptionalInt(args, 'line', 1, Number.MAX_SAFE_INTEGER);
      if ('error' in lineRes) return invalidArgs('memory_read', lineRes.error);
      if (lineRes.value === undefined) {
        return invalidArgs('memory_read', '缺少 line；索引里那条指针的行号要照抄，不要自己推算');
      }
      const linesRes = readOptionalInt(args, 'lines', 1, MEMORY_READ_MAX_LINES);
      if ('error' in linesRes) {
        return invalidArgs(
          'memory_read',
          `lines 只能是 1~${MEMORY_READ_MAX_LINES} 的整数——一次读更多就等于"读整篇"，`
          + '那正是这件工具要避免的。要看全文请用 safe_read，并想清楚为什么需要整篇。',
        );
      }
      const lines = linesRes.value ?? MEMORY_READ_DEFAULT_LINES;

      const resolved = resolveMemoryPath(options.dataDir, pathInput);
      if (resolved === null) {
        return fail(
          FS_ERROR_CODES.PATH_DENIED,
          `memory_read 只读 MEMORIES/ 下的记忆文件，收到的是 ${pathInput}。`
          + '它吃的是**索引里的指针**（形如 `MEMORIES/facts.md:9`）——请照抄索引里那一条。'
          + '要读别的文件用 safe_read。',
        );
      }
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const result = readMemoryEntry(resolved.abs, resolved.rel, lineRes.value, lines);
      if (!result.ok) {
        // 漂了/越界/文件不在：三种都**不给正文**（给了她就拿到可能对不上的记忆，而她自己不知道）
        const code = result.status === 'missing'
          ? FS_ERROR_CODES.NOT_FOUND
          : result.status === 'out-of-range'
            ? FS_ERROR_CODES.INVALID_ARGS
            : FS_ERROR_CODES.NO_MATCH;
        return fail(code, result.message);
      }

      // 访问账：**只放指针、不放正文**（与 memory/selected 同一条纪律）。
      // 记账失败绝不能影响这次读取——账是派生物，正文已经拿到了。
      try {
        options.onAccess?.({
          turn: ctx.turn,
          path: result.path,
          line: result.line,
          lines: result.lines,
          pinned: result.pinned,
        });
      } catch {
        // 静默：账写不进去不该让一次成功的读取变成失败
      }

      const head = `${result.path}:${result.line}${result.pinned ? ' **!pinned**' : ''} · `
        + `读 ${result.lines} 行 · 摘要「${result.summary}」`;
      const tail = result.nextLine === null
        ? '（已到文件末尾）'
        : `（要接着读用 line=${result.nextLine}）`;
      return ok(`${head}\n${result.text}\n${tail}`);
    },
  };
}

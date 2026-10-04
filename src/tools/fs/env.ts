/**
 * Irmia Agent — 文件系工具包：运行环境与默认依赖
 *
 * 把「配置 + 可注入依赖」收敛成一个 FsEnv，供各工具工厂闭包捕获：
 *   • 目录推导全部在此处（数据目录 ↔ 备份根的决议链只有一份）；
 *   • 默认 runProcess 负责把 process 的进程管理语义补齐——超时杀**进程树**、
 *     AbortSignal 触发即杀、输出按头 8k + 尾 2k 截断（design.md §4.18 pwsh 专项）；
 *   • 子进程输出用本包的编码探针解码，中文 Windows 上 es.exe 的 GBK 输出不会变乱码。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildSkipSet } from './search-core.ts';
import { DEFAULT_MAX_EDIT_BYTES } from './edit-core.ts';
import { decodeText } from './text-codec.ts';
import {
  expandAliases,
  resolveInsideRoot,
  type GuardOptions,
  type GuardResult,
  type PathAlias,
} from './path-guard.ts';
import type { FsToolDeps, FsToolOptions, ProcessResult, RunProcessOptions } from './types.ts';

/** 子进程输出的兜底上限：超过即停止累积并标记（正常搜索远不会到这里） */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface FsEnv {
  deps: FsToolDeps;
  dataDir(ctx: { workspaceRoot: string }): string;
  backupRoot(ctx: { workspaceRoot: string }): string;
  /**
   * 路径前缀别名（P1，2026-10-04）：让"按另一套根写下"的相对路径也能解析到
   * （`MEMORIES/`、`diary/`、`persona/`）。见 path-guard.ts 的 `expandAliases`。
   */
  pathAliases(ctx: { workspaceRoot: string }): readonly PathAlias[];
  backupKeep: number;
  maxReadBytes: number;
  maxReadLines: number;
  /** 写工具族的单文件字节上限（读、写两道门同值；见 types.ts 的 maxEditBytes） */
  maxEditBytes: number;
  skipDirs: ReadonlySet<string>;
  /** 只读区前缀（工作区相对路径）：写工具拒绝落在其中的目标（design.md §4.19 技能目录） */
  readOnlyPrefixes: readonly string[];
  /** 每个只读区前缀 → "那该走哪条路"（拒绝消息里那句可操作的话；见 types.ts 的 readOnlyHints） */
  readOnlyHints: Readonly<Record<string, string>>;
  /** 受保护文件绝对路径（钩子配置等「防护自身定义」）：写入口一律拒绝，读不受限 */
  protectedPaths: readonly string[];
  /** undefined = 启动时自动探测；null = 显式禁用（测试注入用） */
  ripgrepPath: string | null | undefined;
  everythingPath: string | null | undefined;
}

/** 默认只读区：技能目录（与 skill/skills.ts 的 SKILL_READ_ONLY_PREFIXES 同口径） */
export const DEFAULT_READ_ONLY_PREFIXES: readonly string[] = ['skills', '.agents/skills'];

/** 默认只读区的"那该走哪条路"（技能目录：读正文照旧，改内容要人确认） */
const DEFAULT_READ_ONLY_HINTS: Readonly<Record<string, string>> = {
  skills: '要读正文用 safe_read（skills/<name>/SKILL.md）；要改内容请由人修改后重新确认技能。',
  '.agents/skills': '要读正文用 safe_read；要改内容请由人修改后重新确认技能。',
};

/**
 * 记忆与人格资产的目录名（别名表用）。三个名字都必须与真实布局一致：
 *   · `<dataDir>/workspace/MEMORIES/`——`persona/memory-injection.ts` 的记忆根；
 *   · `<dataDir>/workspace/diary/`——与它平级的日记；
 *   · `<dataDir>/persona/`——人格资产根（`catalog.ts` 传给 admin 工具的 personaRoot）。
 *
 * **刻意不含 `workspace/`**：仓库根真的有一个同名目录（`http_download` 的落点），
 * 别名它会在两处同名目录之间制造歧义——那个问题归"描述说清根在哪"，不归别名表。
 */
export const MEMORY_DIR_NAME = 'MEMORIES';
export const DIARY_DIR_NAME = 'diary';
export const PERSONA_DIR_NAME = 'persona';

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      // Windows 没有进程组信号，必须借 taskkill /T 才能连子进程一起收掉
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => undefined);
    } catch {
      // taskkill 不可用就退到普通 kill，至少收掉主进程
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 进程可能已经退出，忽略
  }
}

function toTruncatedOutput(chunks: Buffer[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = Buffer.concat(chunks, total);
  if (total <= 10 * 1024) return decodeText(merged).text;
  const head = merged.subarray(0, 8 * 1024);
  const tail = merged.subarray(total - 2 * 1024);
  const decoded = `${decodeText(head).text}\n…[输出已截断：共 ${total} 字节]…\n${decodeText(tail).text}`;
  return decoded;
}

export function runProcessDefault(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env === undefined ? undefined : { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), failed: true, timedOut: false });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let spawnFailed = false;

    const collect = (chunks: Buffer[], bytes: number, data: Buffer, cap: number): number => {
      if (bytes >= cap) return bytes;
      chunks.push(data);
      return bytes + data.byteLength;
    };

    const onAbort = (): void => {
      killTree(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: toTruncatedOutput(stdoutChunks),
        stderr: toTruncatedOutput(stderrChunks),
        failed: spawnFailed || timedOut,
        timedOut,
      });
    };

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        killTree(child);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, data, MAX_OUTPUT_BYTES);
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderrBytes = collect(stderrChunks, stderrBytes, data, MAX_OUTPUT_BYTES);
    });
    child.on('error', (err: Error) => {
      spawnFailed = true;
      stderrChunks.push(Buffer.from(err.message, 'utf8'));
      finish(null);
    });
    child.on('close', (code: number | null) => {
      finish(code);
    });
  });
}

const defaultDeps: FsToolDeps = {
  now: () => new Date(),
  runProcess: runProcessDefault,
  homeDir: () => homedir(),
};

export function createEnv(options: FsToolOptions = {}, overrides: Partial<FsToolDeps> = {}): FsEnv {
  const deps: FsToolDeps = { ...defaultDeps, ...overrides };
  const backupKeep = options.backupKeep ?? 10;
  const skipDirs = buildSkipSet(options.skipDirNames);
  /** 数据目录的决议链只有一份：显式给的优先，否则 `<workspaceRoot>/data` */
  const dataDirOf = (ctx: { workspaceRoot: string }): string =>
    options.dataDir ?? join(ctx.workspaceRoot, 'data');

  const env: FsEnv = {
    deps,
    dataDir: dataDirOf,
    backupRoot: (ctx) => {
      if (options.backupDir !== undefined) return options.backupDir;
      try {
        const home = deps.homeDir();
        if (home !== '') return join(home, '.irmia', 'backups');
      } catch {
        // 取不到 home 就落回数据目录，绝不因为环境缺项而拒绝备份
      }
      return join(dataDirOf(ctx), 'backups');
    },
    // 别名表**从 dataDir 推导**，不另立一处配置：表里的三个根都是数据目录下的固定位置，
    // 写成可配置的只会多一个能配错的地方。
    pathAliases: (ctx) => {
      const data = dataDirOf(ctx);
      return [
        { prefix: MEMORY_DIR_NAME, root: join(data, 'workspace', MEMORY_DIR_NAME) },
        { prefix: DIARY_DIR_NAME, root: join(data, 'workspace', DIARY_DIR_NAME) },
        { prefix: PERSONA_DIR_NAME, root: join(data, PERSONA_DIR_NAME) },
      ];
    },
    backupKeep,
    maxReadBytes: options.maxReadBytes ?? 256 * 1024,
    maxReadLines: options.maxReadLines ?? 2000,
    // 默认值来自 edit-core 的同一个常量（20 MiB，与 devkit 的 SAFE_EDIT_MAX_SIZE 同值）：
    // 读端拒绝、写端拒绝两道门读的是同一个数，不给"两处各写一个字面量"的机会。
    maxEditBytes: options.maxEditBytes ?? DEFAULT_MAX_EDIT_BYTES,
    skipDirs,
    readOnlyPrefixes: options.readOnlyPrefixes ?? DEFAULT_READ_ONLY_PREFIXES,
    // 提示按前缀合并：装配层只补它新增的那几个前缀，默认那两条技能目录的说明不会因此丢掉
    readOnlyHints: { ...DEFAULT_READ_ONLY_HINTS, ...(options.readOnlyHints ?? {}) },
    protectedPaths: options.protectedPaths ?? [],
    ripgrepPath: options.ripgrepPath,
    everythingPath: options.everythingPath,
  };
  return env;
}

/**
 * fs 包内**所有**路径的唯一入口：先过别名表，再过边界判定。
 *
 * 为什么要有这么一个包装，而不是在每个调用点各写两行：三条规则的**顺序**是语义的一部分
 * ——先改写（别名）、后校验（边界），别名永远不能绕过越界检查。把顺序写在一处，
 * 就没有"哪一处写反了"的问题。
 *
 * **三态原样传下去，不在这里折成具体值**：`undefined`（= 历史行为，拿 `workspaceRoot` 当边界）
 * 与"显式给了同一个根"在**判定**上等价，在**拒绝措辞**上不等价——后者要说清 trust.mode 与
 * 怎么改，而 `workspace` 档的默认边界正是工作根（`config.ts` 的 `buildDefaults`），
 * 折一次就把这一位揉掉了。所以折叠与判读都归 `tools/boundary.ts` 的 `boundaryDecision`
 * （唯一判据），本函数只负责"什么时候问它"。
 *
 * `ctx.workspaceRoot` 与边界的分工：前者是**相对路径的解析基准**（也决定 `relPath`，只读区
 * 前缀靠它），后者是**允许活动的范围**。`full` 模式下边界为 `null`，基准照旧——相对路径
 * 仍相对工作根解析，只是不再有"必须在根内"这一条。
 */
export function resolveGuarded(
  env: FsEnv,
  ctx: { workspaceRoot: string; boundaryRoot?: string | null },
  input: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  return resolveInsideRoot(
    ctx.workspaceRoot,
    expandAliases(input, env.pathAliases(ctx), ctx.workspaceRoot),
    {
      ...options,
      ...(ctx.boundaryRoot === undefined ? {} : { boundaryRoot: ctx.boundaryRoot }),
    },
  );
}

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
import { decodeText } from './text-codec.ts';
import type { FsToolDeps, FsToolOptions, ProcessResult, RunProcessOptions } from './types.ts';

/** 子进程输出的兜底上限：超过即停止累积并标记（正常搜索远不会到这里） */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface FsEnv {
  deps: FsToolDeps;
  dataDir(ctx: { workspaceRoot: string }): string;
  backupRoot(ctx: { workspaceRoot: string }): string;
  backupKeep: number;
  maxReadBytes: number;
  maxReadLines: number;
  skipDirs: ReadonlySet<string>;
  /** 只读区前缀（工作区相对路径）：写工具拒绝落在其中的目标（design.md §4.19 技能目录） */
  readOnlyPrefixes: readonly string[];
  /** 受保护文件绝对路径（钩子配置等「防护自身定义」）：写入口一律拒绝，读不受限 */
  protectedPaths: readonly string[];
  /** undefined = 启动时自动探测；null = 显式禁用（测试注入用） */
  ripgrepPath: string | null | undefined;
  everythingPath: string | null | undefined;
}

/** 默认只读区：技能目录（与 skill/skills.ts 的 SKILL_READ_ONLY_PREFIXES 同口径） */
export const DEFAULT_READ_ONLY_PREFIXES: readonly string[] = ['skills', '.agents/skills'];

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

  const env: FsEnv = {
    deps,
    dataDir: (ctx) => options.dataDir ?? join(ctx.workspaceRoot, 'data'),
    backupRoot: (ctx) => {
      if (options.backupDir !== undefined) return options.backupDir;
      try {
        const home = deps.homeDir();
        if (home !== '') return join(home, '.irmia', 'backups');
      } catch {
        // 取不到 home 就落回数据目录，绝不因为环境缺项而拒绝备份
      }
      return join(options.dataDir ?? join(ctx.workspaceRoot, 'data'), 'backups');
    },
    backupKeep,
    maxReadBytes: options.maxReadBytes ?? 256 * 1024,
    maxReadLines: options.maxReadLines ?? 2000,
    skipDirs,
    readOnlyPrefixes: options.readOnlyPrefixes ?? DEFAULT_READ_ONLY_PREFIXES,
    protectedPaths: options.protectedPaths ?? [],
    ripgrepPath: options.ripgrepPath,
    everythingPath: options.everythingPath,
  };
  return env;
}

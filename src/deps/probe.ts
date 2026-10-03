/**
 * Irmia Agent — 外部依赖探测框架（docs/design.md §4.18 工具依赖、review.md v30）
 *
 * 这个模块存在的理由是一句话：**外部依赖要由框架管，不能靠用户自己折腾**。
 * 在这之前，"本机有没有 rg / es.exe / pwsh 7"这件事散在三处各判一遍：
 *   · `src/tools/pwsh.ts` 自己跑一次 `$PSVersionTable` 探测链；
 *   · `src/tools/fs/search-tools.ts` 在**建注册表时**串行试 5 个 es.exe 候选，
 *     每个候选一次 ENOENT（review v27 的 Σ-5 记了这笔账）；
 *   · `rg_search` 更糟——它连探测都不做，直接"调用失败就降级"。
 * 于是同一台机器上"有没有 rg"被回答了很多次，答案还可能不一致（注册时说没有、执行时又说有）。
 *
 * 现在收敛成**一次探测、一份结论、一个缓存**：
 *   ① 用户在 config 里指定的路径（`deps.paths.<name>`）——人明确指过就以他为准；
 *   ② 框架自装目录 `<dataDir>/tools/<name>/`——一键安装的落点；
 *   ③ PATH——机器上早就装好的那些（`where pwsh` 能找到的）。
 * 三段顺序不能反：用户指定 > 框架自装 > 系统 PATH。反过来的话，用户手动指了一条坏路径
 * 却永远轮不到，而"我明明配了它却不用"是查起来最费劲的一类故障。
 *
 * 两个刻意的设计：
 *
 * **① 探测只做一次、结论可刷新。** `probeDependency` 是纯函数（跑一次给一份结论），
 * 缓存与刷新在 `manager.ts`。分开的理由是"安装后复检"必须能拿到新结论——
 * 如果缓存写死在探测函数里，用户点完安装还得重启进程才认账，那是半成品。
 *
 * **② 版本判定属于依赖定义，不属于调用方。** `pwsh` 的判据是**主版本 ≥ 7**：
 * 5.1 也是一个能跑的 shell，但它不是 pwsh 7，装上它不算满足（它是回退选项，
 * 由 pwsh 工具如实标出来）。把这条判据写在定义里，是因为"什么算满足"只能有一个答案。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 默认探测超时：起一个进程读版本号，10 秒足够（与 pwsh.ts 的 PROBE_TIMEOUT_MS 同尺度） */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** 自装目录名：`<dataDir>/tools/<name>/`，安装与探测共用这一个约定 */
export const TOOLS_DIR_NAME = 'tools';

/** 探测结果来源。三段的顺序即优先级，枚举值直接作为报告字段给界面用 */
export type DepSource = 'config' | 'managed' | 'path';

/** 依赖名的唯一清单：定义、安装、报告、界面都按它遍历，不另立一份名单 */
export const DEP_NAMES = ['pwsh', 'rg', 'es'] as const;
export type DepName = (typeof DEP_NAMES)[number];

/** 状态三态：就绪 / 版本不符 / 未安装。界面徽章与建议动作都由它决定 */
export type DepStatus = 'ready' | 'version-mismatch' | 'missing';

/** 建议动作：能一键装的给 install，只能人去装的给 open-download，已就绪给 null */
export type DepAction = 'install' | 'open-download' | null;

/** rg 的官方发布页（Github release 列表，人看的） */
export const RIPGREP_DOWNLOAD_PAGE = 'https://github.com/BurntSushi/ripgrep/releases';

/**
 * es.exe 的下载来源说明。**它必须说清"这不是 Everything 主程序"**：
 * es.exe 是 voidtools 单独发布的命令行客户端，装 Everything 主程序不会带上它，
 * 而不清楚这一点的人会在"我已经装了 Everything"和"工具说没装 es.exe"之间反复打转。
 */
export const ES_DOWNLOAD_PAGE = 'https://www.voidtools.com/downloads/#everything-command-line-interface';

/** PowerShell 7 的官方下载页（自动安装代价过高，只做提示 + 一键打开） */
export const PWSH_DOWNLOAD_PAGE = 'https://github.com/PowerShell/PowerShell/releases/latest';
export const PWSH_WINGET_HINT = 'winget install Microsoft.PowerShell';

// ──────────────────────────────── 类型 ────────────────────────────────

/** 一次版本探测的子进程结果（与 tools/fs 的 ProcessResult 同形，避免两套进程语义） */
export interface DepProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
}

export interface DepProbeOptions {
  /** 探测超时；省略用 DEFAULT_PROBE_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 依赖定义的形状：名称、候选可执行名、版本参数、版本解析与最低要求 */
export interface DependencySpec {
  name: DepName;
  /** 界面上的名字（人不认识 `rg` 这个简称） */
  label: string;
  /** 它是干什么的（界面灰字说明的第一句） */
  purpose: string;
  /**
   * 没有它会发生什么。**必须写清影响**（design §4.18 原则 5：给模型的错误要说下一步）：
   * 界面要"显式告知建议安装"，而"建议"只有在说清代价之后才成立。
   */
  impact: string;
  /** 装它的方式：zip = 框架一键装；manual = 只能人去装（界面给「打开下载页」+ 指令） */
  install: 'zip' | 'manual';
  /** 手动安装时给用户的一句话指令（winget / 下载页说明）；一键装的依赖这里是 null */
  manualHint: string | null;
  /** 手动安装的下载页（界面按钮用）；一键装的依赖这里是 null */
  downloadPage: string | null;
  /** 候选可执行名（按顺序试；只用于第三段 PATH 与第二段自装目录内的文件名匹配） */
  candidates: readonly string[];
  /** 版本探测参数。做成函数是因为 pwsh 走 -EncodedCommand（见 pwsh.ts 的实测依据） */
  versionArgs: () => readonly string[];
  /** 版本探测的额外 spawn 选项 */
  versionSpawn?: { useEncodedCommand?: boolean } | undefined;
  /**
   * 从探测输出解析版本；返回 null = 这个候选不能用（版本不符或输出看不懂）。
   * 它同时承担"最低版本要求"的判定：不满足就返回 null，由上层区分 mismatch 与 missing。
   */
  parseVersion: (stdout: string, result: DepProcessResult) => string | null;
  /**
   * 把输出判成"版本太低"还是"输出看不懂"。只有它返回一个版本号、
   * 而 parseVersion 返回 null 时才会用到——用于区分「装了但版本不符」与「根本没装」。
   */
  parseAnyVersion?: ((stdout: string) => string | null) | undefined;
  /** 最低版本描述（报告与界面用，如 '7.0'） */
  minVersion: string;
}

/** 探测结论。`ok` 为真时 path / version / source 一定有值 */
export interface DepProbeResult {
  ok: boolean;
  /** 命中的可执行文件（第二/三段时是完整路径，第一段可能是名字） */
  path: string;
  /** 版本号文本；探测不到或解析不出时为空串 */
  version: string;
  /** 只有 ok 时有意义 */
  source: DepSource | null;
  /** 失败原因（回给用户/日志用的人话） */
  reason: string;
  /** 命中的候选文件所在目录；第一段（用户指定）时为 null（那是他自己管的） */
  dir: string | null;
}

// ──────────────────────────────── 进程探测 ────────────────────────────────

/** PowerShell 的 -EncodedCommand 要 UTF-16LE base64（与 tools/pwsh.ts 同一约定） */
function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 跑一次版本命令并收集输出。ENOENT（没这个文件）与超时都只是"这个候选不可用"，
 * 不是异常——探测链的整条意义就是"一路试过去"，任何一处失败都不该中断它。
 */
export function runProbeCommand(
  exe: string,
  args: readonly string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DepProcessResult> {
  return new Promise<DepProcessResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: DepProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish({ code: null, stdout: '', stderr: String(err), failed: true, timedOut: false });
      return;
    }

    timer = setTimeout(() => {
      // 探测超时只杀直接子进程：这里没有"命令派生出后代"的场景（与 pwsh 工具不同），
      // 为一个读版本号的进程去 taskkill 整棵树反而是更大的动作
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      finish({ code: null, stdout, stderr, failed: true, timedOut: true });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.on('error', (err: Error) => {
      finish({ code: null, stdout, stderr: stderr === '' ? err.message : stderr, failed: true, timedOut: false });
    });
    child.on('close', (code: number | null) => {
      finish({ code, stdout, stderr, failed: false, timedOut: false });
    });
  });
}

// ──────────────────────────────── 依赖定义 ────────────────────────────────

/**
 * 把 `7.4.6` / `5.1.26100.9444` 这类版本串取前两段做比较。
 * 只做"主版本够不够"这一件事：三个依赖的判据都是主版本级别（7+ / 13+ / 1.1+），
 * 写一个完整的 semver 比较器只会带来没人用的复杂度。
 */
export function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version
    .split(/[.\-+]/u)
    .map((piece) => Number.parseInt(piece, 10))
    .filter((value) => Number.isFinite(value));
  for (let i = 0; i < min.length; i++) {
    const want = min[i] ?? 0;
    // 缺失位按 0 处理（`1` 就是 `1.0.0`）：报出来的版本号位数不固定
    // （PowerShell 的 5.1 与 5.1.26100.9444 是同一个版本），位数不同不该判成"不满足"
    const got = parts[i] ?? 0;
    if (got > want) return true;
    // 相等必须**继续比下一位**：直接落到末尾的 return true 会让 `7.0.0 >= [7,1]` 被误判为满足
    if (got < want) return false;
  }
  return true;
}

/** rg --version 的第一行形如 `ripgrep 15.1.0 (rev ...)`；取版本号那一段 */
function parseRipgrepVersion(stdout: string): string | null {
  const matched = /ripgrep\s+(\d+\.\d+(?:\.\d+)?)/u.exec(stdout);
  return matched === null ? null : matched[1]!;
}

/** es -version 的输出就是一行版本号（实测 1.1.0.27 / ES 1.1.0.38 两种都见过） */
function parseEsVersion(stdout: string): string | null {
  const matched = /(\d+\.\d+\.\d+(?:\.\d+)?)/u.exec(stdout);
  return matched === null ? null : matched[1]!;
}

/** PowerShell 的版本串（`$PSVersionTable.PSVersion.ToString()` 的一行输出） */
function parsePowerShellVersion(stdout: string): string | null {
  const first = stdout.trim().split(/\r?\n/u)[0]?.trim() ?? '';
  return /^\d+(\.\d+)*$/u.test(first) ? first : null;
}

/** pwsh 的版本探测参数：`-EncodedCommand` 是本仓库唯一不会误解码的通道（含中文路径） */
function pwshVersionArgs(): readonly string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    toEncodedCommand('$PSVersionTable.PSVersion.ToString()')];
}

/**
 * 三个内置依赖的定义。`candidates` 只列**真实存在的可执行名**，
 * 不在这里写死 `C:\Program Files\...` 这种安装位置——那种路径进了候选表就意味着
 * 每次探测都要为它们各付一次 ENOENT（review v27 的 Σ-5 就是这么攒出来的）。
 * 系统装机位置由 `extraSearchDirs` 一处集中处理（见下），只在自装目录没命中时才用。
 */
export const DEP_SPECS: Readonly<Record<DepName, DependencySpec>> = {
  pwsh: {
    name: 'pwsh',
    label: 'PowerShell 7（pwsh）',
    // 用户原话："pwsh7 应该也作为一个框架管理的依赖，要求安装。工具默认使用 pwsh7"
    purpose: 'pwsh 工具的默认 shell；工具的第一条通道',
    impact: '没有它时 pwsh 工具如实回退到 Windows PowerShell 5.1（多数命令照跑，'
      + '但 5.1 与 7 的语法与默认编码有差异，每次都只做到"能用"）',
    install: 'manual',
    manualHint: PWSH_WINGET_HINT,
    downloadPage: PWSH_DOWNLOAD_PAGE,
    candidates: ['pwsh.exe', 'pwsh'],
    versionArgs: pwshVersionArgs,
    // 判据是**主版本 ≥ 7**：powershell.exe 5.1 也是一个能跑的 shell，但它不是 pwsh 7，
    // 装上它不算满足（它是回退选项，由 pwsh 工具在回执里如实标出来）
    parseVersion: (stdout) => {
      const version = parsePowerShellVersion(stdout);
      if (version === null) return null;
      return versionAtLeast(version, [7]) ? version : null;
    },
    parseAnyVersion: parsePowerShellVersion,
    minVersion: '7.0',
  },
  rg: {
    name: 'rg',
    label: 'ripgrep（rg）',
    purpose: 'rg_search 的引擎；按内容搜索',
    impact: '没有它时 rg_search **不注册**：模型看到的是"没有这件工具"，'
      + '而不是一件每次调用都失败的搜索工具',
    install: 'zip',
    manualHint: null,
    downloadPage: RIPGREP_DOWNLOAD_PAGE,
    // PATH 上 npm 之类的包装器会给 rg.cmd；.exe 在前，因为它是官方 release 的形态
    candidates: ['rg.exe', 'rg.cmd', 'rg.bat', 'rg'],
    versionArgs: () => ['--version'],
    parseVersion: (stdout) => parseRipgrepVersion(stdout),
    parseAnyVersion: parseRipgrepVersion,
    minVersion: '13.0',
  },
  es: {
    name: 'es',
    label: 'Everything 命令行（es.exe）',
    purpose: 'es_search 的引擎；按文件名搜索（Everything 的索引）',
    impact: '没有它时 es_search **不注册**（装 Everything 主程序不会带上 es.exe，'
      + '它是 voidtools 单独发布的命令行包）',
    install: 'zip',
    manualHint: null,
    downloadPage: ES_DOWNLOAD_PAGE,
    candidates: ['es.exe', 'es'],
    // es 的版本参数是单横线 `-version`（不是 --version），且它对 Everything 客户端
    // 是否在跑不敏感——探测只读它自己的版本号
    versionArgs: () => ['-version'],
    parseVersion: (stdout) => {
      const version = parseEsVersion(stdout);
      if (version === null) return null;
      return versionAtLeast(version, [1, 1]) ? version : null;
    },
    parseAnyVersion: parseEsVersion,
    minVersion: '1.1',
  },
};

// ──────────────────────────────── 单次探测 ────────────────────────────────

/**
 * 探测一个依赖的一个候选。（内部函数：候选遍历与三段顺序在 manager.ts，
 * 这里只负责"给定可执行文件，它可用吗、什么版本"。）
 *
 * 返回 `matched`（解析出的任何版本，不管够不够）与 `ok`（够不够）两件事，
 * 是为了让上层能区分**「装了但版本不符」与「根本没装」**——这两句话对用户的意义完全不同：
 * 前者是他该升级，后者是他该安装。都报"未安装"会让人去装一个已经装了的东西。
 */
export interface CandidateProbe {
  result: DepProbeResult;
  /** 输出里解析出的版本（不论是否满足最低要求）；解析不出为空串 */
  anyVersion: string;
}

export async function probeCandidate(
  spec: DependencySpec,
  exe: string,
  source: DepSource | null,
  options: DepProbeOptions = {},
): Promise<CandidateProbe> {
  const run = await runProbeCommand(exe, spec.versionArgs(), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  return judgeCandidate(spec, exe, source, run);
}

/**
 * 判定一次探测输出。与"怎么拿到输出"分开，是因为测试要注入的只有后者
 * （假进程层），判定必须永远是真代码——如果把判定也一起替掉，那验的就不是实现了。
 */
export function judgeCandidate(
  spec: DependencySpec,
  exe: string,
  source: DepSource | null,
  run: DepProcessResult,
): CandidateProbe {
  const stdout = `${run.stdout}\n${run.stderr}`;

  if (run.timedOut) {
    return {
      result: { ok: false, path: exe, version: '', source: null, reason: `${exe} 探测超时`, dir: null },
      anyVersion: '',
    };
  }
  if (run.failed && run.code === null) {
    // ENOENT 走这里：没有这个文件。这是**正常**结果，不是错误
    return {
      result: {
        ok: false, path: exe, version: '', source: null,
        reason: `${exe} 无法启动（${run.stderr.trim() || 'ENOENT'}）`, dir: null,
      },
      anyVersion: '',
    };
  }

  const anyVersion = spec.parseAnyVersion?.(stdout) ?? '';
  const version = spec.parseVersion(run.stdout, run);
  if (version !== null) {
    return {
      result: { ok: true, path: exe, version, source, reason: '', dir: null },
      anyVersion: version,
    };
  }

  const reason = anyVersion === ''
    ? `${exe} 没有输出可识别的版本号（退出码 ${run.code ?? 'null'}：${stdout.trim().slice(0, 120) || '无输出'}）`
    : `${exe} 版本 ${anyVersion} 低于要求的 ${spec.minVersion}`;
  return {
    result: { ok: false, path: exe, version: '', source: null, reason, dir: null },
    anyVersion,
  };
}

/**
 * 一个依赖的完整探测（不含缓存）：用户指定 → 自装目录 → PATH。
 *
 * `dirs` 由调用方给出（manager 才知道 dataDir 与 config）：
 *   · `configPath`：用户在配置里指的路径（undefined = 没指定）；
 *   · `managedDir`：`<dataDir>/tools/<name>/`；
 *   · `extraSearchDirs`：系统的常见安装位置（只在前两段都没命中时才试）。
 *
 * 返回 `attempts` 是为了让报告能说清"试过哪几个地方"——用户看到
 * 「未安装（已试：config 未指定 / D:\...\tools\rg / PATH 上的 rg.exe）」才知道下一步动哪里。
 */
export interface DependencyProbeOutcome {
  name: DepName;
  status: DepStatus;
  /** 命中（或"解析出版本但不够"）的那个可执行文件；全都没找到时为空串 */
  path: string;
  version: string;
  /** 输出里解析出的任何版本（用于区分 mismatch 与 missing） */
  anyVersion: string;
  source: DepSource | null;
  dir: string | null;
  reason: string;
  /** 试过的位置（人话），顺序即探测顺序 */
  attempts: string[];
}

export interface ProbeDependencyInput {
  configPath?: string | undefined;
  managedDir: string;
  /** 自装目录里候选文件的**实际存在性检查**（测试注入用；默认走 fs.existsSync） */
  exists?: (path: string) => boolean;
  /** 自装目录里候选文件的枚举（测试注入用；默认读目录） */
  listDir?: (dir: string) => string[];
  extraSearchDirs?: readonly string[];
  timeoutMs?: number;
  /**
   * 进程探测的注入点（测试用假可执行文件）。**默认走真 spawn**。
   *
   * 为什么探测要留这个口子：这一层的正确性几乎全在"失败了怎么办"上
   * （候选不存在、超时、版本不符、用户指定了一条坏路径）——那些分支用手写的假进程
   * 一验就准，而"先在本机装一个 5.1 的 pwsh"是没法验的。测试注入的是**进程**，
   * 不是判定：版本解析与三段顺序仍然是真代码在跑。
   */
  runProbe?: ((exe: string) => Promise<DepProcessResult>) | undefined;
}

/** 把一个候选交给探测判定；`run` 是注入点，默认是真 spawn */
async function probeCandidateWith(
  spec: DependencySpec,
  exe: string,
  source: DepSource | null,
  options: DepProbeOptions,
  run?: ((exe: string) => Promise<DepProcessResult>) | undefined,
): Promise<CandidateProbe> {
  if (run === undefined) return await probeCandidate(spec, exe, source, options);
  return judgeCandidate(spec, exe, source, await run(exe));
}

export async function probeDependency(
  spec: DependencySpec,
  input: ProbeDependencyInput,
): Promise<DependencyProbeOutcome> {
  const exists = input.exists ?? defaultExists;
  const listDir = input.listDir ?? defaultListDir;
  const attempts: string[] = [];
  let sawVersion = '';

  const record = (
    status: DepStatus,
    path: string,
    version: string,
    anyVersion: string,
    source: DepSource | null,
    dir: string | null,
    reason: string,
  ): DependencyProbeOutcome => ({
    name: spec.name, status, path, version, anyVersion, source, dir, reason, attempts,
  });

  // ① 用户在 config 里指定的路径：人明确指过就以他为准。
  // 指错了不静默落到后两段——那会变成"我配了却不生效"，比直接报错难查得多。
  const configured = input.configPath?.trim() ?? '';
  if (configured !== '') {
    attempts.push(`config: ${configured}`);
    const probed = await probeCandidateWith(spec, configured, 'config', { ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) }, input.runProbe);
    if (probed.result.ok) {
      return record('ready', configured, probed.result.version, probed.anyVersion, 'config', null, '');
    }
    sawVersion = sawVersion === '' ? probed.anyVersion : sawVersion;
    return record(
      probed.anyVersion === '' ? 'missing' : 'version-mismatch',
      configured, '', probed.anyVersion, null, null,
      `配置里指定的 ${spec.name} 不可用：${probed.result.reason}。`
      + '（用户指定的路径不会被 PATH 上的同名程序顶替——改配置或删掉这一项再试）',
    );
  }
  attempts.push('config: 未指定');

  // ② 框架自装目录：一键安装的落点
  const managed = findExecutableInDir(spec.candidates, input.managedDir, exists, listDir);
  if (managed !== null) {
    attempts.push(`managed: ${managed}`);
    const probed = await probeCandidateWith(spec, managed, 'managed', { ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) }, input.runProbe);
    if (probed.result.ok) {
      return record('ready', managed, probed.result.version, probed.anyVersion, 'managed', input.managedDir, '');
    }
    sawVersion = sawVersion === '' ? probed.anyVersion : sawVersion;
    attempts.push(`managed 内的 ${managed} 不可用：${probed.result.reason}`);
  } else {
    attempts.push(`managed: ${input.managedDir} 下没有 ${spec.candidates.join(' / ')}`);
  }

  // ③ PATH（+ 系统常见安装位置）
  const pathCandidates: string[] = [...spec.candidates];
  for (const dir of input.extraSearchDirs ?? []) {
    for (const name of spec.candidates) pathCandidates.push(join(dir, name));
  }
  const failures: string[] = [];
  for (const candidate of pathCandidates) {
    const probed = await probeCandidateWith(spec, candidate, 'path', { ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) }, input.runProbe);
    if (probed.result.ok) {
      return record('ready', candidate, probed.result.version, probed.anyVersion, 'path', null, '');
    }
    if (probed.anyVersion !== '' && sawVersion === '') sawVersion = probed.anyVersion;
    failures.push(probed.result.reason);
  }
  attempts.push(`path: 试过 ${pathCandidates.join(' / ')}`);

  if (sawVersion !== '') {
    return record(
      'version-mismatch', '', '', sawVersion, null, null,
      `找到 ${spec.name}，但版本 ${sawVersion} 低于要求的 ${spec.minVersion}：请升级。`,
    );
  }
  return record(
    'missing', '', '', '', null, null,
    `未找到 ${spec.name}（最低要求 ${spec.minVersion}）。已试：${attempts.join('；')}。`
    + (failures.length > 0 ? `最近一次失败：${failures[failures.length - 1]}` : ''),
  );
}

/**
 * 目录里的可执行文件定位：**探测与安装的复检共用这一个实现**。
 *
 * 为什么必须共用：安装的复检（`install.ts`）要找"刚落地的那个 exe"，
 * 而日常探测要找"自装目录里那个 exe"——两处若各写一套，就会出现
 * "装完了但复检说找不到"这种最让人火大的结果。实测踩过：voidtools 的 CLI 包里
 * `es.exe` 在 `x64/` 子目录下（`ES-1.1.0.38/x64/es.exe`），只查根目录就会复检失败，
 * 而文件明明躺在那儿。
 *
 * 为什么要容忍一层子目录：zip 解压出来的结构不总是一层——ripgrep 的 release 包
 * 解压后是 `ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe`，我们**刻意把这一层剥掉**
 * （见 install.ts），但手工把 zip 丢进目录的人不会剥；es 的包更是自带 `x64/` 这一层。
 * 多探一层子目录的代价是一次 readdir，收益是"用户自己解压进去也能被认出来"。
 */
export function findExecutableInDir(
  candidates: readonly string[],
  dir: string,
  exists: (path: string) => boolean,
  listDir: (dir: string) => string[],
): string | null {
  for (const name of candidates) {
    const direct = join(dir, name);
    if (exists(direct)) return direct;
  }
  // 一层子目录（zip 自带的那层）：按名字排序保证同一台机器上结论稳定
  let entries: string[] = [];
  try {
    entries = listDir(dir).slice().sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    for (const name of candidates) {
      const nested = join(dir, entry, name);
      if (exists(nested)) return nested;
    }
  }
  return null;
}

/** 默认存在性检查。目录不算（PATH 上可能有个同名目录，spawn 它会得到一个难懂的错误） */
function defaultExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir).map((entry) => String(entry));
  } catch {
    return [];
  }
}

/**
 * 默认的文件系统两件套（存在性 / 单层枚举）。
 *
 * 放在这里而不是 manager.ts 的理由与 `findExecutableInDir` 相同：**安装与探测必须用同一套**。
 * 三处的依赖方向是刻意的单向链——`probe`（叶子）← `install` ← `manager`，没有循环；
 * 把共享件放到中间层会立刻制造一个环。
 */
export const defaultDepFs = {
  exists: (path: string): boolean => defaultExists(path),
  listDir: (dir: string): string[] => defaultListDir(dir),
};

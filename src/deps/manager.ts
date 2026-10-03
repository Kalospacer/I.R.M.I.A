/**
 * Irmia Agent — 外部依赖管理器（探测缓存 + 一键安装 + 复检刷新）
 *
 * 这个类是"外部依赖交给框架管"这句话的落点。三件事必须在**同一个对象**里：
 *   ① **探测只做一次、结论缓存**（review v27 的 Σ-5：`es_search` 的条件注册在建注册表时
 *      串行试 5 个候选、每个候选一次 ENOENT）。现在启动路径上的候选遍历只发生一次，
 *      `rg_search` / `es_search` / `pwsh` 三处共用同一份结论——不会出现"注册时说没有、
 *      执行时又说有"的自相矛盾；
 *   ② **结论可刷新**：装完复检要能改写缓存。如果缓存在进程启动时算一次就永远不动，
 *      用户点完「安装」还得重启进程才认账，那是半成品；
 *   ③ **安装与探测看同一个目录**：`<dataDir>/tools/<name>/` 是唯一的自装落点，
 *      探测的第二段与安装的目标目录由同一个函数给出（`managedDirFor`）。
 *
 * 为什么是类而不是散函数：缓存与"复检后刷新"是同一份状态的两面。散函数要用模块级变量，
 * 那样测试之间会互相污染（前一条用例的缓存漏进下一条），而这个模块的日志恰好是测试的重点。
 * 测试用 `options.probe` 注入假探测——**绝不让测试依赖本机装没装**。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { existsSync, readdirSync } from 'node:fs';
import { get as httpsGet } from 'node:https';

import {
  DEP_NAMES,
  DEP_SPECS,
  ES_DOWNLOAD_PAGE,
  probeDependency,
  probeCandidate,
  PWSH_DOWNLOAD_PAGE,
  PWSH_WINGET_HINT,
  TOOLS_DIR_NAME,
  type DepAction,
  type DependencyProbeOutcome,
  type DependencySpec,
  type DepName,
  type DepProbeOptions,
  type DepProbeResult,
} from './probe.ts';
import {
  downloadWithNode,
  ES_CLI_ZIP_URL,
  installZipDependency,
  managedDirFor,
  resolveRipgrepAsset,
  type DepInstallOutcome,
  type Downloader,
  type ZipPackage,
} from './install.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 系统常见安装位置（只在自装目录没命中时才试，见 probe.ts 的三段顺序） */
const EXTRA_SEARCH_DIRS: Readonly<Record<DepName, readonly string[]>> = {
  pwsh: ['C:\\Program Files\\PowerShell\\7', 'C:\\Program Files\\PowerShell\\7-preview'],
  rg: [],
  es: [
    'C:\\Program Files\\Everything',
    'C:\\Program Files (x86)\\Everything',
    'C:\\Program Files\\Everything 1.5a',
  ],
};

/** 用户 config 里的路径字段名（`deps.paths.<name>`）；与依赖名同名，不另起一套 */
export interface DepPathOverrides {
  pwsh?: string | undefined;
  rg?: string | undefined;
  es?: string | undefined;
}

// ──────────────────────────────── 报告形状（GET /api/deps 与 GUI 卡片共用） ────────────────────────────────

export interface DepReportEntry {
  name: DepName;
  label: string;
  /** 状态三态：ready / version-mismatch / missing（界面徽章直接照它上色） */
  status: DependencyProbeOutcome['status'];
  ok: boolean;
  /** 探测到的可执行文件（就绪时非空） */
  path: string;
  version: string;
  source: DependencyProbeOutcome['source'];
  /** 探测顺序里试过的位置（"下一步该动哪里"要看它） */
  attempts: string[];
  /** 失败原因（人话，含下一步） */
  reason: string;
  /** 它是干什么的 */
  purpose: string;
  /** 没有它会发生什么（用户点名要"显式告知建议安装"——建议要带着代价说） */
  impact: string;
  /** 一键装 / 只提示 / 已就绪 */
  action: DepAction;
  installable: boolean;
  /** 手动安装的指令或下载页（一键装时为 null） */
  manualHint: string | null;
  downloadPage: string | null;
  /** 最低要求（界面显示"需要 7.0"） */
  minVersion: string;
  /** 框架自装目录（`<dataDir>/tools/<name>`） */
  managedDir: string;
}

export interface DepsReport {
  dataDir: string;
  /** 自装目录根（`<dataDir>/tools`） */
  toolsDir: string;
  /** 建议动作汇总：有没有需要用户处理的事 */
  needsAttention: boolean;
  entries: DepReportEntry[];
  /** 生成时刻（界面显示"刚刚探测"） */
  generatedAt: string;
}

// ──────────────────────────────── 选项 ────────────────────────────────

export interface DepsManagerOptions {
  /** 数据目录：自装落点是 `<dataDir>/tools/<name>/` */
  dataDir: string;
  /** 用户在 config 里指定的路径（`deps.paths`） */
  configPaths?: DepPathOverrides | undefined;
  /**
   * 旧字段（`ripgrepPath` / `everythingPath`）的兼容入口。
   * 语义与 fs 工具包当年的口径一致：`undefined` = 自动探测，`null` = 显式禁用，
   * 字符串 = 指定路径（等价于 configPaths 里那一项）。
   */
  ripgrepPath?: string | null | undefined;
  everythingPath?: string | null | undefined;
  /** 探测覆盖点（测试用）：给了就不碰真实进程与文件系统 */
  probe?: ((name: DepName, spec: DependencySpec) => Promise<DependencyProbeOutcome>) | undefined;
  /** 自装目录内候选文件的存在性检查覆盖点（测试用） */
  exists?: ((path: string) => boolean) | undefined;
  /** 自装目录枚举覆盖点（测试用） */
  listDir?: ((dir: string) => string[]) | undefined;
  /** 下载器覆盖点（测试用假源，绝不联网） */
  download?: Downloader | undefined;
  /** 文本型 URL 抓取覆盖点（GitHub release 查询那条路；测试注入假 JSON） */
  fetchText?: ((url: string) => Promise<string>) | undefined;
  /** 探测超时覆盖点 */
  probeTimeoutMs?: number | undefined;
  /** 探测结论变化时的通知（宿主据此写启动日志/告警） */
  onNote?: ((message: string) => void) | undefined;
  /**
   * 复检用的探测覆盖点（测试用）。**安装的三条路里，"复检"是唯一会真 spawn 一个
   * 刚落地的文件的那一步**——测试里那个文件是一段假字节，跑不起来。
   * 不给覆盖点时走真探测（生产路径就是真探测：装完必须真能跑才算装上）。
   */
  verifyProbe?: ((exePath: string) => Promise<{ version: string } | null>) | undefined;
}

// ──────────────────────────────── 管理器 ────────────────────────────────

export class DepsManager {
  readonly dataDir: string;
  /** 框架自装目录根：`<dataDir>/tools` */
  readonly toolsDir: string;

  readonly #options: DepsManagerOptions;
  readonly #cache = new Map<DepName, Promise<DependencyProbeOutcome>>();
  /** 探测计数器：测试用它断言"只探一次"（也是 review v27 Σ-5 的回归锁） */
  #probeCount = 0;

  constructor(options: DepsManagerOptions) {
    this.#options = options;
    this.dataDir = options.dataDir;
    this.toolsDir = `${options.dataDir}${sep()}${TOOLS_DIR_NAME}`;
  }

  /** 累计探测次数（一次 = 一个依赖走完三段顺序）。测试断言它的增长 */
  get probeCount(): number {
    return this.#probeCount;
  }

  /** 某个依赖的自装目录：`<dataDir>/tools/<name>/` */
  managedDir(name: DepName): string {
    return managedDirFor(this.dataDir, name);
  }

  /**
   * 取结论（缓存优先）。**第一次调用时才探测**——启动路径上只付一次代价的关键：
   * 三件依赖各探一次，而不是每件工具各探一次。
   */
  get(name: DepName): Promise<DependencyProbeOutcome> {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached;
    const pending = this.#probeOnce(name);
    this.#cache.set(name, pending);
    return pending;
  }

  /** 一次性探完全部依赖（需要完整报告时用；与逐个 get 共用缓存） */
  async getAll(): Promise<Record<DepName, DependencyProbeOutcome>> {
    const pairs = await Promise.all(DEP_NAMES.map(async (name) => [name, await this.get(name)] as const));
    return Object.fromEntries(pairs) as Record<DepName, DependencyProbeOutcome>;
  }

  /**
   * 丢弃缓存，下次 get 重新探测。**"安装后复检"就靠它**：
   * 装完调一次，三件工具下一次取结论时看到的就是新装的路径。
   */
  refresh(): void {
    this.#cache.clear();
  }

  /** 复检一个具体文件（安装编排内部用）：**绕过缓存**，直接问这个 exe 能不能跑 */
  async verifyExecutable(name: DepName, exePath: string): Promise<DepProbeResult> {
    const injected = this.#options.verifyProbe;
    if (injected !== undefined) {
      const verified = await injected(exePath);
      return verified === null
        ? { ok: false, path: exePath, version: '', source: null, reason: '复检未通过（测试注入）', dir: null }
        : { ok: true, path: exePath, version: verified.version, source: 'managed', reason: '', dir: null };
    }
    const spec = DEP_SPECS[name];
    const probed = await probeCandidate(
      spec,
      exePath,
      'managed',
      this.#options.probeTimeoutMs === undefined ? {} : { timeoutMs: this.#options.probeTimeoutMs },
    );
    return probed.result;
  }

  /**
   * 一键安装。可一键装的只有 zip 型（rg / es）；pwsh 是 manual——见 `packageFor`。
   */
  async install(name: DepName): Promise<DepInstallOutcome> {
    const pkg = packageFor(name, this.#options.fetchText ?? fetchTextWithNode);
    if (pkg === null) {
      return {
        ok: false,
        step: 'download',
        name,
        error: `${DEP_SPECS[name].label} 不支持一键安装（${
          DEP_SPECS[name].manualHint ?? '需要人工安装'
        }）。请在 GUI 里点「打开下载页」按官方方式安装。`,
        details: [
          '为什么不做自动安装：pwsh 的 Windows 分发是 MSI/winget/微软商店包，'
          + '静默安装要提权（UAC），而无人值守进程里弹 UAC 只会得到一个卡住的安装器；'
          + 'MSIX 版本更是无法被 PATH 直接调用。所以这一件只做"提示 + 一键打开下载页"。',
          ...(DEP_SPECS[name].downloadPage === null ? [] : [`下载页：${DEP_SPECS[name].downloadPage}`]),
        ],
      };
    }

    const outcome = await installZipDependency({
      name,
      pkg,
      dataDir: this.dataDir,
      download: this.#options.download ?? downloadWithNode,
      verify: async (exePath) => {
        const verified = await this.verifyExecutable(name, exePath);
        return verified.ok ? { version: verified.version } : null;
      },
      ...(this.#options.fetchText === undefined ? {} : { fetchText: this.#options.fetchText }),
    });

    if (outcome.ok) {
      // 复检通过才刷新缓存：失败时刷新会白付一次探测代价，也掩盖不了"还是找不到"
      this.refresh();
      this.#note(`[依赖] ${DEP_SPECS[name].label} 已安装到 ${outcome.dir}（版本 ${outcome.version}）`);
    } else {
      this.#note(`[依赖] ${DEP_SPECS[name].label} 安装未完成（${outcome.step}）：${outcome.error}`);
    }
    return outcome;
  }

  /** 完整报告（GET /api/deps）：三件依赖的探测结果 + 建议动作 + 自装目录路径 */
  async report(now: () => Date = () => new Date()): Promise<DepsReport> {
    const all = await this.getAll();
    const entries = DEP_NAMES.map((name) => this.#entry(name, all[name]));
    return {
      dataDir: this.dataDir,
      toolsDir: this.toolsDir,
      needsAttention: entries.some((entry) => entry.action !== null),
      entries,
      generatedAt: now().toISOString(),
    };
  }

  // ── 内部 ──

  #note(message: string): void {
    this.#options.onNote?.(message);
  }

  #entry(name: DepName, outcome: DependencyProbeOutcome): DepReportEntry {
    const spec = DEP_SPECS[name];
    const installable = spec.install === 'zip';
    return {
      name,
      label: spec.label,
      status: outcome.status,
      ok: outcome.status === 'ready',
      path: outcome.path,
      version: outcome.version,
      source: outcome.source,
      attempts: outcome.attempts,
      reason: outcome.reason,
      purpose: spec.purpose,
      impact: spec.impact,
      action: outcome.status === 'ready' ? null : (installable ? 'install' : 'open-download'),
      installable,
      manualHint: spec.manualHint,
      downloadPage: spec.downloadPage,
      minVersion: spec.minVersion,
      managedDir: this.managedDir(name),
    };
  }

  /** 一次完整的依赖探测（三段顺序在 probe.ts）。这是唯一给计数加一的地方 */
  async #probeOnce(name: DepName): Promise<DependencyProbeOutcome> {
    this.#probeCount += 1;
    const spec = DEP_SPECS[name];
    const outcome = await (this.#options.probe?.(name, spec)
      ?? probeDependency(spec, {
        configPath: this.#configPathFor(name),
        managedDir: this.managedDir(name),
        ...(this.#options.exists === undefined ? {} : { exists: this.#options.exists }),
        ...(this.#options.listDir === undefined ? {} : { listDir: this.#options.listDir }),
        extraSearchDirs: EXTRA_SEARCH_DIRS[name],
        ...(this.#options.probeTimeoutMs === undefined ? {} : { timeoutMs: this.#options.probeTimeoutMs }),
      }));
    return outcome;
  }

  /**
   * 用户指定的路径。三段顺序的第一段只有一个来源，但有两个入口：
   * 新的 `deps.paths.<name>`（配置）与旧的 `ripgrepPath` / `everythingPath`（测试与老调用方）。
   * 新字段优先——迁移期间两边都写了就以配置为准。
   */
  #configPathFor(name: DepName): string | undefined {
    const fromConfig = this.#options.configPaths?.[name];
    if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim();
    if (name === 'rg' && typeof this.#options.ripgrepPath === 'string' && this.#options.ripgrepPath !== '') {
      return this.#options.ripgrepPath;
    }
    if (name === 'es' && typeof this.#options.everythingPath === 'string' && this.#options.everythingPath !== '') {
      return this.#options.everythingPath;
    }
    return undefined;
  }
}

// ──────────────────────────────── 包描述 ────────────────────────────────

/**
 * 可一键安装的包的地址来源。
 *
 * `rg`：GitHub release 的 `x86_64-pc-windows-msvc.zip`——**用 API 查最新版**而不是写死版本号，
 * 因为写死的那一刻就开始过期，而这个依赖是"要求安装"的（过期意味着新用户装不上）。
 * `es`：voidtools 的 CLI 包是固定链接（历史上 1.1.0.27 → 1.1.0.38 地址不变），
 * 但 URL 里嵌着版本号，升版时会 404——那时报"下载失败：HTTP 404"并给下载页，不静默失败。
 * `pwsh`：**刻意不提供**（见 install() 里的理由）。
 *
 * `fetchText` 从这里透传下去（而不是包内部自己抓），测试注入的假 JSON 才能生效。
 */
export function packageFor(
  name: DepName,
  fetchText: (url: string) => Promise<string> = fetchTextWithNode,
): ZipPackage | null {
  if (name === 'rg') {
    return {
      name: 'rg',
      // 兜底地址：GitHub 的 latest 重定向端点（它自己会解析到最新 release；资产名里带版本号，
      // 所以这条兜底在版本升级后会 404——那时走 API 那条路，或由用户手动装）
      url: 'https://github.com/BurntSushi/ripgrep/releases/latest/download/'
        + 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
      resolveUrl: () => resolveRipgrepAsset(fetchText),
      exeNames: ['rg.exe'],
    };
  }
  if (name === 'es') {
    return { name: 'es', url: ES_CLI_ZIP_URL, exeNames: ['es.exe'] };
  }
  return null;
}

/**
 * GitHub API 的文本抓取：与下载走同一条 `node:https` 通道（不引包，也不落盘——
 * 这个响应是几 KB 的 JSON，读完就丢）。
 */
export function fetchTextWithNode(url: string, timeoutMs = 30_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = httpsGet(
      url,
      { headers: { 'user-agent': 'irmia-agent-deps/1.0', accept: 'application/vnd.github+json' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve(text));
        response.on('error', (err: Error) => reject(err));
      },
    );
    request.on('error', (err: Error) => reject(err));
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`查询超时（${timeoutMs}ms）`));
    });
  });
}

/** 平台分隔符：自装目录路径给人看，用系统自己的形状 */
function sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

// ──────────────────────────────── 出厂默认 ────────────────────────────────

/**
 * 出厂管理器（不注入任何假探测）。**探测是惰性的**：构造它不会跑任何进程，
 * 第一次 `get()` 才探——CLI 只读场景（replay / doctor）也就能白拿一份缓存。
 */
export function createDepsManager(options: DepsManagerOptions): DepsManager {
  return new DepsManager(options);
}

/** 供测试与宿主共用的存在性/枚举默认实现（定义在 probe.ts：安装与探测共用同一套） */
export { defaultDepFs } from './probe.ts';

/** 报告里"未就绪"的那几件，拼一句启动日志（宿主用） */
export function summarizeNotReady(report: DepsReport): string[] {
  return report.entries
    .filter((entry) => !entry.ok)
    .map((entry) => {
      const state = entry.status === 'version-mismatch'
        ? `版本不符（需要 ${entry.minVersion}）`
        : '未安装';
      const hint = entry.installable
        ? '可在设置页「外部依赖」一键安装'
        : `装法：${entry.manualHint ?? entry.downloadPage ?? '见官方文档'}`;
      return `[依赖] ${entry.label} ${state}——${entry.impact}；${hint}`;
    });
}

export { DEP_NAMES, DEP_SPECS, PWSH_DOWNLOAD_PAGE, PWSH_WINGET_HINT, ES_DOWNLOAD_PAGE };
export type { DependencyProbeOutcome, DepName, DepProbeOptions };

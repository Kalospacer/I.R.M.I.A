/**
 * Irmia Agent — 内置协议端（可选开启的外部服务）
 *
 * **为什么要有它**：给 agent 多一条**独立的入站通道**——OneBot，背后是一个真实 QQ 号的社交圈
 * （好友与群聊），不受 QQ 开放平台的沙箱与审核限制。
 *
 * 它**不是**"官方 Bot 的群聊补丁"：2026-10-02 核过官方文档，全量群消息 `GROUP_MESSAGE_CREATE`
 * 用的就是 `GROUP_AND_C2C_EVENT (1<<25)` 那一个订阅位，平台上开了「接收所有消息」官方那条也
 * 收得到群消息（见 review.md 的「已了结（v32 遗留，2026-10-02）」）。两条通道各是一个独立的
 * 消息适配器，互不依赖——选哪条只看"想联络到谁"。
 *
 * 但协议端是个独立的长驻进程：让用户自己起它、自己把端口和 access_token 抄到两边，
 * 等于把框架该干的活推给人。所以这里把"拉起与对接"接过来。
 *
 * **为什么框架不打包它**：SnowLuma 用的是"源码可见非商业许可"，不是 OSI 开源许可——
 * 源码可看、可学、**可非商业自托管**，但商业使用与公开发布修改版都要事先书面授权，
 * 二进制发行包另受 EULA 约束。**自用没问题，随我们分发不行。**
 * 所以这个模块只做四件事：**探测 → 引导 → 拉起 → 对接**；安装由用户自己完成
 * （与 `deps` 那套"外部依赖交给框架管"同一个姿势，只是这一件更大、更该由人点头）。
 *
 * **对接为什么可以零配置**：SnowLuma 默认就在它的 `config/onebot.json` 里开一个 wsServer
 * （`127.0.0.1:3001`，与我们适配器的默认地址同值），access_token 也生成了写在那份文件里。
 * 所以框架**读它的配置**就够了——不需要人在两边各填一遍，也就不存在"两边填得不一样"这种故障。
 *
 * 与框架的关系：它是**她的眼睛**（看群），不是她的一部分。启动失败**不阻塞框架启动**——
 * 适配器按普通 OneBot 处理（连不上就重试），协议端起不来最多是"暂时看不到群"，
 * 不该让她整个停摆。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';

import { killProcessTree } from '../process/kill-tree.ts';

/** 服务状态机的取值（GUI 直接显示，所以用词要人能看懂） */
export type ManagedServiceState =
  /** 目录里没有可执行入口——多半还没下载 */
  | 'not-installed'
  /** 装好了但没跑 */
  | 'stopped'
  /** 已拉起，等它把端口开起来 */
  | 'starting'
  /** 端口通了，适配器可以连 */
  | 'ready'
  /** 起不来或中途死了（detail 带原因） */
  | 'failed';

export interface ManagedServiceStatus {
  state: ManagedServiceState;
  /** 一句话说明（给人看的，含失败原因） */
  detail: string;
  /** 进程号（跑起来时才有） */
  pid?: number;
  /** 对接点：从协议端自己的配置里读出来的（适配器直接用它连） */
  endpoint?: { wsUrl: string; accessToken: string };
  /** 协议端的 WebUI 地址（登录扫码在那儿做） */
  webuiUrl?: string;
}

export interface ManagedServiceOptions {
  /** 协议端安装目录（人指定的，框架不下载） */
  dir: string;
  /** 用哪个 node 跑它（默认当前进程的 execPath，保证与框架同版本） */
  nodePath?: string;
  /** 等端口就绪的上限（毫秒，默认 30s：NTQQ 起来慢） */
  readyTimeoutMs?: number;
  /** 日志出口（协议端的 stdout/stderr 逐行给这里） */
  onLog?: (line: string) => void;
  /** spawn 注入点（测试用；缺省走真实 spawn） */
  spawnFn?: typeof spawn;
}

/**
 * 发行包里可能出现的入口，按优先级探测。
 *
 * **`index.mjs` 排第一是实测来的**（v1.14.20 win-x64-lite 解压后的样子）：发行包根目录直接就是
 * `index.mjs`，没有 `dist/` 那一层——我最初按源码仓库的布局写成 `dist/index.mjs`，
 * 拿真包一试才发现找不到入口。`launcher.bat` 只是它的包装（查 node 版本 → `node ./index.mjs`），
 * 排在后面是因为它多一层 cmd 进程，而我们要收 stdout 与进程树。
 */
const ENTRY_CANDIDATES = ['index.mjs', 'dist/index.mjs', 'launcher.bat', 'launcher.sh'] as const;

/** 协议端的 OneBot 配置（相对于它的安装目录） */
const ONEBOT_CONFIG_PATH = 'config/onebot.json';

/**
 * 从协议端自己的配置里读出对接点。
 *
 * 只认 `networks.wsServers[0]`——那是它的**正向 WebSocket 服务端**，也正是我们适配器连的方向
 * （`wsClients` 是反向，方向相反，不是我们要的）。读不出来就返回 null，绝不猜一个端口：
 * 猜错的后果是连到别的本地服务上，比连不上更难查。
 *
 * 这个函数是纯的（只读一个文件），所以能单独断言——"配置读得对不对"是这条链上最容易悄悄坏掉的一环。
 */
export function readEndpointFromConfig(dir: string): {
  wsUrl: string;
  accessToken: string;
} | null {
  // ① 全局配置：人在它的 WebUI 里存过的那份
  const global = parseEndpoint(tryRead(join(dir, ONEBOT_CONFIG_PATH)));
  if (global !== null) return global;
  // ② 按账号的快照 `config/onebot_<uin>.json`：**第一次起来时它自己物化的那份**。
  //
  // 为什么必须看这里：SnowLuma 的 `OneBotManager` 用 `persistDefaults: true` 加载配置，
  // 而 `loadOneBotConfig` 在没有全局文件时走 `saveOneBotConfig(uin, config, { mode: 'snapshot' })`
  // ——落的是**按账号的完整快照**，全局文件根本不会出现。只读全局那份的后果是：
  // 拿空 token 去连一个**随机生成了 access_token 并开着校验**的端口，表现是"端口通了却一直连不上"，
  // 而且日志里只会看到鉴权失败，看不出是读配置读错了地方。
  //
  // 多个账号时取**最近改动的**那个：同时挂两个 QQ 是可能的，而我们只对接一个——
  // 取最新的至少是"他最近在用的那个"，比按文件名排序更接近意图。
  const perUin = listConfigFiles(join(dir, 'config'))
    .filter((name) => name.startsWith(PER_UIN_PREFIX) && name.endsWith('.json'))
    .map((name) => ({ name, mtime: mtimeOf(join(dir, 'config', name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of perUin) {
    const found = parseEndpoint(tryRead(join(dir, 'config', entry.name)));
    if (found !== null) return found;
  }
  return null;
}

/** 文件修改时间；读不到就当 0（排最后，不影响别的候选） */
function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** 按账号快照的文件名前缀（`onebot_<uin>.json`） */
const PER_UIN_PREFIX = 'onebot_';

function tryRead(p: string): string | null {
  try {
    return defaultRead(p);
  } catch {
    return null;
  }
}

/** 解析一份协议端配置里的第一个 wsServer；形状不对返回 null（**绝不猜一个端口**） */
function parseEndpoint(raw: string | null): { wsUrl: string; accessToken: string } | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const networks = (parsed as Record<string, unknown>)['networks'];
  if (typeof networks !== 'object' || networks === null) return null;
  const servers = (networks as Record<string, unknown>)['wsServers'];
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const first = servers[0];
  if (typeof first !== 'object' || first === null) return null;
  const s = first as Record<string, unknown>;
  const host = typeof s['host'] === 'string' && s['host'] !== '' ? s['host'] : '127.0.0.1';
  const port = typeof s['port'] === 'number' ? s['port'] : Number(s['port']);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const rawPath = typeof s['path'] === 'string' ? s['path'] : '/';
  const path = rawPath === '' ? '/' : rawPath;
  return {
    wsUrl: `ws://${host}:${port}${path}`,
    accessToken: typeof s['accessToken'] === 'string' ? s['accessToken'] : '',
  };
}

/** 列 config 目录下的文件名；目录不在就返回空（第一次跑之前是常态） */
function listConfigFiles(configDir: string): string[] {
  try {
    return readdirSync(configDir);
  } catch {
    return [];
  }
}

function defaultRead(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * 协议端 WebUI 的地址：登录（扫码）在那儿做。
 *
 * 端口写死 5099 是有依据的——SnowLuma 的文档明说"打开 http://localhost:5099，使用启动日志中的
 * 初始密码登录 WebUI"。它以后若改端口，这里会显示一个打不开的链接，**不会影响消息通路**
 * （消息走 OneBot 那条 ws，与 WebUI 无关），所以不值得为它做探测。
 */
export const DEFAULT_WEBUI_URL = 'http://localhost:5099';

export class ManagedProtocolService {
  private readonly options: ManagedServiceOptions;
  private child: ChildProcess | null = null;
  private state: ManagedServiceState = 'stopped';
  private detail = '';
  private endpoint: { wsUrl: string; accessToken: string } | undefined;
  /** 我们主动 stop 时置位：用来区分"它自己死了"与"我叫它停的" */
  private stopping = false;

  constructor(options: ManagedServiceOptions) {
    this.options = options;
  }

  /** 入口文件路径；找不到返回 null（= 还没装） */
  entryPath(): string | null {
    for (const rel of ENTRY_CANDIDATES) {
      const p = join(this.options.dir, rel);
      if (existsSync(p)) return p;
    }
    return null;
  }

  status(): ManagedServiceStatus {
    const out: ManagedServiceStatus = { state: this.state, detail: this.detail };
    if (this.child?.pid !== undefined) out.pid = this.child.pid;
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    if (this.state === 'ready' || this.state === 'starting') out.webuiUrl = DEFAULT_WEBUI_URL;
    return out;
  }

  /**
   * 拉起协议端并等它就绪。
   *
   * **不等它登录**：登录要人扫码，可能几分钟也可能明天——`ready` 的含义只是"端口通了，
   * 适配器可以去连了"。连上之后 QQ 那边的登录态由协议端自己维护，框架不掺和。
   */
  async start(): Promise<ManagedServiceStatus> {
    if (this.child !== null) return this.status();
    const entry = this.entryPath();
    if (entry === null) {
      this.state = 'not-installed';
      this.detail = `没找到可执行入口（找过 ${ENTRY_CANDIDATES.join(' / ')}）——请先下载协议端发行包并解压`;
      return this.status();
    }

    this.state = 'starting';
    this.detail = '正在拉起协议端…';
    const spawnFn = this.options.spawnFn ?? spawn;
    const isScript = entry.endsWith('.mjs') || entry.endsWith('.js');
    const nodePath = this.options.nodePath ?? process.execPath;
    const args = isScript ? [entry] : [];
    const child = isScript
      ? spawnFn(nodePath, args, { cwd: this.options.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawnFn(entry, [], { cwd: this.options.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.stopping = false;

    const relay = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
        if (line.trim() !== '') this.options.onLog?.(line);
      }
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.state = 'stopped';
        this.detail = '已停止';
        return;
      }
      this.state = 'failed';
      this.detail = `协议端自己退出了（code=${code ?? 'null'} signal=${signal ?? 'null'}）——日志见服务日志`;
    });

    // 等端口就绪：**以它的配置文件为准**轮询，文件还没生成时按默认端口探
    const endpoint = await this.waitReady(child);
    if (endpoint === null) {
      this.state = 'failed';
      this.detail = `等 ${Math.round((this.options.readyTimeoutMs ?? 30_000) / 1000)} 秒仍没等到 OneBot 端口——`
        + '它可能还没登录，或者启动失败了（日志见服务日志）';
      return this.status();
    }
    this.endpoint = endpoint;
    this.state = 'ready';
    this.detail = `已就绪，OneBot 在 ${endpoint.wsUrl}`;
    return this.status();
  }

  /** 停掉协议端（连同它的子进程——NTQQ 那层不杀干净会留孤儿） */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      this.state = 'stopped';
      this.detail = '已停止';
      return;
    }
    this.stopping = true;
    killProcessTree(child, { forceTree: true });
    this.child = null;
    this.state = 'stopped';
    this.detail = '已停止';
  }

  /**
   * 轮询等端口开起来。两种来源按优先级：
   *   ① 它的配置文件里写了哪个端口就探哪个（准）
   *   ② 文件还没生成时探默认的 3001（SnowLuma 默认值，也是我们适配器的默认值）
   * 探到之后**再读一次配置**取 token——端口通了文件必然已经写过。
   */
  private async waitReady(child: ChildProcess): Promise<{ wsUrl: string; accessToken: string } | null> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null || this.child === null) return null;
      const fromConfig = readEndpointFromConfig(this.options.dir);
      const probe = fromConfig ?? { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' };
      if (await canConnect(probe.wsUrl)) {
        // 端口通了：配置文件必然已落盘，重读一次拿准确值（含 token）
        return readEndpointFromConfig(this.options.dir) ?? probe;
      }
      await sleep(500);
    }
    return null;
  }
}

/** 把 ws URL 解析成 host/port 并做一次 TCP 连接测试（不握手——协议端开了端口就够） */
export async function canConnect(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  let host = '127.0.0.1';
  let port = 3001;
  try {
    const u = new URL(wsUrl);
    if (u.hostname !== '') host = u.hostname;
    if (u.port !== '') port = Number(u.port);
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** 把相对路径按安装目录解成绝对路径；已经是绝对的就不动它 */
export function resolveServiceDir(dir: string, baseDir: string): string {
  return isAbsolute(dir) ? dir : resolve(baseDir, dir);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms); });
}

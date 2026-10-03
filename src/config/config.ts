/**
 * Irmia Agent — 配置系统（M2 最小子集，对齐 docs/operations.md §1）
 *
 * 与 operations.md §1 的对应关系，逐条落地：
 *   • 单文件、人类可读可编辑 → `config.json`；
 *   • 版本链迁移钩子 → `schemaVersion` 与代码内置 `CONFIG_VERSION` 比较，按序执行
 *     `upgradeHooks`（每钩子随其 targetVersion 恰好触发一次，M6 填链，此处留接口）；
 *   • `configHash` 三指纹之一 → `configHash(config)` 只做 sha256(规范化 JSON)，
 *     与 renderVersion / personaHash 并列作为 `render()` 的确定性输入；
 *   • 密钥不落配置文件 → 文件里只有环境变量 **名**（`apiKeyEnv`），值只在
 *     `readApiKey()` 一处、在真正发起调用的瞬间从进程环境读。
 *
 * 格式决策（有意偏离 operations.md §1 的 TOML）：本期用 **JSON 语法子集**。
 * 理由：Node 自带解析、序列化必然合法（不会写出半截 TOML）、与事件日志同生态；
 * TOML 需要一个零依赖 mini 解析器，那是独立工作量且不影响任何字段语义。
 * 换成 TOML 时只需替换本文件的「读文本 → 文档对象」与「文档对象 → 写文本」两步，
 * 校验层、合并层、迁移层、指纹层全部不动。
 *
 * 注释约定：JSON 没有注释语法，本系统用 **`$` 前缀键** 充当注释（如 `$comment`，
 * 值可以是字符串数组，一行一条）。加载时被递归剔除；写回的默认配置带着它们，
 * 人类读得懂，删掉也不影响运行（`//` 键同样被忽略，照顾手写习惯）。
 *
 * 加载语义（每条都是刻意的）：
 *   • 文件缺失 → 生成带注释的默认配置并原子写回（operations.md §4 首次启动第 3 步）；
 *   • 文件存在但字段缺失 → 逐字段合并默认值，**不自动改写用户文件**（保住他手写的注释与排版）；
 *   • 文件里 JSON 非法 / 字段类型非法 → 抛 ConfigError，绝不静默回退默认
 *     （静默回退会把一次手误变成"配置看起来生效了但其实是默认值"的隐形故障）；
 *   • 版本低于代码 → 先备份原文件再走迁移钩子链；版本高于代码 → 明确报错退出。
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveKey, type KeyName } from './keys.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

export const CONFIG_FILE_NAME = 'config.json';

/**
 * 配置 schema 版本。与文件里的 `schemaVersion` 比较决定是否走迁移钩子链。
 * 事件 schema 版本另有其人（src/main.ts 的 SCHEMA_VERSION），两者解耦：
 * 配置变了不影响日志可读性，反之亦然。
 */
export const CONFIG_VERSION = 1;

/** 默认数据目录名（与 main.ts 的 DEFAULT_DATA_DIR_NAME 同义） */
export const DEFAULT_DATA_DIR_NAME = 'data';
/** 默认工作区目录名（operations.md §4：首次启动创建 workspace/） */
export const DEFAULT_WORKSPACE_DIR_NAME = 'workspace';
/** 默认模型与端点：DeepSeek 兼容 /responses 契约（与 src/model/ds-client.ts 对齐） */
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
/** 默认密钥环境变量名：配置文件里只放名字，不放值 */
export const DEFAULT_API_KEY_ENV = 'IRMIA_API_KEY';
/** 默认 QQ Bot AppID 环境变量名（与密钥同理：这里只放名字） */
export const DEFAULT_QQ_APP_ID_ENV = 'QQ_BOT_APP_ID';
/** 默认 QQ Bot ClientSecret 环境变量名 */
export const DEFAULT_QQ_CLIENT_SECRET_ENV = 'QQ_BOT_CLIENT_SECRET';
/**
 * 群消息攒批窗口默认 3 分钟：够攒两句上下文，又不至于让人等太久（0 = 每条都唤醒）
 */
export const DEFAULT_QQ_GROUP_BATCH_MINUTES = 3;
/**
 * `ask_human` 之后多久没人答就落一条「未批准、未拒绝」的事实（design §6.1，默认 30 分钟）。
 *
 * 为什么是 30 分钟（而不是跟 plan 挂起那条 24h 一个数量级）：
 *   • 人在机器旁时，一张卡"看到 → 打字 → 提交"是几十秒的事，30 分钟是它的十几二十倍，
 *     足够排除"他正在看但还没答完"；
 *   • 她问的往往是她正卡住的那件事。半小时还没人答，"他不在"就是一条**值得据此换路**的
 *     判断（走 QQ 还是先绕开），再晚就白等了一场；
 *   • 24h 那条是**任务层暂停**（一个资源决定，误判的代价大），这条只是"有没有人在"的事实
 *     判断（误判的代价是她多说一句/多试一条路）：两条不该共用一个数量级。
 *
 * 再说一次它**不是默认动作**：超时不批准、不拒绝、不撤卡，只产生事实（§6.1）。
 */
export const DEFAULT_ASK_HUMAN_TIMEOUT_MIN = 30;
/** 默认 OneBot（NapCat 等协议端）正向 ws 地址：协议端默认监听 3001 */
export const DEFAULT_ONEBOT_WS_URL = 'ws://127.0.0.1:3001';
/** 默认 OneBot access_token 环境变量名（与 QQ 同理：配置里只放名字） */
export const DEFAULT_ONEBOT_ACCESS_TOKEN_ENV = 'ONEBOT_ACCESS_TOKEN';
/** 注释键前缀：以它开头的键在加载时被递归忽略 */
export const COMMENT_PREFIX = '$';
/** 环境变量名形状：用来把「把密钥值误填进 apiKeyEnv」当场抓出来 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * 每日记忆整理的默认 cron（design.md §4.17）：凌晨 4 点——整理是后台自维护动作，
 * 挑一个用户不在场的时刻，避免它和真实输入抢同一批预算与注意力。
 */
export const DEFAULT_MEMORY_MAINTAIN_CRON = '0 4 * * *';

// ──────────────────────────────── JSON 值类型 ────────────────────────────────

export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ──────────────────────────────── 配置类型 ────────────────────────────────

/** 单条模型路由：模型 id + API 根地址 + 密钥所在的环境变量名 */
export interface ModelLaneConfig {
  /** 模型 id，按 DeepSeek 兼容 /responses 契约发送 */
  model: string;
  /** API 根地址，不含 `/responses` 后缀 */
  baseUrl: string;
  /** **环境变量名**，不是密钥值本身（密钥教义：文件里只有名字） */
  apiKeyEnv: string;
}

export interface ModelsConfig {
  /** 主循环生成（turn 主力） */
  heavy: ModelLaneConfig;
  /** 必要性判断、压缩摘要、守卫分类（便宜模型优先，design.md §4.11） */
  light: ModelLaneConfig;
  /** 降级链备用路由；缺省不启用（不写这一段即代表不用） */
  degraded?: ModelLaneConfig | undefined;
}

/** 三层预算 + 每日额度 + 软阈值 + 连续失败上限（design.md §4.6 的默认值） */
export interface BudgetConfig {
  /** 单 step 工具调用数上限 */
  stepTools: number;
  /** 单 turn step 数上限 */
  turnSteps: number;
  /** 单任务累计 token 上限 */
  taskTokens: number;
  /** 每日累计 token 上限 */
  dailyTokens: number;
  /** 软阈值比例（0-1）：达到 上限×ratio 时先往尾部 developer 消息提示，越过才硬停 */
  softRatio: number;
  /** 连续模型失败上限：超过则告警并进入可恢复暂停 */
  failStreakMax: number;
}

/** 心跳与空闲退避（design.md §4.12）、周期任务（design.md §4.17） */
export interface WakeConfig {
  /** 心跳基线间隔（分钟）。间隔 = 基线 × 2^空拍数 ×（1.5 − pressure） */
  heartbeatBaselineMin: number;
  /** 空闲退避上限倍数（基线 ×2^n 封顶于基线 × 本值） */
  idleBackoffMax: number;
  /**
   * 心跳间隔下限（分钟，默认 10）。
   *
   * 公式自己算不到这么短（30×0.5=15），所以它是安全网：以后把基线改小、
   * 或压力项变得更激进，也不会把心跳变成连爆。
   */
  heartbeatFloorMin: number;
  /**
   * 心跳间隔上限（分钟，默认 60）。
   *
   * 纯退避算下去安静久了会慢到 6 小时（30×8×1.45），那个尺度上“她还在”的
   * 体感就没了。超过一小时不露面，人会觉得她睡着了。
   */
  heartbeatCeilMin: number;
  /**
   * 每日记忆整理的 cron（五段：分 时 日 月 周）。空字符串 = 关闭该任务。
   * 到期以 `wake/timer` 唤醒，real-loop 按 payload.kind 认出这是整理而不是普通 turn。
   */
  memoryMaintainCron: string;
}

export interface PathsConfig {
  /**
   * 工作目录白名单：文件操作解析后必须落在其中任一目录内（design.md §4.10 第 1 条）。
   * 空数组 = 一个都不允许（用户显式选择），不会悄悄放行。
   */
  workspaceAllowlist: string[];
}

/** 发言节奏（design.md §4.20 的 speak 三路投递） */
export interface SpeakConfig {
  /**
   * 打字节奏（默认开）：段与段之间按"这一段得打多久"隔开，界面上与 IM 里都是一条条往外蹦。
   *
   * 关掉 = 所有段立刻发完。省的是时间（一次长发言不再占几十秒），代价是没有"人在打字"
   * 的体感——她在 IM 那边会显得像台机器一次吐一整段。
   */
  typingEffect: boolean;
  /**
   * 打字速度（字/分钟，默认 90）。
   *
   * 90 字/分是中文手机输入的常见速度，也是"几十个字要打十几秒"的体感来源。
   * 调大 = 说得更快（更短的总等待），调小 = 更慢更黏。范围 30~600。
   */
  charsPerMinute: number;
}

/** 图片进上下文的两个口径（design.md §4.20 图片两条途径） */
export interface VisionConfig {
  /**
   * 图片直通上下文（默认开）。
   *
   * 开：人在 QQ 上发来的图片会**直接进上下文**（模型亲眼看），最多 `maxContextImages` 张；
   * 同时 `vision_read` 多了一个 `inline` 参数——她可以把某张图从"转述"改成"我要原图"。
   * 关：图片一律不进上下文，只剩消息里的地址与 `vision_read` 的文字转述。
   *
   * 为什么默认开：表情包与截图光靠文字转述经常失真（"一张图"和"她真的看见了"是两件事），
   * 而用户的原话是"聊天发送的图片直接进入上下文"。关掉它是省钱的手段，不是安全需要。
   */
  imagesToContext: boolean;
  /**
   * 最多几张图片同时待在上下文里（默认 2）。
   *
   * 图片每轮请求都要重发一遍，不像工具结果读一次就完了；留太多等于每轮都在为旧图付费。
   */
  maxContextImages: number;
}

export interface ToolsConfig {
  /**
   * destructive 工具的开关，三态（与 src/tools/registry.ts 的 includeDestructive 同构）：
   * false → 一件都不列（默认，安全默认）；true → 全列；数组 → 只列名单内的。
   */
  destructiveEnabled: boolean | string[];
  /**
   * **群聊场景是否硬拒绝本机类工具**（2026-10-04 用户定的两种情景）。
   *
   *   • `false`（默认，**软提醒**）：群聊轮次在上下文里附一句场景提醒，本机类工具照给，
   *     由她判断该不该配合；
   *   • `true`（**硬拒绝**）：群聊场合下本机类工具在执行期直接拒绝（清单仍然恒定，
   *     因为"按场景改清单"会把历史上下文的前缀缓存废掉）。
   */
  groupSceneHardRefusal: boolean;
  /**
   * 计划模式（design.md §4.21）：开启时 destructive 调用**不直接执行**，先落 plan/pending
   * 等人工批准（与 needsReview 的「事后确认」是两条队列）。默认关闭。
   *
   * 与 destructiveEnabled 的分工：后者决定「这类工具能不能被模型看见」，
   * 前者决定「看见了之后能不能直接动手」——两个问题，两道门。
   */
  planMode: boolean;
  /**
   * 被关掉的工具名单（设置界面的开关，design §4.18）。
   *
   * 语义是「从她眼前拿掉」：关掉的工具不进模型请求，也就不会被调用；注册表仍知道它存在
   * （界面要显示一件工具存在但关着），执行到半路时会给出「已在设置里关闭」。
   * 用**禁用名单**而不是启用名单：新版本多出来的工具默认能用，不会因为忘了加名单而静默失效。
   */
  disabled: string[];
  /**
   * 她用 `ask_human` 问了人之后，多久没人答复就落一条「未批准、未拒绝」的事实
   * （`human/expired`，design §6.1）。单位是分钟，默认 [DEFAULT_ASK_HUMAN_TIMEOUT_MIN]。
   *
   * **它不是"默认动作"**：超时不产生任何决定，也不撤卡——只是让她得知"人可能不在机器旁、
   * 或没注意到"，要不要换个方式找人（例如走 QQ）由她判断。**没有"超时怎么办"这类设置**，
   * 因为那等于让某一方替人做决定（design §6.1 明说不设这条）。
   */
  askHumanTimeoutMin: number;
}

export interface AlertsConfig {
  /** 通用 webhook 出口：POST JSON `{ level, title, body, ts, fingerprint }`；不配则不出口 */
  webhookUrl?: string | undefined;
  /** 同类告警限流窗口（分钟，design.md §4.12：默认 30） */
  rateLimitMin: number;
}

/** 观测前端与 webhook 的本地 HTTP 服务（design.md §4.15/§4.16） */
export interface WebConfig {
  /** 绑定地址：默认只绑回环 */
  host: string;
  /** 监听端口（默认 7788；改动需重启，不在热更白名单） */
  port: number;
  /** GUI 模式：启动时自动唤起 Edge --app 独立窗口（1350×900），关闭窗口不影响进程 */
  appMode: boolean;
}

/** 联系人表：会话标识（sid）→ 名字 */
export type ContactBook = Record<string, string>;

/**
 * 解析联系人表。非法项一律跳过（人名写错一个字不该让整份配置打不开），
 * 键必须是会话标识形态（含 `:`）—— 否则那多半是写错了地方。
 */
function readContacts(raw: JsonValue | undefined, where: string): ContactBook {
  const out: ContactBook = {};
  if (raw === undefined) return out;
  const obj = objectOr(raw, where);
  for (const [sid, name] of Object.entries(obj)) {
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (!sid.includes(':')) continue;
    out[sid] = name.trim();
  }
  return out;
}

/** 人格连续性与上下文压缩（design.md §4.11 / §4.13、persona.md §4） */
export interface PersonaConfig {
  /**
   * 可见历史 token 估算阈值：超过就在 turn 结束时写 `compaction/summary`。
   * M5 的临时判定口径——估算见 persona/handoff-note.ts 的 `estimateHistoryTokens`。
   */
  compactionThresholdTokens: number;
  /** 交接笔记总预算（token 估算，persona.md §4：默认 4096） */
  handoffBudgetTokens: number;
  /** 交接笔记里最近 1/4 条目的单条满预算（persona.md §4：默认 1024） */
  handoffFoldTokens: number;
  /**
   * 本机用户的档案标识：GUI 聊天框与 CLI `wake` 发出的手动唤醒会带上它，
   * 于是 `data/persona/RELATIONSHIPS/<owner>.md` 自动注入（persona.md §3 的唤醒路由）。
   *
   * 它是**文件名**，不是昵称展示位：写什么就得有同名文件。默认 `owner`。
   * IM 来的人不走它——那些走 openid / user_id，档案按那串标识命名。
   */
  owner: string;
  /**
   * 框架维护的联系人表：会话标识（sid）→ 名字（"这个会话是谁"）。
   *
   * 与 `MEMORIES/aliases.md`（她自己认的）分工：这里是**人声明的事实**，优先于她的记录。
   * QQ 不提供单聊/群聊用户的昵称，也没有查成员的接口，所以"这个会话是用户"这类知识
   * 只能从配置来——她拿到的 openid 本身不携带任何身份信息。
   */
  contacts: ContactBook;
}

/** IM 通道（design.md 的落地入口；M9 先接 QQ 官方 Bot API） */
export interface ChannelsConfig {
  /**
   * **她被怎么称呼**（2026-10-02 用户拍板："文本提及也算，关键词匹配就行"）。
   *
   * 群里的人常常不打 @ 而直接喊名字（"弥亚小姐，帮我看看"）——平台不会把这种句子标成
   * "提到了机器人"，所以框架得自己认：正文里出现这几个词，就当作"这条在叫她"，
   * 与 @ 走同一条唤醒路径（进消息流、起 turn）。
   *
   * 分寸：这是**关键词匹配**，不做语义判断（成本为零、行为可预期）。所以填宽了会误唤醒、
   * 填窄了会漏——这件事只能由人来定，也正是它必须可配、且第一次使用时问一次的原因。
   * 空数组 = 只认平台的 @（旧行为）。
   */
  mentionKeywords: string[];
  /**
   * QQ 官方 Bot API 通道（WebSocket 长连接）。默认关闭。
   *
   * 密钥教义照旧：配置文件里只放**环境变量名**，AppID 与 ClientSecret 的值只在真正建连时
   * 从进程环境读（与 readApiKey 同一条纪律）。两者齐备且 enabled 时才起适配器。
   */
  qqOfficial: {
    enabled: boolean;
    /** AppID 所在环境变量名 */
    appIdEnv: string;
    /** ClientSecret 所在环境变量名 */
    clientSecretEnv: string;
    /**
     * 发文本时用**原生 markdown**（`msg_type: 2`）。默认开。
     *
     * 官方文档：`content` 与 `markdown` **互斥**（"传了 markdown 后此字段必须为空"）；
     * 拿不到 markdown 权限的机器人会被服务端拒绝（`40034127`），这里会自动降级为纯文本重发，
     * 所以开着只多花一个失败请求，不会丢话。要不要关，取决于那个机器人有没有权限。
     */
    useMarkdown: boolean;
    /** API 根地址；不写用官方默认 */
    apiBase?: string | undefined;
    /** 凭证地址；不写用官方默认 */
    tokenUrl?: string | undefined;
    /** 网关地址覆盖点（调试/自建代理；不写则 GET {apiBase}/gateway） */
    gatewayUrl?: string | undefined;
    /**
     * 群消息攒批窗口（分钟）。
     *
     * 单聊是「人直接跟你说话」，每句都要及时看；群聊里的一条 @ 往往只是半句话，
     * 回一条就起一个 turn 既贵又容易答错。所以群消息落库后先攒着，等到窗口才起 turn
     * 一起看——看了也不一定说话（要不要发言由她自己定）。0 = 不攒，每条都唤醒。
     */
    groupBatchMinutes: number;
  };
  /**
   * OneBot 11 通道（NapCat / go-cqhttp 等协议端的正向 WebSocket）。默认关闭。
   *
   * 与 QQ 官方通道的差别全在协议侧：这里只连一个本地 ws 端口，没有 AppID/Secret 换取流程；
   * access_token 若协议端开了校验，同样只写**环境变量名**，值在建连时从进程环境读。
   */
  onebot: {
    enabled: boolean;
    /** 协议端正向 ws 地址（如 ws://127.0.0.1:3001） */
    wsUrl: string;
    /** access_token 所在环境变量名 */
    tokenEnv: string;
    /**
     * **由框架拉起的协议端**（可选）。有这一段就由框架负责启动它，并且**接管 wsUrl 与 token**——
     * 两者从协议端自己的配置（`config/onebot.json`）里读，不需要人在两边各填一遍
     *（两边填得不一样是这条链上最难查的故障）。
     *
     * 框架**不下载、不分发**协议端：SnowLuma 是"源码可见非商业许可"，自用可以、随框架分发不行。
     * 所以这里只放一个**人指定的安装目录**；没装就是 not-installed，界面提示去下载。
     *
     * 不写这一段 = 用外部的协议端，行为与以前完全一样。
     */
    managed?: {
      /** 目前只认 snowluma（OneBot 11 协议端） */
      kind: 'snowluma';
      /** 协议端安装目录（绝对路径，或相对 dataDir） */
      dir: string;
      /** 框架启动时自动拉起（默认 true） */
      autoStart?: boolean;
    };
  };
}

/**
 * 外部依赖（docs/design.md §4.18、review.md v30）。
 *
 * 三件外部依赖（pwsh 7 / ripgrep / es.exe）的探测与安装由框架管（`src/deps/`），
 * 这里只留**一个**人工干预的入口：路径。
 *
 * 为什么需要它：`deps.paths.<name>` 是探测三段顺序的**第一段**（用户指定 > 框架自装 > PATH）。
 * 没有它的话，一个人把 rg 装在 `C:\tools\rg\rg.exe` 而没加 PATH 时，
 * 框架只能告诉他"未安装"——而"我明明装了"是最让人恼火的一类答复。
 * 显式指了却不可用时**不静默落到后两段**：那会变成"我配了却不生效"，
 * 比直接报错难查得多（见 src/deps/probe.ts）。
 */
export interface DepsConfig {
  /** 各依赖的可执行文件路径（绝对路径）；不写 = 走框架自装目录与 PATH */
  paths: {
    pwsh?: string | undefined;
    rg?: string | undefined;
    es?: string | undefined;
  };
}

/** 生效的配置全量。人可读、可 JSON 序列化、无循环引用，可直接参与指纹计算 */
export interface AppConfig {
  /** 配置 schema 版本 */
  schemaVersion: number;
  /** 数据根目录（绝对路径）：事件日志、投影缓存、锁、persona 都在它下面 */
  dataDir: string;
  models: ModelsConfig;
  budget: BudgetConfig;
  wake: WakeConfig;
  vision: VisionConfig;
  speak: SpeakConfig;
  persona: PersonaConfig;
  paths: PathsConfig;
  tools: ToolsConfig;
  /** 外部依赖（pwsh / rg / es）的用户指定路径；探测的第一段 */
  deps: DepsConfig;
  channels: ChannelsConfig;
  alerts: AlertsConfig;
  web: WebConfig;
  /** IANA 时区名（operations.md §2：budget/rollover 的"今日"按它解释） */
  timezone: string;
}

// ──────────────────────────────── 错误 ────────────────────────────────

/**
 * 配置错误。带定位信息（字段路径或文件路径），启动期直接打印即可施救。
 * 所有类型/范围问题都走这里，不做"尽力而为"的猜测修正。
 */
export class ConfigError extends Error {
  /** 出错位置：字段路径（如 `budget.softRatio`）或文件路径 */
  readonly where: string;

  constructor(message: string, where: string) {
    super(message);
    this.name = 'ConfigError';
    this.where = where;
  }
}

// ──────────────────────────────── 默认值 ────────────────────────────────

/** 系统时区（拿不到就退 UTC，绝不因为时区探测失败而让进程起不来） */
export function systemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz !== '' ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 默认配置（唯一默认值源）。`dir` 是配置所在目录，相对路径字段以它为基准解析成绝对路径。
 * 每次调用都新建对象，调用方改返回值不会污染后续加载。
 */
function buildDefaults(dir: string): AppConfig {
  return {
    schemaVersion: CONFIG_VERSION,
    dataDir: join(dir, DEFAULT_DATA_DIR_NAME),
    models: {
      heavy: { model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, apiKeyEnv: DEFAULT_API_KEY_ENV },
      light: { model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, apiKeyEnv: DEFAULT_API_KEY_ENV },
    },
    budget: {
      stepTools: 20,
      turnSteps: 30,
      taskTokens: 500_000,
      dailyTokens: 2_000_000,
      softRatio: 0.8,
      failStreakMax: 5,
    },
    wake: {
      heartbeatBaselineMin: 30,
      idleBackoffMax: 8,
      heartbeatFloorMin: 10,
      heartbeatCeilMin: 60,
      memoryMaintainCron: DEFAULT_MEMORY_MAINTAIN_CRON,
    },
    vision: {
      imagesToContext: true,
      maxContextImages: 2,
    },
    speak: {
      typingEffect: true,
      charsPerMinute: 90,
    },
    persona: {
      compactionThresholdTokens: 32_000,
      handoffBudgetTokens: 4_096,
      handoffFoldTokens: 1_024,
      owner: 'owner',
      contacts: {},
    },
    paths: { workspaceAllowlist: [join(dir, DEFAULT_WORKSPACE_DIR_NAME)] },
    tools: {
      destructiveEnabled: false, groupSceneHardRefusal: false, planMode: false, disabled: [],
      askHumanTimeoutMin: DEFAULT_ASK_HUMAN_TIMEOUT_MIN,
    },
    // 默认一个路径都不指定：探测的三段顺序里"用户指定"是显式干预，
    // 默认值必须是"没干预"，否则框架自装目录与 PATH 就永远轮不到
    deps: { paths: {} },
    channels: {
      // 默认空：只认平台的 @（旧行为）。第一次使用时界面会问一次，也可以随时在设置里改
      mentionKeywords: [],
      qqOfficial: {
        enabled: false,
        appIdEnv: DEFAULT_QQ_APP_ID_ENV,
        useMarkdown: true,
        clientSecretEnv: DEFAULT_QQ_CLIENT_SECRET_ENV,
        groupBatchMinutes: DEFAULT_QQ_GROUP_BATCH_MINUTES,
      },
      onebot: {
        enabled: false,
        wsUrl: DEFAULT_ONEBOT_WS_URL,
        tokenEnv: DEFAULT_ONEBOT_ACCESS_TOKEN_ENV,
      },
    },
    alerts: { rateLimitMin: 30 },
    web: { host: '127.0.0.1', port: 7788, appMode: false },
    timezone: systemTimezone(),
  };
}

/** 默认配置（经同一套校验，保证默认值自身合法——默认配置是自检过的配置） */
export function defaultConfig(dir: string): AppConfig {
  return parseAppConfig({}, resolve(dir));
}

// ──────────────────────────────── 文档读取与注释 ────────────────────────────────

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 「她被怎么称呼」最多几个词、每个词多长：填成"整个群名"或贴一整段话都没有意义 */
export const MENTION_KEYWORD_MAX = 20;
export const MENTION_KEYWORD_LEN_MAX = 24;

/**
 * 解析 `channels.mentionKeywords`：**宽容但不猜**。
 *
 * 宽容之处：字符串数组、单个字符串（人可能只填一个词）、带空格的逗号/顿号分隔串，都收。
 * 严格之处：非字符串项直接报错（不静默丢掉——"我配了却不生效"比报错难查得多，见文件头的纪律）；
 * 超长/超数的**截断并报错**：截断是怕它悄悄膨胀成一份没人看的名单，报错是因为那是配置错误。
 */
function parseMentionKeywords(raw: JsonValue | undefined): string[] {
  if (raw === undefined) return [];
  const list: string[] = [];
  if (typeof raw === 'string') {
    list.push(...raw.split(/[,，、\s]+/u));
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw new ConfigError(
          `channels.mentionKeywords 里只允许字符串（这一项是 ${describeValue(item)}）`,
          'channels.mentionKeywords',
        );
      }
      list.push(item);
    }
  } else {
    throw new ConfigError(
      `channels.mentionKeywords 应是字符串数组（或一个逗号分隔的字符串），实际是 ${describeValue(raw)}`,
      'channels.mentionKeywords',
    );
  }
  const out: string[] = [];
  for (const item of list) {
    const word = item.trim();
    if (word === '') continue;
    if ([...word].length > MENTION_KEYWORD_LEN_MAX) {
      throw new ConfigError(
        `channels.mentionKeywords 里的「${word.slice(0, 12)}…」太长（上限 ${MENTION_KEYWORD_LEN_MAX} 字）：`
        + '这里要填的是"她可能被怎么称呼"，不是一整句话',
        'channels.mentionKeywords',
      );
    }
    if (!out.includes(word)) out.push(word);
  }
  if (out.length > MENTION_KEYWORD_MAX) {
    throw new ConfigError(
      `channels.mentionKeywords 最多 ${MENTION_KEYWORD_MAX} 个词（现在 ${out.length} 个）`,
      'channels.mentionKeywords',
    );
  }
  return out;
}

/** 递归剔除注释键（`$` 前缀与 `//`）。未知键保留——向前兼容未来版本的字段 */
export function stripComments(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stripComments(item));
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith(COMMENT_PREFIX) || key === '//') continue;
      out[key] = stripComments(item);
    }
    return out;
  }
  return value;
}

function parseJsonDocument(text: string, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`配置文件不是合法 JSON（${path}）：${detail}`, path);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`配置文件顶层必须是 JSON 对象（${path}）`, path);
  }
  return value as JsonObject;
}

/**
 * 带注释的默认配置文档：内容全部来自 `defaultConfig()`，只有 `$comment` 是手写的。
 * 单一默认值源 + 注释插值，避免"模板与默认值漂移"这种最恶心的配置 bug。
 */
function defaultDocument(dir: string): JsonObject {
  const d = defaultConfig(dir);
  return {
    $comment: [
      'Irmia Agent 配置（M2 最小子集：JSON 语法子集，语义对齐 docs/operations.md §1）',
      '以 "$" 开头的键是注释，加载时忽略；删掉它们不影响运行。',
      '密钥不落配置文件：apiKeyEnv 只写环境变量名，密钥值放进程环境里。',
      '本文件缺失时会自动重建；字段缺失时按默认值补齐，但不会自动改写你写过的文件。',
    ],
    schemaVersion: d.schemaVersion,
    dataDir: d.dataDir,
    models: {
      $comment: [
        'heavy = turn 主循环；light = 必要性判断/摘要/守卫分类；degraded = 降级链备用路由（不写即不启用）。',
        'baseUrl 是 API 根地址（不含 /responses）。',
      ],
      heavy: { model: d.models.heavy.model, baseUrl: d.models.heavy.baseUrl, apiKeyEnv: d.models.heavy.apiKeyEnv },
      light: { model: d.models.light.model, baseUrl: d.models.light.baseUrl, apiKeyEnv: d.models.light.apiKeyEnv },
    },
    budget: {
      $comment: [
        '三层刹车 + 每日额度 + 软阈值（design.md §4.6）。全部跨重启累计。',
        'softRatio：达到 上限×ratio 时先提示模型收尾，越过才硬停。',
      ],
      stepTools: d.budget.stepTools,
      turnSteps: d.budget.turnSteps,
      taskTokens: d.budget.taskTokens,
      dailyTokens: d.budget.dailyTokens,
      softRatio: d.budget.softRatio,
      failStreakMax: d.budget.failStreakMax,
    },
    wake: {
      $comment: [
        '心跳基线 30 分钟，空拍按 2^n 退避、封顶 8 倍；任何外部事件到达即复位（design.md §4.12）。',
        'heartbeatFloorMin / heartbeatCeilMin：间隔的实际下上下限（分钟）。退避再深也不超过 60 分钟不露面，压力再大也不短于 10 分钟一拍。',
        'memoryMaintainCron：每日记忆整理的 cron（五段：分 时 日 月 周），默认凌晨 4 点；空串关闭该任务。',
      ],
      heartbeatBaselineMin: d.wake.heartbeatBaselineMin,
      idleBackoffMax: d.wake.idleBackoffMax,
      heartbeatFloorMin: d.wake.heartbeatFloorMin,
      heartbeatCeilMin: d.wake.heartbeatCeilMin,
      memoryMaintainCron: d.wake.memoryMaintainCron,
    },
    vision: {
      $comment: [
        '图片进上下文的两条途径（design.md §4.20）：聊天图片直接进上下文（模型亲眼看），以及 vision_read 的文字转述。',
        'imagesToContext：默认 true。开 = QQ 发来的图片直接进上下文（最多 maxContextImages 张），且 vision_read 可用 inline 参数把指定图放进上下文；关 = 图片一律不进，只剩地址与转述。',
        'maxContextImages：同时待在上下文里的图片张数上限（默认 2）。图片每轮都要重发，留太多等于每轮都为旧图付费。',
      ],
      imagesToContext: d.vision.imagesToContext,
      maxContextImages: d.vision.maxContextImages,
    },
    speak: {
      $comment: [
        '发言节奏（speak 的拆条投递）：段与段之间按"这一段要打多久"隔开，界面与 IM 同一节奏。',
        'typingEffect：默认 true。关掉则所有段立刻发完，没有"人在打字"的体感。',
        'charsPerMinute：打字速度（默认 90 字/分钟，中文手机输入的常见速度）。调大说得更快，范围 30~600。',
      ],
      typingEffect: d.speak.typingEffect,
      charsPerMinute: d.speak.charsPerMinute,
    },
    persona: {
      $comment: [
        '人格连续性与上下文压缩（design.md §4.11/§4.13、persona.md §4）。',
        'compactionThresholdTokens：可见历史估算超过它就在 turn 结束时压缩（写 compaction/summary，历史只遮蔽不重写）。',
        'handoffBudgetTokens / handoffFoldTokens：交接笔记的总预算与最近条目的单条满预算。',
        'owner：本机用户的档案标识。你在聊天框说话时它会作为 person 注入，于是 persona/RELATIONSHIPS/<owner>.md 自动生效——文件名必须和这里一致（默认 owner）。',
        'contacts：联系人表（会话 sid → 名字）。QQ 不给昵称，也不提供查成员的接口，所以“这个 QQ 会话是用户”只能在这里声明；优先于她自己的 MEMORIES/aliases.md。',
      ],
      compactionThresholdTokens: d.persona.compactionThresholdTokens,
      handoffBudgetTokens: d.persona.handoffBudgetTokens,
      handoffFoldTokens: d.persona.handoffFoldTokens,
      owner: d.persona.owner,
    },
    paths: {
      $comment: [
        '工作目录白名单：文件操作解析后必须落在其中任一目录内；空数组 = 一个都不允许。',
      ],
      workspaceAllowlist: [...d.paths.workspaceAllowlist],
    },
    tools: {
      $comment: [
        'destructive 工具开关，三态：false 全关（默认）/ true 全开 / 数组只开名单内的（如 ["pwsh","http_post"]）。',
        '「危险」在系统里的含义是"崩溃后不可自动重试"，不代表开关可以随手打开。',
        'planMode：开启后 destructive 调用先落 plan/pending 等人工批准，批准一次只放行一次。',
        'askHumanTimeoutMin：她用 ask_human 问了人之后多久没人答，就落一条「未批准、未拒绝」的事实'
          + '（human/expired）。它**不是**"超时怎么办"的默认动作——超时不批准、不拒绝、也不撤卡，'
          + '只是让她得知人可能不在机器旁，换不换方式找人是她自己的判断。',
      ],
      destructiveEnabled: d.tools.destructiveEnabled,
      planMode: d.tools.planMode,
      askHumanTimeoutMin: d.tools.askHumanTimeoutMin,
      disabled: [...d.tools.disabled],
    },
    deps: {
      $comment: [
        '外部依赖（pwsh 7 / ripgrep / es.exe）的用户指定路径——探测顺序的第一段（用户指定 > 框架自装目录 <dataDir>/tools/<name> > PATH）。',
        '不写就走后两段；写了一个不可用的路径**不会**静默退回 PATH，而是如实报"你指的那个用不了"——"我配了却不生效"是最难查的一类故障。',
        'pwsh 要求主版本 >= 7（powershell.exe 5.1 不算满足，它只是工具的回退项）。rg 与 es 是 rg_search / es_search 的引擎，没装就不注册这两件工具。',
        'rg 与 es 可以在 GUI 设置页「外部依赖」一键安装（下载官方包解压到 <dataDir>/tools/<name>/）；pwsh 7 需要人工安装（winget install Microsoft.PowerShell）。',
      ],
      // 只写出显式指定过的路径：`undefined` 在 JSON 里会被丢掉，写进去反而让模板文件出现空值
      paths: {
        ...(d.deps.paths.pwsh === undefined ? {} : { pwsh: d.deps.paths.pwsh }),
        ...(d.deps.paths.rg === undefined ? {} : { rg: d.deps.paths.rg }),
        ...(d.deps.paths.es === undefined ? {} : { es: d.deps.paths.es }),
      },
    },
    channels: {
      $comment: [
        'IM 通道（M9）：QQ 官方 Bot API 与 OneBot 11（NapCat 等协议端）。enabled=false 时完全不起适配器。',
        'mentionKeywords：**她被怎么称呼**（关键词匹配）。群里的人常不打 @ 直接喊名字，'
          + '正文里出现这几个词就当作"在叫她"，与 @ 走同一条唤醒路径。空数组 = 只认平台的 @。',
        '  这是关键词匹配，不做语义判断：填宽了会误唤醒、填窄了会漏——分寸由人定，界面上可改。',
        '密钥不落配置文件：只写环境变量名（appIdEnv / clientSecretEnv / tokenEnv），值放进程环境里。',
        'QQ：两者齐备且 enabled=true 时才建连；apiBase/tokenUrl/gatewayUrl 不写用官方默认地址。',
        'QQ：AppID/ClientSecret 的值写在 data/.keys.json（界面填）或环境变量里，环境变量优先；'
          + 'groupBatchMinutes 是群消息攒批窗口（单聊不受它影响，每句都及时看）。',
          'useMarkdown：发文本时用原生 markdown（msg_type=2），默认开——她发的报告才能在 QQ 里真正渲染。',
          '  官方口径：content 与 markdown 互斥；拿不到 markdown 权限的机器人会被服务端拒绝，',
          '  这里会自动降级为纯文本重发（只多花一个失败请求，不丢话）。机器人确实没权限时可关掉。',
        'OneBot：连 wsUrl（协议端正向 ws 端口）；tokenEnv 对应的环境变量为空时按“协议端未开校验”匿名连接。',
        'OneBot：managed 段写了就由框架拉起内置协议端（目前只认 snowluma），并且**接管 wsUrl 与 token**——',
        '  两者从协议端自己的 config/onebot.json 里读，不需要两边各填一遍。dir 是它的安装目录（绝对路径，或相对 dataDir）。',
        '  为什么框架不打包它：SnowLuma 是“源码可见非商业许可”，自用可以、随框架分发不行——所以只在这里指向你自己装的目录。',
        '  不写 managed = 用外部的协议端，行为与以前完全一样；autoStart: false 则只登记不自动拉起（界面可手动启停）。',
      ],
      mentionKeywords: [...d.channels.mentionKeywords],
      qqOfficial: {
        enabled: d.channels.qqOfficial.enabled,
        appIdEnv: d.channels.qqOfficial.appIdEnv,
        useMarkdown: d.channels.qqOfficial.useMarkdown,
        clientSecretEnv: d.channels.qqOfficial.clientSecretEnv,
      },
      onebot: {
        enabled: d.channels.onebot.enabled,
        wsUrl: d.channels.onebot.wsUrl,
        tokenEnv: d.channels.onebot.tokenEnv,
        // managed 只在写了的时候带上：它一出现就意味着"框架接管启动"，
        // 归一化时凭空补一个默认值，会把"用外部协议端"悄悄变成"框架接管"
        ...(d.channels.onebot.managed === undefined ? {} : { managed: d.channels.onebot.managed }),
      },
    },
    alerts: {
      $comment: [
        '通用 webhook 出口：POST JSON { level, title, body, ts, fingerprint }；不配 webhookUrl 即只落日志。',
        'rateLimitMin：同类告警限流窗口（分钟）。',
      ],
      rateLimitMin: d.alerts.rateLimitMin,
    },
    timezone: d.timezone,
  };
}

// ──────────────────────────────── 字段校验 ────────────────────────────────

function describeValue(value: JsonValue | undefined): string {
  if (value === undefined) return '缺失';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function objectOr(raw: JsonValue | undefined, where: string): JsonObject {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new ConfigError(`${where} 必须是对象，收到 ${describeValue(raw)}`, where);
  return raw;
}

function pickString(raw: JsonValue | undefined, where: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(`${where} 必须是字符串，收到 ${describeValue(raw)}`, where);
  return raw;
}

function pickNonEmptyString(raw: JsonValue | undefined, where: string, fallback: string): string {
  const text = pickString(raw, where, fallback);
  if (text.trim() === '') throw new ConfigError(`${where} 不能为空字符串`, where);
  return text;
}

function pickNumber(raw: JsonValue | undefined, where: string, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ConfigError(`${where} 必须是有限数字，收到 ${describeValue(raw)}`, where);
  }
  return raw;
}

function pickInt(
  raw: JsonValue | undefined,
  where: string,
  fallback: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  const n = pickNumber(raw, where, fallback);
  if (!Number.isInteger(n)) throw new ConfigError(`${where} 必须是整数，收到 ${describeValue(raw)}`, where);
  if (n < min || n > max) {
    throw new ConfigError(`${where} 必须在 ${min}..${max} 之间，收到 ${n}`, where);
  }
  return n;
}

/**
 * cron 表达式（五段：分 时 日 月 周）。空串是合法取值（"显式关闭这个周期任务"），
 * 形状校验只做能在这里判定的部分（段数与字符集）；「永不触发」这类语义判定交给
 * wake/timer-store.ts 的 parseCron（那里才有月份天数与星期的完整语义）。
 */
function pickCron(raw: JsonValue | undefined, where: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(`${where} 必须是字符串，收到 ${describeValue(raw)}`, where);
  const text = raw.trim();
  if (text === '') return '';
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    throw new ConfigError(`${where} 需要 5 段（分 时 日 月 周），收到 ${fields.length} 段：${text}`, where);
  }
  for (const field of fields) {
    if (!/^[0-9*/,\-]+$/.test(field)) {
      throw new ConfigError(`${where} 的段只允许数字与 * / , - 组合，收到：${field}`, where);
    }
  }
  return text;
}

/** 软阈值比例：必须落在 (0, 1]——写成 8 而不是 0.8 是真实会发生的错误，在这里抓住 */
function pickRatio(raw: JsonValue | undefined, where: string, fallback: number): number {
  const n = pickNumber(raw, where, fallback);
  if (n <= 0 || n > 1) {
    throw new ConfigError(`${where} 是比例，必须落在 (0, 1] 之间（例如 0.8 表示 80%），收到 ${n}`, where);
  }
  return n;
}

function pickBaseUrl(raw: JsonValue | undefined, where: string, fallback: string): string {
  const url = pickNonEmptyString(raw, where, fallback);
  if (!/^https?:\/\//iu.test(url)) {
    throw new ConfigError(
      `${where} 必须以 http:// 或 https:// 开头（收到 ${JSON.stringify(url)}）：这是不含 /responses 后缀的 API 根地址`,
      where,
    );
  }
  return url;
}

/** apiKeyEnv 只接受环境变量名形状——把 `sk-...` 密钥值填进来会当场报错（密钥教义的自检） */
function pickEnvName(raw: JsonValue | undefined, where: string, fallback: string): string {
  const name = pickNonEmptyString(raw, where, fallback);
  if (!ENV_NAME_RE.test(name)) {
    throw new ConfigError(
      `${where} 必须是环境变量名而不是密钥值（收到 ${JSON.stringify(name)}）：密钥不落配置文件，` +
        `这里写 "IRMIA_API_KEY" 这类名字，值放到进程环境里`,
      where,
    );
  }
  return name;
}

function pickTimezone(raw: JsonValue | undefined, where: string, fallback: string): string {
  const tz = pickNonEmptyString(raw, where, fallback);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ConfigError(
      `${where} 不是合法的 IANA 时区名（收到 ${JSON.stringify(tz)}），例如 "Asia/Shanghai" 或 "UTC"`,
      where,
    );
  }
  return tz;
}

function pickHttpUrlOptional(raw: JsonValue | undefined, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const url = pickNonEmptyString(raw, where, '');
  if (!/^https?:\/\//iu.test(url)) {
    throw new ConfigError(`${where} 必须以 http:// 或 https:// 开头（收到 ${JSON.stringify(url)}）`, where);
  }
  return url;
}

/** 路径白名单：逐项解析为绝对路径并去重（保留首次出现顺序，保证同一份文件加载结果稳定） */
function pickPathList(raw: JsonValue | undefined, where: string, fallback: string[], dir: string): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  if (!Array.isArray(raw)) throw new ConfigError(`${where} 必须是字符串数组，收到 ${describeValue(raw)}`, where);
  const seen = new Set<string>();
  const out: string[] = [];
  raw.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${itemWhere} 必须是非空字符串路径，收到 ${describeValue(item)}`, itemWhere);
    }
    const abs = resolve(dir, item);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  });
  return out;
}

function parseLane(raw: JsonValue | undefined, where: string, base: ModelLaneConfig): ModelLaneConfig {
  if (raw === undefined || raw === null) return { ...base };
  if (!isPlainObject(raw)) throw new ConfigError(`${where} 必须是对象，收到 ${describeValue(raw)}`, where);
  return {
    model: pickNonEmptyString(raw['model'], `${where}.model`, base.model),
    baseUrl: pickBaseUrl(raw['baseUrl'], `${where}.baseUrl`, base.baseUrl),
    apiKeyEnv: pickEnvName(raw['apiKeyEnv'], `${where}.apiKeyEnv`, base.apiKeyEnv),
  };
}

function pickBoolean(raw: JsonValue | undefined, where: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new ConfigError(`${where} 只能是 true / false，收到 ${describeValue(raw)}`, where);
  }
  return raw;
}

/** 工具名名单：逐项非空字符串、去重、保序（与 pickPathList 的去重口径一致，但不做路径解析） */
function pickToolNameList(raw: JsonValue | undefined, where: string, fallback: readonly string[]): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  if (!Array.isArray(raw)) throw new ConfigError(`${where} 必须是字符串数组，收到 ${describeValue(raw)}`, where);
  const seen = new Set<string>();
  const out: string[] = [];
  raw.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${itemWhere} 必须是非空字符串工具名，收到 ${describeValue(item)}`, itemWhere);
    }
    const name = item.trim();
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out;
}

function parseDestructive(
  raw: JsonValue | undefined,
  where: string,
  base: boolean | string[],
): boolean | string[] {
  if (raw === undefined || raw === null) return Array.isArray(base) ? [...base] : base;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      const itemWhere = `${where}[${index}]`;
      if (typeof item !== 'string' || item.trim() === '') {
        throw new ConfigError(`${itemWhere} 必须是非空字符串工具名，收到 ${describeValue(item)}`, itemWhere);
      }
      return item;
    });
  }
  throw new ConfigError(`${where} 只能是 false / true / 工具名数组，收到 ${describeValue(raw)}`, where);
}

/** OneBot 的 wsUrl：只接受 ws:// 与 wss://（它是协议端的正向 WebSocket 端口） */
function pickOneBotWsUrl(raw: JsonValue | undefined, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const url = pickNonEmptyString(raw, where, '');
  if (!/^wss?:\/\//iu.test(url)) {
    throw new ConfigError(
      `${where} 必须以 ws:// 或 wss:// 开头（收到 ${JSON.stringify(url)}）：这里是协议端的正向 WebSocket 端口`,
      where,
    );
  }
  return url;
}

/**
 * `channels.onebot.managed`（可选：由框架拉起的协议端）。
 *
 * 为什么 `dir` 缺失/为空要**报错**而不是回退默认：这一段一出现就意味着"框架接管它的启动"，
 * 而"接管"必须有个目录——凭空补一个默认值只会让框架去拉起一个不存在的路径，
 * 表现是 not-installed，人却以为自己配好了。同理 `kind` 只认 snowluma：写别的名字说明
 * 写这段话的人期待了另一套启动方式，静默降级成 snowluma 是最坏的一种"体贴"。
 *
 * `autoStart` 刻意**只在写了的时候才带上**（undefined = 默认 true，判定在 main.ts）：
 * 补一个显式 true 进配置对象，会让"我没写过它"与"我写了 true"在 `GET /api/config`
 * 与 configHash 里再也分不出来。
 */
function parseOneBotManaged(raw: JsonValue | undefined): ChannelsConfig['onebot']['managed'] {
  if (raw === undefined || raw === null) return undefined;
  const where = 'channels.onebot.managed';
  const obj = objectOr(raw, where);
  const kindRaw = obj['kind'];
  const kind = kindRaw === undefined || kindRaw === null ? 'snowluma' : kindRaw;
  if (kind !== 'snowluma') {
    throw new ConfigError(
      `${where}.kind 目前只认 "snowluma"，收到 ${describeValue(kindRaw)}`,
      `${where}.kind`,
    );
  }
  const dirRaw = obj['dir'];
  if (typeof dirRaw !== 'string' || dirRaw.trim() === '') {
    throw new ConfigError(
      `${where}.dir 必须是非空字符串（协议端安装目录），收到 ${describeValue(dirRaw)}：`
        + '这一段一写就代表框架要拉起它，没有目录就无从拉起',
      `${where}.dir`,
    );
  }
  // 目录**不在这里解析成绝对路径**：与 `deps.paths` 不同，它有"相对 dataDir"的语义
  // （见类型注释），而解析基准是运行期的 dataDir——配置解析期只有 dir（配置文件所在目录），
  // 两者不是一回事。归一化交给写入侧与 main.ts 的 resolveServiceDir。
  const managed: NonNullable<ChannelsConfig['onebot']['managed']> = { kind, dir: dirRaw.trim() };
  const autoStart = obj['autoStart'];
  if (autoStart !== undefined && autoStart !== null) {
    managed.autoStart = pickBoolean(autoStart, `${where}.autoStart`, true);
  }
  return managed;
}

function parseOneBotChannel(raw: JsonValue | undefined, base: ChannelsConfig['onebot']): ChannelsConfig['onebot'] {
  const obj = objectOr(raw, 'channels.onebot');
  const managed = parseOneBotManaged(obj['managed']);
  return {
    enabled: pickBoolean(obj['enabled'], 'channels.onebot.enabled', base.enabled),
    wsUrl: pickOneBotWsUrl(obj['wsUrl'], 'channels.onebot.wsUrl') ?? base.wsUrl,
    tokenEnv: pickEnvName(obj['tokenEnv'], 'channels.onebot.tokenEnv', base.tokenEnv),
    ...(managed === undefined ? {} : { managed }),
  };
}

function parseQqOfficialChannel(raw: JsonValue | undefined, base: ChannelsConfig['qqOfficial']): ChannelsConfig['qqOfficial'] {
  const obj = objectOr(raw, 'channels.qqOfficial');
  const out: ChannelsConfig['qqOfficial'] = {
    enabled: pickBoolean(obj['enabled'], 'channels.qqOfficial.enabled', base.enabled),
    appIdEnv: pickEnvName(obj['appIdEnv'], 'channels.qqOfficial.appIdEnv', base.appIdEnv),
    useMarkdown: pickBoolean(obj['useMarkdown'], 'channels.qqOfficial.useMarkdown', base.useMarkdown),
    clientSecretEnv: pickEnvName(obj['clientSecretEnv'], 'channels.qqOfficial.clientSecretEnv', base.clientSecretEnv),
    // 0 合法（= 不攒批，每条都唤醒），所以下限是 0；上限 1440（一天）——再大就不是「攒一会儿」了
    groupBatchMinutes: pickInt(obj['groupBatchMinutes'], 'channels.qqOfficial.groupBatchMinutes', base.groupBatchMinutes, 0, 1440),
  };
  const apiBase = pickHttpUrlOptional(obj['apiBase'], 'channels.qqOfficial.apiBase');
  if (apiBase !== undefined) out.apiBase = apiBase;
  const tokenUrl = pickHttpUrlOptional(obj['tokenUrl'], 'channels.qqOfficial.tokenUrl');
  if (tokenUrl !== undefined) out.tokenUrl = tokenUrl;
  const gatewayUrl = pickGatewayUrlOptional(obj['gatewayUrl'], 'channels.qqOfficial.gatewayUrl');
  if (gatewayUrl !== undefined) out.gatewayUrl = gatewayUrl;
  return out;
}

/**
 * 网关地址：只接受 ws:// 与 wss://。接受明文 `ws://` 是刻意的（本地调试要连假网关/反向代理），
 * 但本字段只在配置里能写——协议默认值永远是官方的 wss 地址。
 */
function pickGatewayUrlOptional(raw: JsonValue | undefined, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const url = pickNonEmptyString(raw, where, '');
  if (!/^wss?:\/\//iu.test(url)) {
    throw new ConfigError(
      `${where} 必须以 ws:// 或 wss:// 开头（收到 ${JSON.stringify(url)}）：网关是 WebSocket 端点，不是 http 地址`,
      where,
    );
  }
  return url;
}

/**
 * 全量解析：把（已剔注释、已迁移的）文档逐字段合并到默认值上。
 * 缺字段 → 默认值；类型错 → ConfigError。所有相对路径以 `dir` 为基准解析为绝对路径。
 */
function parseAppConfig(doc: JsonObject, dir: string): AppConfig {
  const base = buildDefaults(dir);

  // 下限 0：未版本化的历史配置是「版本 0」，交给迁移链处理，不在这里当成非法值
  const schemaVersion = pickInt(doc['schemaVersion'], 'schemaVersion', base.schemaVersion, 0);
  const dataDir = resolve(dir, pickNonEmptyString(doc['dataDir'], 'dataDir', base.dataDir));
  const timezone = pickTimezone(doc['timezone'], 'timezone', base.timezone);

  const modelsRaw = objectOr(doc['models'], 'models');
  const models: ModelsConfig = {
    heavy: parseLane(modelsRaw['heavy'], 'models.heavy', base.models.heavy),
    light: parseLane(modelsRaw['light'], 'models.light', base.models.light),
  };
  const degradedRaw = modelsRaw['degraded'];
  if (degradedRaw !== undefined && degradedRaw !== null) {
    // 降级链缺省继承 heavy 的连接契约，只覆盖用户写了的字段
    models.degraded = parseLane(degradedRaw, 'models.degraded', models.heavy);
  }

  const budgetRaw = objectOr(doc['budget'], 'budget');
  const budget: BudgetConfig = {
    stepTools: pickInt(budgetRaw['stepTools'], 'budget.stepTools', base.budget.stepTools, 1),
    turnSteps: pickInt(budgetRaw['turnSteps'], 'budget.turnSteps', base.budget.turnSteps, 1),
    taskTokens: pickInt(budgetRaw['taskTokens'], 'budget.taskTokens', base.budget.taskTokens, 1),
    dailyTokens: pickInt(budgetRaw['dailyTokens'], 'budget.dailyTokens', base.budget.dailyTokens, 1),
    softRatio: pickRatio(budgetRaw['softRatio'], 'budget.softRatio', base.budget.softRatio),
    failStreakMax: pickInt(budgetRaw['failStreakMax'], 'budget.failStreakMax', base.budget.failStreakMax, 1),
  };

  const wakeRaw = objectOr(doc['wake'], 'wake');
  const wake: WakeConfig = {
    heartbeatBaselineMin: pickInt(
      wakeRaw['heartbeatBaselineMin'], 'wake.heartbeatBaselineMin', base.wake.heartbeatBaselineMin, 1,
    ),
    idleBackoffMax: pickInt(wakeRaw['idleBackoffMax'], 'wake.idleBackoffMax', base.wake.idleBackoffMax, 1),
    heartbeatFloorMin: pickInt(
      wakeRaw['heartbeatFloorMin'], 'wake.heartbeatFloorMin', base.wake.heartbeatFloorMin, 1,
    ),
    heartbeatCeilMin: 1,
    memoryMaintainCron: pickCron(
      wakeRaw['memoryMaintainCron'],
      'wake.memoryMaintainCron',
      base.wake.memoryMaintainCron,
    ),
  };
  // 上限低于下限是配置写反了：以下限为准（心跳更快不危险，静默更久才危险）
  wake.heartbeatCeilMin = Math.max(
    wake.heartbeatFloorMin,
    pickInt(wakeRaw['heartbeatCeilMin'], 'wake.heartbeatCeilMin', base.wake.heartbeatCeilMin, 1),
  );

  const visionRaw = objectOr(doc['vision'], 'vision');
  const vision: VisionConfig = {
    imagesToContext: pickBoolean(
      visionRaw['imagesToContext'],
      'vision.imagesToContext',
      base.vision.imagesToContext,
    ),
    // 0 是合法值（= 图片一张都不进上下文），所以下限取 0
    maxContextImages: pickInt(
      visionRaw['maxContextImages'],
      'vision.maxContextImages',
      base.vision.maxContextImages,
      0,
    ),
  };

  const speakRaw = objectOr(doc['speak'], 'speak');
  const speak: SpeakConfig = {
    typingEffect: pickBoolean(speakRaw['typingEffect'], 'speak.typingEffect', base.speak.typingEffect),
    // 打字速度：低于 30 字/分等于每字两秒，一段十几个字就要半分钟——那不是"慢"，是卡住
    charsPerMinute: pickInt(
      speakRaw['charsPerMinute'],
      'speak.charsPerMinute',
      base.speak.charsPerMinute,
      30,
    ),
  };

  const personaRaw = objectOr(doc['persona'], 'persona');
  const persona: PersonaConfig = {
    compactionThresholdTokens: pickInt(
      personaRaw['compactionThresholdTokens'],
      'persona.compactionThresholdTokens',
      base.persona.compactionThresholdTokens,
      1,
    ),
    handoffBudgetTokens: pickInt(
      personaRaw['handoffBudgetTokens'],
      'persona.handoffBudgetTokens',
      base.persona.handoffBudgetTokens,
      1,
    ),
    handoffFoldTokens: pickInt(
      personaRaw['handoffFoldTokens'],
      'persona.handoffFoldTokens',
      base.persona.handoffFoldTokens,
      1,
    ),
    owner: pickString(personaRaw['owner'], 'persona.owner', base.persona.owner).trim(),
    contacts: readContacts(personaRaw['contacts'], 'persona.contacts'),
  };

  const pathsRaw = objectOr(doc['paths'], 'paths');
  const paths: PathsConfig = {
    workspaceAllowlist: pickPathList(
      pathsRaw['workspaceAllowlist'], 'paths.workspaceAllowlist', base.paths.workspaceAllowlist, dir,
    ),
  };

  const toolsRaw = objectOr(doc['tools'], 'tools');
  const tools: ToolsConfig = {
    destructiveEnabled: parseDestructive(toolsRaw['destructiveEnabled'], 'tools.destructiveEnabled', base.tools.destructiveEnabled),
    groupSceneHardRefusal: pickBoolean(
      toolsRaw['groupSceneHardRefusal'],
      'tools.groupSceneHardRefusal',
      base.tools.groupSceneHardRefusal,
    ),
    planMode: pickBoolean(toolsRaw['planMode'], 'tools.planMode', base.tools.planMode),
    // 上限 1440 分钟（一天）：比它更大的"等待线"已经失去意义——人一天没露面的可能性比
    // "他还在看这张卡"大得多，那时该发生的是她换个方式找人，而不是把这条线拉长
    askHumanTimeoutMin: pickInt(
      toolsRaw['askHumanTimeoutMin'], 'tools.askHumanTimeoutMin', base.tools.askHumanTimeoutMin, 1, 1440,
    ),
    // 只收非空字符串；去重后保持首次出现顺序（界面开关写入的顺序即名单顺序）
    disabled: pickToolNameList(toolsRaw['disabled'], 'tools.disabled', base.tools.disabled),
  };

  const depsRaw = objectOr(doc['deps'], 'deps');
  const depsPathsRaw = objectOr(depsRaw['paths'], 'deps.paths');
  const deps: DepsConfig = { paths: {} };
  // 三个键各自独立：只写了 rg 的人不该因为没写 pwsh 而报错（缺字段 = 不干预）
  for (const name of ['pwsh', 'rg', 'es'] as const) {
    const raw = depsPathsRaw[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new ConfigError(`deps.paths.${name} 必须是字符串路径，收到 ${describeValue(raw)}`, `deps.paths.${name}`);
    }
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    // 相对路径以配置文件所在目录为基准解析成绝对路径（与 dataDir/paths 同一口径）
    deps.paths[name] = resolve(dir, trimmed);
  }

  const alertsRaw = objectOr(doc['alerts'], 'alerts');
  const alerts: AlertsConfig = {
    rateLimitMin: pickInt(alertsRaw['rateLimitMin'], 'alerts.rateLimitMin', base.alerts.rateLimitMin, 0),
  };
  const webhookUrl = pickHttpUrlOptional(alertsRaw['webhookUrl'], 'alerts.webhookUrl');
  if (webhookUrl !== undefined) alerts.webhookUrl = webhookUrl;

  const channelsRaw = objectOr(doc['channels'], 'channels');
  const channels: ChannelsConfig = {
    mentionKeywords: parseMentionKeywords(channelsRaw['mentionKeywords']),
    qqOfficial: parseQqOfficialChannel(channelsRaw['qqOfficial'], base.channels.qqOfficial),
    onebot: parseOneBotChannel(channelsRaw['onebot'], base.channels.onebot),
  };

  const webRaw = objectOr(doc['web'], 'web');
  const web: WebConfig = {
    host: pickString(webRaw['host'], 'web.host', base.web.host) ?? '127.0.0.1',
    port: pickInt(webRaw['port'], 'web.port', base.web.port, 1, 65535) ?? 7788,
    appMode: pickBoolean(webRaw['appMode'], 'web.appMode', base.web.appMode),
  };

  return {
    schemaVersion, dataDir, models, budget, wake, vision, speak, persona, paths, tools, deps, channels,
    alerts, web, timezone,
  };
}

// ──────────────────────────────── 版本迁移 ────────────────────────────────

/**
 * 迁移钩子：每个钩子负责「targetVersion-1 → targetVersion」这一步，恰好触发一次
 * （operations.md §3 的 upgrade hooks 链）。钩子只改派生配置文档，绝不回头改历史事件。
 */
export interface ConfigUpgradeHook {
  /** 该钩子的目标版本，例如 2 表示"把 1 升到 2" */
  readonly targetVersion: number;
  /** 纯函数：接收旧文档返回新文档；返回 null 表示拒绝迁移（缺信息，需人工介入） */
  readonly upgrade: (doc: JsonObject) => JsonObject | null;
}

/** 内置迁移链：M6 完整迁移链在此登记；M2 只有版本比较与执行器，链为空 */
export const upgradeHooks: readonly ConfigUpgradeHook[] = [];

/** 钩子执行结果：迁移后的文档 + 实际触发过的目标版本序列 */
export interface UpgradeResult {
  doc: JsonObject;
  applied: number[];
}

/**
 * 从 `fromVersion` 按序执行到 `toVersion`。任何一个版本缺钩子就报错——
 * 跳步迁移会让字段语义断层，宁可让人来修。
 */
export function applyUpgradeChain(
  doc: JsonObject,
  fromVersion: number,
  toVersion: number,
  hooks: readonly ConfigUpgradeHook[] = upgradeHooks,
): UpgradeResult {
  let current = doc;
  const applied: number[] = [];
  for (let version = fromVersion + 1; version <= toVersion; version += 1) {
    const hook = hooks.find((candidate) => candidate.targetVersion === version);
    if (hook === undefined) {
      throw new ConfigError(
        `配置版本 ${fromVersion} 升到 ${toVersion} 需要目标版本为 ${version} 的迁移钩子，当前代码里没有登记`,
        'schemaVersion',
      );
    }
    const next = hook.upgrade(current);
    if (next === null) {
      throw new ConfigError(`迁移钩子 v${version} 拒绝迁移这份配置，需要人工处理`, 'schemaVersion');
    }
    // 归一化版本号：钩子漏写 schemaVersion 也不会让后续比较失真
    current = { ...next, schemaVersion: version };
    applied.push(version);
  }
  return { doc: current, applied };
}

// ──────────────────────────────── 规范化与指纹 ────────────────────────────────

/** 规范化：递归排序键、剔除 undefined 成员（等价于 JSON 序列化语义） */
function canonicalize(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: JsonObject = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonicalize(item);
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * 规范化 JSON：键序无关的确定性字节串。
 * 同一份配置在任何机器、任何键序下都得到同一串——这是 configHash 能当指纹的前提。
 */
export function canonicalConfigJson(config: unknown): string {
  return JSON.stringify(canonicalize(config));
}

/**
 * 配置指纹：sha256(规范化 JSON) 的完整 hex。
 * 与 renderVersion、personaHash 并列构成 render 的三输入指纹（operations.md §1）：
 * 同一 seq 区间 + 同一三指纹 ⟹ 同一请求体。展示时取前 8 位即可。
 */
export function configHash(config: AppConfig): string {
  return createHash('sha256').update(canonicalConfigJson(config), 'utf8').digest('hex');
}

// ──────────────────────────────── 密钥读取 ────────────────────────────────

/**
 * **唯一**读取密钥值的入口：只在真正发起调用时调用，值不落在配置对象里、
 * 不落在事件日志里（operations.md §1：日志里的密钥引用一律是掩码）。
 * 未配置返回 null，由调用方决定是报错、降级还是提示用户去配。
 *
 * 取值链交给 keys.ts 的 `resolveKey`（环境变量优先 > `data/.keys.json`），
 * 两个参数各说一件事：`lane.apiKeyEnv` 是**环境变量名**（配置里写的名字），
 * `name` 是**受管键名**（没有环境变量时去 `.keys.json` 里读哪一个）。
 * 不传 `dataDir` / `name` 时行为与只看环境变量的历史版本逐字一致，
 * 所以既有调用点与测试的语义没动过。
 */
export function readApiKey(
  lane: Pick<ModelLaneConfig, 'apiKeyEnv'>,
  env: Record<string, string | undefined> = process.env,
  dataDir: string | null = null,
  name: KeyName | null = null,
): string | null {
  return resolveKey(dataDir, name, { env, envName: lane.apiKeyEnv });
}

// ──────────────────────────────── 加载 ────────────────────────────────

export interface LoadConfigOptions {
  /** 迁移钩子链覆盖点（测试与 M6 演进用）；默认取内置 upgradeHooks */
  hooks?: readonly ConfigUpgradeHook[];
}

export interface LoadedConfig {
  /** 生效配置（默认值已合并、路径已解析为绝对路径） */
  config: AppConfig;
  /** 配置文件绝对路径（dir/config.json） */
  path: string;
  /** 本次是否新建了默认配置文件（true 表示目录里原本没有它） */
  createdDefault: boolean;
  /** 本次实际触发过的迁移目标版本；空数组表示未迁移 */
  appliedUpgradeTargets: number[];
  /** configHash(config) 的现成结果 */
  configHash: string;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** 原子写：同目录 tmp → fsync → rename 覆盖（schema §11 的统一写盘规则） */
let tmpSeq = 0;
async function writeFileAtomic(path: string, text: string): Promise<void> {
  // pid + 序号：同进程并发写各自有独立 tmp，最后 rename 的都是完整内容
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq++}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * 加载配置。
 *
 * `dir` 是配置所在目录（config.json 的父目录），也是相对路径字段的解析基准。
 * 文件缺失时生成带注释的默认配置并写回；文件存在时只读不改写。
 */
export async function loadConfig(dir: string, options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const dirAbs = resolve(dir);
  const path = join(dirAbs, CONFIG_FILE_NAME);

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await mkdir(dirAbs, { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(defaultDocument(dirAbs), null, 2)}\n`);
    const config = defaultConfig(dirAbs);
    return {
      config,
      path,
      createdDefault: true,
      appliedUpgradeTargets: [],
      configHash: configHash(config),
    };
  }

  const raw = parseJsonDocument(text, path);
  // raw 已知是对象，剔注释后仍是对象
  const stripped = stripComments(raw) as JsonObject;
  const fromVersion = pickInt(stripped['schemaVersion'], 'schemaVersion', CONFIG_VERSION, 0);

  let doc = stripped;
  let applied: number[] = [];

  if (fromVersion > CONFIG_VERSION) {
    throw new ConfigError(
      `配置版本 ${fromVersion} 高于本程序支持的 ${CONFIG_VERSION}（${path}）：` +
        '这份配置来自更新的代码，用旧程序读它会静默丢字段，请先升级程序',
      path,
    );
  }

  if (fromVersion < CONFIG_VERSION) {
    // 迁移前备份原文件（对齐 milestones.md M6-2：迁移必须可回退）
    const backup = `${path}.bak.v${fromVersion}`;
    await copyFile(path, backup);
    const result = applyUpgradeChain(stripped, fromVersion, CONFIG_VERSION, options.hooks ?? upgradeHooks);
    doc = result.doc;
    applied = result.applied;
  }

  const config = parseAppConfig(doc, dirAbs);
  return { config, path, createdDefault: false, appliedUpgradeTargets: applied, configHash: configHash(config) };
}

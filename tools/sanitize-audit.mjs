#!/usr/bin/env node
/**
 * sanitize-audit.mjs —— **脱敏闸门**：扫「会进包 / 会进公开副本的那批文件」。
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 它为什么存在（与既有两道闸门的分工，别搞混）
 * ════════════════════════════════════════════════════════════════════════════════
 * 仓库里已经有两道闸门，各自守一个**出口**的**产物**：
 *   · tools/package-gate.ps1 —— 扫**装配好的便携包目录**（zip 出去的那份）；
 *   · tools/publish-oss.mjs  —— 扫**同步完的公开副本目录**（push 出去的那份）。
 * 两道都是"事后扫产物"：内容已经写到磁盘上、脱敏已经跑过了，它们负责最后一道复核。
 * 而脱敏真正的坑在**更前面一步**，这两道都够不着：
 *
 *   1) **同步前的源头**。publish-oss.mjs 只把规则表 SANITIZE_RULES 里那几句话换掉
 *      （真名/人格名/「用户」/三个本机路径根）。规则表**没写到的类别**它不认——
 *      凭据（`sk-…`、`Bearer …`、`*_ACCESS_TOKEN` 的值）、QQ openid（32 位大写十六进制）、
 *      群号，这三类它既不在规则表里替换、词表 private-words.json 里也没有对应条目，
 *      于是**一个字节都不会被拦**，原样同步进公开副本。
 *      实测：用户的真实 QQ openid 与真实群号就在 `test/**`、`src/**` 里当夹具用，
 *      而 `test/` 与 `src/` 都在 SYNC_ROOTS 里 ⇒ 它们今天是**会发布**的。
 *   2. **"会不会发布"这件事只有那两份脚本自己知道**。人肉判断"哪些文件会进包"是错的源头，
 *      所以本工具**不自己写死名单**：它去读那两份脚本里的表（见下面「表一/表二」），
 *      再用与它们相同的判据算出同一个集合。谁改了那两张表，本工具自动跟着改。
 *
 * ⇒ 本工具的定位是**源头闸门**：在"同步/装配之前"就把会外发的那批文件扫一遍，
 *   专盯既有两道闸门**没有覆盖**的那几类敏感面。
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 三条设计纪律（都是踩过的坑，别改回去）
 * ════════════════════════════════════════════════════════════════════════════════
 * ① **不另开一份词表**。private-words.json 的头部写着"**唯一一份**，谁都不许另开一份"。
 *    所以本工具**读**它，只补它没有的**结构性模式**（凭据形状、QQ id 形状）。
 *    补的不是"某个具体的真值"，而是"这一类值的形状"——于是它不需要知道用户的 token 是什么，
 *    也能拦住"把那个 token 抄进夹具"这件事（实测就是这么漏的，见 docs/sanitize-audit.md）。
 *    ⚠️ 这一条同时是**安全**要求：本工具会随 `tools/` 同步进公开副本（tools 在 SYNC_ROOTS 里），
 *    所以它自己的源码里**一个真值都不许有**——真值只能来自 config.json（运行期读、不落盘）。
 *
 * ② **不出卖自己**。本工具必然逐条写着要拦的形态（`sk-`、32 位十六进制…），
 *    扫自己会把"探测器"报成"泄漏源"。处理办法不是整份文件豁免，而是**只豁免"探测器词表"那一类**
 *    （third-party-fingerprint：它按设计就要写着 kimi / deskhand 这些词），
 *    **凭据形状类照样扫自己**——将来谁往本文件里塞一把真 key，闸门立刻红。
 *
 * ③ **绝不回显真值**。命中一律脱敏后打印（`E7FEC35E…1314`）。审计报告是要发给人的，
 *    报告里再抄一遍真 token 就等于把闸门的输出来当第二次泄漏源。
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 用法 / 退出码
 * ════════════════════════════════════════════════════════════════════════════════
 *   node tools/sanitize-audit.mjs                    # 扫 ships（会进包 ∪ 会进公开副本）
 *   node tools/sanitize-audit.mjs --scope oss        # 只按公开副本口径
 *   node tools/sanitize-audit.mjs --scope package    # 只按便携包口径
 *   node tools/sanitize-audit.mjs --scope repo       # 全仓已跟踪文件（**报表**，不改退出码）
 *   node tools/sanitize-audit.mjs --json             # 只输出一行 JSON（测试读这个）
 *   node tools/sanitize-audit.mjs --list             # 追加打印"到底扫了哪 N 个文件"
 *
 * 退出码：0 = 通过；1 = 有**未白名单**的命中（这批内容今天不许发）；
 *         2 = 环境/用法错误（git 读不出、那两张表解析不出——**判据没法应用**时宁可红）。
 *   ⚠️ 2 与 1 分开是要紧的：把"判据失效"当成"通过"是闸门最坏的失败形状。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..');

const PUBLISH_SRC = join(HERE, 'publish-oss.mjs');
const ASSEMBLE_SRC = join(REPO, 'packaging', 'assemble-package.ps1');
const WORDS_JSON = join(HERE, 'private-words.json');

/** 本工具自身（见纪律 ②） */
const SELF_REL = 'tools/sanitize-audit.mjs';

// ════════════════════════════════════════════════════════════════════════════
// 表：结构性模式 —— 既有两道闸门**没有覆盖**的那几类
//
// 这里只写"形状"，不写"某个具体人的具体值"（纪律 ①）。每条都记着它拦的是什么、
// 以及**为什么既有的规则表/词表拦不住**。
// ⚠️ 顺序无关：命中按 id 归组，同一条模式下重复命中只算多次、不重复计处。
// ════════════════════════════════════════════════════════════════════════════════
export const STRUCTURAL_PATTERNS = [
  {
    id: 'api-key',
    why: '模型 API key 的形状（sk- 开头）。阈值取 20 是有意的：仓库里的假夹具都不超过 10 个字符'
      + '（`sk-abcdef1234` 这类），真 key 远长于此。既有的 private-words.json 一条都没收这类——'
      + '它收的是"某个具体的词"，而 key 是随机的，只能按形状拦。',
    re: /\bsk-[A-Za-z0-9_-]{20,}/gu,
  },
  {
    id: 'bearer',
    why: 'HTTP Authorization 头里带着真凭据。公开副本是会被别人 clone 的，夹具里的 Bearer 值'
      + '一旦是真值就等于公开凭据。',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gu,
  },
  {
    id: 'secret-assign',
    why: '把密钥**字面值**直接写进配置/代码（而不是引用环境变量）。config.json 里 ONEBOT_*_TOKEN'
      + ' 就是这么躺着真值的，而它被 git 跟踪、真值又被抄进了 test/ 夹具——这一条盯的就是那次泄漏。',
    re: /\b(?:clientSecret|appSecret|access_token|ACCESS_TOKEN|ONEBOT_[A-Z0-9_]*TOKEN)\b\s*[:=]\s*['"]([^'"]{16,})['"]/gu,
  },
  {
    id: 'qq-openid',
    why: 'QQ 官方 Bot 的 openid / 群 openid（32 位**大写**十六进制）。它是**真人身份**：'
      + '拿到 openid 就能把"某个人的私聊/某个群"钉死。仓库里它当夹具用了几十处，'
      + '既有两道闸门都不认识这个形状 ⇒ 会原样进公开副本。'
      + '（自造值有两档放行：一眼看得出是序列的走白名单，补零计数器那种走 PLACEHOLDER_SHAPES。）',
    re: /\b[0-9A-F]{32}\b/gu,
    placeholderShapes: true,
  },
  {
    id: 'qq-group-no',
    why: 'QQ 群号（纯数字）。与 openid 不同，群号是**可搜索的公开标识**，但也正因如此，'
      + '把某个群的群号写进夹具等于向公开面报出"这些人是谁"。只认 channel 上下文里的写法'
      + '（`group_id:` / `qq:group:`），免得把预算数字（500000000 那类）算进来。',
    re: /(?:group_id|qq:group:)\s*[:=]?\s*['"]?\d{6,12}\b/gu,
    placeholderShapes: true,
  },
  {
    id: 'third-party-fingerprint',
    why: '第三方项目的名字。它**不是**敏感项（公开产品名），列在这里是为了把"说明性提及"'
      + '与"把别人的源码拷进来"分开：提及进白名单（带理由），而源码进入会是 license 问题'
      + '（本项目 AGPL-3.0，但拷别人代码仍需逐条核许可）。',
    re: /\b(?:kimi|deskhand)\b/giu,
  },
];

// ════════════════════════════════════════════════════════════════════════════
// 明显占位值的形状 —— 与白名单**分开**的一档
//
// 为什么不能塞进白名单：白名单是按"值"逐条登记的，而占位值是**成族**出现的
// （`…0001`/`…0002`/…/`…0006` 只是计数器；`123456789` 还有 `123456780` 这种变体）。
// 逐条登记等于让下一代占位值再把闸门顶红一次，而那一次的红是假的。
// 所以这里按**形状**识别，并且每条形状都写明"为什么这个形状不可能是真的"。
//
// ⚠️ 只对**形状类**模式生效（`qq-openid` / `qq-group-no`）。`config-value` 那一档
//    永远不许走这里：它的定义就是"这一个值来自 config.json"，真值不可能是占位。
// ⚠️ 这几条判据本身也被自检盯着（--self-test）：既要放行占位，也要**照样拦住**随机值。
// ════════════════════════════════════════════════════════════════════════════════
export const PLACEHOLDER_SHAPES = [
  {
    id: 'zero-padded-counter',
    re: /^0{24,}[0-9A-F]{1,8}$/u,
    why: '前 24 位全是 0 的十六进制：只可能是"补零 + 计数器"造出来的占位。'
      + '真 openid 由平台随机生成，连续 24 个 0 的概率可以忽略。',
  },
  {
    id: 'canonical-fake-number',
    re: /^(?:group_id|qq:group:)\s*[:=]?\s*['"]?12345678\d\b/u,
    why: '`123456789` 这一族是工程上公认的假号（连它的 123456780~123456789 变体 '
      + '——那些只差最后一位计数器）。',
  },
];

/** 这一处命中是不是"明显的占位值"（是则返回命中的那条形状，否则 null） */
export function placeholderOf(text) {
  return PLACEHOLDER_SHAPES.find((p) => p.re.test(text)) ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
// 本机真值清单 —— **从 config.json 现读，不在源码里写死**
//
// 为什么需要它（这是本工具唯一能拦住"真值被抄进夹具"的办法）：
//   形状类模式有天花板。`const token = 'nIdI43Xl…'` 这一行里没有 `ACCESS_TOKEN=` 这样的
//   键名可认、值又是纯字母数字（不是 32 位大写十六进制），只按形状写模式要么扫不到、
//   要么把 package-lock.json 里几千条 integrity 哈希一起报上来。
//   而"这台机器上哪些值算私有"这件事，config.json 本来就是唯一真相源（联系人表、通道凭据、
//   managed service 的开关都在里面）——所以**问它**，不写死在代码里。
//
// ⚠️ 三条纪律：
//   ① 只读，不写（config.json 是用户的东西，本次任务明确不许碰 ⇒ 这里一个字节都不改它）；
//   ② **绝不把抽出来的值打印成明文**（纪律 ③），只打 `config.json:179 的 ONEBOT_WS_ACCESS_TOKEN`
//      这样的**出处**，让人自己去看那一行；
//   ③ 读不到 config.json（公开副本 / CI / 别人的机器）就**降级**成"只按形状扫"，并在报表里
//      明说这一档今天没参与——**不许**静默当成"没有真值要防"。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG_PATH = join(REPO, 'config.json');

/**
 * 值得拿来比对的形状：凭据、sid。其余（散文、版本号、路径、**长驼峰键名**、示例数字）一律不收。
 *
 * ⚠️ 这两条门（`forKeys`）是被实测打回来的：
 *   第一版把"长度 ≥24 的字母数字串"当凭据，于是 config.json 的**长驼峰键名**
 *   （`compactionThresholdTokens` 这种）被当成凭据收进清单，`gui/**` 里 89 处正常引用
 *   全被报成"真值泄漏"——闸门一旦开始报假命中，真命中就会被读报表的人跳过。
 *   收窄办法：凭据必须**含数字**（驼峰键名不含），且 ≥24 字符。
 *   同理，纯数字那一档整档删掉：`123456789` 这类**示例值**在文档里到处都是，
 *   收进来会让闸门逼人把"占位符"本身改掉。群号由 `qq-group-no` 的形状模式负责。
 */
function isInventoryValue(v, forKeys = false) {
  if (typeof v !== 'string') return false;
  if (v.includes('<') || v.includes('…') || v.includes('/')) return false; // 占位符与路径
  // 联系人表的**键**是 `qq:c2c:<openid>` / `onebot:group:<号>` 这种形态（键只认这一档）
  if (/^(?:qq|onebot):(?:c2c|group):[0-9A-Za-z]{6,}$/u.test(v)) return 'sid';
  if (forKeys) return false;
  if (v.length >= 24 && /^[A-Za-z0-9_-]+$/u.test(v) && /\d/u.test(v)) return 'token';
  return false;
}

/**
 * 读 config.json，抽出"这台机器上算私有的字面值"。
 * 返回 { values: [{value, kind, source}], reason }；读不到时 values 为空数组、reason 说明原因。
 * `source` 形如 `config.json:179 的 ONEBOT_WS_ACCESS_TOKEN`——**只给位置，不给值**。
 */
export function configInventory() {
  const raw = readMaybe(CONFIG_PATH);
  if (raw === null) {
    return { values: [], reason: '读不到 config.json（公开副本 / CI 上本来就没有它）⇒ 真值清单为空，只按形状扫' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { values: [], reason: `config.json 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）⇒ 真值清单为空` };
  }

  // 值 → 出处：同一个值可能在多处出现（例如联系人表与通道配置里各写一遍）。
  const found = new Map();
  const jsonText = raw;
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') {
      const kind = isInventoryValue(node);
      if (kind === false) return;
      if (found.has(node)) return;
      // 找出处：在 config.json 原文里定位这个值（JSON 里它会被转义，所以要试两种写法）。
      const forms = [JSON.stringify(node), node];
      let at = -1;
      for (const f of forms) {
        at = jsonText.indexOf(f);
        if (at >= 0) break;
      }
      const line = at < 0 ? 0 : jsonText.slice(0, at).split('\n').length;
      found.set(node, { value: node, kind, source: `config.json:${line} 的 ${path.join('.')}` });
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, [...path, `[${i}]`])); return; }
    for (const [k, v] of Object.entries(node)) {
      // 联系人表的**键**本身就是 sid（`qq:c2c:<openid>`），别漏掉。
      // 键只认 sid 这一档（`forKeys`），长驼峰键名不算凭据——见 isInventoryValue 的注释。
      const kind = isInventoryValue(k, true);
      if (kind !== false && !found.has(k)) {
        const at = jsonText.indexOf(JSON.stringify(k));
        const line = at < 0 ? 0 : jsonText.slice(0, at).split('\n').length;
        found.set(k, { value: k, kind, source: `config.json:${line} 的键 ${[...path, k].join('.')}` });
      }
      walk(v, [...path, k]);
    }
  };
  walk(doc, []);
  return {
    values: [...found.values()].sort((a, b) => b.value.length - a.value.length),
    reason: null,
  };
}

/** 会话 id 里那段 openid（`qq:c2c:<openid>` → `<openid>`），要单独也扫一遍 */
function inventoryForms(entry) {
  const out = [entry.value];
  if (entry.kind === 'sid') {
    const tail = entry.value.slice(entry.value.lastIndexOf(':') + 1);
    if (tail.length >= 6) out.push(tail);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 自造夹具值 —— **都在运行期拼出来，不写成字面量**
//
// 为什么非拼不可：本文件会随 `tools/` 同步进公开副本（tools 在 SYNC_ROOTS 里），而
// `tools/private-words.json` 现在也按**形状**拦 32 位大写十六进制与 channel 上下文里的群号
// ——把样例写成字面量，等于本文件自己撞上它要拦的形状（实测：自检第 ⑤ 条当场红）。
// 拆成 8 字符一段拼起来，源码里就没有那个形状了，运行期才出现。
//
// ⚠️ 这些前缀同时写在 private-words.json 的放行族里（`FFEEDDCC` / `01234567` / `A1B2C3D4` /
//    `0F1E2D3C` / `00000000`）。自检最后一条会盯这件事：本文件这儿放行的族，词表那边也必须放行。
// ════════════════════════════════════════════════════════════════════════════
const FAKE = {
  /** 顺序递增（A1B2C3D4…） */
  seqUp: ['A1B2C3D4', 'E5F60718', '293A4B5C', '6D7E8F90'].join(''),
  /** 两段递减（0F1E2D3C → 4B5A6978 → 8765…） */
  seqDown: ['0F1E2D3C', '4B5A6978', '8796A5B4', 'C3D2E1F0'].join(''),
  /** AABBCC 递减（FFEEDDCC…） */
  aabbcc: ['FFEEDDCC', 'BBAA9988', '77665544', '33221100'].join(''),
  /** 顺序十六进制写两遍（0123456789ABCDEF…） */
  abcdef: ['01234567', '89ABCDEF', '01234567', '89ABCDEF'].join(''),
  /** 脱敏占位值：补零 + 序号 */
  zeroCounter: (n) => `0${String(n).padStart(31, '0')}`,
  /** 群号样例：不在 config.json 里、也没在仓库里出现过的随机数字 */
  groupNo: (digits) => `group_id: ${digits}`,
  groupSid: (digits) => `qq:group:${digits}`,
};

// ════════════════════════════════════════════════════════════════════════════
// 白名单 —— **逐条带理由**，且只收"说明性提及 / 自造夹具"这两类
//
// 纪律：为了让闸门变绿而往这里加条目 = 拆闸门。正确做法是回去改内容再重跑。
// 每条必须有 why；--json 会把没被命中的条目报成 stale（过期白名单也是债，要删）。
//   paths: 只对这些路径生效（glob，`**` 跨目录）；省略 = 所有路径
//   match: 命中文本里必须含这个子串才豁免；省略 = 该 id 的命中全豁免
// ════════════════════════════════════════════════════════════════════════════════
export const WHITELIST = [
  {
    id: 'third-party-fingerprint',
    paths: ['skills/office/**'],
    why: '说明性提及：office 技能的注释与 SKILL.md 里拿它当"能力面参照"与"踩过的坑"举例'
      + '（"和 Kimi 那套对齐的能力面，但实现全是我们自己的"）。**实现是自研的**，没有拷源码；'
      + 'skills/office 零第三方代码、许可干净，这正是它 2026-10-18 进表零的理由。'
      + '⚠️ 这个目录归另一条线在改，本审计不改它——只在这里登记"为什么它可以留着"。',
  },
  {
    id: 'third-party-fingerprint',
    paths: ['gui/test/extensions_page_test.dart'],
    why: '说明性提及：MCP 服务器**名字**，作为扩展页列表夹具里的一个字符串'
      + '（`mcpServer(\'xxx-mcp\', state: \'never-started\', disabled: true)`）。'
      + 'deskhand-mcp 是公开的第三方 MCP 服务，它的仓库地址写在 packaging/installer 里，'
      + '那是公开信息（按"别过度脱敏"的口径：公开仓库地址不是敏感项）。'
      + '夹具里只有名字，没有它的代码、没有它的凭据。',
  },
  {
    id: 'api-key',
    paths: ['test/config.test.ts'],
    why: '自造夹具：变量名就叫 `secret`，值是一句 "secret value must not leak" 的英文占位串'
      + '（`sk-` 打头）。这条用例验的恰恰是"密钥不能泄漏"，值是故意造的，不是真 key。'
      + '⚠️ 这里**不把那个占位串逐字写出来**：本文件会随 tools/ 同步进公开副本，'
      + '写出来就会撞上本闸门自己的 api-key 形态（实测红过一次）。',
  },
  {
    id: 'bearer',
    paths: ['gui/test/auth_gate_test.dart'],
    why: '自造夹具：一个描述性的"旧版界面令牌"占位（`Bearer` + legacy-ui-token-value），'
      + '验的是认证头的解析，不是真凭据。同上，不逐字写出。',
  },
  {
    id: 'bearer',
    paths: ['test/web-search.test.ts'],
    why: '自造夹具：由同一族 `sk-` 占位串拼出来的 Bearer 头（`Bearer` + 那句占位串），'
      + '而且同一份文件里 ANYSEARCH_API_KEY_ENV 也是占位，验的是"密钥从环境变量取、不进日志"。',
  },
  {
    id: 'qq-openid',
    match: FAKE.aabbcc, // FFEEDDCC…（AABBCC 递减）
    why: '自造夹具：AABBCC 递减序列，一眼看得出是造的。用在"不许按 id 去重/不许按 id 判真伪"'
      + '那几条用例里。',
  },
  {
    id: 'qq-openid',
    match: FAKE.abcdef, // 01234567…（顺序十六进制写两遍）
    why: '自造夹具：顺序十六进制（0123456789ABCDEF 写两遍），与 FFEEDDCC 那条同一族，'
      + '用来验"不同 id 不被合并成同一个会话"。',
  },
  {
    id: 'qq-openid',
    match: FAKE.seqUp, // A1B2C3D4…（顺序递增）
    why: '自造夹具：A1B2C3D4… 顺序递增，一眼看得出是造的。',
  },
  {
    id: 'qq-openid',
    match: FAKE.seqDown, // 0F1E2D3C…（两段递减）
    why: '自造夹具：0F1E2D3C → 4B5A6978 → 87654321 的两段递减序列。',
  },
  {
    id: 'qq-group-no',
    match: FAKE.groupSid('111111111'),
    why: '自造夹具：九个 1。用来验"同一个群号在不同 sid 形态下被认成同一个会话"。',
  },
  {
    id: 'qq-group-no',
    match: FAKE.groupSid('222222222'),
    why: '自造夹具：九个 2。与九个 1 那条配对，验"两个不同的群不该被同一份别名配置套住"。',
  },
  // 这里原本还有一条 `test/encoding-boundaries.test.ts` 的白名单（词表里带 `Users` 那条规则的
  // 误报：夹具把用户目录根逐字写进了 Buffer）。2026-10-18 把夹具改成占位符写法
  // （用户名位置写 `<user>`）之后，那条规则不再命中 ⇒ 白名单条目当场失效。
  // 按本闸门"死条目 = 债"的纪律把它撤掉，而不是留着一条永不触发的豁免。
];

// ════════════════════════════════════════════════════════════════════════════
// 小工具
// ════════════════════════════════════════════════════════════════════════════

/** 环境/用法错误 —— 与"命中"分开（退出码 2，见文件头） */
class EnvError extends Error {}

function readMaybe(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function unescapeJs(s) {
  return s.replace(/\\(.)/gu, '$1');
}

/**
 * `const NAME = [ … ];` 里那段方括号内容（用括号配平找结尾，不吃字符串里的 `]`）。
 * `prefix` 用来认 `const NAME = new Map([ … ])` 那种包了一层构造函数壳的写法（OSS_OWN 就是它）。
 */
function arrayBodyOf(src, name, prefix = '') {
  const head = new RegExp(`const\\s+${name}\\s*=\\s*${prefix}\\[`, 'u').exec(src);
  if (!head) return null;
  let i = head.index + head[0].length - 1; // 指向 '['
  let depth = 0;
  let quote = null;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(head.index + head[0].length, i);
    }
  }
  return null;
}

/** 把一段"只有字符串字面量与逗号"的数组内容解析成字符串数组（注释与展开式跳过） */
function literalsOf(inner) {
  const out = [];
  for (const token of inner.replace(/\/\/[^\n]*/gu, '').split(',')) {
    const lit = /^\s*'(?:[^'\\]|\\.)*'\s*$/u.test(token)
      ? /^\s*'((?:[^'\\]|\\.)*)'\s*$/u.exec(token)
      : /^\s*"((?:[^"\\]|\\.)*)"\s*$/u.exec(token);
    if (lit?.[1] !== undefined) out.push(unescapeJs(lit[1]));
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 与 tools/publish-oss.mjs 的 globToRe 同一套语义（`**` 跨目录、`*` 段内、`?` 单字符） */
function globToRe(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i += 1) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i += 1; if (pat[i + 1] === '/') i += 1; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, 'u');
}

/**
 * 解密命中值：**只留头尾**。审计报告是要发给人的，报告里再抄一遍真值 = 第二次泄漏（纪律 ③）。
 * 短值（`Bearer …` 里那一小段）连头都不留够，免得"掩码"成了提示。
 */
function mask(s) {
  const flat = s.replace(/\s+/gu, ' ').trim();
  if (flat.length <= 10) return `${flat.slice(0, 2)}…`;
  return `${flat.slice(0, 8)}…${flat.slice(-2)}`;
}

function git(args) {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new EnvError(`git ${args.join(' ')} 跑不起来：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** git 跟踪的仓库文件（正斜杠、未加引号） */
export function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter((s) => s !== '').sort();
}

/**
 * 未跟踪、且**没被 .gitignore 忽略**的文件。
 * 为什么要它：`git ls-files` 看不见"刚写下、还没提交"的文件，而那些文件**一提交就会同批发出去**
 * ——本工具自己就是第一例（写完当场漏了三处 Windows 用户目录根的绝对路径，因为它还是未跟踪的，
 * 闸门根本不看它；是用 `--include-untracked` 自检才抓到的）。
 * 默认不算进来：默认口径要与两道既有闸门一致（它们只认提交，公开副本镜像的是提交不是草稿纸）。
 * 要拿它做**提交前**自检时加 `--include-untracked`。
 */
export function untrackedFiles() {
  return git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((s) => s !== '').sort();
}

// ════════════════════════════════════════════════════════════════════════════
// 表一 / 表二：**从既有闸门的源码里读**"哪些文件会外发"
//
// 为什么不在这里再抄一份名单：那正是"两处漂移"的形状（仓库历史里踩过多次，
// 见 test/publish-oss-skills.test.ts 第 5 组用例的注释）。本工具只做两件事：
//   ① 读那两张表（正则抠字符串字面量，不执行 PowerShell、也不 import 那个有副作用的脚本）；
//   ② 用与它们**相同的判据**算集合。
// 解析失败一律 EnvError（退出码 2），**不许**退化成"空集合 ⇒ 全绿"。
// ════════════════════════════════════════════════════════════════════════════
export function loadPipeline() {
  const publishSrc = readMaybe(PUBLISH_SRC);
  const assembleSrc = readMaybe(ASSEMBLE_SRC);
  const wordsSrc = readMaybe(WORDS_JSON);
  if (wordsSrc === null) throw new EnvError(`读不到词表：${WORDS_JSON}（既有的两份闸门都靠它，本工具也不另开一份）`);
  let words;
  try {
    words = JSON.parse(wordsSrc);
  } catch (e) {
    throw new EnvError(`词表不是合法 JSON：${WORDS_JSON} — ${e instanceof Error ? e.message : String(e)}`);
  }

  const pipeline = {
    hasPublish: publishSrc !== null,
    hasAssemble: assembleSrc !== null,
    words,
    syncRoots: [],
    excludes: [],
    keep: [],
    ossOwn: [],
    skillsPublic: [],
    sanitizeRules: [],
    payloadFiles: [],
    skillsWhitelist: [],
  };

  // ── 公开副本口径 ───────────────────────────────────────────────────────────
  if (publishSrc !== null) {
    const take = (name, label, prefix = '') => {
      const body = arrayBodyOf(publishSrc, name, prefix);
      if (body === null) throw new EnvError(`tools/publish-oss.mjs 里找不到 ${label}（${name}）—— 判据没法应用`);
      return body;
    };
    pipeline.syncRoots = literalsOf(take('SYNC_ROOTS', '同步范围'));
    pipeline.keep = literalsOf(take('KEEP', 'KEEP 白名单'));
    pipeline.ossOwn = [...take('OSS_OWN', '公开副本自有清单', 'new Map\\(').matchAll(/\[\s*'((?:[^'\\]|\\.)*)'\s*,/gu)]
      .map((m) => unescapeJs(m[1]));
    pipeline.skillsPublic = literalsOf(take('SKILLS_PUBLIC', '技能白名单'));
    pipeline.excludes = [...take('EXCLUDE', '排除表').matchAll(/pat:\s*'((?:[^'\\]|\\.)*)'/gu)]
      .map((m) => unescapeJs(m[1]));

    // 脱敏规则表：按出现顺序取 find / to 两两配对（每条规则各一个）。
    // 为什么要它：本工具审的是"**脱敏之后**会外发的内容"。规则表已经换掉的词（真名、人格名、
    // 「用户」、三个本机路径根）在本工具里就不该再报——否则每一天都会有几十条假命中，
    // 而假命中会把真命中淹掉。
    const rulesBody = take('SANITIZE_RULES', '脱敏规则表');
    const finds = [...rulesBody.matchAll(/find:\s*'((?:[^'\\]|\\.)*)'/gu)].map((m) => unescapeJs(m[1]));
    const tos = [...rulesBody.matchAll(/to:\s*'((?:[^'\\]|\\.)*)'/gu)].map((m) => unescapeJs(m[1]));
    if (finds.length !== tos.length || finds.length === 0) {
      throw new EnvError(`tools/publish-oss.mjs 的 SANITIZE_RULES 解析不对称（find ${finds.length} / to ${tos.length}）`
        + ' —— 判据没法应用，宁可红');
    }
    pipeline.sanitizeRules = finds.map((find, i) => ({ find, to: tos[i] }));

    for (const [label, arr] of [['SYNC_ROOTS', pipeline.syncRoots], ['EXCLUDE', pipeline.excludes],
      ['SKILLS_PUBLIC', pipeline.skillsPublic]]) {
      if (arr.length === 0) throw new EnvError(`tools/publish-oss.mjs 的 ${label} 解析出来是空的 —— 判据没法应用`);
    }
  }

  // ── 便携包口径 ─────────────────────────────────────────────────────────────
  if (assembleSrc !== null) {
    const grab = (re, label) => {
      const m = re.exec(assembleSrc);
      if (!m) throw new EnvError(`packaging/assemble-package.ps1 里找不到 ${label} —— 判据没法应用`);
      return [...m[1].matchAll(/'([^']*)'/gu)].map((x) => x[1]);
    };
    pipeline.skillsWhitelist = grab(/\$SkillsWhitelist\s*=\s*@\(([^)]*)\)/u, '$SkillsWhitelist');
    pipeline.payloadFiles = grab(/\$PayloadFiles\s*=\s*@\(([^)]*)\)/u, '$PayloadFiles');
    if (pipeline.skillsWhitelist.length === 0) throw new EnvError('$SkillsWhitelist 解析出来是空的 —— 判据没法应用');
  }

  return pipeline;
}

/** 技能目录名（`skills/<名>/…` → `<名>`）；不在 skills/ 下返回 null */
function skillNameOf(rel) {
  if (!rel.startsWith('skills/')) return null;
  const rest = rel.slice('skills/'.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? rest : rest.slice(0, slash);
}

/**
 * 这个仓库文件的内容**会不会进公开副本** —— 与 tools/publish-oss.mjs 的 willPublish 同一套判据。
 * 唯一的差别（有意为之）：`OSS_OWN` 里那几份**不算会外发**。理由：那几份在公开副本里是
 * **另一个版本**（脚本第 2 步显式跳过、不覆盖），仓库侧这一份写了什么都不会出去——
 * 例如 brand/README.md 的仓库版就写着本机 Python 绝对路径与真名，而它今天一个有字节都没外发。
 */
export function ossShipSet(pipeline, repoFiles) {
  if (!pipeline.hasPublish) return null;
  const excludeRe = pipeline.excludes.map((pat) => ({ pat, re: globToRe(pat) }));
  const keepSet = new Set(pipeline.keep);
  const ownSet = new Set(pipeline.ossOwn);
  const publicSkills = new Set(pipeline.skillsPublic);

  const exclusionOf = (rel) => {
    if (keepSet.has(rel)) return null;
    return excludeRe.find((e) => e.re.test(rel)) ?? null;
  };
  const underSyncRoot = (rel) => pipeline.syncRoots.some((root) => rel === root || rel.startsWith(`${root}/`));

  const out = new Set();
  for (const rel of repoFiles) {
    if (ownSet.has(rel)) continue;
    const name = skillNameOf(rel);
    if (name !== null) {
      if (publicSkills.has(name)) out.add(rel); // 技能：发不发只看表零，排除表只是备注
      continue;
    }
    if (!underSyncRoot(rel)) continue;
    if (exclusionOf(rel) !== null) continue;
    out.add(rel);
  }
  return out;
}

/**
 * 这个仓库文件**会不会进便携包** —— 与 packaging/assemble-package.ps1 的装配清单同一套判据：
 * `packaging/<$PayloadFiles>` + `skills/<$SkillsWhitelist>/**` + `package.json`。
 * ⚠️ 包里还有 `dist\`（tsc 产物）与 `gui\`（Flutter release 产物）——那是**构建产物**，不在仓库里。
 *    它们的内容由 `src\` 与 `gui\` 的源决定，而这两棵树在**公开副本口径**里是被逐字节扫的
 *    （`src`、`gui` 都在 SYNC_ROOTS 里）⇒ 覆盖上了，这里不必再假装能扫构建物。
 */
export function packageShipSet(pipeline, repoFiles) {
  if (!pipeline.hasAssemble) return null;
  const out = new Set();
  for (const f of pipeline.payloadFiles) out.add(`packaging/${f}`);
  const whitelist = new Set(pipeline.skillsWhitelist);
  for (const rel of repoFiles) {
    const name = skillNameOf(rel);
    if (name !== null && whitelist.has(name)) out.add(rel);
  }
  if (repoFiles.includes('package.json')) out.add('package.json');
  return out;
}

/** 按规则表脱敏一段文本（与 tools/publish-oss.mjs 的 sanitizeText 同一套语义） */
export function sanitizeText(text, rules) {
  let out = text;
  for (const rule of rules) {
    // 源码里的字符串字面量把反斜杠写了两遍（`'D:\\IrmiaAgent\\…'`），两形都要换，否则等于换个写法留着。
    const forms = [rule.find];
    if (rule.find.includes('\\')) forms.push(rule.find.split('\\').join('\\\\'));
    const toForms = [rule.to];
    if (rule.to.includes('\\')) toForms.push(rule.to.split('\\').join('\\\\'));
    forms.forEach((form, i) => {
      // 含 ASCII 字母的规则一律大小写不敏感：Windows 路径不区分大小写（`D:\IrmiaAgent\` 就是 `D:\IrmiaAgent\`），
      // 只认写死的大小写等于留洞。publish-oss.mjs 里逐条标 ci 的是同一件事，这里统一按"更宽"的那一侧。
      const rx = new RegExp(escapeRe(form), /[A-Za-z]/u.test(form) ? 'giu' : 'gu');
      out = out.replace(rx, () => toForms[i] ?? rule.to);
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 扫描
// ════════════════════════════════════════════════════════════════════════════

/** 文本还是二进制：前 8 KB 里有 NUL 就当二进制（不解码、不替换，免得把文件改坏） */
function looksText(buf) {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i += 1) if (buf[i] === 0) return false;
  return true;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 一条 hit 是否被白名单豁免（id 或 idMatches 命中 + 路径 glob 命中 + match 子串命中） */
function whitelistEntryFor(hit, entries) {
  return entries.find((e) => (e.id === hit.id || (e.idMatches !== undefined && e.idMatches.test(hit.id)))
    && (e.paths === undefined || e.paths.some((p) => globToRe(p).test(hit.rel)))
    && (e.match === undefined || hit.text.includes(e.match))) ?? null;
}

/**
 * 扫一批文件。
 * @param {string[]} files 相对仓库根的路径
 * @param {object} opts
 * @param {Record<string, 'oss'|'package'|'repo'>} opts.scopeOf 每个文件的出口（决定用哪一档词表）
 */
export function scan(files, pipeline, opts) {
  const { scopeOf, inventory } = opts;
  const inv = inventory ?? { values: [], reason: '未提供真值清单' };
  const hits = [];
  const whitelisted = [];
  const placeholders = [];
  const stats = { candidates: files.length, scanned: 0, binary: 0, bytes: 0, missing: 0 };
  const usedWhitelist = new Set();

  // 词表按出口分档（包的出厂配置里「用户」是正常称呼，公开副本里一处都不许有——口径写在词表本人的 $comment 里）
  const wordsByScope = {
    oss: pipeline.words.words.filter((w) => (w.scope ?? []).includes('oss')),
    package: pipeline.words.words.filter((w) => (w.scope ?? []).includes('package')),
    repo: pipeline.words.words,
  };

  for (const rel of files) {
    const abs = join(REPO, ...rel.split('/'));
    let buf;
    try {
      if (!statSync(abs).isFile()) continue;
      buf = readFileSync(abs);
    } catch {
      stats.missing += 1;
      continue;
    }
    if (!looksText(buf)) { stats.binary += 1; continue; }
    stats.scanned += 1;
    stats.bytes += buf.length;

    const scope = scopeOf[rel] ?? 'repo';
    // 公开副本口径：先按规则表脱敏，再扫——审的是"**真会出去的那份内容**"，不是仓库里这份草稿。
    // 包的出厂配置不走那张规则表（它是从 config.json 现生成的），所以包口径扫原文。
    const text = scope === 'oss' ? sanitizeText(buf.toString('utf8'), pipeline.sanitizeRules) : buf.toString('utf8');
    const lineOf = lineIndex(text);

    /**
     * 同一个位置只记一次（按 `rel:index` 去重）。
     * 为什么要去重：用户的真实 openid 既会被"本机真值清单"认出来，也会被 `qq-openid` 的形状认出来——
     * 不去重就会把一处泄漏报成两处，读报表的人会以为漏得比实际更狠，而修的时候又只改一处。
     * 顺序也有意为之：真值清单**先跑**，于是同一处命中优先记成"某把真值泄漏了"（它给出的
     * `why` 带 config.json 的行号，比"这是个 32 位十六进制"可操作得多）。
     */
    const claimed = new Set();
    const push = (hit) => {
      const key = `${hit.rel}:${hit.index}`;
      if (claimed.has(key)) return;
      claimed.add(key);
      // 明显占位值：单独一档（既不算命中，也不算白名单）。
      // 只对形状类模式生效——`config-value` 永远不走这条（真值不可能是占位，见 PLACEHOLDER_SHAPES）。
      const shape = hit.placeholderShapes === true ? placeholderOf(hit.text) : null;
      if (shape !== null) { placeholders.push({ ...hit, shape }); return; }
      const entry = whitelistEntryFor(hit, WHITELIST);
      if (entry !== null) { usedWhitelist.add(entry); whitelisted.push({ ...hit, entry }); }
      else hits.push(hit);
    };

    // ── 零、本机真值清单（config.json 里那些真实凭据 / sid / 号）──────────────
    // **先跑**：它认得"这一个具体值"，比形状类模式更精确（见上面 push 的注释）。
    for (const entry of inv.values) {
      for (const form of inventoryForms(entry)) {
        const rx = new RegExp(escapeRe(form), 'gu');
        let m;
        while ((m = rx.exec(text)) !== null) {
          push({
            id: 'config-value',
            rel,
            index: m.index,
            line: lineOf(m.index),
            text: m[0],
            // ⚠️ why 里只写**出处**，绝不写值本身（纪律 ③）
            why: `本机真值原样出现在会外发的文件里：${entry.source}（${entry.kind}）。`
              + '这是最硬的一类——它不是"形状像"，是"就是那一个值"。',
            kind: 'config',
          });
          if (m.index === rx.lastIndex) rx.lastIndex += 1;
        }
      }
    }

    // ── 一、词表（private-words.json，**唯一一份**）────────────────────────
    for (const w of wordsByScope[scope] ?? []) {
      // 带 match 的词：只认正则（正则里写着"排除误报"的条件）。不带 match 的词走字面量，
      // 含 ASCII 字母时大小写不敏感——与两道既有闸门的口径逐条对齐。
      const patterns = w.match !== undefined
        ? [w.match, ...(w.match.includes('\\') ? [w.match.replace(/\\/gu, '\\\\')] : [])]
        : [w.word, ...(w.word.includes('\\') ? [w.word.split('\\').join('\\\\')] : [])];
      for (const pattern of patterns) {
        const rx = new RegExp(
          w.match !== undefined ? pattern : escapeRe(pattern),
          w.match !== undefined ? 'gu' : (/[A-Za-z]/u.test(pattern) ? 'giu' : 'gu'),
        );
        let m;
        while ((m = rx.exec(text)) !== null) {
          push({ id: `word:${w.word}`, rel, index: m.index, line: lineOf(m.index), text: m[0], why: w.why, kind: 'word' });
          if (m.index === rx.lastIndex) rx.lastIndex += 1;
        }
      }
    }

    // ── 二、结构性模式（本工具的补充）───────────────────────────────────────
    for (const p of STRUCTURAL_PATTERNS) {
      // 纪律 ②：探测器词表那一类不扫自己（否则闸门把自己报成泄漏源）；
      // 凭据形状类**照样扫自己**——将来谁往本文件里塞一把真 key，这里立刻红。
      if (rel === SELF_REL && p.id === 'third-party-fingerprint') continue;
      // 包口径只扫"会随包发出去的手写内容"，第三方名字在包里不是敏感项
      if (scope === 'package' && p.id === 'third-party-fingerprint') continue;
      const rx = new RegExp(p.re.source, p.re.flags);
      let m;
      while ((m = rx.exec(text)) !== null) {
        push({
          id: p.id, rel, index: m.index, line: lineOf(m.index), text: m[0], why: p.why, kind: 'pattern',
          placeholderShapes: p.placeholderShapes === true,
        });
        if (m.index === rx.lastIndex) rx.lastIndex += 1;
      }
    }
  }

  const staleWhitelist = WHITELIST.filter((e) => !usedWhitelist.has(e));
  return { hits, whitelisted, placeholders, stats, staleWhitelist, whitelist: WHITELIST };
}

// ════════════════════════════════════════════════════════════════════════════
// 组装一次审计
// ════════════════════════════════════════════════════════════════════════════
/**
 * @param {'ships'|'oss'|'package'|'repo'} scope
 * @returns {{ scope: string, files: string[], scopeOf: Record<string,string>, pipeline: object,
 *            hits: object[], whitelisted: object[], stats: object, staleWhitelist: object[],
 *            words: {oss:number,package:number,repo:number}, ok: boolean }}
 */
export function runAudit(scope = 'ships', opts = {}) {
  if (!['ships', 'oss', 'package', 'repo'].includes(scope)) {
    throw new EnvError(`未知的 scope：${scope}（可选 ships / oss / package / repo）`);
  }
  const pipeline = loadPipeline();
  const repoFiles = opts.includeUntracked === true
    ? [...new Set([...trackedFiles(), ...untrackedFiles()])].sort()
    : trackedFiles();
  const inventory = configInventory();

  const oss = ossShipSet(pipeline, repoFiles);
  const pkg = packageShipSet(pipeline, repoFiles);
  if (scope !== 'repo' && oss === null && pkg === null) {
    throw new EnvError('既读不到 tools/publish-oss.mjs、也读不到 packaging/assemble-package.ps1 —— '
      + '"会外发哪些文件"无从判定（判据没法应用，宁可红）。换 --scope repo 可跑全仓报表。');
  }

  const scopeOf = {};
  let files;
  if (scope === 'repo') {
    files = repoFiles;
  } else {
    const set = new Set();
    if (scope !== 'package' && oss !== null) for (const rel of oss) set.add(rel);
    if (scope !== 'oss' && pkg !== null) for (const rel of pkg) set.add(rel);
    files = [...set].sort();
  }
  for (const rel of files) {
    const inOss = oss !== null && oss.has(rel);
    const inPkg = pkg !== null && pkg.has(rel);
    if (scope === 'repo') scopeOf[rel] = 'repo';
    // 同时进两个出口（例如 skills/office、package.json）⇒ 按**更严**的那一档扫：
    // 公开副本口径（词表 oss 档 + 规则表脱敏）比包口径严（包内「用户」是正常称呼）。
    else if (inOss) scopeOf[rel] = 'oss';
    else if (inPkg) scopeOf[rel] = 'package';
  }

  const result = scan(files, pipeline, { scopeOf, inventory });
  const words = {
    oss: pipeline.words.words.filter((w) => (w.scope ?? []).includes('oss')).length,
    package: pipeline.words.words.filter((w) => (w.scope ?? []).includes('package')).length,
    repo: pipeline.words.words.length,
  };
  return {
    scope,
    files,
    scopeOf,
    pipeline,
    inventory,
    ...result,
    words,
    ok: result.hits.length === 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 自检（--self-test）：证明"闸门本身还有牙"
//
// 为什么闸门要有自己的自检：一个永远返回 0 的闸门看起来和"通过"一模一样。
// 下面这些用例不碰仓库里任何真实内容，只拿**现场构造的样本**验三件事：
//   ① 每条结构性模式**真的会命中**该命中的东西（模式被写坏 = 静默失效）；
//   ② 它**不会**命中明显无害的行（过宽 = 噪声，噪声会把真命中淹掉）；
//   ③ 白名单与"不另开词表"这两条纪律没被绕开。
// 任何一条不过 ⇒ 非 0 退出。这批样本里**一个真值都没有**（纪律 ①）。
// ════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const checks = [];
  const failures = [];
  const ok = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, detail: detail ?? 'ok' });
    } catch (e) {
      failures.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  const pipeline = loadPipeline();
  const sample = {
    token: `A1b2C3d4E5f6G7h8I9j0K1l2M3n4`,
    openid: FAKE.aabbcc,
  };

  // ① 每条模式都得命中它该命中的样本
  const positive = {
    'api-key': `const k = 'sk-${sample.token}';`,
    bearer: `Authorization: Bearer ${sample.token}`,
    'secret-assign': `ONEBOT_WS_ACCESS_TOKEN: "${sample.token}"`,
    'qq-openid': `const sid = 'qq:c2c:${sample.openid}';`,
    'qq-group-no': FAKE.groupNo('705463642'),
    'third-party-fingerprint': '与 Kimi 那套对齐的能力面，实现全是我们自己的',
  };
  for (const p of STRUCTURAL_PATTERNS) {
    ok(`模式 ${p.id} 命中样本`, () => {
      must(positive[p.id] !== undefined, `自检里没有 ${p.id} 的样本 —— 新加模式必须同时给样本`);
      const rx = new RegExp(p.re.source, p.re.flags);
      must(rx.test(positive[p.id]), `${p.id} 没命中自己的样本：${JSON.stringify(positive[p.id])}`);
      return '命中';
    });
  }

  // ② 无害的行一条都不许命中（过宽的模式会把真命中淹掉）
  ok('无害样本零命中', () => {
    const benign = [
      'const taskTokens = 500000000; // 5e8，单日非缓存预算',
      'const budget = { dailyTokens: 50000000 };',
      'curl http://127.0.0.1:7788/api/health',
      'const sha = "9f2c7e1a4b"; // 短哈希',
    ];
    const bad = [];
    for (const p of STRUCTURAL_PATTERNS) {
      if (p.id === 'third-party-fingerprint') continue; // 名字类模式，无害样本里本来就没有那几个词
      const rx = new RegExp(p.re.source, p.re.flags);
      for (const line of benign) if (rx.test(line)) bad.push(`${p.id} 误命中：${line}`);
    }
    must(bad.length === 0, bad.join('；'));
    return `${benign.length} 行 × ${STRUCTURAL_PATTERNS.length - 1} 条模式`;
  });

  // ②-b 占位值判据必须"放行占位、拦住真值"两侧都成立
  //      只测放行那一侧最危险：把 re 写成 /.*/ 也能全绿，而那时候闸门已经等于没了。
  ok('占位值判据两侧都成立', () => {
    const accepted = [FAKE.zeroCounter(1), FAKE.groupNo('123456789'), FAKE.groupSid('123456780')];
    // 反例刻意用**从没在仓库里出现过**的随机数字：拿真号当反例会出事（实测踩过，
    // 自检第 ⑥ 条当场把本文件自己点出来了）。
    const rejected = [sample.openid, FAKE.groupNo('830512647'), FAKE.groupSid('649173825')];
    const bad = [];
    for (const v of accepted) if (placeholderOf(v) === null) bad.push(`该当占位却没认出来：${v}`);
    for (const v of rejected) if (placeholderOf(v) !== null) bad.push(`真值形状被当成占位：${v}`);
    must(bad.length === 0, bad.join('；'));
    return `${PLACEHOLDER_SHAPES.length} 条形状（放行 ${accepted.length} / 拦截 ${rejected.length}）`;
  });

  // ③ 白名单纪律：每条必须有 id/idMatches + 够长的理由；`config-value` 一条都不许有
  ok('白名单逐条带理由', () => {
    for (const [i, e] of WHITELIST.entries()) {
      must(e.id !== undefined || e.idMatches !== undefined, `第 ${i + 1} 条白名单既没有 id 也没有 idMatches`);
      must(typeof e.why === 'string' && e.why.length >= 20, `第 ${i + 1} 条白名单的理由太短（要写清"为什么它可以留"）`);
    }
    return `${WHITELIST.length} 条`;
  });
  ok('白名单不许给真值开后门', () => {
    // `config-value` 是"这一个具体值就是 config.json 里那一把"的命中。给它白名单 =
    // 直接宣布"本机的真凭据可以出现在公开面"，没有任何正当场景。
    const bad = WHITELIST.filter((e) => e.id === 'config-value');
    must(bad.length === 0, '白名单里出现了 config-value 条目：那等于放行本机真凭据');
    return '0 条';
  });
  ok('idMatches 白名单必须唯一解析', () => {
    const words = pipeline.words.words.map((w) => `word:${w.word}`);
    for (const e of WHITELIST.filter((x) => x.idMatches !== undefined)) {
      const hit = words.filter((w) => e.idMatches.test(w));
      must(hit.length === 1, `idMatches ${e.idMatches} 解析到 ${hit.length} 个词（要恰好 1 个，否则白名单放行的范围说不清）`);
    }
    return `${WHITELIST.filter((x) => x.idMatches !== undefined).length} 条`;
  });

  // ③-d 本工具放行的"自造夹具族"，**词表那边也必须放行**。
  // 为什么这条要紧：词表是两个**产物闸门**的口径。如果本文件放行了一个值、而词表拦它，
  // 那这个值今天在源头上"通过"、到了 publish-oss / package-gate 会被拦下——
  // 结果是出包/发布那一步红，而红的地方离原因很远。两边放行同一族是本工具的前提。
  ok('放行的夹具族与词表同向', () => {
    const ossWords = pipeline.words.words.filter((w) => (w.scope ?? []).includes('oss'));
    const bad = [];
    for (const e of WHITELIST) {
      if (e.match === undefined) continue;
      for (const w of ossWords) {
        const rx = w.match !== undefined
          ? new RegExp(w.match, 'u')
          : new RegExp(escapeRe(w.word), /[A-Za-z]/u.test(w.word) ? 'iu' : 'u');
        if (rx.test(e.match)) bad.push(`「${e.match.slice(0, 12)}…」被词表条目「${w.word}」拦着`);
      }
    }
    must(bad.length === 0,
      `本工具放行、词表拦 —— 两处口径不一致（产物闸门会在出包/发布那一步红）：${bad.join('；')}`);
    return `${WHITELIST.filter((e) => e.match !== undefined).length} 个夹具族`;
  });

  // ④ 脱敏规则真的把词换掉了（规则表写歪 = 每一处都变成假命中）
  ok('脱敏规则自洽', () => {
    for (const rule of pipeline.sanitizeRules) {
      const out = sanitizeText(rule.find, pipeline.sanitizeRules);
      must(!out.includes(rule.find), `规则 ${JSON.stringify(rule.find)} 换完还在原地`);
    }
    return `${pipeline.sanitizeRules.length} 条规则`;
  });

  // ⑤ **本文件自己必须是"能发出去"的**：它随 tools/ 同步进公开副本（tools 在 SYNC_ROOTS 里）。
  //    判据不是"没有敏感词"，而是"**过完脱敏规则之后**没有敏感词" —— 与公开副本闸门同一把尺子。
  ok('本文件过完脱敏规则后无 oss 档词', () => {
    const self = readMaybe(fileURLToPath(import.meta.url));
    must(self !== null, '读不到本文件');
    const sanitized = sanitizeText(self, pipeline.sanitizeRules);
    const bad = [];
    for (const w of pipeline.words.words.filter((x) => (x.scope ?? []).includes('oss'))) {
      const rx = new RegExp(w.match ?? escapeRe(w.word), w.match === undefined && /[A-Za-z]/u.test(w.word) ? 'iu' : 'u');
      if (rx.test(sanitized)) bad.push(w.word);
    }
    must(bad.length === 0, `本文件里出现了 oss 档的词（发进公开副本会被拦下）：${bad.join('、')}`);
    return '0 个';
  });

  // ⑥ 本文件里不许有 config.json 里的真值（闸门自己成为泄漏源是最坏的一种）
  ok('本文件不含本机真值', () => {
    const inv = configInventory();
    if (inv.values.length === 0) return `跳过（${inv.reason}）`;
    const self = readMaybe(fileURLToPath(import.meta.url)) ?? '';
    const bad = inv.values.filter((e) => inventoryForms(e).some((f) => self.includes(f)));
    must(bad.length === 0, `本文件里出现了 ${bad.length} 个 config.json 的真值（${bad.map((b) => b.source).join('、')}）`);
    return `${inv.values.length} 条真值都不在`;
  });

  return { ok: failures.length === 0, checks: checks.length, checked: checks, failures };
}

// ════════════════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════════════════
function main(argv) {
  const has = (f) => argv.includes(f);
  const opt = (f, dflt) => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  const scope = opt('--scope', 'ships');
  const asJson = has('--json');
  const listFiles = has('--list');

  // ── 自检：不扫仓库，只验"闸门本身还有牙"（见 selfTest 的注释）────────────────
  if (has('--self-test')) {
    let self;
    try {
      self = selfTest();
    } catch (e) {
      if (e instanceof EnvError) {
        if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }));
        else console.error(`✗ 自检没法跑：${e.message}`);
        return 2;
      }
      throw e;
    }
    if (asJson) {
      console.log(JSON.stringify({ ...self, failures: self.failures.map((f) => f.name) }));
    } else {
      console.log(`脱敏闸门自检：${self.checks} 条`);
      for (const c of self.checked) console.log(`  ✓ ${c.name} —— ${c.detail}`);
      for (const f of self.failures) console.log(`  ✗ ${f.name} —— ${f.error}`);
      console.log(self.ok ? '结论：自检通过（模式有牙、白名单有理由、本文件本身能发出去）'
        : `结论：自检**不通过**（${self.failures.length} 条）`);
    }
    return self.ok ? 0 : 1;
  }

  let audit;
  try {
    audit = runAudit(scope, { includeUntracked: has('--include-untracked') });
  } catch (e) {
    if (e instanceof EnvError) {
      if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }));
      else console.error(`✗ 环境/用法错误：${e.message}`);
      return 2;
    }
    throw e;
  }

  const { files, hits, whitelisted, placeholders, stats, staleWhitelist, pipeline, words, scopeOf, ok } = audit;

  if (asJson) {
    // 与 tools/publish-oss.mjs 的 `--skills-check --json` 同一份契约：**只输出一行 JSON**。
    // 值一律脱敏（纪律 ③）：这份 JSON 会被测试、报表、乃至人贴进 issue。
    console.log(JSON.stringify({
      ok,
      scope,
      scannedFiles: stats.scanned,
      candidates: stats.candidates,
      binarySkipped: stats.binary,
      missing: stats.missing,
      totalHits: hits.length,
      whitelistedHits: whitelisted.length,
      placeholderHits: placeholders.length,
      whitelistEntries: audit.whitelist.length,
      whitelistUsed: audit.whitelist.length - staleWhitelist.length,
      staleWhitelist: staleWhitelist.length,
      words,
      // 这几条是"**表是从脚本源码里现读的，不是写死的**"的证据：测试会拿它们与独立解析对账。
      pipeline: {
        syncRoots: pipeline.syncRoots.length,
        excludes: pipeline.excludes.length,
        ossOwn: pipeline.ossOwn.length,
        skillsPublic: pipeline.skillsPublic,
        sanitizeRules: pipeline.sanitizeRules.length,
        skillsWhitelist: pipeline.skillsWhitelist,
        payloadFiles: pipeline.payloadFiles,
        hasPublish: pipeline.hasPublish,
        hasAssemble: pipeline.hasAssemble,
      },
      inventoryCount: audit.inventory.values.length,
      inventoryReason: audit.inventory.reason,
      files,
      scopeOf,
      hits: hits.map((h) => ({ id: h.id, rel: h.rel, line: h.line, masked: mask(h.text) })),
      whitelisted: whitelisted.map((h) => ({ id: h.id, rel: h.rel, line: h.line, masked: mask(h.text) })),
      placeholders: placeholders.map((h) => ({ id: h.id, rel: h.rel, line: h.line, masked: mask(h.text), shape: h.shape.id })),
    }));
    // repo 口径是**报表**：它刻意不看退出码（见下面人读报表那段同样的判据）。
    return scope === 'repo' ? 0 : (ok ? 0 : 1);
  }

  // ── 人读的报表 ──────────────────────────────────────────────────────────────
  const scopeLabel = scope === 'repo'
    ? '全仓已跟踪文件（**报表**：不改退出码）'
    : scope === 'oss' ? '公开副本口径（publish-oss.mjs）'
      : scope === 'package' ? '便携包口径（assemble-package.ps1）'
        : 'ships = 会进包 ∪ 会进公开副本';
  console.log(`脱敏闸门 · 扫描面：${scopeLabel}`);
  console.log(`仓库：${REPO}`);
  if (pipeline.hasPublish) {
    console.log(`  公开副本口径：同步范围 ${pipeline.syncRoots.length} 个顶层条目`
      + ` / 排除表 ${pipeline.excludes.length} 条 / 公开副本自有 ${pipeline.ossOwn.length} 份（不覆盖⇒不扫）`
      + ` / 技能白名单 ${pipeline.skillsPublic.length} 个（${pipeline.skillsPublic.join(', ') || '空'}）`
      + ` / 脱敏规则 ${pipeline.sanitizeRules.length} 条（先替换再扫）`);
  } else {
    console.log('  公开副本口径：**读不到 tools/publish-oss.mjs**（公开副本里没有它）⇒ 这一侧不参与');
  }
  if (pipeline.hasAssemble) {
    console.log(`  便携包口径：技能白名单 ${pipeline.skillsWhitelist.length} 个（${pipeline.skillsWhitelist.join(', ')}）`
      + ` / 自持件 ${pipeline.payloadFiles.length} 个 + package.json`);
  } else {
    console.log('  便携包口径：**读不到 packaging/assemble-package.ps1** ⇒ 这一侧不参与');
  }
  console.log(`  词表（private-words.json，与既有两道闸门同一份）：oss 档 ${words.oss} 条 / package 档 ${words.package} 条 / 全表 ${words.repo} 条`);
  console.log('  结构性模式（本工具的补充）：'
    + STRUCTURAL_PATTERNS.map((p) => p.id).join(' / '));
  if (audit.inventory.reason !== null) {
    console.log(`  本机真值清单：**${audit.inventory.values.length} 条** —— ${audit.inventory.reason}`);
  } else {
    // 只报条数与出处类型，绝不报值（纪律 ③）
    const kinds = audit.inventory.values.reduce((acc, v) => ({ ...acc, [v.kind]: (acc[v.kind] ?? 0) + 1 }), {});
    console.log(`  本机真值清单：${audit.inventory.values.length} 条（从 config.json 现读：`
      + Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' / ')
      + '）—— 只用来比对，**值不外显**');
  }

  console.log(`\n共扫 ${stats.scanned} 个文件（候选 ${stats.candidates} 个，二进制跳过 ${stats.binary} 个`
    + `${stats.missing > 0 ? `，读不到 ${stats.missing} 个` : ''}，合计 ${(stats.bytes / 1024).toFixed(0)} KB）`
    + ` / 命中 ${hits.length} 处 / 白名单 ${audit.whitelist.length} 条（其中 ${audit.whitelist.length - staleWhitelist.length} 条今天真的用上了）`
    + ` / 明显占位值放行 ${placeholders.length} 处`);

  // 占位值单独列一行：它不是"白名单"（没有逐条理由），而是"按形状判定为自造值"。
  // 把这两档混在一起报，读报表的人就分不清"判断过的"与"认出来是假的"。
  if (placeholders.length > 0) {
    const byShape = new Map();
    for (const p of placeholders) {
      const acc = byShape.get(p.shape.id) ?? { shape: p.shape, list: [] };
      acc.list.push(p);
      byShape.set(p.shape.id, acc);
    }
    console.log(`\n明显占位值放行 ${placeholders.length} 处（按形状，不是逐条白名单）：`);
    for (const [id, { shape, list }] of byShape) {
      console.log(`  · ${id}：${list.length} 处 —— ${shape.why}`);
      for (const p of list.slice(0, 3)) console.log(`      ${p.rel}:${p.line}  ${mask(p.text)}`);
      if (list.length > 3) console.log(`      …（还有 ${list.length - 3} 处）`);
    }
  }

  if (listFiles) {
    console.log(`\n扫描清单（${files.length} 个）：`);
    for (const rel of files) console.log(`  [${scopeOf[rel] ?? 'repo'}] ${rel}`);
  }

  if (whitelisted.length > 0) {
    console.log(`\n白名单放行 ${whitelisted.length} 处（下面对每一处都给出理由——白名单不是"跳过"，是"判断过了"）：`);
    const byEntry = new Map();
    for (const w of whitelisted) {
      const k = w.entry;
      const acc = byEntry.get(k) ?? [];
      acc.push(w);
      byEntry.set(k, acc);
    }
    for (const [entry, list] of byEntry) {
      console.log(`  · [${entry.id}] ${list.length} 处 —— ${entry.why}`);
      for (const w of list.slice(0, 4)) console.log(`      ${w.rel}:${w.line}  ${mask(w.text)}`);
      if (list.length > 4) console.log(`      …（同一条理由在 ${list.length - 4} 处）`);
    }
  }

  if (staleWhitelist.length > 0) {
    console.log(`\n⚠️ 过期白名单 ${staleWhitelist.length} 条（今天一处都没命中 —— 白名单也是债，该删就删）：`);
    for (const e of staleWhitelist) console.log(`  · [${e.id}] ${e.paths?.join(', ') ?? '（所有路径）'} —— ${e.why.slice(0, 60)}…`);
  }

  if (hits.length > 0) {
    console.log(`\n✗ 未白名单的命中 ${hits.length} 处（这批内容**今天不许发**）：`);
    // 先按**互不相同的值**归组，再按模式归组。
    // 为什么按值排前面：78 处命中里其实只有 6 个不同的值（一个 openid 就在 22 个地方出现），
    // 按"处"排会让人以为要改 78 次；按"值"排才知道"改 6 个决定就能清零"。
    const byValue = new Map();
    for (const h of hits) {
      const key = h.text;
      const acc = byValue.get(key) ?? { text: h.text, id: h.id, list: [] };
      acc.list.push(h);
      byValue.set(key, acc);
    }
    console.log(`\n  ▸ 互不相同的命中值 ${byValue.size} 个（下面每一行 = 一个决定，不是一处改动）`);
    for (const { text, id, list } of [...byValue.values()].sort((a, b) => b.list.length - a.list.length)) {
      const files = [...new Set(list.map((h) => h.rel))];
      console.log(`    ${mask(text)}   [${id}]  ${list.length} 处 / ${files.length} 个文件`);
      console.log(`        出处：${list.slice(0, 3).map((h) => `${h.rel}:${h.line}`).join(', ')}`
        + `${list.length > 3 ? ` …（还有 ${list.length - 3} 处）` : ''}`);
    }

    const byPattern = new Map();
    for (const h of hits) {
      const acc = byPattern.get(h.id) ?? [];
      acc.push(h);
      byPattern.set(h.id, acc);
    }
    console.log('\n  ▸ 按模式归组（每一类的判据在这里说清）：');
    for (const [id, list] of byPattern) {
      console.log(`\n    [${id}] ${list.length} 处`);
      console.log(`      为什么拦：${list[0].why}`);
      for (const h of list.slice(0, 6)) console.log(`      ${h.rel}:${h.line}  ${mask(h.text)}`);
      if (list.length > 6) console.log(`      …（还有 ${list.length - 6} 处）`);
    }
    console.log('\n处置：把命中改成占位符（`<用户名>` / `<QQ 号>` / `123456789` 这类明显假值），'
      + '或者——只有当它确实是"说明性提及 / 自造夹具"时——往 tools/sanitize-audit.mjs 的 WHITELIST 加一条**带理由**的条目。');
    console.log('⚠️ 为了让闸门变绿而删词/删模式 = 拆闸门。');
  } else {
    console.log('\n结论：通过 —— 这批会外发的文件里，没有未白名单的敏感面命中。');
  }

  // repo 口径是**报表**：它刻意不看退出码（全仓里有大量"仓库里可以有、但不会外发"的内容：
  // docs/ 与 _research/ 都在排除表里，报告与调研里写着本机路径是正常的）。
  if (scope === 'repo') return 0;
  return ok ? 0 : 1;
}

// 只在直接执行时跑 CLI（被 test/sanitize.test.ts import 时不要跑）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

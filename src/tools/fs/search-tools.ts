/**
 * Irmia Agent — 文件系工具包：搜索两件（rg_search / es_search）
 *
 * **两件都是条件注册的**（v30）：探测到引擎才把这件工具造出来，没有就不注册。
 *
 * 这条口径是用户拍的：**外部依赖由框架强制安装**（GUI 里一键装、装不了就显式提示），
 * 于是"引擎缺失"是一个**已经被告知过的环境状态**，不再需要工具层面的降级链——
 * "因为强制安装了依赖，那么可以删掉降级链了"。删掉的收益不只是少一段代码：
 * 一件"永远降级"的工具比没有这件工具更糟，模型会先想到它，然后每次都以
 * "引擎调用失败"开场，白烧一次调用与一份常驻 token（v27 对 es_search 的实测：
 * 5 次调用全部 fallback）。rg_search 这一轮补上同一条口径。
 *
 * 它原先的降级是"TS 逐行扫描"（v27 之前 es_search 也有一份，那时已删）。那个 fallback
 * 的坏处更隐蔽：它让"降级"看起来像成功——**同一件工具、同一种结果形状、换了个引擎**，
 * 模型完全看不出这次搜索是全盘扫出来的（慢、且不受 .gitignore 约束），
 * 于是也没人会想到去装 ripgrep。宁可它不出现。
 *
 * **但"没有时如实告知"保留**：工具不出现是注册层面的事，不能静默消失得无声无息。
 * 启动日志里会写一条（`buildFsTools` 的 onNote，见 fs/index.ts），
 * `GET /api/deps` 与设置页「外部依赖」卡片也会说清"没装 rg 会怎样 + 怎么装"。
 *
 * rg_search 的输出解析基于 rg 的 `--null`：路径与行内容之间是 NUL 字节，
 * 于是「Windows 路径里的 `C:\` 冒号」与「匹配文本里的冒号」都不再是歧义源。
 * 实测输出形状（rg 15.1.0）：
 *     .\a.txt<NUL>2:foo one      ← 匹配行：<行号>:<文本>
 *     .\a.txt<NUL>1-alpha        ← 上下文行：<行号>-<文本>
 * 列号不由 rg 提供，改由本模块在匹配文本上重跑一次匹配算出来，避免依赖
 * `--column` 那种「上下文行没有列号」的不对称格式。
 *
 * es_search 的参数取自 voidtools 官方 CLI 文档（已核验）：
 *   `-n <num>` 限制结果数、`-path <path>` 限定目录、`-r` 正则、`-p` 全路径匹配；
 *   注意 `-i` 在 es 里是 **区分大小写**（与 rg 相反），所以「忽略大小写」时不能加它。
 *   退出码 8 = Everything IPC 窗口不存在（客户端没在跑）——**如实报错，不降级**：
 *   工具既然是因为探测到引擎才注册的，静默走一遍全盘扫描只会让她以为索引还有效。
 */

import { relative } from 'node:path';

import { PATH_BOUNDARY_HINT } from '../boundary.ts';
import type { FsEnv } from './env.ts';
import { resolveGuarded } from './env.ts';
import { buildMatcher } from './search-core.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  ok,
  readOptionalBool,
  readOptionalInt,
  readOptionalString,
  readString,
  type ProcessResult,
  type ToolContext,
  type ToolDefinition,
} from './types.ts';

/** rg 的 max-filesize 默认值：8MB（单文件超过它就是"这不是源码"，跳过比读进来强） */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

// ──────────────────────────────── 公共结果形状 ────────────────────────────────

interface SearchHit {
  relPath: string;
  line: number;
  column: number;
  text: string;
  contextBefore: Array<{ line: number; text: string }>;
  contextAfter: Array<{ line: number; text: string }>;
}

function renderHits(hits: readonly SearchHit[], engineLabel: string, header: string): string {
  if (hits.length === 0) return `${engineLabel}\n${header}\n(无命中)`;
  const maxLine = hits.reduce((max, hit) => {
    const boundary = Math.max(hit.line, ...hit.contextAfter.map((c) => c.line), ...hit.contextBefore.map((c) => c.line));
    return Math.max(max, boundary);
  }, 1);
  const width = String(maxLine).length;
  const blocks = hits.map((hit) => {
    const rows: string[] = [`${hit.relPath}:${hit.line}:${hit.column}: ${hit.text}`];
    for (const ctx of hit.contextBefore) {
      rows.push(`  ${String(ctx.line).padStart(width, ' ')}| ${ctx.text}`);
    }
    rows.push(`  ${String(hit.line).padStart(width, ' ')}: ${hit.text}`);
    for (const ctx of hit.contextAfter) {
      rows.push(`  ${String(ctx.line).padStart(width, ' ')}| ${ctx.text}`);
    }
    return rows.join('\n');
  });
  return `${engineLabel}\n${header}\n\n${blocks.join('\n\n')}`;
}

function truncationNote(shown: number, limit: number): string {
  return shown >= limit ? `\n[已达上限 ${limit}：缩小 pattern、加 path/glob 或用更精确的正则]` : '';
}

// ──────────────────────────────── 引擎探测结论 ────────────────────────────────

/**
 * 探测结论（由 `src/deps/` 给出）。`available` 为假时调用方**不注册**这件工具。
 *
 * 与 v27 的 `EsSearchProbeGate` 是同一个东西，只是把它从本文件搬到了框架层：
 * 结论与分派仍然是同一份判断（不会出现"注册了但一调就降级"），
 * 但"哪几个候选、什么顺序、用户指没指路径"这些事现在只有 `src/deps/probe.ts` 知道。
 */
export interface SearchEngineGate {
  available: boolean;
  /** 探测认定的可执行文件（可能是完整路径）；不可用时为空串 */
  command: string;
  /** 引擎版本标签（写进结果首行，便于排障） */
  label: string;
  /** 不可用的原因（启动日志与报告用的人话） */
  reason: string;
}

/**
 * 把依赖探测结论翻译成搜索工具的闸门结论。
 * 只吃需要的四个字段（而不是整个 `DepProbeResult`）：调用方手里可能是
 * `DependencyProbeOutcome`（管理器给的，多几个字段），少一层搬运就少一处漂移。
 */
export function searchGateOf(
  probe: { ok: boolean; path: string; version: string; reason: string },
  label: string,
): SearchEngineGate {
  if (probe.ok) {
    return {
      available: true,
      command: probe.path,
      label: `${label} ${probe.version}`.trim(),
      reason: '',
    };
  }
  return { available: false, command: '', label: '', reason: probe.reason };
}

// ──────────────────────────────── rg_search ────────────────────────────────

/** 解析 rg --null 输出。任何解析不了的行都丢掉，绝不让格式细节把整次搜索变成错误 */
function parseRgNullOutput(stdout: string, root: string, fallbackPath: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // 上下文缓冲：同一文件的连续行先攒着，遇到匹配行再分配到前后
  interface Pending {
    file: string;
    line: number;
    text: string;
    isMatch: boolean;
  }
  const pending: Pending[] = [];

  const flush = (): void => {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i] as Pending;
      if (!item.isMatch) continue;
      const before: Array<{ line: number; text: string }> = [];
      for (let j = i - 1; j >= 0 && pending[j]?.isMatch === false; j--) {
        const ctx = pending[j] as Pending;
        before.unshift({ line: ctx.line, text: ctx.text });
      }
      const after: Array<{ line: number; text: string }> = [];
      for (let j = i + 1; j < pending.length && pending[j]?.isMatch === false; j++) {
        const ctx = pending[j] as Pending;
        after.push({ line: ctx.line, text: ctx.text });
      }
      hits.push({
        relPath: item.file,
        line: item.line,
        column: 1,
        text: item.text,
        contextBefore: before,
        contextAfter: after,
      });
    }
    pending.length = 0;
  };

  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (rawLine === '') continue;
    if (rawLine === '--') {
      flush();
      continue;
    }
    const nul = rawLine.indexOf('\0');
    let file: string;
    let rest: string;
    if (nul === -1) {
      // 单文件搜索时 rg 可能省略文件名（已加 -H，这里是兜底）
      file = fallbackPath;
      rest = rawLine;
    } else {
      file = rawLine.slice(0, nul);
      rest = rawLine.slice(nul + 1);
    }
    const parsed = /^(\d+)([:-])(.*)$/u.exec(rest);
    if (parsed === null) continue;
    const lineNo = Number(parsed[1]);
    const isMatch = parsed[2] === ':';
    const text = parsed[3] ?? '';
    const pendingFile = relative(root, file).replaceAll('\\', '/');
    const last = pending[pending.length - 1];
    if (last !== undefined && last.file !== pendingFile) flush();
    pending.push({ file: pendingFile, line: lineNo, text, isMatch });
  }
  flush();
  return hits;
}

export function createRgSearchTool(env: FsEnv, gate: SearchEngineGate): ToolDefinition {
  return {
    name: 'rg_search',
    // path 那句是 P3 的正面修法：描述说清"文件也吃得下"，她就不必先猜对工具。
    // 实测依据：11 次把文件路径喂进来、被"不是目录"挡回去（docs/tools-audit.md §2.2），
    // 而 `rg` 本来就吃文件操作数——挡它的是我们自己多要的那一道 requireDirectory。
    description:
      '按内容搜索（不是文件名）：由 ripgrep 引擎执行，首行标注 engine。' +
      '支持正则、glob 过滤、上下文行、忽略大小写；path 给目录就递归搜、给单个文件就只搜它。' +
      '定位后用 safe_read 读区间。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（默认）或字面量（fixed_strings=true）' },
        path: { type: 'string', description: `搜索范围：目录（递归搜）或单个文件（只搜它），默认工作根。${PATH_BOUNDARY_HINT}` },
        glob: { type: 'string', description: '文件名过滤，如 "*.ts" 或 "src/**/*.{ts,js}"；多个用逗号分隔' },
        context: { type: 'integer', description: '每条命中前后各带多少行上下文，默认 0（只看命中行），上限 20' },
        max_results: { type: 'integer', description: '最多返回多少条命中，默认 40' },
        case_sensitive: { type: 'boolean', description: '区分大小写，默认 false（默认不区分，与 ripgrep 默认相反）' },
        fixed_strings: { type: 'boolean', description: '把 pattern 当字面量而不是正则，默认 false' },
        max_file_bytes: { type: 'integer', description: '跳过大于该字节数的文件，默认 8388608' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 15_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'rg_search');
      if (args === null) return invalidArgs('rg_search', '期望一个对象，例如 {"pattern": "TODO", "glob": "*.ts"}');
      const pattern = readString(args, 'pattern');
      if (pattern === null || pattern === '') return invalidArgs('rg_search', '缺少 pattern');

      const ctxRes = readOptionalInt(args, 'context', 0, 20);
      if ('error' in ctxRes) return invalidArgs('rg_search', ctxRes.error);
      const maxRes = readOptionalInt(args, 'max_results', 1, 1000);
      if ('error' in maxRes) return invalidArgs('rg_search', maxRes.error);
      const sizeRes = readOptionalInt(args, 'max_file_bytes', 1024, 512 * 1024 * 1024);
      if ('error' in sizeRes) return invalidArgs('rg_search', sizeRes.error);
      const contextLines = ctxRes.value ?? 0;
      const maxResults = maxRes.value ?? 40;
      const maxFileBytes = sizeRes.value ?? MAX_FILE_BYTES;
      // 参数名与默认值都照 devkit：那边是 `case_sensitive`，默认 false = **不区分大小写**
      // （`_registry.py:583-605`、`tools/rg_search.py:244-252`）。旧实现是 `ignore_case`
      // 默认 false = 区分大小写，方向正好相反——默认值翻转会**静默改变召回**，
      // 所以这里连参数名一起换成源的名字：`case_sensitive` 的默认值写在名字里（false 即"不敏感"），
      // 而 `ignore_case` 这个名字配 false 读起来像"不忽略=敏感"，两套读法都有理，正是要消除的歧义。
      const caseSensitive = readOptionalBool(args, 'case_sensitive') ?? false;
      const ignoreCase = !caseSensitive;
      const fixedStrings = readOptionalBool(args, 'fixed_strings') ?? false;
      const globArg = readOptionalString(args, 'glob');

      const pathInput = readOptionalString(args, 'path') ?? '.';
      // **目录与单个文件都收**（P3）：传目录照旧递归搜，传文件就只搜那一个文件——
      // 这正是 rg 的基本用法，`--with-filename` 已经在，单文件的命中照样带文件名。
      // 旧口径要的是 `requireDirectory: true`（只收目录），把"文件操作数"整个挡在门外：
      // 实测 11 次传文件被拒，占它 16 次失败里的 11 次（docs/tools-audit.md §2.2）。
      const target = await resolveGuarded(env, ctx, pathInput, {
        purpose: 'rg_search',
        allowDirectory: true,
      });
      if (!target.ok) return fail(target.code, target.reason);
      const searchRoot = target.path;

      const matcherResult = buildMatcher(pattern, { ignoreCase, fixedStrings });
      if ('error' in matcherResult) return invalidArgs('rg_search', matcherResult.error);
      const matcher = matcherResult.matcher;
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const globs = globArg === undefined ? [] : globArg.split(',').map((g) => g.trim()).filter((g) => g !== '');
      const rgArgs = [
        '--line-number',
        '--no-heading',
        '--with-filename',
        '--null',
        '--color', 'never',
        '--context', String(contextLines),
        '--max-filesize', String(maxFileBytes),
        '--no-messages',
      ];
      if (ignoreCase) rgArgs.push('--ignore-case');
      if (fixedStrings) rgArgs.push('--fixed-strings');
      for (const glob of globs) rgArgs.push('--glob', glob);
      rgArgs.push('--', pattern, searchRoot);

      const result: ProcessResult = await env.deps.runProcess(gate.command, rgArgs, {
        timeoutMs: 14_000,
        signal: ctx.signal,
      });
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // 退出码 0=有命中，1=无命中，2=出错。出错**不再降级**（v30 删掉了 TS 扫描那条路）：
      // 工具是因为探测到引擎才注册的，这时换成"我们自己扫一遍"只会让结果换个来源而看不出来。
      // 如实报错 + 给出路（装/修 ripgrep），比一个换了引擎的"成功"结果诚实。
      if (result.timedOut || (result.failed && result.code === null) || (result.code !== 0 && result.code !== 1)) {
        const why = result.timedOut
          ? '调用超时'
          : result.failed && result.code === null
            ? result.stderr.trim() || '无法启动'
            : result.stderr.trim() || `退出码 ${result.code ?? 'null'}`;
        return fail(
          FS_ERROR_CODES.SEARCH_FAILED,
          `ripgrep 未返回结果：${why}（引擎 ${gate.command}）。`
          + '请确认它在设置页「外部依赖」里显示为已就绪；按文件名找用 es_search，'
          + '或先 list_dir 看目录结构。',
        );
      }

      const hits = parseRgNullOutput(result.stdout, ctx.workspaceRoot, searchRoot);
      for (const hit of hits) {
        const hit2 = matcher(hit.text);
        hit.column = hit2 === null ? 1 : hit2.index + 1;
      }
      const limited = hits.slice(0, maxResults);
      const engine = `engine: ripgrep (${gate.label})`;
      const header =
        `模式 ${'`'}${pattern}${'`'} · 命中 ${hits.length} 处 / 文件 ${new Set(hits.map((h) => h.relPath)).size} 个 · ` +
        `context=${contextLines}${ignoreCase ? ' · 忽略大小写' : ' · 区分大小写'}${fixedStrings ? ' · 字面量' : ''}`;
      return ok(renderHits(limited, engine, header) + truncationNote(limited.length, maxResults));
    },
  };
}

// ──────────────────────────────── es_search ────────────────────────────────

/**
 * es_search 的探测闸门在 v27 就有了（当时是本文件里的 `createEsSearchProbeGate`），
 * v30 把它交给了框架层：候选清单与三段顺序（用户指定 → 自装目录 → PATH）现在只有
 * `src/deps/probe.ts` 一处知道，本文件只拿结论。上一版那 5 个候选**串行各一次 ENOENT**
 * 的代价（review v27 的 Σ-5）也随之消失——探测只做一次，结论在工具之间共享。
 *
 * handler 直接照 `gate` 分派、不再探第二次：注册结论与运行行为必须一致，
 * 否则会出现"注册时说有、执行时说没有"的自相矛盾两句话。
 */
export function createEsSearchTool(env: FsEnv, gate: SearchEngineGate): ToolDefinition {
  return {
    name: 'es_search',
    description:
      '按文件名搜索（找内容用 rg_search）：由 Everything 索引秒回，支持 * 与 ? 通配符，' +
      '也可整个路径匹配。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名模式，支持 * 与 ?，如 "*.test.ts"；也给字面量子串如 "config"' },
        path: { type: 'string', description: `限定搜索目录（相对工作根），默认工作根。${PATH_BOUNDARY_HINT}` },
        max_results: { type: 'integer', description: '最多返回多少个文件，默认 100；传 0 表示只报数量、不列文件' },
        match_path: { type: 'boolean', description: 'true 时对整个路径匹配而不是只匹配文件名，默认 false' },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认 true' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 15_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'es_search');
      if (args === null) return invalidArgs('es_search', '期望一个对象，例如 {"pattern": "*.test.ts"}');
      const pattern = readString(args, 'pattern');
      if (pattern === null || pattern === '') return invalidArgs('es_search', '缺少 pattern');
      // max_results 的最小值是 **0**（旧实现是 1，`max_results:0` 直接报参数错）：devkit 把
      // 0 定义为"只统计不返回列表"（`tools/es_search.py:220`、`:275-276`），它的 schema 里
      // 这个 0 是写明的默认边界之一。模型在"先探一下有多少个"的场景会真的用 0。
      const maxRes = readOptionalInt(args, 'max_results', 0, 2000);
      if ('error' in maxRes) return invalidArgs('es_search', maxRes.error);
      const maxResults = maxRes.value ?? 100;
      // 0 = 只要数量：es.exe 那边就不加 `-n`（与源 `if max_results > 0` 同判据），
      // 但**结果一条都不列**——这正是她传 0 时要的东西，也是它省上下文的地方。
      const countOnly = maxResults === 0;
      const matchPath = readOptionalBool(args, 'match_path') ?? false;
      const ignoreCase = readOptionalBool(args, 'ignore_case') ?? true;

      const pathInput = readOptionalString(args, 'path') ?? '.';
      const guarded = await resolveGuarded(env, ctx, pathInput, {
        purpose: 'es_search',
        requireDirectory: true,
      });
      // 错误消息给一句出路（0 token：结果不进 tools 段，行为一个字不动）：
      // es 的实参是 `-path <dir>`，给它文件只会返回空——所以"只吃目录"这条要**拦在前面**，
      // 而 path-guard 只说"不是目录"、没有下一步。传文件进来时她要做的正是 rg_search（P3 之后它吃文件）。
      if (!guarded.ok) {
        return fail(
          guarded.code,
          guarded.reason
          + (guarded.code === FS_ERROR_CODES.NOT_A_DIRECTORY
            ? '；es_search 只按文件名搜目录，要按内容搜这个文件请用 rg_search（它吃文件操作数）'
            : ''),
        );
      }
      const searchRoot = guarded.path;
      const patternText = pattern;
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // es 的 -i 表示「区分大小写」，与 rg 相反；忽略大小写时不能加
      // `-n` 只在 max_results > 0 时给（源 `tools/es_search.py:275-276` 同判据）
      const esArgs = countOnly ? ['-path', searchRoot] : ['-n', String(maxResults), '-path', searchRoot];
      if (!ignoreCase) esArgs.push('-i');
      if (matchPath) esArgs.push('-p');
      esArgs.push('--', patternText);

      const result = await env.deps.runProcess(gate.command, esArgs, {
        timeoutMs: 14_000,
        signal: ctx.signal,
      });
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // 退出码 8 = Everything IPC 窗口不存在（客户端没在跑）。装过 es.exe 的机器上这仍然会发生
      // ——Everything 客户端退出了而 es.exe 还在。此时**不降级**：工具既然是因为探测到引擎
      // 才注册的，静默走一遍全盘扫描只会让模型误以为索引还有效（也白烧一次扫描）。
      // 如实报错 + 给出路，比一个换了引擎的"成功"结果诚实。
      const engineDead = result.code === 8 || /IPC|Everything search client/u.test(result.stderr);
      if (result.timedOut || engineDead || result.code !== 0) {
        const why = result.timedOut
          ? '调用超时'
          : engineDead
            ? 'Everything 客户端没有在运行（退出码 8）——启动 Everything 后重试'
            : result.stderr.trim() || `退出码 ${result.code ?? 'null'}`;
        return fail(
          FS_ERROR_CODES.SEARCH_FAILED,
          `es.exe 未返回结果：${why}。找文件内容用 rg_search；按名字找且引擎不可用时，可用 list_dir 逐层看。`,
        );
      }

      const found = result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const engine = `engine: everything (${gate.label})`;
      const header = `模式 ${'`'}${patternText}${'`'} · 命中 ${found.length} 个文件`;
      // max_results=0：只报数量。**一条路径都不列**——这是"先探一下有多少个"的调用，
      // 列出来就等于没省（而省上下文正是她传 0 的目的）。
      if (countOnly) {
        return ok(`${engine}\n${header}\n（max_results=0：只统计不列文件；要看清单请传 max_results≥1）`);
      }
      const limited = found.slice(0, maxResults);
      const body = limited.map((p) => relative(ctx.workspaceRoot, p).replaceAll('\\', '/')).join('\n');
      return ok(`${engine}\n${header}\n\n${body}${found.length === 0 ? '(无命中)' : ''}${truncationNote(limited.length, maxResults)}`);
    },
  };
}

/** 供测试断言用：搜索工具必然把 engine 写在首行 */
export const ENGINE_LINE_PREFIX = 'engine: ';

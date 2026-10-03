/**
 * Irmia Agent — 文件系工具包测试
 *
 * 对齐 docs/milestones.md M4-1（路径越界）/ M4-2（符号链接绕过）验收，
 * 以及 design.md §4.18 里 safe 家族的五步链语义。
 *
 * 白名单类用例刻意放在真实临时目录里跑，而不是打桩：只有让内核真的解析
 * `..`、真的跟一遍符号链接，才能证明「拒绝」不是因为路径拼错。
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildMatcher,
  createEnv,
  estimateTokens,
  FS_ERROR_CODES,
  globToRegExp,
  listBackups,
  MAX_DESCRIPTION_TOKENS,
  runProcessDefault,
  splitLines,
  encodeText,
  decodeText,
  fuzzyMatch,
  planEdit,
  resolveInsideRoot,
  isInside,
  BLOB_ID_PATTERN,
  fsTools,
  type DetectedEncoding,
  type ToolContext,
  type ToolDefinition,
} from '../src/tools/fs/index.ts';
import { DepsManager } from '../src/deps/manager.ts';
import { DEP_SPECS } from '../src/deps/probe.ts';

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

interface Harness {
  root: string;
  outside: string;
  backupDir: string;
  ctx: ToolContext;
  tool(name: string): ToolDefinition;
  /** 工具是否注册（rg_search / es_search 都是条件注册的，断言"没注册"要用它） */
  has(name: string): boolean;
  /** 本次装配用到的探测次数（锁"一次探测"这条不变量） */
  probes(): number;
}

/**
 * 假依赖管理器的探测路由：**测试要的是"路由到哪个可执行文件"，
 * 版本号用不到**（工具首行写的是探测认定的那个命令）。
 * 非 Windows 上 fake-deps-exe 真能跑（见 ensureFakeEngineScript），
 * Windows 上退回真实探测——那时"有引擎"的用例会显式跳过。
 */
const FAKE_DEP_EXE = 'fake-deps-exe';

let fakeEnginePath: string | null = null;

/**
 * 造一个真能跑的假引擎脚本（POSIX）。为什么不用"指向一个不存在的文件"：
 * 那样 `spawn` 会 ENOENT，而"引擎可用"这条路径根本没被走到——
 * 用例会以"未返回结果"失败，看起来像实现坏了。假引擎必须在盘上、真能执行。
 */
async function ensureFakeEngineScript(): Promise<void> {
  if (process.platform === 'win32' || fakeEnginePath !== null) return;
  const root = await mkdtemp(join(tmpdir(), 'irmia-fake-engine-'));
  const path = join(root, 'fake-deps-exe');
  await writeFile(path, '#!/bin/sh\nprintf "ripgrep 15.1.0 (fake)\\n"\n', 'utf8');
  await chmod(path, 0o755);
  fakeEnginePath = path;
}

/**
 * 假依赖管理器。**绝不让测试依赖本机装没装 rg / es**：
 * 探测走注入的 runProcess（测试自己的假实现），没有注入时对 rg 退回真实探测
 * （唯一一处"允许碰真机"的地方，且只影响"调用引擎"那条用例的可用性）。
 *
 * `options.ripgrepPath / everythingPath` 的语义原样保留：`null` = 显式禁用，
 * 字符串 = 指定路径（等价于 config 里指定的第一段）。
 */
function makeFakeDeps(
  root: string,
  options: Record<string, unknown>,
  deps: Record<string, unknown>,
  counter: { n: number },
): DepsManager {
  const configPaths: DepPaths = {
    ...(typeof options['ripgrepPath'] === 'string' ? { rg: options['ripgrepPath'] as string } : {}),
    ...(typeof options['everythingPath'] === 'string' ? { es: options['everythingPath'] as string } : {}),
  };
  const disabled = {
    rg: options['ripgrepPath'] === null,
    es: options['everythingPath'] === null,
  };
  const run = deps['runProcess'] as
    | ((command: string, args: string[], opts: unknown) => Promise<{
      code: number | null; stdout: string; stderr: string; failed: boolean; timedOut: boolean;
    }>)
    | undefined;

  const probe = async (name: string): Promise<{ version: string; path: string } | null> => {
    // 显式禁用 = 不探（连计数都不加）：显式禁用的语义就是"别碰它"
    if (name === 'rg' && disabled.rg) return null;
    if (name === 'es' && disabled.es) return null;
    counter.n += 1;
    // 版本参数照依赖定义走（es 是单横线 `-version`，rg 是 `--version`）：
    // 测试替掉的只是"进程怎么跑"，不是"探测该问什么"
    const args = [...DEP_SPECS[name as 'rg' | 'es'].versionArgs()];
    if (run !== undefined) {
      const result = await run(FAKE_DEP_EXE, args, { timeoutMs: 5000 });
      return result.timedOut || result.code !== 0 ? null : { version: 'fake', path: FAKE_DEP_EXE };
    }
    if (name !== 'rg') return null;
    const command = fakeEnginePath ?? 'rg';
    const real = await runProcessDefault(command, args, { timeoutMs: 5000 });
    return real.code === 0 && /ripgrep/u.test(real.stdout) ? { version: 'fake', path: command } : null;
  };

  return new DepsManager({
    dataDir: join(root, 'data'),
    configPaths,
    ...(disabled.rg ? { ripgrepPath: null } : {}),
    ...(disabled.es ? { everythingPath: null } : {}),
    probe: async (name) => {
      const probed = await probe(name);
      const ok = probed !== null;
      return {
        name,
        status: ok ? 'ready' as const : 'missing' as const,
        path: ok ? probed.path : '',
        version: ok ? '15.1.0' : '',
        anyVersion: ok ? '15.1.0' : '',
        source: ok ? 'config' as const : null,
        dir: null,
        reason: ok ? '' : `测试环境：${name} 不可用`,
        attempts: ok ? [`test: ${probed.path}`] : [`test: ${name} 不可用`],
      };
    },
  });
}

type DepPaths = { pwsh?: string; rg?: string; es?: string };

async function makeHarness(
  options: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'irmia-fs-ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'irmia-fs-out-'));
  const backupDir = join(root, '.backups');
  const counter = { n: 0 };
  const manager = makeFakeDeps(root, options, deps, counter);

  // fsTools 是 async 的（两件搜索工具要探测到引擎才注册），所以装配这一步在工作台里 await 一次
  const table = new Map<string, ToolDefinition>();
  await fsTools(
    { register: (tool) => table.set(tool.name, tool) },
    { backupDir, ...options, deps: manager },
    { now: () => new Date('2026-02-01T00:00:00.000Z'), ...deps },
  );

  const lookup = (name: string): ToolDefinition => {
    const tool = table.get(name);
    assert.ok(tool !== undefined, `工具 ${name} 未注册`);
    return tool;
  };

  return {
    root,
    outside,
    backupDir,
    ctx: {
      callId: 'call-1',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
    },
    tool: lookup,
    has: (name) => table.has(name),
    probes: () => counter.n,
  };
}

async function withHarness(
  body: (h: Harness) => Promise<void>,
  options: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
): Promise<void> {
  const har = await makeHarness(options, deps);
  try {
    await body(har);
  } finally {
    await rm(har.root, { recursive: true, force: true });
    await rm(har.outside, { recursive: true, force: true });
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

let rgAvailable: boolean | null = null;
async function detectRipgrep(): Promise<boolean> {
  if (rgAvailable === null) {
    const result = await runProcessDefault('rg', ['--version'], { timeoutMs: 5000 });
    rgAvailable = result.code === 0 && /ripgrep/u.test(result.stdout);
  }
  return rgAvailable;
}

// ──────────────────────────────── 纯函数单元 ────────────────────────────────

describe('text-codec', () => {
  it('splitLines 区分空文件与「一个空行」', () => {
    assert.deepEqual(splitLines('').lines, []);
    assert.deepEqual(splitLines('\n').lines, ['']);
    assert.deepEqual(splitLines('a\n').lines, ['a']);
    assert.deepEqual(splitLines('a\r\nb').lines, ['a', 'b']);
    assert.equal(splitLines('a\r\nb').eol, '\r\n');
    assert.equal(splitLines('a\r\nb').trailingNewline, false);
  });

  it('encodeText 保持 UTF-8 BOM 与 UTF-16LE', () => {
    const bom = encodeText('你好', 'utf8-bom');
    assert.equal(bom.buffer.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(decodeText(bom.buffer).text, '你好');
    assert.equal(decodeText(bom.buffer).encoding, 'utf8-bom');

    const utf16 = encodeText('hello', 'utf16le');
    assert.equal(utf16.buffer.subarray(0, 2).toString('hex'), 'fffe');
    assert.equal(decodeText(utf16.buffer).text, 'hello');
    assert.equal(decodeText(utf16.buffer).encoding, 'utf16le');
  });

  it('GBK 内容能被探针识别（写出时降级为 UTF-8 并说明）', () => {
    // "中文" 的 GBK 字节
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    const decoded = decodeText(gbk);
    assert.equal(decoded.text, '中文');
    assert.equal(decoded.encoding, 'gbk');

    const encoded = encodeText('中文', 'gbk');
    assert.equal(encoded.encoding, 'utf8');
    assert.equal(encoded.notes.length, 1);
  });

  it('globToRegExp 支持 ** 与 {a,b}', () => {
    assert.ok(globToRegExp('*.ts').test('a.ts'));
    assert.ok(!globToRegExp('*.ts').test('a.js'));
    assert.ok(globToRegExp('src/**/*.{ts,js}').test('src/a/b/c.js'));
    assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/**/*.ts').test('lib/a.ts'));
  });

  it('isInside 不会被同前缀目录骗过', () => {
    assert.ok(isInside('/tmp/ws', '/tmp/ws/a.ts'));
    assert.ok(isInside('/tmp/ws', '/tmp/ws'));
    assert.ok(!isInside('/tmp/ws', '/tmp/ws-evil/a.ts'));
    assert.ok(!isInside('/tmp/ws', '/tmp/other'));
  });

  it('buildMatcher 对非法正则给出可读错误', () => {
    const bad = buildMatcher('([', {});
    assert.ok('error' in bad);
    const fixed = buildMatcher('a.b', { fixedStrings: true });
    assert.ok('matcher' in fixed);
    assert.equal(fixed.matcher('xa.by')?.index, 1);
    const plain = buildMatcher('b', {});
    assert.ok('matcher' in plain);
    assert.equal(plain.matcher('abc')?.index, 1);
    assert.equal(plain.matcher('xyz'), null);
    const insensitive = buildMatcher('B', { ignoreCase: true });
    assert.ok('matcher' in insensitive);
    assert.equal(insensitive.matcher('abc')?.index, 1);
  });

  it('fuzzyMatch 要求所有行的缩进差一致', () => {
    const file = ['    a', '    b'];
    assert.equal(fuzzyMatch(file, ['  a', '  b']).length, 1);
    // 差值不一致：第二行差 2、第一行差 0，不算容错命中
    assert.equal(fuzzyMatch(file, ['    a', '  b']).length, 0);
    // 差 3 格超出容错范围
    assert.equal(fuzzyMatch(file, [' a', ' b']).length, 0);
  });

  it('planEdit 保持原文件换行风格', () => {
    const result = planEdit('a\r\nb\r\n', { mode: 'replace', old: 'b', new: 'B' });
    assert.ok(result.ok);
    assert.equal(result.text, 'a\r\nB\r\n');
  });
});

// ──────────────────────────────── 白名单 ────────────────────────────────

describe('路径白名单（M4-1 / M4-2）', () => {
  it('工作区内文件可读，越界路径被拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'inside.txt'), 'hello', 'utf8');
      await writeFile(join(h.outside, 'secret.txt'), 'TOPSECRET', 'utf8');

      const good = await h.tool('safe_read').handler({ path: 'inside.txt' }, h.ctx);
      assert.equal(good.isError, undefined);
      assert.match(good.content, /hello/u);

      for (const bad of ['../secret.txt', '../../secret.txt', join(h.outside, 'secret.txt')]) {
        const res = await h.tool('safe_read').handler({ path: bad }, h.ctx);
        assert.equal(res.isError, true, `应拒绝：${bad}`);
        assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
      }
    });
  });

  it('同前缀目录不算工作区内', async () => {
    await withHarness(async (h) => {
      const sibling = `${h.root}-evil`;
      await mkdir(sibling, { recursive: true });
      await writeFile(join(sibling, 'x.txt'), 'nope', 'utf8');
      try {
        const res = await h.tool('safe_read').handler({ path: join(sibling, 'x.txt') }, h.ctx);
        assert.equal(res.isError, true);
        assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
      } finally {
        await rm(sibling, { recursive: true, force: true });
      }
    });
  });

  it('指向工作区外的符号链接目录：读与写都被拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.outside, 'secret.txt'), 'TOPSECRET', 'utf8');
      await symlink(h.outside, join(h.root, 'link'), 'junction');
      await mkdir(join(h.outside, 'sub'), { recursive: true });

      const read = await h.tool('safe_read').handler({ path: 'link/secret.txt' }, h.ctx);
      assert.equal(read.isError, true);
      assert.equal(read.error?.code, FS_ERROR_CODES.PATH_DENIED);

      // 目标还不存在，但路径经过符号链接——必须靠 realpath 祖先解析挡住（M4-2 的关键点）
      const write = await h.tool('safe_write').handler({ path: 'link/pwn.txt', content: 'x' }, h.ctx);
      assert.equal(write.isError, true);
      assert.equal(write.error?.code, FS_ERROR_CODES.PATH_DENIED);
      await assert.rejects(readText(join(h.outside, 'pwn.txt')));
    });
  });

  it('指向工作区外的符号链接文件同样被拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.outside, 'secret.txt'), 'TOPSECRET', 'utf8');
      try {
        // Windows 上文件级 symlink 需要开发者模式或管理员权限；无权限时跳过而不是假装测过
        await symlink(join(h.outside, 'secret.txt'), join(h.root, 'file-link.txt'));
      } catch (err) {
        if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') return;
        throw err;
      }
      const res = await h.tool('safe_read').handler({ path: 'file-link.txt' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });

  it('工作区内的符号链接仍然可用（拒绝的是越界，不是链接本身）', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'real'), { recursive: true });
      await writeFile(join(h.root, 'real', 'a.txt'), 'inside-link', 'utf8');
      await symlink(join(h.root, 'real'), join(h.root, 'alias'), 'junction');
      const res = await h.tool('safe_read').handler({ path: 'alias/a.txt' }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /inside-link/u);
    });
  });

  it('Windows 保留设备名被拒绝', async () => {
    if (process.platform !== 'win32') return;
    await withHarness(async (h) => {
      const res = await h.tool('safe_read').handler({ path: 'NUL' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });

  it('resolveInsideRoot 对空路径与 NUL 字节给出明确理由', async () => {
    await withHarness(async (h) => {
      const empty = await resolveInsideRoot(h.root, '   ');
      assert.equal(empty.ok, false);
      const nul = await resolveInsideRoot(h.root, 'a\0b');
      assert.equal(nul.ok, false);
      if (!nul.ok) assert.equal(nul.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

// ──────────────────────────────── safe_read / list_dir ────────────────────────────────

describe('safe_read', () => {
  it('行号前缀是固定形状：右对齐 4 + │ + 空格（safe_edit 的剥除按同一个形状认）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\n', 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'a.txt' }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      // 逐行严格比对：`   1│ l1` 是契约（宽度固定 4，1~9999 行都够，且固定宽度才好剥）。
      // 首行前面补一个 \n，这样一条断言同时覆盖"行首"与"行尾"两种位置
      const body = `\n${res.content}\n`;
      assert.ok(body.includes('\n   1│ l1\n'), `行号形状不对：\n${res.content}`);
      assert.ok(body.includes('\n   3│ l3\n'), `行号形状不对：\n${res.content}`);
    });
  });

  it('行号**没有开关**：line_numbers 参数已删，传了也不影响输出', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\n', 'utf8');
      // v27 删掉了这个参数：行号是 safe_edit 行号寻址唯一的地址来源，不该有"关掉眼睛"的开关。
      // 传一个已不存在的参数不该让它静默改变行为（工具契约里 additionalProperties:false，
      // 但 handler 层对未知键的处置是忽略——这里锁的是"输出仍带行号"）
      const res = await h.tool('safe_read').handler({ path: 'a.txt', line_numbers: false }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.match(res.content, /(^|\n)   1│ l1/u, '不管传什么，行号都必须在');
      const schema = h.tool('safe_read').parameters['properties'] as Record<string, unknown>;
      assert.equal('line_numbers' in schema, false, 'schema 里也不该再有这个参数');
    });
  });

  it('行号前缀 + offset/limit 区间', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'a.txt', offset: 2, limit: 2 }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /   2│ l2/u);
      assert.match(res.content, /   3│ l3/u);
      assert.ok(!res.content.includes('l4'), 'limit 之外的行不应出现');
      assert.match(res.content, /显示 2-3/u);
    });
  });

  it('行号是**文件真实行号**，不是切片内的相对号（tail / offset 最容易错）', async () => {
    // 这一条是行号寻址能用的前提：她读 tail 拿到 `   4│ l4`，就该能拿 4 去 delete_lines；
    // 若输出的是切片相对号（1），她会删掉文件开头——静默改错文件，比报错难查得多。
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5', 'utf8');

      const tail = await h.tool('safe_read').handler({ path: 'a.txt', tail: 2 }, h.ctx);
      const tailBody = `\n${tail.content}\n`;
      assert.ok(tailBody.includes('\n   4│ l4\n'), `tail 的行号必须是 4/5：\n${tail.content}`);
      assert.ok(tailBody.includes('\n   5│ l5\n'), `tail 的行号必须是 4/5：\n${tail.content}`);
      assert.ok(!tail.content.includes('   1│ '), 'tail 不该出现相对行号 1');

      const range = await h.tool('safe_read').handler({ path: 'a.txt', offset: 3 }, h.ctx);
      assert.ok(`\n${range.content}\n`.includes('\n   3│ l3\n'), `offset 之后的行号必须从 3 起：\n${range.content}`);
      assert.ok(!range.content.includes('   1│ '), 'offset 之后不该从 1 重新数');
    });
  });

  it('head 与 tail 互斥，且各自取对端', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5', 'utf8');
      const head = await h.tool('safe_read').handler({ path: 'a.txt', head: 2 }, h.ctx);
      assert.match(head.content, /l1/u);
      assert.match(head.content, /l2/u);
      assert.ok(!head.content.includes('l3'));

      const tail = await h.tool('safe_read').handler({ path: 'a.txt', tail: 2 }, h.ctx);
      assert.match(tail.content, /l4/u);
      assert.match(tail.content, /l5/u);
      assert.ok(!tail.content.includes('l3'));

      const both = await h.tool('safe_read').handler({ path: 'a.txt', head: 1, tail: 1 }, h.ctx);
      assert.equal(both.isError, true);
      assert.equal(both.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('超过单次返回行数上限时截断并给出续读指引', async () => {
    await withHarness(async (h) => {
      const lines = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`).join('\n');
      await writeFile(join(h.root, 'big.txt'), lines, 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'big.txt' }, h.ctx);
      assert.match(res.content, /\[截断\]/u);
      assert.match(res.content, /offset=51&limit=50/u);
    }, { maxReadLines: 50 });
  });

  it('二进制文件被拒绝并指向 read_blob', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
      const res = await h.tool('safe_read').handler({ path: 'bin.dat' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.BINARY_FILE);
      assert.match(res.content, /read_blob/u);
    });
  });

  it('UTF-8 BOM 与 UTF-16LE 都能正确解码', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'bom.txt'), encodeText('中文内容', 'utf8-bom').buffer);
      const bom = await h.tool('safe_read').handler({ path: 'bom.txt' }, h.ctx);
      assert.match(bom.content, /utf8-bom/u);
      assert.match(bom.content, /中文内容/u);

      await writeFile(join(h.root, 'u16.txt'), encodeText('宽字符', 'utf16le').buffer);
      const u16 = await h.tool('safe_read').handler({ path: 'u16.txt' }, h.ctx);
      assert.match(u16.content, /utf16le/u);
      assert.match(u16.content, /宽字符/u);
    });
  });

  it('目标是目录时指向 list_dir', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'sub'), { recursive: true });
      const res = await h.tool('safe_read').handler({ path: 'sub' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NOT_A_FILE);
      assert.match(res.content, /list_dir/u);
    });
  });

  it('缺少 path 时给出参数提示而不是崩溃', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_read').handler({}, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      const notObject = await h.tool('safe_read').handler('src/main.ts', h.ctx);
      assert.equal(notObject.isError, true);
    });
  });
});

describe('list_dir', () => {
  it('列出类型、大小与时间，depth 控制递归', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'pkg/nested'), { recursive: true });
      await writeFile(join(h.root, 'pkg/a.ts'), 'x', 'utf8');
      await writeFile(join(h.root, 'pkg/nested/b.ts'), 'yy', 'utf8');

      const flat = await h.tool('list_dir').handler({ path: 'pkg' }, h.ctx);
      assert.match(flat.content, /\[F\] a\.ts/u);
      assert.match(flat.content, /\[D\] nested\//u);
      assert.ok(!flat.content.includes('b.ts'), 'depth=1 不应下探');

      const deep = await h.tool('list_dir').handler({ path: 'pkg', depth: 2 }, h.ctx);
      assert.match(deep.content, /nested\/b\.ts/u);
    });
  });

  it('不跟进指向目录的符号链接', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'real'), { recursive: true });
      await writeFile(join(h.root, 'real/deep.txt'), 'x', 'utf8');
      await symlink(join(h.root, 'real'), join(h.root, 'alias'), 'junction');
      const res = await h.tool('list_dir').handler({ path: '.', depth: 3 }, h.ctx);
      assert.match(res.content, /\[L\] alias/u);
      assert.ok(!res.content.includes('alias/deep.txt'), '符号链接目录不应被展开');
    });
  });
});

// ──────────────────────────────── rg_search / es_search ────────────────────────────────

describe('rg_search（条件注册）', () => {
  it('探测不到 ripgrep 时**根本不注册**（v30 删掉了 TS 降级链）', async () => {
    await withHarness(async (h) => {
      assert.equal(h.has('rg_search'), false, '没有 ripgrep 就不该有这件工具');
      // 同一台机器上其余工具一件都不能少：条件注册只针对引擎那两件
      for (const name of ['safe_read', 'list_dir', 'read_blob', 'safe_edit', 'safe_write']) {
        assert.equal(h.has(name), true, `${name} 不该被连坐`);
      }
    }, { ripgrepPath: null });
  });

  it('有引擎时调用它并标注 engine（解析与形状都不变）', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return; // Windows：没有可执行的假引擎，跳过（本机真装 rg 时由下面的用例覆盖）
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\n// TODO fix\nconst b = 2;\n', 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'TODO', context: 1 }, h.ctx);
      assert.match(res.content, /^engine: ripgrep/u);
      assert.match(res.content, /a\.ts:2:4/u);
      // 上下文行与匹配行同形：前一行带行号管道符，命中行带冒号
      assert.match(res.content, /1\| const a = 1;/u);
      assert.match(res.content, /2: \/\/ TODO fix/u);
    });
  });

  // Windows 上假引擎跑不起来（本仓库的开发机就是 Windows），这条用例退回真实 rg；
  // 它锁的是**解析形状**（--null 输出、上下文行、列号重算），与引擎真假无关
  it('本机真装 rg 时：解析形状与上面一致', async () => {
    if (fakeEnginePath !== null) return; // 已经由假引擎覆盖过
    if (!await detectRipgrep()) return;
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\n// TODO fix\nconst b = 2;\n', 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'TODO', context: 1 }, h.ctx);
      assert.match(res.content, /^engine: ripgrep/u);
      assert.match(res.content, /a\.ts:2:4/u);
      assert.match(res.content, /2: \/\/ TODO fix/u);
    });
  });

  it('探测是逐件一次的：装配后不再探，handler 也不探', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'hit\n', 'utf8');
      // rg 显式禁用（不探），es 自动探测且本机没有（一次探测）
      assert.equal(h.has('rg_search'), false);
      assert.equal(h.has('es_search'), false);
      assert.equal(h.probes(), 1, '两件工具只该付一次探测（禁用的那件连探都不探）');
    }, { ripgrepPath: null });
  });

  it('非法正则被拒绝', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return;
    await withHarness(async (h) => {
      const res = await h.tool('rg_search').handler({ pattern: '([' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('max_results 截断并提示', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return;
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), Array.from({ length: 20 }, () => 'hit').join('\n'), 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'hit', max_results: 3 }, h.ctx);
      assert.match(res.content, /\[已达上限 3/u);
    });
  });

  it('搜索范围越界被拒绝', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return;
    await withHarness(async (h) => {
      const res = await h.tool('rg_search').handler({ pattern: 'x', path: '../' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

describe('es_search（条件注册）', () => {
  it('探测不到 es.exe 时**根本不注册**（旧实现里它永远在，且每次都 fallback）', async () => {
    await withHarness(async (h) => {
      assert.equal(h.has('es_search'), false, '没有 es.exe 就不该有这件工具');
      // 同一台机器上其余工具一件都不能少：条件注册只针对这一件
      for (const name of ['safe_read', 'list_dir', 'read_blob', 'safe_edit']) {
        assert.equal(h.has(name), true, `${name} 不该被连坐`);
      }
    }, { everythingPath: null });
  });

  it('探测到 es.exe 才注册；调用走引擎而不是 fallback', async () => {
    // 注入一个假的 es.exe：注册探测（`-version`）与正式调用各答一次。
    // 这条用例锁的是"探测结论 → 注册 → handler 分派"这三步用的是同一份判断
    const calls: string[][] = [];
    // es 返回的是绝对路径，而工作区根要到 makeHarness 里才知道——用一个可变引用把它接上
    const ws = { root: '' };
    const fakeEs = async (command: string, args: string[]): Promise<Record<string, unknown>> => {
      calls.push([command, ...args]);
      if (args.includes('-version')) {
        return { code: 0, stdout: '1.1.0.27', stderr: '', failed: false, timedOut: false };
      }
      return {
        code: 0,
        stdout: `${join(ws.root, 'src', 'alpha.test.ts')}\r\n`,
        stderr: '',
        failed: false,
        timedOut: false,
      };
    };
    await withHarness(async (h) => {
      ws.root = h.root;
      assert.equal(h.has('es_search'), true, '探到 es.exe 就该注册');
      const result = await h.tool('es_search').handler({ pattern: '*.test.ts' }, h.ctx);
      assert.equal(result.isError, undefined, result.content);
      assert.match(result.content, /^engine: everything \(es (fake|15\.1\.0)\)/u);
      assert.ok(!result.content.includes('fallback'), '探到引擎就不该再走 fallback');
      assert.match(result.content, /src\/alpha\.test\.ts/u, '绝对路径要转成工作区相对路径');
      // es 的注册探测是 `-version`；rg 的探测（`--version`）会先出现在同一个假实现里，
      // 所以这里按参数筛出 es 那一次，而不是假设它是第一个
      const versionCalls = calls.filter((call) => call.includes('-version'));
      assert.equal(versionCalls.length, 1, `es 的探测只该发生一次：${JSON.stringify(calls)}`);
      // 三次调用 = rg 探测 + es 探测 + 这一次搜索。**探测各一次**就是这条用例要锁的不变量：
      // 旧实现里 es 的 5 个候选会各来一次，而这个假实现会看到 5 次 `-version`
      assert.equal(calls.length, 3, `调用序列不符：${JSON.stringify(calls)}`);
      assert.match(calls[2]?.join(' ') ?? '', /-n 100 -path /u, '第三次必须是那次搜索本身');
    }, { everythingPath: 'C:\\fake\\es.exe' }, { runProcess: fakeEs });
  });

  it('引擎在、客户端没跑（退出码 8）时如实报错，不静默降级成扫描', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('es_search').handler({ pattern: 'a.txt' }, h.ctx);
      assert.equal(res.isError, true);
      assert.match(res.content, /Everything 客户端没有在运行/u);
      assert.match(res.content, /rg_search/u, '拒绝时要给出替代路径');
    }, { everythingPath: 'C:\\fake\\es.exe' }, {
      runProcess: async (_command: string, args: string[]) => (args.includes('-version')
        ? { code: 0, stdout: '1.1.0.27', stderr: '', failed: false, timedOut: false }
        : { code: 8, stdout: '', stderr: 'Everything IPC unavailable', failed: false, timedOut: false }),
    });
  });
});

// ──────────────────────────────── read_blob ────────────────────────────────

describe('read_blob', () => {
  it('按 offset/limit 分页，且给出续读指引', async () => {
    await withHarness(async (h) => {
      const blobId = 'a'.repeat(64);
      const blobs = join(h.root, 'data', 'blobs');
      await mkdir(blobs, { recursive: true });
      await writeFile(join(blobs, blobId), 'ABCDEFGHIJ', 'utf8');

      const page1 = await h.tool('read_blob').handler({ blobId, offset: 0, limit: 4 }, h.ctx);
      assert.equal(page1.isError, undefined);
      assert.match(page1.content, /ABCD/u);
      assert.match(page1.content, /续读：offset=4&limit=4/u);

      const page2 = await h.tool('read_blob').handler({ blobId, offset: 4, limit: 6 }, h.ctx);
      assert.match(page2.content, /EFGHIJ/u);
      assert.match(page2.content, /已到末尾/u);
      assert.ok(!page2.content.includes('续读'));
    });
  });

  it('blobId 格式非法 / blob 不存在 / offset 越界都有明确错误码', async () => {
    await withHarness(async (h) => {
      const bad = await h.tool('read_blob').handler({ blobId: 'zz' }, h.ctx);
      assert.equal(bad.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      assert.ok(BLOB_ID_PATTERN.test('a'.repeat(64)));

      const missing = await h.tool('read_blob').handler({ blobId: 'b'.repeat(64) }, h.ctx);
      assert.equal(missing.error?.code, FS_ERROR_CODES.NOT_FOUND);

      const blobs = join(h.root, 'data', 'blobs');
      await mkdir(blobs, { recursive: true });
      await writeFile(join(blobs, 'c'.repeat(64)), 'short', 'utf8');
      const past = await h.tool('read_blob').handler({ blobId: 'c'.repeat(64), offset: 99 }, h.ctx);
      assert.equal(past.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('path 不能逃出 blob 根', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'outside-blob.txt'), 'x', 'utf8');
      const res = await h.tool('read_blob').handler({ path: '../../outside-blob.txt' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

// ──────────────────────────────── safe_edit ────────────────────────────────

describe('safe_edit', () => {
  // ── 行号前缀防呆（v27） ──
  //
  // 这一组锁的是「行号寻址」能用起来的前提：safe_read 的输出带 `  12│ ` 前缀，
  // 模型整段抄进 old 是**必然**会发生的事（实测它抄过一次之后就该一直被兜住）。
  // 没有这层剥除，read 端给了行号反而让编辑端更容易失败——比不给行号更糟。

  it('old/new 都带 safe_read 行号前缀时自动剥除后替换', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│ const b = 2;',
        new: '   2│ const b = 42;',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.match(res.content, /已自动剥除 old\/new 上的 safe_read 行号前缀/u, '要告诉她剥过了');
      assert.equal(await readText(join(h.root, 'a.ts')), 'const a = 1;\nconst b = 42;\n');
    });
  });

  it('new 是模型自己敲的（不带前缀）也照剥 old：剥除只由 old 决定', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│ const b = 2;',
        new: 'const b = 42;',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const a = 1;\nconst b = 42;\n');
    });
  });

  it('多行 old 全带前缀时一起剥（逐行剥，不是只剥第一行）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'function f() {\n  const y = 2;\n  return y;\n}\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│   const y = 2;\n   3│   return y;',
        new: '   2│   const y = 3;\n   3│   return y;',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.equal(await readText(join(h.root, 'a.ts')), 'function f() {\n  const y = 3;\n  return y;\n}\n');
    });
  });

  it('文件里**字面**含 `数字│` 的内容：精确匹配优先，一个字节都不剥', async () => {
    // 这是"顺序"那条纪律的回归锁：剥除只在精确匹配失败之后发生。
    // 若把剥除挪到前面，这段本来能精确命中的内容会被改坏。
    await withHarness(async (h) => {
      const original = 'a\n12│ 这是正文的一部分\nb\n';
      await writeFile(join(h.root, 'a.txt'), original, 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.txt',
        old: '12│ 这是正文的一部分',
        new: '12│ 改过了',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.ok(!res.content.includes('已自动剥除'), `精确命中就不该走剥除：${res.content}`);
      assert.equal(await readText(join(h.root, 'a.txt')), 'a\n12│ 改过了\nb\n');
    });
  });

  it('只有一部分行带前缀时不剥（宁可不改，也不猜哪些前缀是内容）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│ const b = 2;',
        // new 半带不带：没有判据知道 `const a = 1;` 那行是不是也该带前缀
        new: '   2│ const b = 42;\nconst c = 3;',
      }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const a = 1;\nconst b = 2;\n', '文件不该被动过');
    });
  });

  it('精确替换并留下备份', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'export const A = 1;\nexport const B = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const B = 2;', new: 'const B = 42;' }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /精确替换 1 处/u);
      assert.match(res.content, /语法检查通过/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const A = 1;\nexport const B = 42;\n');

      const backups = await listBackups(h.backupDir, h.root, join(h.root, 'a.ts'));
      assert.equal(backups.length, 1);
      const restored = await readFile(backups[0]!.path, 'utf8');
      assert.match(restored, /const B = 2;/u);
    });
  });

  it('多匹配不给 occurrence 时列出全部位置并拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const', new: 'let' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.AMBIGUOUS_MATCH);
      assert.match(res.content, /1:1/u);
      assert.match(res.content, /2:1/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const x = 1;\nconst y = 2;\n');
    });
  });

  it('occurrence 与 replace_all 都能消歧', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
      const one = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const', new: 'let', occurrence: 2 }, h.ctx);
      assert.equal(one.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const x = 1;\nlet y = 2;\n');

      const all = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const', new: 'var', replace_all: true }, h.ctx);
      assert.equal(all.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'var x = 1;\nlet y = 2;\n');
    });
  });

  it('缩进差一到两格时容错命中，并把 new 的缩进校正回文件风格', async () => {
    await withHarness(async (h) => {
      const original = 'function f() {\n    const x = 1;\n    return x;\n}\n';
      await writeFile(join(h.root, 'a.ts'), original, 'utf8');
      // 模型抄来的 old 少了 2 格缩进
      const res = await h.tool('safe_edit').handler(
        { path: 'a.ts', old: '  const x = 1;\n  return x;', new: '  const y = 2;\n  return y;' },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.match(res.content, /缩进容错替换/u);
      assert.match(res.content, /\+2 格/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'function f() {\n    const y = 2;\n    return y;\n}\n');
    });
  });

  it('缩进差超过两格不算容错命中', async () => {
    await withHarness(async (h) => {
      const original = 'function f() {\n      const x = 1;\n      return x;\n}\n';
      await writeFile(join(h.root, 'a.ts'), original, 'utf8');
      // 多行 old 且零缩进：精确匹配必然落空，只能靠缩进容错——而 6 格差超出 1-2 格的范围
      const res = await h.tool('safe_edit').handler(
        { path: 'a.ts', old: 'const x = 1;\nreturn x;', new: 'const y = 2;\nreturn y;' },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
      assert.equal(await readText(join(h.root, 'a.ts')), original);
    });
  });

  it('语法检查失败时不落盘（回滚语义：文件保持原样）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'bad.ts'), 'const ok = 1;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'bad.ts', old: 'const ok = 1;', new: 'const ok: = ;' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      assert.equal(await readText(join(h.root, 'bad.ts')), 'const ok = 1;\n');
    });
  });

  it('JSON 语法失败也被拦下', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'c.json'), '{\n  "a": 1\n}\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'c.json', old: '"a": 1', new: '"a": ,' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      assert.equal(await readText(join(h.root, 'c.json')), '{\n  "a": 1\n}\n');
    });
  });

  it('insert_at_line 与 delete_lines 行模式', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
      const ins = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'insert_at_line', line: 2, new: 'inserted' },
        h.ctx,
      );
      assert.equal(ins.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.txt')), 'one\ninserted\ntwo\nthree\n');

      const del = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'delete_lines', start_line: 1, end_line: 2 },
        h.ctx,
      );
      assert.equal(del.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.txt')), 'two\nthree\n');
    });
  });

  it('文件不存在时指向 safe_write', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_edit').handler({ path: 'nope.ts', old: 'a', new: 'b' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NOT_FOUND);
      assert.match(res.content, /safe_write/u);
    });
  });
});

// ──────────────────────────────── safe_write / safe_rollback ────────────────────────────────

describe('safe_write / safe_rollback', () => {
  it('新建文件会自动创建父目录', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_write').handler(
        { path: 'deep/nested/new.ts', content: 'export const N = 1;\n' },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.match(res.content, /新建文件/u);
      assert.equal(await readText(join(h.root, 'deep/nested/new.ts')), 'export const N = 1;\n');
    });
  });

  it('语法不合法的内容被拒绝，不产生文件', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_write').handler({ path: 'broken.ts', content: 'const a: = ;' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      await assert.rejects(readText(join(h.root, 'broken.ts')));
    });
  });

  it('覆盖前备份，safe_rollback 能恢复，且回滚本身可回滚', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'export const V = 1;\n', 'utf8');
      await h.tool('safe_write').handler({ path: 'a.ts', content: 'export const V = 2;\n' }, h.ctx);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const V = 2;\n');

      const listed = await h.tool('safe_rollback').handler({ path: 'a.ts', list: true }, h.ctx);
      assert.match(listed.content, /备份/u);

      const back = await h.tool('safe_rollback').handler({ path: 'a.ts' }, h.ctx);
      assert.equal(back.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const V = 1;\n');
      assert.match(back.content, /已回滚到备份/u);

      // 回滚前的状态被快照，所以还能「回滚回去」
      const again = await h.tool('safe_rollback').handler({ path: 'a.ts' }, h.ctx);
      assert.equal(again.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const V = 2;\n');
    });
  });

  it('没有备份时给出可操作的理由', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'fresh.ts'), 'x', 'utf8');
      const res = await h.tool('safe_rollback').handler({ path: 'fresh.ts' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_BACKUP);
      assert.match(res.content, /safe_edit/u);
    });
  });

  it('每文件只保留最近 10 份备份', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'v0\n', 'utf8');
      const tool = h.tool('safe_write');
      for (let i = 1; i <= 15; i++) {
        const res = await tool.handler({ path: 'a.txt', content: `v${i}\n` }, h.ctx);
        assert.equal(res.isError, undefined);
      }
      const backups = await listBackups(h.backupDir, h.root, join(h.root, 'a.txt'));
      assert.equal(backups.length, 10);
    });
  });
});

// ──────────────────────────────── multi_edit ────────────────────────────────

describe('multi_edit', () => {
  it('跨文件成功且逐文件报告', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const oldName = 1;\n', 'utf8');
      await writeFile(join(h.root, 'b.ts'), 'export { oldName };\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'oldName', new: 'newName' },
            { file: 'b.ts', old: 'oldName', new: 'newName' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.match(res.content, /2 处编辑 \/ 2 个文件/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const newName = 1;\n');
      assert.equal(await readText(join(h.root, 'b.ts')), 'export { newName };\n');
    });
  });

  it('任一处找不到就一个字节都不写', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const A = 1;\n', 'utf8');
      await writeFile(join(h.root, 'b.ts'), 'const B = 1;\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'const A', new: 'const Z' },
            { file: 'b.ts', old: 'NOT_PRESENT', new: 'x' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const A = 1;\n');
      assert.equal(await readText(join(h.root, 'b.ts')), 'const B = 1;\n');
    });
  });

  it('任一处语法检查不过就整体不写', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'export const A = 1;\n', 'utf8');
      await writeFile(join(h.root, 'b.ts'), 'export const B = 1;\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'const A = 1;', new: 'const A = 2;' },
            { file: 'b.ts', old: 'const B = 1;', new: 'const B: = 1;' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const A = 1;\n');
      assert.equal(await readText(join(h.root, 'b.ts')), 'export const B = 1;\n');
    });
  });

  it('同一文件的多个 edits 按顺序叠加', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'const a = 1;', new: 'let a = 1;' },
            { file: 'a.ts', old: 'let a = 1;', new: 'let a = 3;' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'let a = 3;\nconst b = 2;\n');
    });
  });

  it('edits 为空或越界文件被拒绝', async () => {
    await withHarness(async (h) => {
      const empty = await h.tool('multi_edit').handler({ edits: [] }, h.ctx);
      assert.equal(empty.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      const escape = await h.tool('multi_edit').handler(
        { edits: [{ file: '../evil.ts', old: 'a', new: 'b' }] },
        h.ctx,
      );
      assert.equal(escape.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

// ──────────────────────────────── 注册契约 ────────────────────────────────

/**
 * 注册契约专用：一个"哪些引擎可用"由参数决定的假管理器。
 *
 * 这两条用例必须在**任意一台机器上**给出同一份清单（本机有没有 rg 是偶然的），
 * 所以探测结果直接给定，既不碰进程也不碰文件系统。
 */
function stubDeps(available: { rg: boolean; es: boolean }): DepsManager {
  return new DepsManager({
    dataDir: join(tmpdir(), 'irmia-stub-deps'),
    probe: async (name) => (available[name as 'rg' | 'es'] === true
      ? {
        name,
        status: 'ready' as const,
        path: `C:\\fake\\${name}.exe`,
        version: name === 'rg' ? '15.1.0' : '1.1.0.38',
        anyVersion: name === 'rg' ? '15.1.0' : '1.1.0.38',
        source: 'config' as const,
        dir: null,
        reason: '',
        attempts: ['test: 固定结论'],
      }
      : {
        name,
        status: 'missing' as const,
        path: '',
        version: '',
        anyVersion: '',
        source: null,
        dir: null,
        reason: `测试：${name} 不可用`,
        attempts: [`test: ${name} 不可用`],
      }),
  });
}

describe('fsTools 注册', () => {
  it('两个引擎都没有时注册八件（rg_search 与 es_search 都不在），且三属性符合 design.md §4.18', async () => {
    const table = new Map<string, ToolDefinition>();
    // 显式注入"两个引擎都没有"的结论：这条用例要在**任意一台机器上**给出同一份清单
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: false, es: false }) },
    );
    assert.deepEqual(
      list.map((tool) => tool.name),
      ['safe_read', 'list_dir', 'read_blob', 'safe_edit', 'safe_write', 'safe_rollback', 'multi_edit'],
    );

    const expected: Record<string, [string, string, number]> = {
      safe_read: ['parallel', 'none', 10_000],
      list_dir: ['parallel', 'none', 10_000],
      read_blob: ['parallel', 'none', 10_000],
      safe_edit: ['exclusive', 'destructive', 30_000],
      safe_write: ['exclusive', 'destructive', 30_000],
      safe_rollback: ['exclusive', 'destructive', 30_000],
      multi_edit: ['exclusive', 'destructive', 60_000],
    };
    for (const [name, [mode, sideEffect, timeoutMs]] of Object.entries(expected)) {
      const tool = table.get(name);
      assert.ok(tool !== undefined, `${name} 未注册`);
      assert.equal(tool.executionMode, mode, `${name} executionMode`);
      assert.equal(tool.sideEffect, sideEffect, `${name} sideEffect`);
      assert.equal(tool.timeoutMs, timeoutMs, `${name} timeoutMs`);
      assert.equal(tool.parameters['type'], 'object');
      const tokens = estimateTokens(tool.description);
      assert.ok(tokens <= MAX_DESCRIPTION_TOKENS, `${name} 描述 ${tokens} token 超过预算`);
    }
  });

  it('装齐两个引擎时是九件，且两件搜索工具各自插在原位置（顺序即缓存前缀）', async () => {
    const table = new Map<string, ToolDefinition>();
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: true, es: true }) },
    );
    assert.deepEqual(
      list.map((tool) => tool.name),
      ['safe_read', 'list_dir', 'rg_search', 'es_search', 'read_blob', 'safe_edit', 'safe_write', 'safe_rollback', 'multi_edit'],
    );
    for (const name of ['rg_search', 'es_search']) {
      const tool = table.get(name);
      assert.equal(tool?.executionMode, 'parallel', `${name} executionMode`);
      assert.equal(tool?.timeoutMs, 15_000, `${name} timeoutMs`);
      assert.equal(tool?.sideEffect, 'none', `${name} sideEffect`);
    }
  });

  it('只有 rg 时是八件：条件注册是逐件的，不互相连坐', async () => {
    const table = new Map<string, ToolDefinition>();
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: true, es: false }) },
    );
    assert.deepEqual(
      list.map((tool) => tool.name),
      ['safe_read', 'list_dir', 'rg_search', 'read_blob', 'safe_edit', 'safe_write', 'safe_rollback', 'multi_edit'],
    );
  });

  it('条件注册的"不出现"会如实告知（onNote 收到理由，而不是静默少一件）', async () => {
    const notes: string[] = [];
    const table = new Map<string, ToolDefinition>();
    await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: false, es: false }), onNote: (line) => notes.push(line) },
    );
    assert.equal(notes.length, 2, `应当两条告知（rg 与 es 各一条），实际 ${JSON.stringify(notes)}`);
    assert.match(notes[0] ?? '', /rg_search 未注册/u);
    assert.match(notes[1] ?? '', /es_search 未注册/u);
  });

  it('enableDestructive=false 时只注册只读工具（M4-4 的注册层前提）', async () => {
    const table = new Map<string, ToolDefinition>();
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: true, es: true }) },
      {},
      { enableDestructive: false },
    );
    assert.equal(list.length, 5);
    assert.ok(list.every((tool) => tool.sideEffect !== 'destructive'));
  });

  it('createEnv 从 workspaceRoot 推导数据目录', async () => {
    const root = join(tmpdir(), 'irmia-env-check');
    const env = createEnv({ dataDir: join(root, 'data') }, { now: () => new Date(0) });
    assert.equal(env.dataDir({ workspaceRoot: root }), join(root, 'data'));
    assert.equal(env.maxReadLines, 2000);
  });

  it('编码枚举覆盖设计里承诺的集合', async () => {
    const encodings: DetectedEncoding[] = ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'gbk', 'latin1'];
    assert.equal(encodings.length, 6);
  });
});

/**
 * 外部依赖（探测 / 安装 / 复检）测试 —— src/deps/
 *
 * 三条纪律，每条都对应一次踩过的坑：
 *
 *   1. **绝不碰真机**。探测与安装都要"用注入的假可执行文件 / 假下载源"：
 *      用例不能因为开发机上恰好装了 rg 就变绿、没装就变红（那是"假锁"的另一种形态：
 *      绿得没有信息）。所有进程与网络入口都是本文件里的假实现。
 *   2. **断言理由，不只断言红绿**。安装的三类失败必须各报各的（下载 / 解压 / 复检），
 *      所以这里逐个断言 `step` 与错误文本里的关键词，而不是"失败了就行"。
 *   3. **锁的是语义，不是当前实现**。比如"配置指定的路径坏了不许静默落到 PATH"——
 *      断言的是"PATH 上那个可执行文件一次都没被碰过"，而不是某句错误消息的措辞。
 *
 * 跑法就是 npm test（node --test --experimental-strip-types）。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  DEP_SPECS,
  ES_CLI_ZIP_URL,
  ES_DOWNLOAD_PAGE,
  PWSH_DOWNLOAD_PAGE,
  managedDirFor,
  probeDependency,
  readManifest,
  readZipEntries,
  resolveRipgrepAsset,
  stripSingleTopDir,
  versionAtLeast,
  type DepProcessResult,
  type DependencyProbeOutcome,
  type DepName,
} from '../src/deps/index.ts';
import { DepsManager, packageFor, summarizeNotReady } from '../src/deps/manager.ts';

// ──────────────────────────────── 假可执行文件 ────────────────────────────────

/**
 * 假进程层：按可执行文件名回答版本。
 *
 * `answers` 的键是"候选名"（`pwsh.exe` / `rg.exe` / …），值是探测输出；
 * 不在表里的名字一律当作"没这个文件"（ENOENT）——这正是探测链要处理的正常情形。
 */
function fakeRunner(
  answers: Record<string, string | { stdout: string; code?: number; timedOut?: boolean; failed?: boolean }>,
  seen?: string[],
): (exe: string) => Promise<DepProcessResult> {
  return async (exe: string): Promise<DepProcessResult> => {
    seen?.push(exe);
    const answer = answers[exe];
    if (answer === undefined) {
      return { code: null, stdout: '', stderr: `spawn ${exe} ENOENT`, failed: true, timedOut: false };
    }
    if (typeof answer === 'string') {
      return { code: 0, stdout: answer, stderr: '', failed: false, timedOut: false };
    }
    return {
      code: answer.code ?? 0,
      stdout: answer.stdout,
      stderr: '',
      failed: answer.failed ?? false,
      timedOut: answer.timedOut ?? false,
    };
  };
}

/** 造一个假的"自装目录"：`files` 里的相对路径都当作真实存在 */
function fakeFs(files: readonly string[]): {
  exists: (path: string) => boolean;
  listDir: (dir: string) => string[];
  add(path: string): void;
} {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path),
    listDir: (dir) => {
      const prefix = `${dir}\\`;
      const names = new Set<string>();
      for (const file of set) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf('\\');
        if (slash === -1) continue; // 只列子目录名（manager 会自己去拼候选名）
        names.add(rest.slice(0, slash));
      }
      return [...names];
    },
    add: (path) => {
      set.add(path);
    },
  };
}

/** 探测一个依赖：注入假进程层与假文件系统，**不碰真机** */
async function probeWith(
  name: DepName,
  input: {
    configPath?: string;
    managedDir: string;
    answers: Record<string, string | { stdout: string; code?: number; timedOut?: boolean; failed?: boolean }>;
    files?: readonly string[];
    extraSearchDirs?: readonly string[];
  },
  seen?: string[],
): Promise<DependencyProbeOutcome> {
  const fs = fakeFs(input.files ?? []);
  const spec = DEP_SPECS[name];
  // probeDependency 内部用 runProbeCommand（真 spawn），这里换成假实现：
  // 通过 monkey patch 太重，所以直接调 probeCandidate 那条路——见下面的 runProbe 注入
  return await probeDependency(spec, {
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    managedDir: input.managedDir,
    exists: fs.exists,
    listDir: fs.listDir,
    ...(input.extraSearchDirs === undefined ? {} : { extraSearchDirs: input.extraSearchDirs }),
    runProbe: fakeRunner(input.answers, seen),
  });
}

// ──────────────────────────────── 版本判定 ────────────────────────────────

describe('依赖探测：版本判定', () => {
  it('versionAtLeast 只做主版本级比较（三个依赖的判据都是这个粒度）', () => {
    assert.equal(versionAtLeast('7.4.6', [7]), true);
    assert.equal(versionAtLeast('7.0.0', [7]), true);
    assert.equal(versionAtLeast('5.1.26100.9444', [7]), false);
    assert.equal(versionAtLeast('15.1.0', [13]), true);
    assert.equal(versionAtLeast('12.0.0', [13]), false);
    assert.equal(versionAtLeast('1.1.0.38', [1, 1]), true);
    assert.equal(versionAtLeast('1.0.9', [1, 1]), false);
    // 位数不够时按缺失位为 0 处理（'1' >= [1,0]，但 < [1,1]）
    assert.equal(versionAtLeast('1', [1, 0]), true);
    assert.equal(versionAtLeast('1', [1, 1]), false);
  });

  it('pwsh 的判据是**主版本 >= 7**：5.1 是一个能跑的 shell，但它不算满足', () => {
    const spec = DEP_SPECS.pwsh;
    assert.equal(spec.parseVersion('7.4.6', { code: 0, stdout: '7.4.6', stderr: '', failed: false, timedOut: false }), '7.4.6');
    assert.equal(spec.parseVersion('5.1.26100.9444', { code: 0, stdout: '', stderr: '', failed: false, timedOut: false }), null);
    // 输出不是版本号（比如打印了别的东西）也算不可用
    assert.equal(spec.parseVersion('not a version', { code: 0, stdout: '', stderr: '', failed: false, timedOut: false }), null);
    // 但"解析出了 5.1"这件事要能区分出来——它决定报告说"版本不符"还是"未安装"
    assert.equal(spec.parseAnyVersion?.('5.1.26100.9444'), '5.1.26100.9444');
    assert.equal(spec.minVersion, '7.0');
  });

  it('rg 的版本取自 `ripgrep X.Y.Z` 那一行；es 的版本是一行纯版本号', () => {
    const ctx: DepProcessResult = { code: 0, stdout: '', stderr: '', failed: false, timedOut: false };
    assert.equal(DEP_SPECS.rg.parseVersion('ripgrep 15.1.0 (rev abc)', ctx), '15.1.0');
    assert.equal(DEP_SPECS.rg.parseVersion('ripgrep 15.1.0\nfeatures:+pcre2', ctx), '15.1.0');
    assert.equal(DEP_SPECS.rg.parseVersion('something else', ctx), null);
    assert.equal(DEP_SPECS.es.parseVersion('1.1.0.38', ctx), '1.1.0.38');
    assert.equal(DEP_SPECS.es.parseVersion('ES 1.1.0.27', ctx), '1.1.0.27');
    assert.equal(DEP_SPECS.es.parseVersion('Everything IPC unavailable', ctx), null);
    // es 的版本参数是**单横线**（voidtools 的口径），写错就是永远探不到
    assert.deepEqual([...DEP_SPECS.es.versionArgs()], ['-version']);
    assert.deepEqual([...DEP_SPECS.rg.versionArgs()], ['--version']);
  });
});

// ──────────────────────────────── 三段顺序 ────────────────────────────────

describe('依赖探测：三段顺序（config → 自装目录 → PATH）', () => {
  const managedDir = 'C:\\data\\tools\\rg';

  it('config 指定的路径最先（人明确指过就以他为准）', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      configPath: 'C:\\path\\to\\rg.exe',
      managedDir,
      answers: { 'C:\\path\\to\\rg.exe': 'ripgrep 15.1.0', 'rg.exe': 'ripgrep 14.0.0' },
      files: [`${managedDir}\\rg.exe`],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'config');
    assert.equal(outcome.path, 'C:\\path\\to\\rg.exe');
    assert.equal(outcome.version, '15.1.0');
    assert.deepEqual(seen, ['C:\\path\\to\\rg.exe'], '命中第一段就不该再碰后两段');
  });

  it('config 没指定时先看自装目录（一键安装的落点），命中就不去 PATH', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      managedDir,
      answers: { [`${managedDir}\\rg.exe`]: 'ripgrep 15.1.0', 'rg.exe': 'ripgrep 14.0.0' },
      files: [`${managedDir}\\rg.exe`],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'managed');
    assert.equal(outcome.path, `${managedDir}\\rg.exe`);
    assert.deepEqual(seen, [`${managedDir}\\rg.exe`]);
  });

  it('自装目录里多一层子目录也认（手工解压 zip 的人不会剥那层）', async () => {
    const outcome = await probeWith('rg', {
      managedDir,
      answers: { [`${managedDir}\\ripgrep-15.1.0-x86_64-pc-windows-msvc\\rg.exe`]: 'ripgrep 15.1.0' },
      files: [`${managedDir}\\ripgrep-15.1.0-x86_64-pc-windows-msvc\\rg.exe`],
    });
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'managed');
    assert.match(outcome.path, /ripgrep-15\.1\.0/u);
  });

  it('前两段都没有时走 PATH（并带上系统常见安装位置）', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('es', {
      managedDir: 'C:\\data\\tools\\es',
      answers: { 'C:\\Program Files\\Everything\\es.exe': '1.1.0.38' },
      extraSearchDirs: ['C:\\Program Files\\Everything'],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'path');
    assert.equal(outcome.path, 'C:\\Program Files\\Everything\\es.exe');
    assert.ok(seen.length >= 2, `应当逐级试过来：${seen.join(' → ')}`);
  });

  it('**config 指定的路径坏了不许静默落到 PATH**：如实报错，且 PATH 上的同名程序一次都没被碰', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      configPath: 'D:\\Broken\\rg.exe',
      managedDir,
      answers: { 'rg.exe': 'ripgrep 15.1.0' },
    }, seen);
    assert.equal(outcome.status, 'missing');
    assert.deepEqual(seen, ['D:\\Broken\\rg.exe'], '用户指定优先且排他：不许被 PATH 顶替');
    assert.match(outcome.reason, /配置里指定/u);
    assert.match(outcome.attempts.join(' '), /D:\\Broken\\rg\.exe/u);
  });

  it('一个候选都没有时：状态是未安装，reason 里列出试过哪几处（下一步该动哪里）', async () => {
    const outcome = await probeWith('rg', { managedDir, answers: {} });
    assert.equal(outcome.status, 'missing');
    assert.equal(outcome.path, '');
    assert.ok(outcome.attempts.length >= 3, `三段都要留痕：${outcome.attempts.join(' | ')}`);
    assert.match(outcome.attempts[0] ?? '', /config/u);
    assert.match(outcome.attempts[1] ?? '', /managed/u);
    assert.match(outcome.attempts[2] ?? '', /path/u);
  });

  it('**装了但版本不符**与"根本没装"是两句话（前者该升级、后者该安装）', async () => {
    const outcome = await probeWith('pwsh', {
      managedDir: 'C:\\data\\tools\\pwsh',
      answers: { 'pwsh.exe': '5.1.26100.9444' },
    });
    assert.equal(outcome.status, 'version-mismatch');
    assert.equal(outcome.anyVersion, '5.1.26100.9444');
    assert.equal(outcome.version, '');
    assert.match(outcome.reason, /低于要求的 7\.0/u);
    assert.match(outcome.reason, /请升级/u);
  });

  it('探测超时算这个候选不可用，整条链继续往下（一个卡住的候选不该拖死探测）', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      managedDir,
      answers: {
        'rg.exe': { stdout: '', timedOut: true },
        'rg.cmd': 'ripgrep 15.1.0',
      },
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.path, 'rg.cmd');
    assert.deepEqual(seen, ['rg.exe', 'rg.cmd']);
  });
});

// ──────────────────────────────── 缓存与复检 ────────────────────────────────

describe('依赖管理器：一次探测 + 安装后复检', () => {
  it('探测只做一次：多次 get 与 getAll 共用同一份结论', async () => {
    let calls = 0;
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => {
        calls += 1;
        return {
          name, status: 'missing', path: '', version: '', anyVersion: '',
          source: null, dir: null, reason: `${name} 没有`, attempts: [],
        };
      },
    });
    await manager.get('rg');
    await manager.get('rg');
    await manager.getAll();
    assert.equal(calls, 3, '三个依赖各探一次（rg 只探一次）');
    assert.equal(manager.probeCount, 3);
  });

  it('返回值连失败一起缓存：get 不因失败而反复重探', async () => {
    let calls = 0;
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => {
        calls += 1;
        return {
          name, status: 'missing', path: '', version: '', anyVersion: '',
          source: null, dir: null, reason: '', attempts: [],
        };
      },
    });
    const first = await manager.get('es');
    const second = await manager.get('es');
    assert.equal(first, second, '同一份对象（不是每次新建一份）');
    assert.equal(calls, 1);
  });

  it('复检能刷新结论：refresh() 之后 get 拿到新答案（"装完不必重启进程"）', async () => {
    let ready = false;
    let calls = 0;
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => {
        calls += 1;
        return ready
          ? {
            name, status: 'ready', path: 'C:\\data\\tools\\rg\\rg.exe', version: '15.1.0',
            anyVersion: '15.1.0', source: 'managed', dir: 'C:\\data\\tools\\rg', reason: '', attempts: [],
          }
          : {
            name, status: 'missing', path: '', version: '', anyVersion: '',
            source: null, dir: null, reason: '没装', attempts: [],
          };
      },
    });
    assert.equal((await manager.get('rg')).status, 'missing');
    ready = true;
    assert.equal((await manager.get('rg')).status, 'missing', '没刷新之前必须还是旧结论');
    manager.refresh();
    const after = await manager.get('rg');
    assert.equal(after.status, 'ready');
    assert.equal(after.path, 'C:\\data\\tools\\rg\\rg.exe');
    assert.equal(calls, 2);
  });

  it('报告形状：三件依赖各一行，字段齐（徽章/路径/版本/影响/动作/自装目录）', async () => {
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => ({
        name,
        status: name === 'rg' ? 'ready' : 'missing',
        path: name === 'rg' ? 'C:\\data\\tools\\rg\\rg.exe' : '',
        version: name === 'rg' ? '15.1.0' : '',
        anyVersion: '',
        source: name === 'rg' ? 'managed' : null,
        dir: null,
        reason: name === 'rg' ? '' : `${name} 未安装`,
        attempts: [],
      }),
    });
    const report = await manager.report(() => new Date('2026-10-01T00:00:00.000Z'));
    assert.equal(report.entries.length, 3);
    assert.equal(report.needsAttention, true);
    assert.equal(report.toolsDir, 'C:\\data\\tools');
    const rg = report.entries.find((entry) => entry.name === 'rg')!;
    assert.equal(rg.ok, true);
    assert.equal(rg.action, null, '已就绪就没有建议动作');
    assert.equal(rg.managedDir, managedDirFor('C:\\data', 'rg'));
    const pwsh = report.entries.find((entry) => entry.name === 'pwsh')!;
    // pwsh 只能人工装：动作是"打开下载页"，不是"一键安装"
    assert.equal(pwsh.installable, false);
    assert.equal(pwsh.action, 'open-download');
    assert.equal(pwsh.downloadPage, PWSH_DOWNLOAD_PAGE);
    assert.match(pwsh.manualHint ?? '', /winget/u);
    // 未安装的影响必须写出来（用户点名要"显式告知建议安装"）
    assert.ok(pwsh.impact.length > 0);
    assert.match(pwsh.impact, /5\.1/u);
    const es = report.entries.find((entry) => entry.name === 'es')!;
    assert.equal(es.installable, true);
    assert.equal(es.action, 'install');
    // 报告里的顺序就是 DEP_NAMES 的顺序（界面按它排）
    assert.deepEqual(report.entries.map((entry) => entry.name), ['pwsh', 'rg', 'es']);
  });

  it('startup 告知：未就绪的每一件都有一句话，且带上装法', async () => {
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: `${name} 未安装`, attempts: [],
      }),
    });
    const lines = summarizeNotReady(await manager.report());
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /PowerShell 7/u);
    assert.match(lines[0] ?? '', /winget/u);
    assert.match(lines[1] ?? '', /ripgrep/u);
    assert.match(lines[1] ?? '', /一键安装/u);
  });
});

// ──────────────────────────────── zip 解析 ────────────────────────────────

/** 手写一个最小 zip：只支持 store 与 deflate，够用来验解析 */
function buildZip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.store === true ? 0 : 8;
    const body = method === 0 ? entry.data : deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

/** CRC32（zip 的校验字段）。手写一份：零依赖约束下不引包 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('zip 解析与解压（零依赖自实现）', () => {
  it('能读 store 与 deflate 两种成员（ripgrep 的包是 deflate）', () => {
    const zip = buildZip([
      { name: 'x86_64-pc-windows-msvc/rg.exe', data: Buffer.from('fake-rg-binary', 'utf8') },
      { name: 'x86_64-pc-windows-msvc/LICENSE-MIT', data: Buffer.from('MIT', 'utf8'), store: true },
    ]);
    const read = readZipEntries(zip);
    assert.equal(read.ok, true, read.error);
    assert.deepEqual(read.entries.map((entry) => entry.name), [
      'x86_64-pc-windows-msvc/rg.exe',
      'x86_64-pc-windows-msvc/LICENSE-MIT',
    ]);
    assert.equal(read.entries[0]?.data.toString('utf8'), 'fake-rg-binary');
    assert.equal(read.entries[1]?.data.toString('utf8'), 'MIT');
  });

  it('单层公共前缀会被剥掉（`ripgrep-x/rg.exe` → `rg.exe`）——装完的目录才扁平', () => {
    const zip = buildZip([
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe', data: Buffer.from('a', 'utf8') },
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/doc/rg.1', data: Buffer.from('b', 'utf8') },
    ]);
    const stripped = stripSingleTopDir(readZipEntries(zip).entries);
    assert.deepEqual(stripped.map((entry) => entry.name), ['rg.exe', 'doc/rg.1']);
  });

  it('不是"单层公共前缀"就不剥（两个顶层目录时保持原样）', () => {
    const zip = buildZip([
      { name: 'bin/rg.exe', data: Buffer.from('a', 'utf8') },
      { name: 'doc/rg.1', data: Buffer.from('b', 'utf8') },
    ]);
    const stripped = stripSingleTopDir(readZipEntries(zip).entries);
    assert.deepEqual(stripped.map((entry) => entry.name), ['bin/rg.exe', 'doc/rg.1']);
  });

  it('不是 zip 时如实报"不是 zip"，而不是抛异常或解出一堆垃圾', () => {
    const read = readZipEntries(Buffer.from('<html>代理拦截页</html>', 'utf8'));
    assert.equal(read.ok, false);
    assert.match(read.error, /不是 zip/u);
  });

  it('截断的 zip 被识别为损坏（下载中断的包不该被当成好包）', () => {
    const zip = buildZip([{ name: 'rg.exe', data: Buffer.from('x'.repeat(2000), 'utf8') }]);
    // 砍掉尾部（EOCD 在最后，砍掉它就没有目录可读）
    const truncated = zip.subarray(0, zip.length - 40);
    const read = readZipEntries(truncated);
    assert.equal(read.ok, false, '截断的包不该解析成功');
    // 只砍数据段（目录还在）时也必须在读成员时报错，而不是给出一份半截的解压结果
    const halfData = zip.subarray(0, 60);
    assert.equal(readZipEntries(halfData).ok, false);
  });
});

// ──────────────────────────────── 安装编排 ────────────────────────────────

/** 假下载源：把给定字节写到目标路径，不联网 */
function fakeDownload(bytes: Buffer, options: { fail?: string; onCall?: (url: string) => void } = {}) {
  return async (url: string, target: string): Promise<{
    ok: boolean; path: string; bytes: number; finalUrl: string; error: string;
  }> => {
    options.onCall?.(url);
    if (options.fail !== undefined) {
      return { ok: false, path: target, bytes: 0, finalUrl: url, error: options.fail };
    }
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
    return { ok: true, path: target, bytes: bytes.length, finalUrl: url, error: '' };
  };
}

describe('一键安装：下载 → 解压 → 复检', () => {
  it('整条链走通：解压到自装目录、复检通过、写清单、并刷新探测缓存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'irmia-dep-'));
    const dataDir = join(root, 'data');
    const zip = buildZip([
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe', data: Buffer.from('exe-bytes', 'utf8') },
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/README.md', data: Buffer.from('# rg', 'utf8') },
    ]);

    // 探测结论由"文件系统上真的有没有"决定：装完复检才有意义。
    // 复检那一步注入假探测——测试里落地的是一段假字节，跑不起来（生产路径走真探测）
    const manager = new DepsManager({
      dataDir,
      probe: async (name) => {
        const exe = join(managedDirFor(dataDir, name), name === 'rg' ? 'rg.exe' : 'es.exe');
        const ok = existsSync(exe);
        return {
          name,
          status: ok ? 'ready' : 'missing',
          path: ok ? exe : '',
          version: ok ? '15.1.0' : '',
          anyVersion: '',
          source: ok ? 'managed' : null,
          dir: ok ? managedDirFor(dataDir, name) : null,
          reason: ok ? '' : `${name} 未安装`,
          attempts: [],
        };
      },
      verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '15.1.0' } : null),
      download: fakeDownload(zip),
    });

    assert.equal((await manager.get('rg')).status, 'missing');
    const outcome = await manager.install('rg');
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;

    assert.equal(outcome.step, 'done');
    assert.equal(outcome.dir, managedDirFor(dataDir, 'rg'));
    assert.equal(outcome.exePath, join(managedDirFor(dataDir, 'rg'), 'rg.exe'));
    assert.equal(existsSync(outcome.exePath), true, '可执行文件必须真落地');
    assert.equal(existsSync(join(outcome.dir, 'README.md')), true, '顶层目录被剥掉后其余文件照落');
    assert.equal(existsSync(join(outcome.dir, 'ripgrep-15.1.0-x86_64-pc-windows-msvc')), false, '不该留着那层壳');

    // 清单：人可读（装了什么、从哪来）
    const manifest = await readManifest(dataDir, 'rg');
    assert.equal(manifest?.['name'], 'rg');
    assert.equal(manifest?.['exePath'], outcome.exePath);

    // **复检通过后缓存必须刷新**：不然界面点亮了、工具还看不见
    assert.equal((await manager.get('rg')).status, 'ready');
  });

  it('失败一：下载失败 → step=download，且说清"重试还是换源"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'irmia-dep-'));
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      download: fakeDownload(Buffer.alloc(0), { fail: 'HTTP 404' }),
    });

    const outcome = await manager.install('es');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.step, 'download');
    assert.match(outcome.error, /下载失败/u);
    assert.match(outcome.error, /HTTP 404/u);
    assert.match(outcome.error, /打开下载页/u, '要给出下一步');
    assert.ok(outcome.details.some((line) => line.includes(ES_CLI_ZIP_URL)), '细节里要有下载地址');
  });

  it('失败二：解压失败 → step=extract（下载到的东西不是 zip）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'irmia-dep-'));
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      // 下载成功，但内容是一个 HTML 拦截页
      download: fakeDownload(Buffer.from('<html>blocked</html>', 'utf8')),
    });

    const outcome = await manager.install('rg');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.step, 'extract');
    assert.match(outcome.error, /解压失败/u);
    assert.match(outcome.error, /不是 zip/u);
    // 与下载失败**必须是两句不同的话**（处置完全不同：一个重试、一个换源）
    assert.ok(!outcome.error.includes('下载失败'), '解压失败不该被写成下载失败');
  });

  it('失败三：装完复检仍不行 → step=verify（文件在，但探测不通过）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'irmia-dep-'));
    const zip = buildZip([{ name: 'rg/rg.exe', data: Buffer.from('not-really-rg', 'utf8') }]);
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      download: fakeDownload(zip),
      // 复检走真探测：这个假 exe 跑不起来 → verify 失败
      probeTimeoutMs: 3000,
    });

    const outcome = await manager.install('rg');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.step, 'verify');
    assert.match(outcome.error, /复检/u);
    assert.match(outcome.error, /杀毒软件/u, '要给出最可能的下一步（隔离是这类失败的头号原因）');
    assert.equal(existsSync(join(managedDirFor(join(root, 'data'), 'rg'), 'rg.exe')), true, '文件确实落地了');
  });

  it('pwsh **不提供一键安装**：如实说清为什么，并给出官方下载页', async () => {
    const root = await mkdtemp(join(tmpdir(), 'irmia-dep-'));
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      // 给了下载器也不该被用到：pwsh 这条路根本不进下载
      download: fakeDownload(Buffer.from('should-not-be-used', 'utf8')),
    });

    const outcome = await manager.install('pwsh');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.error, /不支持一键安装/u);
    assert.ok(outcome.details.some((line) => line.includes(PWSH_DOWNLOAD_PAGE)));
    assert.ok(outcome.details.some((line) => /UAC|提权|MSI/u.test(line)), '取舍理由要写在回执里');
    assert.equal(packageFor('pwsh'), null);
  });

  it('es 的包地址是 voidtools 的 CLI 包；rg 用 GitHub API 解析最新版', async () => {
    const es = packageFor('es');
    assert.equal(es?.url, ES_CLI_ZIP_URL);
    assert.match(ES_CLI_ZIP_URL, /^https:\/\/www\.voidtools\.com\/ES-[\d.]+\.x64\.zip$/u);
    assert.deepEqual(es?.exeNames, ['es.exe']);
    assert.equal(DEP_SPECS.es.downloadPage, ES_DOWNLOAD_PAGE);

    // rg：不写死版本号，从 release API 里挑 Windows 资产
    const asset = await resolveRipgrepAsset(async () => JSON.stringify({
      tag_name: '15.1.0',
      assets: [
        { name: 'ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://x/linux' },
        {
          name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
          browser_download_url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
        },
      ],
    }));
    assert.equal(asset.ok, true);
    if (!asset.ok) return;
    assert.equal(asset.version, '15.1.0');
    assert.match(asset.url, /windows-msvc\.zip$/u);

    // API 挂了要如实说，而不是静默用一个空地址去下载
    const failed = await resolveRipgrepAsset(async () => {
      throw new Error('ECONNRESET');
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /ECONNRESET/u);

    // 没有 msvc 资产时也要如实报（而不是随便挑一个装错平台）
    const wrongPlatform = await resolveRipgrepAsset(async () => JSON.stringify({
      tag_name: '15.1.0',
      assets: [{ name: 'ripgrep-15.1.0-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://x/mac' }],
    }));
    assert.equal(wrongPlatform.ok, false);
  });

  it('安装的落点是 <dataDir>/tools/<name>，且清单写在那个目录里', async () => {
    const root = await mkdtemp(join(tmpdir(), 'irmia-dep-'));
    const zip = buildZip([{ name: 'rg.exe', data: Buffer.from('bytes', 'utf8') }]);
    // fetchText 注入假的 release 元数据：这条用例要在**任意一台机器、任意网络**下同一个结果，
    // 绝不能让 packageFor 去问真 GitHub（那既是联网测试，也会随上游版本漂移）
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name,
        status: existsSync(join(managedDirFor(join(root, 'data'), name), 'rg.exe')) ? 'ready' : 'missing',
        path: '', version: '', anyVersion: '', source: null, dir: null, reason: '', attempts: [],
      }),
      verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '15.1.0' } : null),
      fetchText: async () => JSON.stringify({
        tag_name: '15.1.0',
        assets: [{
          name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
          browser_download_url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/rg.zip',
        }],
      }),
      download: fakeDownload(zip),
    });
    const installed = await manager.install('rg');
    assert.equal(installed.ok, true, installed.ok ? '' : installed.error);
    assert.equal(existsSync(join(root, 'data', 'tools', 'rg', 'install.json')), true);
    const manifest = JSON.parse(await readFile(join(root, 'data', 'tools', 'rg', 'install.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest['name'], 'rg');
    assert.equal(manifest['sourceUrl'], 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/rg.zip');
    assert.equal(manifest['version'], '15.1.0');
    // 下载的临时包不该留在 .cache 里
    assert.equal(existsSync(join(root, 'data', 'tools', '.cache', 'rg.zip')), false);
  });
});

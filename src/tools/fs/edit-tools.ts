/**
 * Irmia Agent — 文件系工具包：写工具四件
 * （safe_edit / safe_write / safe_rollback / multi_edit）
 *
 * 四件全是 destructive + exclusive + 30s（multi_edit 60s），对齐 design.md §4.18。
 * destructive 的含义不是「危险」，而是「崩溃后不可自动重试，必须转人工」——
 * 所以每一次落盘之前都先把原文备好，任何一步失败都能退回去。
 *
 * 白名单纪律（§4.10 第 1 条 + M4-1/M4-2 验收）：写路径先 resolve、再 realpath、
 * 再比前缀，符号链接指向工作区外一律拒绝。
 */

import { createBackup, listBackups, readBackup } from './backup.ts';
import type { FsEnv } from './env.ts';
import {
  atomicWrite,
  describeVerdict,
  guardedWrite,
  parseEditRequest,
  parseEditRequestFromUnknown,
  planEdit,
  readTargetFile,
  type WriteTarget,
} from './edit-core.ts';
import { readOnlyPrefixOf, resolveInsideRoot } from './path-guard.ts';
import { decodeText, encodeText, type DetectedEncoding } from './text-codec.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  isRecord,
  ok,
  readOptionalBool,
  readOptionalString,
  readString,
  toErrorMessage,
  type ToolContext,
  type ToolDefinition,
} from './types.ts';

/** 把读到的文件内容解码成文本，同时保留编码判定（写回时要按原编码落盘） */
function decodeTarget(buffer: Buffer): { text: string; encoding: DetectedEncoding } {
  const decoded = decodeText(buffer);
  return { text: decoded.text, encoding: decoded.encoding };
}

function backupLine(name: string, created: boolean): string {
  return created ? `备份：新建前无原文件（回滚将删除该文件），快照名 ${name}` : `备份：${name}`;
}

/**
 * 版本快照（design §4.22 的 `data/.versions/`）的一行交代。
 *
 * 快照是**只增不改**的内容寻址库，与 backups/ 的"最近 N 份"是两件事：前者回答
 * 「昨天那个版本还在不在」（文件级 undo 的依据，M8-9），后者回答「刚才改坏了怎么退回去」。
 * 失败必须说出来——文件已经写入是事实，少的只是 undo 历史里的一版，而这件事只有报出来才有人管。
 */
function snapshotLine(warnings: readonly string[] | undefined): string {
  if (warnings === undefined || warnings.length === 0) {
    return '版本库：本次内容已留快照（data/.versions/workspace/，跨日留存，只增不改）。';
  }
  return `注意：${warnings.join('、')} 的版本快照写入失败——文件已写入，但 data/.versions/ 里没有这一版`
    + '（文件级 undo 会缺这一个版本；backups/ 的写入前快照不受影响）。';
}

// ──────────────────────────────── safe_edit ────────────────────────────────

export function createSafeEditTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_edit',
    description:
      '已有文件精确替换（先备份，改坏自动回滚）。old 里抄自 safe_read 的行号前缀自动剥掉。'
      + '多匹配用 occurrence:N 或 replace_all。整行增删用 mode=insert_at_line / delete_lines'
      + '（配 line 或 start_line+end_line）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，必须在工作目录内' },
        mode: { type: 'string', enum: ['replace', 'insert_at_line', 'delete_lines'], description: '默认 replace' },
        old: { type: 'string', description: 'replace 模式：要被替换的原文（行号前缀会被自动剥掉）' },
        new: { type: 'string', description: 'replace 模式：替换后的新文本；insert_at_line 模式：要插入的文本' },
        replace_all: { type: 'boolean', description: '替换全部匹配，默认 false（多匹配时必须显式消歧）' },
        occurrence: { type: 'integer', description: '只替换第 N 处匹配（1-based），与 replace_all 互斥' },
        line: { type: 'integer', description: 'insert_at_line 模式：插入到第几行之前（真实行号，1-based；0 = 开头）' },
        start_line: { type: 'integer', description: 'delete_lines 模式：起始行（含，真实行号，1-based）' },
        end_line: { type: 'integer', description: 'delete_lines 模式：结束行（含，真实行号，1-based）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 30_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_edit');
      if (args === null) return invalidArgs('safe_edit', '期望一个对象，例如 {"path": "a.ts", "old": "x", "new": "y"}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_edit', '缺少 path');

      const parsed = parseEditRequest(args);
      if ('error' in parsed) return invalidArgs('safe_edit', parsed.error);

      const guarded = await resolveInsideRoot(ctx.workspaceRoot, pathInput, { purpose: 'safe_edit' });
      if (!guarded.ok) {
        return fail(
          guarded.code,
          guarded.code === FS_ERROR_CODES.NOT_FOUND
            ? `${guarded.reason}；safe_edit 只改已存在的文件，新建文件请用 safe_write。`
            : guarded.reason,
        );
      }
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const read = await readTargetFile(guarded.path);
      if (read.error !== undefined) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
      }
      if (read.buffer === null) {
        return fail(FS_ERROR_CODES.NOT_FOUND, `${guarded.relPath} 不存在；新建文件请用 safe_write。`);
      }

      const decoded = decodeTarget(read.buffer);
      const plan = planEdit(decoded.text, parsed);
      if (!plan.ok) {
        const extra = plan.matches === undefined
          ? []
          : plan.matches.map((match) => `${match.line}:${match.column}  ${match.preview}`);
        return fail(
          plan.code,
          plan.message + (extra.length === 0 ? '' : `\n命中位置：\n${extra.map((line) => `  ${line}`).join('\n')}`),
        );
      }

      const target: WriteTarget = {
        path: guarded.path,
        relPath: guarded.relPath,
        text: plan.text,
        original: read.buffer,
        encoding: decoded.encoding,
      };
      const result = await guardedWrite(env, ctx, [target]);
      if (!result.ok) return fail(result.code, result.message);

      const beforeLines = decoded.text === '' ? 0 : decoded.text.split('\n').length;
      const afterLines = plan.text === '' ? 0 : plan.text.split('\n').length;
      const backup = result.backups[0];
      const verdict = result.verdicts[0];
      const lines = [
        `${guarded.relPath} 已更新：${plan.summary}`,
        `行数 ${beforeLines} → ${afterLines}${plan.fuzzy ? '（缩进容错命中）' : ''}`,
        verdict === undefined ? '' : describeVerdict(verdict.verdict),
        backup === undefined ? '' : backupLine(backup.record.name, backup.created),
        snapshotLine(result.snapshotWarnings),
        '如需撤销，用 safe_rollback 指定该文件（默认回到最近一次备份）。',
      ].filter((line) => line !== '');
      return ok(lines.join('\n'));
    },
  };
}

// ──────────────────────────────── safe_write ────────────────────────────────

export function createSafeWriteTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_write',
    description:
      '新建或整体覆盖文本文件：自动建父目录，写前做语法检查（.ts/.js/.json），失败即中止并保留原文件。' +
      '覆盖会先备份，可用 safe_rollback 恢复。已有文件做局部修改请用 safe_edit。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，必须在工作目录内' },
        content: { type: 'string', description: '完整文件内容' },
        encoding: {
          type: 'string',
          enum: ['auto', 'utf8', 'utf8-bom', 'utf16le', 'latin1'],
          description: '写入编码，默认 auto（沿用原文件编码；新文件为 utf8）',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 30_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_write');
      if (args === null) return invalidArgs('safe_write', '期望一个对象，例如 {"path": "a.ts", "content": ""}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_write', '缺少 path');
      const content = readString(args, 'content');
      if (content === null) return invalidArgs('safe_write', '缺少 content（要写空文件请传 content:""）');
      const encodingArg = readOptionalString(args, 'encoding') ?? 'auto';

      const guarded = await resolveInsideRoot(ctx.workspaceRoot, pathInput, {
        purpose: 'safe_write',
        allowMissing: true,
      });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const read = await readTargetFile(guarded.path);
      if (read.error !== undefined) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
      }
      const originalEncoding: DetectedEncoding =
        read.buffer === null ? 'utf8' : decodeTarget(read.buffer).encoding;
      const requested: DetectedEncoding | null =
        encodingArg === 'utf8' || encodingArg === 'utf8-bom' || encodingArg === 'utf16le' || encodingArg === 'latin1'
          ? encodingArg
          : null;
      const encoding: DetectedEncoding = requested ?? originalEncoding;

      const target: WriteTarget = {
        path: guarded.path,
        relPath: guarded.relPath,
        text: content,
        original: read.buffer,
        encoding,
      };
      const result = await guardedWrite(env, ctx, [target]);
      if (!result.ok) return fail(result.code, result.message);

      const backup = result.backups[0];
      const verdict = result.verdicts[0];
      const notice = read.buffer === null ? '（新建文件）' : '（已覆盖，原内容已备份）';
      const lines = [
        `${guarded.relPath} 已写入${notice}`,
        `字节数 ${Buffer.byteLength(content, 'utf8')} · 编码 ${encoding}`,
        verdict === undefined ? '' : describeVerdict(verdict.verdict),
        backup === undefined ? '' : backupLine(backup.record.name, backup.created),
        snapshotLine(result.snapshotWarnings),
      ].filter((line) => line !== '');

      // 编码降级说明必须回给模型：它可能是下一次「内容看起来对但读出来不对」的线索
      const encodeNotes = encodeText(content, encoding).notes;
      return ok([...lines, ...encodeNotes.map((note) => `注意：${note}`)].join('\n'));
    },
  };
}

// ──────────────────────────────── safe_rollback ────────────────────────────────

export function createSafeRollbackTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_rollback',
    description:
      '把文件回滚到指定或最近一次备份。回滚前会先给当前状态留快照，所以回滚本身也可回滚。' +
      'list:true 只列出备份，不做修改。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，必须在工作目录内' },
        backup: { type: 'string', description: '指定备份文件名（见 list:true 的输出）；省略则取最近一次' },
        list: { type: 'boolean', description: '只列出备份，不执行回滚' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 30_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_rollback');
      if (args === null) return invalidArgs('safe_rollback', '期望一个对象，例如 {"path": "a.ts"}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_rollback', '缺少 path');
      const listOnly = readOptionalBool(args, 'list') ?? false;
      const wanted = readOptionalString(args, 'backup');

      const guarded = await resolveInsideRoot(ctx.workspaceRoot, pathInput, {
        purpose: 'safe_rollback',
        allowMissing: true,
      });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const backupRoot = env.backupRoot(ctx);
      const all = await listBackups(backupRoot, ctx.workspaceRoot, guarded.path);

      if (listOnly) {
        if (all.length === 0) {
          return ok(`${guarded.relPath} 没有可用备份（备份根：${backupRoot}）`);
        }
        const rows = all.map((entry, index) => {
          const mark = index === 0 ? ' ← 最近' : '';
          return `  ${entry.name}  ${entry.bytes} B  ${entry.mtime}${mark}`;
        });
        return ok(`${guarded.relPath} 的备份（${all.length} 份，最多保留 ${env.backupKeep} 份）：\n${rows.join('\n')}`);
      }

      // 只读区（design §4.19 技能目录）：可读不可写，而回滚也是写操作。
      // list:true 已在上面返回（那是纯读），所以这里拦不到误伤。
      const roPrefix = readOnlyPrefixOf(env.readOnlyPrefixes, guarded.relPath);
      if (roPrefix !== null) {
        return fail(
          FS_ERROR_CODES.PATH_DENIED,
          `${guarded.relPath} 在只读区 ${roPrefix}/ 内（design §4.19：技能目录是只读资产）；`
          + '回滚同样是写操作，被拒绝。需要恢复请由人处理该目录。',
        );
      }

      if (all.length === 0) {
        return fail(
          FS_ERROR_CODES.NO_BACKUP,
          `${guarded.relPath} 没有可用备份。备份只在写工具执行时产生；若该文件从未被写工具改过，就用 safe_edit 直接改。`,
        );
      }
      const chosen = wanted === undefined || wanted === ''
        ? (all[0] as (typeof all)[number])
        : all.find((entry) => entry.name === wanted);
      if (chosen === undefined) {
        return fail(
          FS_ERROR_CODES.NO_BACKUP,
          `备份 ${wanted} 不存在。可用备份：\n${all.map((entry) => `  ${entry.name}`).join('\n')}`,
        );
      }

      const read = await readTargetFile(guarded.path);
      if (read.error !== undefined) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
      }

      // 当前状态先快照：回滚本身也要可回滚，否则一次误回滚就永久丢内容
      let snapshotName = '(无需快照：文件当前不存在)';
      try {
        const snapshot = await createBackup(
          backupRoot,
          ctx.workspaceRoot,
          guarded.path,
          read.buffer,
          env.deps.now(),
          env.backupKeep,
        );
        snapshotName = snapshot.name;
      } catch (err) {
        return fail(
          FS_ERROR_CODES.WRITE_FAILED,
          `回滚前快照失败，已中止（不冒丢失当前内容的风险）：${toErrorMessage(err)}`,
        );
      }

      // 直接读备份文件内容并原子写回；不再过语法检查——回滚的语义是「回到已知状态」
      const backupContent = await readBackup(backupRoot, ctx.workspaceRoot, guarded.path, chosen.name);
      if (!backupContent.ok) return fail(FS_ERROR_CODES.NO_BACKUP, backupContent.reason);

      const restored = decodeText(backupContent.buffer);
      try {
        await atomicWrite(guarded.path, backupContent.buffer);
      } catch (err) {
        return fail(FS_ERROR_CODES.ROLLBACK_FAILED, `回滚写入失败：${toErrorMessage(err)}`);
      }

      return ok(
        [
          `${guarded.relPath} 已回滚到备份 ${chosen.name}`,
          `备份时间 ${chosen.mtime} · ${chosen.bytes} B`,
          `回滚前的当前状态已另存为快照：${snapshotName}（若回滚错了，再用 safe_rollback 指回它）`,
          `恢复内容按 ${restored.encoding} 解读。`,
        ].join('\n'),
      );
    },
  };
}

// ──────────────────────────────── multi_edit ────────────────────────────────

export function createMultiEditTool(env: FsEnv): ToolDefinition {
  return {
    name: 'multi_edit',
    description:
      '一次提交跨文件的多处替换，具备原子性：全部替换与语法检查都通过才落盘，任一失败则全量回滚。' +
      '同一文件的多个 edits 按数组顺序叠加。适合重命名、批量改签名这类一致性修改。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '编辑列表，按顺序应用',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: '文件路径（也可写作 filepath）' },
              filepath: { type: 'string', description: 'file 的别名' },
              old: { type: 'string', description: '要被替换的原文' },
              new: { type: 'string', description: '替换后的新文本' },
              replace_all: { type: 'boolean', description: '替换全部匹配，默认 false' },
              occurrence: { type: 'integer', description: '只替换第 N 处匹配（1-based）' },
            },
            required: [],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 60_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'multi_edit');
      if (args === null) return invalidArgs('multi_edit', '期望一个对象，例如 {"edits": [{"file": "a.ts", "old": "x", "new": "y"}]}');
      const rawEdits = args['edits'];
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return invalidArgs('multi_edit', 'edits 必须是非空数组');
      }
      if (rawEdits.length > 200) {
        return invalidArgs('multi_edit', `edits 最多 200 项，实际 ${rawEdits.length}；分批提交更容易定位失败点`);
      }

      // 按文件分组、组内保序：同一文件的多个编辑必须串行叠加，不能各自基于磁盘原文
      interface PendingFile {
        path: string;
        relPath: string;
        text: string;
        encoding: WriteTarget['encoding'];
        original: Buffer | null;
        applied: number;
      }
      const files = new Map<string, PendingFile>();
      const order: string[] = [];

      for (let index = 0; index < rawEdits.length; index++) {
        const raw = rawEdits[index];
        const parsed = parseEditRequestFromUnknown(raw);
        if ('error' in parsed) return invalidArgs('multi_edit', `edits[${index}]：${parsed.error}`);
        if (!isRecord(raw)) return invalidArgs('multi_edit', `edits[${index}] 不是对象`);

        const fileInput = readString(raw, 'file') ?? readString(raw, 'filepath');
        if (fileInput === null || fileInput === '') {
          return invalidArgs('multi_edit', `edits[${index}] 缺少 file`);
        }

        let entry = files.get(fileInput);
        if (entry === undefined) {
          const guarded = await resolveInsideRoot(ctx.workspaceRoot, fileInput, { purpose: 'multi_edit' });
          if (!guarded.ok) {
            const hint = guarded.code === FS_ERROR_CODES.NOT_FOUND
              ? '；multi_edit 只改已存在的文件，新建文件请用 safe_write。'
              : '';
            return fail(guarded.code, `edits[${index}]（${fileInput}）被拒绝：${guarded.reason}${hint}`);
          }
          const read = await readTargetFile(guarded.path);
          if (read.error !== undefined) {
            return fail(FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
          }
          if (read.buffer === null) {
            return fail(FS_ERROR_CODES.NOT_FOUND, `edits[${index}]：${guarded.relPath} 不存在；新建文件请用 safe_write。`);
          }
          const decoded = decodeTarget(read.buffer);
          entry = {
            path: guarded.path,
            relPath: guarded.relPath,
            text: decoded.text,
            encoding: decoded.encoding,
            original: read.buffer,
            applied: 0,
          };
          files.set(fileInput, entry);
          order.push(fileInput);
        }

        const plan = planEdit(entry.text, parsed);
        if (!plan.ok) {
          const extra = plan.matches === undefined
            ? ''
            : `\n命中位置：\n${plan.matches.map((m) => `  ${m.line}:${m.column}  ${m.preview}`).join('\n')}`;
          return fail(
            plan.code,
            `edits[${index}] 在 ${entry.relPath} 上失败：${plan.message}${extra}\n` +
              '本次所有编辑都已放弃（原子语义：一个失败，全部不落盘）。',
          );
        }
        entry.text = plan.text;
        entry.applied += 1;
      }

      if (ctx.signal.aborted) return ABORTED_RESULT;

      const targets: WriteTarget[] = order.map((key) => {
        const entry = files.get(key) as PendingFile;
        return {
          path: entry.path,
          relPath: entry.relPath,
          text: entry.text,
          original: entry.original,
          encoding: entry.encoding,
        };
      });

      const result = await guardedWrite(env, ctx, targets);
      if (!result.ok) return fail(result.code, result.message);

      const rows = order.map((key, index) => {
        const entry = files.get(key) as PendingFile;
        const before = entry.original === null ? 0 : decodeText(entry.original).text.split('\n').length;
        const after = entry.text === '' ? 0 : entry.text.split('\n').length;
        const verdict = result.verdicts[index]?.verdict;
        return `  ${entry.relPath} · ${entry.applied} 处编辑 · 行数 ${before} → ${after} · ${verdict === undefined ? '' : describeVerdict(verdict)}`;
      });

      const backupRows = result.backups.map((backup) => `  ${backup.relPath} → ${backup.record.name}${backup.created ? '（新建前快照）' : ''}`);
      return ok(
        [
          `multi_edit 完成：${rawEdits.length} 处编辑 / ${order.length} 个文件`,
          ...rows,
          '备份：',
          ...backupRows,
          '如需撤销，对相应文件用 safe_rollback。',
        ].join('\n'),
      );
    },
  };
}

/**
 * Irmia Agent — 附件仓库（把外部发来的图片落到本地）
 *
 * 存在的理由只有一条，但是硬的：**图片进上下文必须是本地字节**。
 *
 * QQ 的富媒体给的是**临时直链**（`multimedia.nt.qq.com.cn/download?...&rkey=…`）。把直链
 * 直接塞进 `input_image` 看起来能省一次下载，代价却是：那条 URL 一旦过期，服务端会返回
 * `400 Failed to download image`，而这条消息**永远留在历史里**——于是那条会话的每一次请求
 * 都必然失败，且她自己修不好（历史是只追加的）。实测拿一个取不到的地址请求，就是这个错。
 *
 * 所以约定是：**URL 只是"去哪取"的线索，进上下文的一律是本地那份字节**。
 *   • 落盘位置：`<dataDir>/blobs/images/<sha256(url)>`（内容寻址，同一张图重复发不重复存）
 *   • 不带扩展名：MIME 由事件里的 `type` 给出，不靠文件名猜
 *   • 写失败/超时一律降级——那条消息退化成纯文字（仍能看到地址），不阻塞 turn
 *
 * **大图先压再进**（`compressForContext`）：图片每轮请求都要重发一次，一张 2.2MB 的 PNG
 * 转成 base64 是 3MB——那笔上传开销与等待时间全落在"她回一句话"上。而模型端本来就会把图
 * 缩到自己的输入尺寸，我们传原图只是在替它搬像素。实测 640×1138 的 PNG（1.07MB）缩到
 * 1024 长边、存成 JPEG 质量 75 之后是 81KB（8%），一次约 0.5 秒。
 *
 * 谁负责下载与压缩（见 real-loop 的 prewarmRecentAttachments）：每拍补扫新到的附件。
 * 渲染层不下载也不读盘，它通过注入的 loader 拿 data URL（render 是纯函数）。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RenderImageRef } from '../model/render.ts';

/** 附件目录名（在 `<dataDir>/blobs/` 之下，与 tools/fs 的 blob 外置同域） */
export const ATTACHMENT_DIR_NAME = 'images';

/**
 * 下载上限：只防"这不是一张图"的意外（视频、压缩包），不是"进不进上下文"的门槛。
 *
 * 旧版这里是 1.5MB 的**硬上限**——超了那张图就完全不进上下文，只剩一个地址。用户否掉了
 * 这个口径：模型端本来就会压缩，卡在门口没有意义，该做的是**自己先压**（见 compressForContext）。
 */
export const DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 超过这个体积就先压一道。
 *
 * 定在 400KB 是因为它落在"base64 之后约 550KB"——一轮请求里带两张也就是 1MB 出头，
 * 而她一轮的正文本来就有十几 KB 到几十 KB。再大就该压，再小不值得起一次进程。
 */
export const CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES = 400_000;

/** 压缩后的最长边：模型看图的输入尺寸用不到比这更大，再大只是替它搬像素 */
export const CONTEXT_IMAGE_MAX_EDGE = 1024;

/** JPEG 质量：75 是"看不出差别"与"体积掉一个量级"之间的常用点 */
export const CONTEXT_IMAGE_JPEG_QUALITY = 75;

/**
 * 压缩后的兜底上限：压完仍然超过它就不进上下文（留地址 + 让她用 vision_read 转述）。
 * 正常压缩到这个数是不可能的（实测 1MB PNG → 81KB），所以它只是防"压缩器半死不活"。
 */
export const CONTEXT_IMAGE_HARD_BYTES = 1_500_000;

/** 下载超时（毫秒）。等太久会把"回一句话"这件事拖成事故 */
export const DEFAULT_ATTACHMENT_TIMEOUT_MS = 5_000;

/** 压缩超时（毫秒）：起一次系统进程的开销在几百毫秒量级，给足余量 */
export const DEFAULT_COMPRESS_TIMEOUT_MS = 15_000;

export function attachmentDir(dataDir: string): string {
  return join(dataDir, 'blobs', ATTACHMENT_DIR_NAME);
}

/** 落盘路径：内容寻址（key 通常是那条临时直链），不带扩展名 */
export function attachmentPath(dataDir: string, key: string): string {
  const sha = createHash('sha256').update(key).digest('hex');
  return join(attachmentDir(dataDir), sha);
}

/** 压缩产物的路径：与原件同址加后缀，一眼看出它是"给上下文用的那一份" */
export function compressedPath(dataDir: string, key: string): string {
  return `${attachmentPath(dataDir, key)}.ctx.jpg`;
}

/**
 * 压缩器（注入点）：把 `source` 缩到 `maxEdge` 以内并以 JPEG 存到 `dest`，成功返回 true。
 *
 * 默认实现走系统自带的 GDI+（Windows PowerShell 5.1 + System.Drawing）——这个项目零外部
 * 依赖，"缩个图"不值得为它破例，何况这条路在 Windows 上永远可用。测试注入假实现，
 * 免得每次跑用例都起一个进程。
 */
export type ImageCompressor = (
  source: string,
  dest: string,
  options: { maxEdge: number; quality: number; timeoutMs: number },
) => Promise<boolean>;

let compressor: ImageCompressor = compressWithGdiPlus;

/** 测试注入点：传 null 恢复默认 */
export function setImageCompressorForTest(fn: ImageCompressor | null): void {
  compressor = fn ?? compressWithGdiPlus;
}

/**
 * 用系统自带的 GDI+ 缩一张图。
 *
 * 两个细节是为了"路径里什么字符都不怕"：脚本用 `-EncodedCommand`（UTF-16LE base64）递进去，
 * 路径本身也走 base64——省掉所有引号转义，中文路径与空格都照常。
 */
async function compressWithGdiPlus(
  source: string,
  dest: string,
  options: { maxEdge: number; quality: number; timeoutMs: number },
): Promise<boolean> {
  const b64 = (text: string): string => Buffer.from(text, 'utf16le').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(source)}')))`,
    `$max = ${options.maxEdge}`,
    '$scale = [Math]::Min(1.0, $max / [Math]::Max($src.Width, $src.Height))',
    '$w = [int][Math]::Max(1, [Math]::Round($src.Width * $scale))',
    '$h = [int][Math]::Max(1, [Math]::Round($src.Height * $scale))',
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.DrawImage($src, 0, 0, $w, $h)',
    "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    '$p = New-Object System.Drawing.Imaging.EncoderParameters 1',
    `$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ${options.quality}L`,
    `$bmp.Save([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(dest)}')), $codec, $p)`,
    '$g.Dispose(); $bmp.Dispose(); $src.Dispose()',
    "Write-Output 'ok'",
  ].join('; ');

  // 用系统自带的 Windows PowerShell，而不是 pwsh 7：压缩链不该依赖用户另装的 shell
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return await new Promise<boolean>((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64(script)],
      { timeout: options.timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) {
          rmSync(dest, { force: true });
          resolve(false);
          return;
        }
        resolve(stdout.includes('ok') && existsSync(dest) && statSync(dest).size > 0);
      },
    );
  });
}

export interface EnsureAttachmentOptions {
  /** 注入点：默认全局 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 允许落盘的最大字节数（只防"这不是一张图"，不是进不进上下文的门槛） */
  maxBytes?: number;
  /** 压缩后的最长边（默认 1024） */
  maxEdge?: number;
  /** JPEG 质量（默认 75） */
  quality?: number;
  /** 压缩超时（毫秒） */
  compressTimeoutMs?: number;
}

export type EnsureAttachmentOutcome = 'cached' | 'fetched' | 'skipped' | 'failed';

/**
 * 确保 key 指向的图片在本地有一份，**并且有一份适合进上下文的**（大图会先压一道）。
 *
 * 任何失败都只是"这张图进不了上下文"，不是错误——调用方不该因为它中断 turn。
 */
export async function ensureAttachment(
  dataDir: string,
  key: string,
  options: EnsureAttachmentOptions = {},
): Promise<{ outcome: EnsureAttachmentOutcome; bytes?: number; reason?: string; compressed?: boolean }> {
  if (key === '') return { outcome: 'skipped', reason: '空的附件标识' };
  const target = attachmentPath(dataDir, key);

  let downloaded: { outcome: EnsureAttachmentOutcome; bytes?: number; reason?: string };
  try {
    if (existsSync(target) && statSync(target).size > 0) {
      downloaded = { outcome: 'cached', bytes: statSync(target).size };
    } else {
      downloaded = await downloadAttachment(dataDir, key, target, options);
    }
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (downloaded.outcome === 'failed' || downloaded.outcome === 'skipped') return downloaded;

  // 大图先压再算：压缩失败不算错——原件还在，进不进上下文由 readAttachmentDataUrl 判断
  const size = downloaded.bytes ?? 0;
  if (size > CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES) {
    const compressed = await ensureCompressed(dataDir, key, options);
    return { ...downloaded, compressed };
  }
  return downloaded;
}

/** 下载那一半：把 URL 的字节落到 `target` */
async function downloadAttachment(
  dataDir: string,
  key: string,
  target: string,
  options: EnsureAttachmentOptions,
): Promise<{ outcome: EnsureAttachmentOutcome; bytes?: number; reason?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES;
  try {
    const response = await fetchImpl(key, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { outcome: 'failed', reason: `HTTP ${response.status}` };
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { outcome: 'skipped', reason: `附件 ${declared} 字节，超过下载上限 ${maxBytes}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) return { outcome: 'failed', reason: '收到 0 字节' };
    if (buffer.byteLength > maxBytes) {
      return { outcome: 'skipped', reason: `附件 ${buffer.byteLength} 字节，超过下载上限 ${maxBytes}` };
    }
    mkdirSync(attachmentDir(dataDir), { recursive: true });
    writeFileSync(target, buffer);
    return { outcome: 'fetched', bytes: buffer.byteLength };
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 压缩那一半：已有压缩产物就直接用，否则起一次系统进程缩一道。
 *
 * 返回"现在有没有压缩产物"，调用方不需要区分"这次压的"与"早就压好的"。
 */
async function ensureCompressed(
  dataDir: string,
  key: string,
  options: EnsureAttachmentOptions,
): Promise<boolean> {
  const dest = compressedPath(dataDir, key);
  try {
    if (existsSync(dest) && statSync(dest).size > 0) return true;
  } catch {
    // 读不到当没有，继续压
  }
  try {
    return await compressor(attachmentPath(dataDir, key), dest, {
      maxEdge: options.maxEdge ?? CONTEXT_IMAGE_MAX_EDGE,
      quality: options.quality ?? CONTEXT_IMAGE_JPEG_QUALITY,
      timeoutMs: options.compressTimeoutMs ?? DEFAULT_COMPRESS_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
}

/**
 * 把引用读成 data URL（渲染层的注入 loader 用它）。
 *
 * **优先读压缩产物**：有 `.ctx.jpg` 就用它——那份是专门为上下文准备的小图。
 * 没有就退回原件，但原件超过 `CONTEXT_IMAGE_HARD_BYTES` 时不给（压缩都压不下来的东西，
 * 塞进每一轮请求只会更糟）：那时的降级是她仍能看到地址、用 `vision_read` 转述。
 *
 * 返回 null 都表示"这张图这次不进上下文"，后果只是那条消息少一张图——
 * 比让整个请求 400 好得多。
 */
export function readAttachmentDataUrl(
  dataDir: string,
  ref: RenderImageRef,
  hardBytes: number = CONTEXT_IMAGE_HARD_BYTES,
): string | null {
  if (ref.key === '') return null;
  const small = compressedPath(dataDir, ref.key);
  try {
    if (existsSync(small)) {
      const size = statSync(small).size;
      if (size > 0) return `data:image/jpeg;base64,${readFileSync(small).toString('base64')}`;
    }
  } catch {
    // 压缩产物读不到就退回原件
  }
  try {
    const path = attachmentPath(dataDir, ref.key);
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (size === 0 || size > hardBytes) return null;
    return `data:${ref.mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 把工作目录内的一个图片文件读成 data URL——给"她自己要求把这张放进上下文"用
 * （vision_read 的直通模式走 `image/attached` 事件，key 就是那个文件路径）。
 */
export function readFileDataUrl(absPath: string, mime: string, maxBytes: number): string | null {
  try {
    if (!existsSync(absPath)) return null;
    const size = statSync(absPath).size;
    if (size === 0 || size > maxBytes) return null;
    return `data:${mime};base64,${readFileSync(absPath).toString('base64')}`;
  } catch {
    return null;
  }
}

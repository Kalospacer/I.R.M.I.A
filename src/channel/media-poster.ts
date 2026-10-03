/**
 * Irmia Agent — `send_media` 的宿主侧投递口（从 main.ts 里抽出来，好用用例把这条胶水钉住）
 *
 * 为什么单独一个文件：工具层有测、通道层有测，但**中间这段胶水**原来写在 main.ts 里，
 * 一次都没被执行过（验收脚本照出来的正是这一类）。它的三条规则都很实在：
 *
 *   ① **只读工作区里的文件**（与 fs 工具同一条边界）：`resolve` 之后必须真的落在 `dataDir`
 *      里面——`../` 绕出去、同前缀的兄弟目录（`data-evil/`）都要挡住；
 *   ② 读到字节交给通道层（工具层自己不碰字节：它只递路径）；
 *   ③ **网络地址直接透传**：让平台自己去回源，我们不做下载中转。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

import { createChannelMediaPoster, type ChannelAdapter } from './qq-official.ts';
import type { MediaPoster } from '../tools/admin.ts';

/** 单个媒体的大小上限：官方软限制 200MB（文件类），我们只做一道"别把内存打爆"的粗线 */
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

export interface WorkspaceMediaPosterOptions {
  /** 允许读取的根目录（工作区） */
  dataDir: string;
  /** 通道表（键是通道名） */
  channels: ReadonlyMap<string, ChannelAdapter>;
  /** 单文件字节上限（测试用） */
  maxBytes?: number;
}

/**
 * 造一个 `MediaPoster`：读工作区里的文件 → 交给通道层上传并发送。
 *
 * 没有 QQ 官方通道时调用方应该**不要装它**（工具会如实报"没有接线"）——这个工厂只管造，
 * 装不装是装配层的事。
 */
export function createWorkspaceMediaPoster(options: WorkspaceMediaPosterOptions): MediaPoster {
  const allowed = resolve(options.dataDir);
  const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES;
  return {
    async post(target, media) {
      const poster = createChannelMediaPoster(options.channels);
      // 已经是字节（宿主自己的调用方）或本来就是网络地址：直接交给通道层
      if (media.data !== undefined || media.path === undefined) {
        return await poster.post(target, media);
      }
      const full = resolve(allowed, media.path);
      if (full !== allowed && !full.startsWith(allowed + sep)) {
        return { ok: false, reason: `只能发工作区（${allowed}）里的文件，收到：${media.path}` };
      }
      if (!existsSync(full)) {
        return { ok: false, reason: `文件不存在：${media.path}` };
      }
      let size: number;
      try {
        const stat = statSync(full);
        if (!stat.isFile()) return { ok: false, reason: `不是一个文件：${media.path}` };
        size = stat.size;
      } catch (err) {
        return { ok: false, reason: `读文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      if (size > maxBytes) {
        return { ok: false, reason: `文件太大（${size} 字节，上限 ${maxBytes}）：${media.path}` };
      }
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(full);
      } catch (err) {
        return { ok: false, reason: `读文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      return await poster.post(target, { ...media, data: bytes, name: basename(full) });
    },
  };
}

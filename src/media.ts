import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Part } from '@google/genai';

/** Gemini が直接扱える拡張子 → MIME タイプ */
const MIME_BY_EXT: Record<string, string> = {
  // 画像
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  // ドキュメント
  '.pdf': 'application/pdf',
  // 音声
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // 動画
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/mov',
  '.avi': 'video/avi',
  '.webm': 'video/webm',
  '.wmv': 'video/wmv',
  '.3gp': 'video/3gpp',
};

export function mimeForPath(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

export function isMediaPath(path: string): boolean {
  return mimeForPath(path) !== null;
}

export function mediaKind(mime: string): string {
  if (mime.startsWith('image/')) return '画像';
  if (mime.startsWith('audio/')) return '音声';
  if (mime.startsWith('video/')) return '動画';
  if (mime === 'application/pdf') return 'PDF';
  return 'ファイル';
}

export class MediaError extends Error {}

/**
 * メディアファイルを inlineData の Part にする。
 * Files API はバックエンド (Gemini API / Vertex AI) で扱いが異なるため、
 * どちらでも同じに動くインライン添付に統一している。
 */
export async function buildMediaPart(abs: string, maxBytes: number): Promise<{ part: Part; mime: string; bytes: number }> {
  const mime = mimeForPath(abs);
  if (!mime) throw new MediaError(`対応していない形式です: ${abs}`);

  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    throw new MediaError(`ファイルを開けません: ${abs}`);
  }
  if (size > maxBytes) {
    throw new MediaError(
      `ファイルが大きすぎます (${(size / 1024 / 1024).toFixed(1)} MB > 上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB): ${abs}\n` +
        '設定 maxMediaBytes を上げるか、事前に縮小・分割してください。',
    );
  }

  const buf = await readFile(abs);
  return {
    part: { inlineData: { mimeType: mime, data: buf.toString('base64') } },
    mime,
    bytes: size,
  };
}

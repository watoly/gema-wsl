import { Type } from '@google/genai';
import { MediaError, buildMediaPart, isMediaPath, mediaKind } from '../media.js';
import { ToolError, type ToolDef } from './types.js';
import { pathKind, relPath, resolvePath } from './util.js';

export const viewMediaTool: ToolDef = {
  name: 'view_media',
  risk: 'read',
  declaration: {
    name: 'view_media',
    description:
      '画像・PDF・音声・動画をモデルに直接読み込ませる。read_file では読めないバイナリ形式を扱うときに使う。' +
      '対応形式: png/jpg/webp/gif/heic, pdf, mp3/wav/aac/ogg/flac, mp4/mov/webm など。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'メディアファイルのパス' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args['path'] ?? ''));
    const rel = relPath(ctx, abs);
    if ((await pathKind(abs)) !== 'file') throw new ToolError(`ファイルが存在しません: ${rel}`);
    if (!isMediaPath(abs)) {
      throw new ToolError(
        `${rel} は view_media が扱える形式ではありません。テキストなら read_file を使ってください。`,
      );
    }
    try {
      const { part, mime, bytes } = await buildMediaPart(abs, ctx.config.maxMediaBytes);
      return {
        output: `${rel} を読み込みました (${mediaKind(mime)}, ${mime}, ${(bytes / 1024).toFixed(0)}KB)。内容は続くメッセージに添付されています。`,
        summary: `${rel} (${mediaKind(mime)} ${(bytes / 1024).toFixed(0)}KB)`,
        mediaParts: [{ text: `<media path="${rel}" type="${mime}" />` }, part],
      };
    } catch (err) {
      throw new ToolError(err instanceof MediaError ? err.message : String(err));
    }
  },
};

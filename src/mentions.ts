import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Part } from '@google/genai';
import { MediaError, buildMediaPart, isMediaPath, mediaKind } from './media.js';
import { expandHome } from './tools/util.js';

const MAX_TEXT_MENTION_BYTES = 200 * 1024;

export interface ExpandedMentions {
  parts: Part[];
  attached: string[];
  /** 添付を試みたが失敗したもの (画面に出す) */
  problems: string[];
}

/**
 * 入力中の `@path/to/file` を検出して添付する。
 * テキストはそのまま、画像・PDF・音声・動画は inlineData として送る。
 * 見つからないパスはただのテキストとして残す。
 */
export async function expandMentions(
  text: string,
  cwd: string,
  maxMediaBytes = 15 * 1024 * 1024,
): Promise<ExpandedMentions> {
  const mentions = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!);
  const parts: Part[] = [{ text }];
  const attached: string[] = [];
  const problems: string[] = [];

  for (const mention of [...new Set(mentions)]) {
    const expanded = expandHome(mention);
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

    let isFile = false;
    try {
      isFile = (await stat(abs)).isFile();
    } catch {
      continue; // 存在しない @ はただの文字列
    }
    if (!isFile) continue;

    if (isMediaPath(abs)) {
      try {
        const { part, mime, bytes } = await buildMediaPart(abs, maxMediaBytes);
        parts.push({ text: `\n<attached-media path="${mention}" type="${mime}" />` });
        parts.push(part);
        attached.push(`${mention} [${mediaKind(mime)} ${(bytes / 1024).toFixed(0)}KB]`);
      } catch (err) {
        problems.push(err instanceof MediaError ? err.message : String(err));
      }
      continue;
    }

    try {
      const st = await stat(abs);
      if (st.size > MAX_TEXT_MENTION_BYTES) {
        problems.push(`${mention} はテキスト添付の上限 (${MAX_TEXT_MENTION_BYTES / 1024}KB) を超えています`);
        continue;
      }
      const content = await readFile(abs, 'utf8');
      parts.push({ text: `\n<attached-file path="${mention}">\n${content}\n</attached-file>` });
      attached.push(mention);
    } catch {
      problems.push(`${mention} を読み取れませんでした`);
    }
  }
  return { parts, attached, problems };
}

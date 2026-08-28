import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Part } from '@google/genai';
import { expandHome } from './tools/util.js';

const MAX_MENTION_BYTES = 200 * 1024;

/**
 * 入力中の `@path/to/file` を検出し、そのファイル内容を追加の Part として添付する。
 * 見つからないパスはただのテキストとして残す。
 */
export async function expandMentions(
  text: string,
  cwd: string,
): Promise<{ parts: Part[]; attached: string[] }> {
  const mentions = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!);
  const parts: Part[] = [{ text }];
  const attached: string[] = [];

  for (const mention of [...new Set(mentions)]) {
    const expanded = expandHome(mention);
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > MAX_MENTION_BYTES) continue;
      const content = await readFile(abs, 'utf8');
      parts.push({ text: `\n<attached-file path="${mention}">\n${content}\n</attached-file>` });
      attached.push(mention);
    } catch {
      /* 存在しない @ はメンションではなくただの文字列として扱う */
    }
  }
  return { parts, attached };
}

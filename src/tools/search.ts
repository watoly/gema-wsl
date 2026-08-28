import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Type } from '@google/genai';
import { DEFAULT_IGNORE_DIRS } from '../config.js';
import { ToolError, type ToolDef } from './types.js';
import { Ignore, globToRegExp, isBinary, pathKind, relPath, resolvePath, walk } from './util.js';

const MAX_WALK_ENTRIES = 20_000;

function hasRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('rg', ['--version'], (err) => resolve(!err));
  });
}

export const globTool: ToolDef = {
  name: 'glob',
  risk: 'read',
  declaration: {
    name: 'glob',
    description:
      'glob パターンでファイルを検索する。例: "**/*.ts", "src/**/{a,b}.js"。' +
      '.gitignore とビルド生成物は除外される。ファイル名からファイルを探すときに使う。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING, description: 'glob パターン' },
        path: { type: Type.STRING, description: '検索の起点ディレクトリ。省略時はカレントディレクトリ。' },
        limit: { type: Type.INTEGER, description: '返す最大件数。省略時は 200。' },
      },
      required: ['pattern'],
    },
  },
  async run(args, ctx) {
    const pattern = String(args['pattern'] ?? '');
    if (!pattern) throw new ToolError('pattern が空です');
    const base = resolvePath(ctx, String(args['path'] ?? '.'));
    if ((await pathKind(base)) !== 'dir') throw new ToolError(`ディレクトリが存在しません: ${relPath(ctx, base)}`);

    const limit = Math.max(1, Math.min(Number(args['limit'] ?? 200) || 200, 1000));
    const re = globToRegExp(pattern);
    const ignore = Ignore.fromRoot(ctx.root);
    const hits: string[] = [];
    let scanned = 0;

    for await (const entry of walk(base, { root: base, ignore, signal: ctx.signal })) {
      if (++scanned > MAX_WALK_ENTRIES) break;
      if (re.test(entry.rel) || re.test(entry.rel.split('/').pop()!)) {
        hits.push(relPath(ctx, entry.abs));
        if (hits.length >= limit) break;
      }
    }
    if (hits.length === 0) return { output: `一致するファイルはありません: ${pattern}`, summary: `${pattern} — 0 件` };
    return { output: hits.join('\n'), summary: `${pattern} — ${hits.length} 件` };
  },
};

interface GrepHit {
  file: string;
  line: number;
  text: string;
}

async function grepWithRipgrep(
  pattern: string,
  base: string,
  fileGlob: string | undefined,
  ignoreCase: boolean,
  limit: number,
): Promise<GrepHit[]> {
  const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '200'];
  if (ignoreCase) rgArgs.push('-i');
  if (fileGlob) rgArgs.push('--glob', fileGlob);
  for (const dir of DEFAULT_IGNORE_DIRS) rgArgs.push('--glob', `!${dir}/`);
  rgArgs.push('-e', pattern, base);

  return new Promise((resolve, reject) => {
    execFile('rg', rgArgs, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // rg は一致 0 件でも exit code 1 を返す
      if (err && (err as NodeJS.ErrnoException).code !== undefined && !stdout) {
        const code = (err as unknown as { code?: number }).code;
        if (code === 1) return resolve([]);
        return reject(err);
      }
      const hits: GrepHit[] = [];
      for (const raw of stdout.split('\n')) {
        if (!raw) continue;
        const m = raw.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        hits.push({ file: m[1]!, line: Number(m[2]), text: m[3]! });
        if (hits.length >= limit) break;
      }
      resolve(hits);
    });
  });
}

async function grepInJs(
  re: RegExp,
  base: string,
  fileRe: RegExp | null,
  limit: number,
  maxFileBytes: number,
  signal: AbortSignal,
): Promise<GrepHit[]> {
  const ignore = Ignore.fromRoot(base);
  const hits: GrepHit[] = [];
  let scanned = 0;

  for await (const entry of walk(base, { root: base, ignore, signal })) {
    if (++scanned > MAX_WALK_ENTRIES || hits.length >= limit) break;
    if (fileRe && !fileRe.test(entry.rel) && !fileRe.test(entry.rel.split('/').pop()!)) continue;
    let buf: Buffer;
    try {
      buf = await readFile(entry.abs);
    } catch {
      continue;
    }
    if (buf.byteLength > maxFileBytes || isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i]!)) {
        hits.push({ file: entry.abs, line: i + 1, text: lines[i]! });
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

export const grepTool: ToolDef = {
  name: 'grep',
  risk: 'read',
  declaration: {
    name: 'grep',
    description:
      'ファイルの中身を正規表現で全文検索する。ripgrep が利用できれば自動で使う。' +
      'コード中のシンボルや文言を探すときに使う。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING, description: '検索する正規表現' },
        path: { type: Type.STRING, description: '検索の起点ディレクトリ。省略時はカレントディレクトリ。' },
        glob: { type: Type.STRING, description: '対象ファイルを絞る glob。例: "*.ts"' },
        ignore_case: { type: Type.BOOLEAN, description: '大文字小文字を無視する場合 true' },
        limit: { type: Type.INTEGER, description: '返す最大ヒット数。省略時は 100。' },
      },
      required: ['pattern'],
    },
  },
  async run(args, ctx) {
    const pattern = String(args['pattern'] ?? '');
    if (!pattern) throw new ToolError('pattern が空です');
    const base = resolvePath(ctx, String(args['path'] ?? '.'));
    if ((await pathKind(base)) !== 'dir') throw new ToolError(`ディレクトリが存在しません: ${relPath(ctx, base)}`);

    const limit = Math.max(1, Math.min(Number(args['limit'] ?? 100) || 100, 500));
    const ignoreCase = Boolean(args['ignore_case']);
    const fileGlob = args['glob'] ? String(args['glob']) : undefined;

    let hits: GrepHit[] | null = null;
    if (await hasRipgrep()) {
      try {
        hits = await grepWithRipgrep(pattern, base, fileGlob, ignoreCase, limit);
      } catch {
        hits = null; // ripgrep が失敗したら JS 実装にフォールバックする
      }
    }
    if (hits === null) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (err) {
        throw new ToolError(`正規表現が不正です: ${String(err)}`);
      }
      hits = await grepInJs(
        re,
        base,
        fileGlob ? globToRegExp(fileGlob) : null,
        limit,
        ctx.config.maxFileBytes,
        ctx.signal,
      );
    }

    if (hits.length === 0) return { output: `一致なし: /${pattern}/`, summary: `/${pattern}/ — 0 件` };
    const body = hits
      .map((h) => `${relPath(ctx, h.file)}:${h.line}: ${h.text.trim().slice(0, 300)}`)
      .join('\n');
    return { output: body, summary: `/${pattern}/ — ${hits.length} 件` };
  },
};

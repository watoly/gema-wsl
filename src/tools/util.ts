import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_IGNORE_DIRS } from '../config.js';
import { ToolError, type ToolContext } from './types.js';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 引数のパスを絶対パスに解決し、ワークスペース外アクセスを弾く */
export function resolvePath(ctx: ToolContext, p: string): string {
  if (!p || typeof p !== 'string') throw new ToolError('path が空です');
  const expanded = expandHome(p);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.cwd, expanded);
  if (!ctx.config.allowOutsideWorkspace && !isInside(ctx.root, abs)) {
    throw new ToolError(
      `ワークスペース (${ctx.root}) の外にアクセスしようとしました: ${abs}\n` +
        '設定 allowOutsideWorkspace を true にすると許可されます。',
    );
  }
  return abs;
}

export function relPath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.root, abs);
  return rel === '' ? '.' : rel.startsWith('..') ? abs : rel;
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ─────────────────────────── .gitignore ───────────────────────────

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegExpSource(pattern: string): string {
  let src = '';
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          src += '(?:.*/)?';
        } else {
          src += '.*';
        }
      } else {
        src += '[^/]*';
      }
    } else if (ch === '?') {
      src += '[^/]';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        src += '\\[';
      } else {
        src += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (ch === '{') {
      braceDepth++;
      src += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      src += ')';
    } else if (ch === ',' && braceDepth > 0) {
      src += '|';
    } else {
      src += ch.replace(/[.+^$(){}|\\\[\]]/g, '\\$&');
    }
  }
  return src;
}

/** .gitignore のサブセット実装 (否定 `!`、ディレクトリ限定 `/` 末尾、アンカー、`**` に対応) */
export class Ignore {
  private rules: IgnoreRule[] = [];

  static fromRoot(root: string): Ignore {
    const ig = new Ignore();
    for (const name of ['.gitignore', join('.git', 'info', 'exclude')]) {
      const p = join(root, name);
      if (!existsSync(p)) continue;
      try {
        ig.add(readFileSync(p, 'utf8'));
      } catch {
        /* 読めないファイルは無視 */
      }
    }
    return ig;
  }

  add(text: string): void {
    for (const raw of text.split('\n')) {
      let line = raw.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      const body = globToRegExpSource(line);
      const src = anchored ? `^${body}$` : `(^|/)${body}$`;
      this.rules.push({ re: new RegExp(src), negate, dirOnly });
    }
  }

  /** relPath はスラッシュ区切りの相対パス */
  ignores(relPathStr: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(relPathStr)) ignored = !rule.negate;
    }
    return ignored;
  }
}

export interface WalkOptions {
  root: string;
  ignore?: Ignore;
  /** これ以上のファイル数を列挙したら打ち切る */
  maxEntries?: number;
  maxDepth?: number;
  includeDirs?: boolean;
  signal?: AbortSignal;
}

/** ワークスペースを再帰的に走査し、root からの相対パス (スラッシュ区切り) を返す */
export async function* walk(dir: string, opts: WalkOptions, depth = 0): AsyncGenerator<{
  rel: string;
  abs: string;
  isDir: boolean;
}> {
  if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (opts.signal?.aborted) return;
    const abs = join(dir, entry.name);
    const rel = relative(opts.root, abs).split(sep).join('/');
    const isDir = entry.isDirectory();
    if (isDir && DEFAULT_IGNORE_DIRS.includes(entry.name)) continue;
    if (opts.ignore?.ignores(rel, isDir)) continue;
    if (isDir) {
      if (opts.includeDirs) yield { rel, abs, isDir: true };
      yield* walk(abs, opts, depth + 1);
    } else if (entry.isFile()) {
      yield { rel, abs, isDir: false };
    }
  }
}

/** glob パターン (`**`, `*`, `?`, `{a,b}`) を相対パス用の正規表現にする */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

export async function pathKind(abs: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const st = await stat(abs);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

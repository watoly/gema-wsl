import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Type } from '@google/genai';
import { diffPreview } from './diff.js';
import { ToolError, type ToolDef } from './types.js';
import { Ignore, isBinary, pathKind, relPath, resolvePath } from './util.js';

const MAX_READ_LINES = 2000;

function numbered(lines: string[], startLine: number): string {
  return lines.map((l, i) => `${String(startLine + i).padStart(6)}\t${l}`).join('\n');
}

export const readFileTool: ToolDef = {
  name: 'read_file',
  risk: 'read',
  declaration: {
    name: 'read_file',
    description:
      'ファイルの内容を行番号つきで読む。長いファイルは offset / limit で分割して読むこと。' +
      'バイナリファイルは読めない。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'ファイルパス (相対 or 絶対)' },
        offset: { type: Type.INTEGER, description: '読み始める行番号 (1 始まり)。省略時は 1。' },
        limit: { type: Type.INTEGER, description: `読む行数。省略時は ${MAX_READ_LINES}。` },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args['path'] ?? ''));
    const kind = await pathKind(abs);
    if (kind === 'missing') throw new ToolError(`ファイルが存在しません: ${relPath(ctx, abs)}`);
    if (kind === 'dir') throw new ToolError(`ディレクトリです。list_dir を使ってください: ${relPath(ctx, abs)}`);

    const buf = await readFile(abs);
    if (isBinary(buf)) throw new ToolError(`バイナリファイルのため読み取れません: ${relPath(ctx, abs)}`);

    let text = buf.toString('utf8');
    let note = '';
    if (buf.byteLength > ctx.config.maxFileBytes) {
      text = buf.subarray(0, ctx.config.maxFileBytes).toString('utf8');
      note = `\n… (ファイルが大きいため ${ctx.config.maxFileBytes} バイトで打ち切り)`;
    }

    const allLines = text.split('\n');
    const offset = Math.max(1, Number(args['offset'] ?? 1) || 1);
    const limit = Math.max(1, Math.min(Number(args['limit'] ?? MAX_READ_LINES) || MAX_READ_LINES, MAX_READ_LINES));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) {
      throw new ToolError(`offset ${offset} は総行数 ${allLines.length} を超えています`);
    }
    const more = offset - 1 + slice.length < allLines.length
      ? `\n… (全 ${allLines.length} 行中 ${offset}-${offset + slice.length - 1} 行を表示)`
      : '';

    return {
      output: numbered(slice, offset) + more + note,
      summary: `${relPath(ctx, abs)} (${slice.length} 行)`,
    };
  },
};

export const writeFileTool: ToolDef = {
  name: 'write_file',
  risk: 'write',
  declaration: {
    name: 'write_file',
    description:
      'ファイルを新規作成または全文上書きする。既存ファイルの部分修正には edit_file を優先すること。' +
      '親ディレクトリは自動生成される。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'ファイルパス' },
        content: { type: Type.STRING, description: 'ファイルの全内容' },
      },
      required: ['path', 'content'],
    },
  },
  approval(args, ctx) {
    const abs = resolvePath(ctx, String(args['path'] ?? ''));
    const rel = relPath(ctx, abs);
    const content = String(args['content'] ?? '');
    return {
      tool: 'write_file',
      key: `write_file:${rel}`,
      title: `ファイルを書き込む: ${rel}`,
      detail: content.split('\n').slice(0, 40).join('\n'),
    };
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args['path'] ?? ''));
    const content = String(args['content'] ?? '');
    const existed = (await pathKind(abs)) === 'file';
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    const rel = relPath(ctx, abs);
    const lines = content.split('\n').length;
    return {
      output: `${existed ? '上書き' : '新規作成'}しました: ${rel} (${lines} 行, ${Buffer.byteLength(content)} バイト)`,
      summary: `${rel} を${existed ? '上書き' : '作成'} (${lines} 行)`,
    };
  },
};

export const editFileTool: ToolDef = {
  name: 'edit_file',
  risk: 'write',
  declaration: {
    name: 'edit_file',
    description:
      '既存ファイル内の文字列を置換する。old_string はファイル内で一意になるよう十分な前後の文脈を含めること。' +
      '一致が 0 件、または複数件で replace_all=false の場合はエラーになる。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'ファイルパス' },
        old_string: { type: Type.STRING, description: '置換前の文字列 (完全一致)' },
        new_string: { type: Type.STRING, description: '置換後の文字列' },
        replace_all: { type: Type.BOOLEAN, description: '一致箇所をすべて置換する場合 true' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  approval(args, ctx) {
    const abs = resolvePath(ctx, String(args['path'] ?? ''));
    const rel = relPath(ctx, abs);
    return {
      tool: 'edit_file',
      key: `edit_file:${rel}`,
      title: `ファイルを編集する: ${rel}`,
      detail: diffPreview(String(args['old_string'] ?? ''), String(args['new_string'] ?? ''), 0),
    };
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args['path'] ?? ''));
    const rel = relPath(ctx, abs);
    const oldString = String(args['old_string'] ?? '');
    const newString = String(args['new_string'] ?? '');
    const replaceAll = Boolean(args['replace_all']);

    if (oldString === newString) throw new ToolError('old_string と new_string が同一です');
    if ((await pathKind(abs)) !== 'file') throw new ToolError(`ファイルが存在しません: ${rel}`);

    const original = await readFile(abs, 'utf8');
    const parts = original.split(oldString);
    const count = parts.length - 1;
    if (count === 0) {
      throw new ToolError(
        `old_string がファイル内に見つかりません: ${rel}\n` +
          'read_file で現在の内容を確認し、空白・インデントまで正確に一致させてください。',
      );
    }
    if (count > 1 && !replaceAll) {
      throw new ToolError(
        `old_string が ${count} 箇所に一致しました: ${rel}\n` +
          '一意になるよう前後の文脈を増やすか、replace_all=true を指定してください。',
      );
    }
    const updated = replaceAll ? parts.join(newString) : original.replace(oldString, newString);
    await writeFile(abs, updated, 'utf8');
    return {
      output: `${rel} を編集しました (${count} 箇所置換)`,
      summary: `${rel} を編集 (${count} 箇所)`,
    };
  },
};

export const listDirTool: ToolDef = {
  name: 'list_dir',
  risk: 'read',
  declaration: {
    name: 'list_dir',
    description:
      'ディレクトリの中身を一覧表示する。.gitignore と一般的なビルド生成物 (node_modules, dist 等) は除外される。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'ディレクトリパス。省略時はカレントディレクトリ。' },
      },
    },
  },
  async run(args, ctx) {
    const target = String(args['path'] ?? '.');
    const abs = resolvePath(ctx, target);
    if ((await pathKind(abs)) !== 'dir') throw new ToolError(`ディレクトリが存在しません: ${relPath(ctx, abs)}`);

    const ignore = Ignore.fromRoot(ctx.root);
    const entries = await readdir(abs, { withFileTypes: true });
    const rows: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbs = `${abs}/${entry.name}`;
      const childRel = relPath(ctx, childAbs).split('\\').join('/');
      if (entry.isDirectory()) {
        if (ignore.ignores(childRel, true)) continue;
        rows.push(`${entry.name}/`);
      } else if (entry.isFile()) {
        if (ignore.ignores(childRel, false)) continue;
        let size = 0;
        try {
          size = (await stat(childAbs)).size;
        } catch {
          /* ignore */
        }
        rows.push(`${entry.name}  (${size} B)`);
      } else {
        rows.push(entry.name);
      }
    }
    return {
      output: rows.length ? `${relPath(ctx, abs)}:\n${rows.join('\n')}` : `${relPath(ctx, abs)}: (空)`,
      summary: `${relPath(ctx, abs)} — ${rows.length} 件`,
    };
  },
};

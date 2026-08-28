import { spawn } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolError, type ToolDef } from './types.js';
import { pathKind, relPath, resolvePath } from './util.js';

const MAX_OUTPUT_CHARS = 30_000;

/** コマンド文字列から実行されるコマンド名を抜き出す (パイプ・連結を考慮した粗い解析) */
export function baseCommands(command: string): string[] {
  const segments = command.split(/\|\||&&|[;|&\n]/);
  const found: string[] = [];
  for (const seg of segments) {
    const trimmed = seg.trim().replace(/^[({\s]+/, '');
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    const cmd = tokens[i];
    if (cmd) found.push(cmd.replace(/^.*\//, '').replace(/^["']|["']$/g, ''));
  }
  return found;
}

/** 許可リストだけで判断できない「危険な形」を含むか */
function hasUnsafeShellSyntax(command: string): boolean {
  return /[>]|\$\(|`|\brm\b|\bmv\b|\bchmod\b|\bchown\b|\bcurl\b|\bwget\b|\bgit\s+push\b/.test(command);
}

export const runCommandTool: ToolDef = {
  name: 'run_command',
  risk: 'exec',
  declaration: {
    name: 'run_command',
    description:
      'bash でシェルコマンドを実行し、標準出力・標準エラー・終了コードを返す。' +
      'ビルド・テスト・git 操作・パッケージ管理などに使う。' +
      'ファイルの読み書きには専用ツール (read_file / write_file / edit_file) を優先すること。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: '実行するコマンド' },
        description: { type: Type.STRING, description: 'このコマンドが何をするかの短い説明 (承認画面に表示)' },
        cwd: { type: Type.STRING, description: '実行ディレクトリ。省略時はカレントディレクトリ。' },
        timeout_ms: { type: Type.INTEGER, description: 'タイムアウト (ミリ秒)。省略時は設定値。' },
      },
      required: ['command', 'description'],
    },
  },
  approval(args, ctx) {
    const command = String(args['command'] ?? '');
    const bases = baseCommands(command);
    const denied = bases.filter((b) => ctx.config.denyCommands.includes(b));
    if (denied.length > 0) {
      // deny リストは run() 側で必ず弾くので、ここでも承認を要求しておく
      return {
        tool: 'run_command',
        key: `run_command:__denied__`,
        title: `禁止コマンドを含みます: ${denied.join(', ')}`,
        detail: command,
      };
    }
    const allAllowed =
      bases.length > 0 &&
      bases.every((b) => ctx.config.allowCommands.includes(b)) &&
      !hasUnsafeShellSyntax(command);
    if (allAllowed) return null;

    return {
      tool: 'run_command',
      key: `run_command:${[...new Set(bases)].sort().join(',')}`,
      title: `コマンドを実行する: ${String(args['description'] ?? '')}`.trim(),
      detail: command,
    };
  },
  async run(args, ctx) {
    const command = String(args['command'] ?? '');
    if (!command.trim()) throw new ToolError('command が空です');

    const denied = baseCommands(command).filter((b) => ctx.config.denyCommands.includes(b));
    if (denied.length > 0) {
      throw new ToolError(
        `設定 denyCommands により拒否されました: ${denied.join(', ')}\n` +
          'どうしても必要な場合はユーザー自身が実行するか、.gema/config.json の denyCommands を編集してください。',
      );
    }

    let cwd = ctx.cwd;
    if (args['cwd']) {
      cwd = resolvePath(ctx, String(args['cwd']));
      if ((await pathKind(cwd)) !== 'dir') throw new ToolError(`実行ディレクトリが存在しません: ${cwd}`);
    }

    const timeoutMs = Math.max(1000, Number(args['timeout_ms'] ?? ctx.config.shellTimeoutMs) || ctx.config.shellTimeoutMs);

    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, GEMA: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;

      const append = (target: 'out' | 'err', chunk: string) => {
        const current = target === 'out' ? stdout : stderr;
        if (current.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
        const next = current + chunk;
        if (target === 'out') stdout = next.slice(0, MAX_OUTPUT_CHARS);
        else stderr = next.slice(0, MAX_OUTPUT_CHARS);
        if (next.length > MAX_OUTPUT_CHARS) truncated = true;
      };

      child.stdout.on('data', (d: Buffer) => append('out', d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => append('err', d.toString('utf8')));

      const killTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGTERM');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);

        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.trimEnd());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (truncated) parts.push(`… (出力が ${MAX_OUTPUT_CHARS} 文字を超えたため打ち切り)`);
        if (signal) parts.push(`[シグナル ${signal} で終了${signal === 'SIGTERM' ? ' — タイムアウトまたは中断' : ''}]`);
        parts.push(`[exit code: ${code ?? 'null'}]`);

        const rel = relPath(ctx, cwd);
        resolvePromise({
          output: parts.join('\n') || '(出力なし)',
          summary: `${command.split('\n')[0]!.slice(0, 70)} → exit ${code ?? signal ?? '?'}${rel === '.' ? '' : ` (${rel})`}`,
          isError: code !== 0,
        });
      };

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        rejectPromise(new ToolError(`コマンドを起動できませんでした: ${err.message}`));
      });
      child.on('close', finish);
    });
  },
};

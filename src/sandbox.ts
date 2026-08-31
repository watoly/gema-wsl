import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { GemaConfig } from './config.js';
import { expandHome } from './tools/util.js';

let bwrapPath: string | null | undefined;

/** bubblewrap が使えるか (結果はプロセス内でキャッシュ) */
export function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  try {
    bwrapPath = execFileSync('sh', ['-c', 'command -v bwrap'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    bwrapPath = null;
  }
  return bwrapPath;
}

/** 非特権ユーザー名前空間が実際に使えるかを 1 度だけ実測する */
let usableCache: boolean | undefined;
export function sandboxUsable(): boolean {
  if (usableCache !== undefined) return usableCache;
  const bwrap = findBwrap();
  if (!bwrap) {
    usableCache = false;
    return false;
  }
  try {
    execFileSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', '--', 'true'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    usableCache = true;
  } catch {
    usableCache = false;
  }
  return usableCache;
}

export interface SpawnSpec {
  file: string;
  args: string[];
}

/**
 * コマンドをサンドボックス内で動かすための spawn 引数を組み立てる。
 * sandbox が off、または bubblewrap が使えない場合は素の bash を返す。
 */
export function buildSpawnSpec(
  command: string,
  cwd: string,
  root: string,
  config: GemaConfig,
): SpawnSpec {
  if (config.sandbox === 'off') return { file: 'bash', args: ['-c', command] };

  const bwrap = findBwrap();
  if (!bwrap || !sandboxUsable()) return { file: 'bash', args: ['-c', command] };

  const args = ['--ro-bind', '/', '/'];

  // 書き込みを許すパス
  const writable: string[] = ['/tmp'];
  if (config.sandbox === 'workspace-write') writable.push(root);
  for (const p of config.sandboxWritablePaths) {
    const abs = expandHome(p);
    if (existsSync(abs)) writable.push(abs);
  }
  for (const p of [...new Set(writable)]) {
    args.push('--bind', p, p);
  }

  args.push('--dev', '/dev', '--proc', '/proc');
  args.push('--unshare-all');
  if (config.sandboxNetwork) args.push('--share-net');
  args.push('--die-with-parent', '--new-session');
  args.push('--chdir', cwd);
  args.push('--', 'bash', '-c', command);

  return { file: bwrap, args };
}

/** 起動時に表示する 1 行サマリ */
export function describeSandbox(config: GemaConfig): string {
  if (config.sandbox === 'off') return 'サンドボックス: 無効';
  if (!sandboxUsable()) {
    return 'サンドボックス: 要求されましたが bubblewrap が使えないため無効 (sudo apt-get install -y bubblewrap)';
  }
  const scope = config.sandbox === 'workspace-write' ? 'ワークスペースと /tmp のみ書き込み可' : '/tmp のみ書き込み可';
  const net = config.sandboxNetwork ? 'ネットワークあり' : 'ネットワーク遮断';
  return `サンドボックス: ${config.sandbox} (${scope}, ${net})`;
}

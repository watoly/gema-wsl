import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GemaConfig } from './config.js';

const MAX_CONTEXT_FILE_CHARS = 12_000;

export interface ProjectContext {
  files: { path: string; chars: number }[];
  text: string;
}

/** GEMINI.md / AGENTS.md / CLAUDE.md などのプロジェクト指示を読み込む */
export function loadProjectContext(root: string, config: GemaConfig): ProjectContext {
  const files: { path: string; chars: number }[] = [];
  const chunks: string[] = [];

  for (const name of config.contextFileNames) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (text.length > MAX_CONTEXT_FILE_CHARS) {
      text = `${text.slice(0, MAX_CONTEXT_FILE_CHARS)}\n… (長いため省略)`;
    }
    files.push({ path: name, chars: text.length });
    chunks.push(`<project-instructions file="${name}">\n${text}\n</project-instructions>`);
  }
  return { files, text: chunks.join('\n\n') };
}

function gitInfo(root: string): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .filter(Boolean).length;
    return `git ブランチ: ${branch} (未コミットの変更 ${status} 件)`;
  } catch {
    return 'git リポジトリではありません';
  }
}

export function buildSystemInstruction(root: string, cwd: string, config: GemaConfig): string {
  const ctx = loadProjectContext(root, config);
  const wslDistro = process.env['WSL_DISTRO_NAME'];

  const sections = [
    `あなたは "gema" という対話型コーディングエージェントです。ユーザーのターミナル (WSL/Ubuntu) 上で動作し、
提供されたツールを使ってユーザーのソフトウェア開発作業を直接手伝います。`,

    `## 動作原則
- 与えられたツールを積極的に使って、推測ではなく実際のファイル内容・コマンド出力に基づいて判断すること。
- ファイルを編集する前に、必ず read_file で現在の内容を確認すること。
- 既存ファイルの部分修正には edit_file を使い、write_file による全文上書きは新規作成時か全面書き換え時に限ること。
- 探索は glob (ファイル名) と grep (中身) を使い分けること。広い探索を恐れず、まず現状を把握してから手を動かすこと。
- 変更を加えたら、可能ならテストやビルドを run_command で実行して結果を確認すること。
- 破壊的な操作 (ファイル削除、git push、外部への送信など) は、ユーザーが明示的に指示した場合のみ行うこと。
- ユーザーの依頼の範囲を勝手に広げないこと。頼まれていないリファクタリングや追加機能は提案に留めること。`,

    `## 応答スタイル
- ユーザーが日本語で書いたら日本語で答えること。
- ターミナル表示なので簡潔に。前置き・要約の繰り返し・過剰な確認は避けること。
- コードを示すときはファイルパスと行番号を \`path/to/file.ts:42\` の形式で書くこと。
- 作業が終わったら、何をしたかを数行で報告すること。できていないことがあれば正直に述べること。`,

    `## 実行環境
- OS: Linux (${wslDistro ? `WSL2 / ${wslDistro}` : 'WSL または Linux'})
- Node.js: ${process.version}
- ワークスペース (ルート): ${root}
- カレントディレクトリ: ${cwd}
- ${gitInfo(root)}
- 現在日時: ${new Date().toISOString()}
- モデル: ${config.model}
- Windows 側のファイルは /mnt/c/... からアクセスできますが、I/O が遅い点に注意してください。`,

    `## ツール実行の承認について
書き込み系・実行系のツールはユーザーの承認を経てから実行されます。
承認が拒否された場合は、無理に別の手段で同じことをやろうとせず、理由を尋ねるか代替案を提示してください。`,
  ];

  if (ctx.text) {
    sections.push(
      `## プロジェクト固有の指示
以下はこのプロジェクトのリポジトリに置かれた指示です。上記の一般原則より優先してください。

${ctx.text}`,
    );
  }
  if (config.systemPromptExtra) sections.push(config.systemPromptExtra);

  return sections.join('\n\n');
}

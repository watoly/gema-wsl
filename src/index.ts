#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Agent } from './agent.js';
import { ApprovalGate } from './approval.js';
import { createClient, explainApiError } from './client.js';
import { loadConfig, describeAuth, validateConfig, type AuthMode, type GemaConfig, type ThinkLevel } from './config.js';
import { expandMentions } from './mentions.js';
import { Repl } from './repl.js';
import { SessionLog, listSessions, readSessionFile } from './session.js';
import type { ApprovalDecision, ApprovalRequest } from './tools/types.js';
import { expandHome } from './tools/util.js';
import { StreamingMarkdown, c, errLine, label, line, out } from './ui.js';

const VERSION = '0.1.0';

const HELP = `
${c.bold('gema')} — WSL / Ubuntu 向け Gemini コーディングエージェント  v${VERSION}

${c.bold('使い方')}
  gema                        対話モードで起動
  gema -p "<指示>"            1 回だけ実行して終了 (非対話)
  cat spec.md | gema -p       標準入力を指示として実行

${c.bold('オプション')}
  -p, --print [prompt]        非対話モード。prompt 省略時は標準入力を読む
  -m, --model <id>            使用するモデル (例: gemini-3.7-flash)
      --auth <apikey|vertex>  認証方式を明示指定
      --project <id>          Vertex AI の GCP プロジェクト ID
      --location <loc>        Vertex AI のロケーション (既定: global)
      --think <LEVEL>         思考量: MINIMAL / LOW / MEDIUM / HIGH
      --show-thoughts         モデルの思考を表示する
  -C, --cwd <dir>             作業ディレクトリを指定して起動
      --yolo                  承認ゲートを無効化 (すべて自動承認)
      --continue              直近のセッションを復元して起動
      --resume <n>            n 番目のセッションを復元 (--sessions で確認)
      --sessions              保存済みセッション一覧を表示して終了
      --no-session            セッションログを保存しない
  -h, --help                  このヘルプ
  -v, --version               バージョン

${c.bold('認証')}
  A) Gemini API キー   .env に GEMINI_API_KEY=... (https://aistudio.google.com/apikey)
  B) Vertex AI         GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT
                       事前に  gcloud auth application-default login
`;

interface Cli {
  overrides: Partial<GemaConfig>;
  print: boolean;
  prompt?: string;
  cwd?: string;
  resumeIndex?: number;
  listSessions: boolean;
  noSession: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { overrides: {}, print: false, listSessions: false, noSession: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        errLine(`オプション ${a} には値が必要です`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case '-h':
      case '--help':
        out(HELP);
        process.exit(0);
        break;
      case '-v':
      case '--version':
        line(VERSION);
        process.exit(0);
        break;
      case '-p':
      case '--print': {
        cli.print = true;
        const peek = argv[i + 1];
        if (peek && !peek.startsWith('-')) cli.prompt = argv[++i];
        break;
      }
      case '-m':
      case '--model':
        cli.overrides.model = next();
        break;
      case '--auth': {
        const v = next();
        if (v !== 'apikey' && v !== 'vertex') {
          errLine('--auth は apikey か vertex を指定してください');
          process.exit(2);
        }
        cli.overrides.auth = v as AuthMode;
        break;
      }
      case '--project':
        cli.overrides.project = next();
        cli.overrides.auth ??= 'vertex';
        break;
      case '--location':
        cli.overrides.location = next();
        break;
      case '--think':
        cli.overrides.thinkingLevel = next().toUpperCase() as ThinkLevel;
        break;
      case '--show-thoughts':
        cli.overrides.showThoughts = true;
        break;
      case '-C':
      case '--cwd':
        cli.cwd = next();
        break;
      case '--yolo':
        cli.overrides.autoApprove = true;
        break;
      case '--continue':
        cli.resumeIndex = 0;
        break;
      case '--resume':
        cli.resumeIndex = Math.max(0, Number(next()) - 1);
        break;
      case '--sessions':
        cli.listSessions = true;
        break;
      case '--no-session':
        cli.noSession = true;
        break;
      default:
        if (a.startsWith('-')) {
          errLine(`不明なオプション: ${a}  (gema --help)`);
          process.exit(2);
        }
        // 裸の引数はプロンプトとして扱う
        cli.prompt = cli.prompt ? `${cli.prompt} ${a}` : a;
    }
  }
  return cli;
}

function findWorkspaceRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  let cwd = process.cwd();
  if (cli.cwd) {
    const target = isAbsolute(expandHome(cli.cwd)) ? expandHome(cli.cwd) : resolve(cwd, expandHome(cli.cwd));
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      errLine(`ディレクトリが存在しません: ${target}`);
      process.exit(2);
    }
    cwd = target;
    process.chdir(target);
  }
  const root = findWorkspaceRoot(cwd);

  const { config } = loadConfig(cwd, cli.overrides);

  if (cli.listSessions) {
    const sessions = listSessions(cwd);
    if (sessions.length === 0) line('保存済みセッションはありません');
    sessions.forEach((s, i) => {
      line(`${String(i + 1).padStart(2)}  ${s.mtime.toLocaleString()}  ${String(s.turns).padStart(3)} ターン  ${s.firstUserMessage}`);
    });
    return;
  }

  const problem = validateConfig(config);
  if (problem) {
    errLine(label('error', problem));
    process.exit(1);
  }

  const client = createClient(config);
  const session = cli.noSession ? null : new SessionLog(cwd, config.model, describeAuth(config));

  // ApprovalGate は Repl に依存し、Repl は Agent に依存するため、遅延バインドで循環を解く
  const asker: { ask: (req: ApprovalRequest) => Promise<ApprovalDecision> } = {
    ask: async () => 'deny',
  };
  const gate = new ApprovalGate((req) => asker.ask(req), config.autoApprove);

  const agent = new Agent({
    client,
    config,
    gate,
    root,
    cwd,
    session,
    log: (text) => line(c.dim(`    ${text}`)),
  });

  if (cli.resumeIndex !== undefined) {
    const sessions = listSessions(cwd);
    const target = sessions[cli.resumeIndex];
    if (!target) {
      errLine('復元できるセッションがありません');
      process.exit(1);
    }
    agent.loadHistory(readSessionFile(target.path));
    line(c.dim(`セッションを復元しました: ${target.id}`));
  }

  const stdinText = cli.print && !cli.prompt ? await readStdin() : '';
  const oneShotPrompt = cli.prompt ?? stdinText;

  if (cli.print || (!process.stdin.isTTY && oneShotPrompt)) {
    if (!oneShotPrompt) {
      errLine('プロンプトが空です。gema -p "<指示>" のように指定してください。');
      process.exit(2);
    }
    await runOnce(agent, gate, oneShotPrompt, config);
    return;
  }

  const repl = new Repl({ agent, gate, config, root, session });
  asker.ask = (req) => repl.ask(req);
  await repl.run();
}

/** 非対話モード。承認ゲートは自動承認 (--yolo 相当) でなければ書き込み系を拒否する。 */
async function runOnce(agent: Agent, gate: ApprovalGate, prompt: string, config: GemaConfig): Promise<void> {
  if (!gate.auto) {
    errLine(
      c.dim('非対話モードでは承認プロンプトを出せないため、書き込み・実行系のツールは拒否されます。' +
        ' 許可する場合は --yolo を付けてください。'),
    );
  }
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const { parts } = await expandMentions(prompt, agent.cwd);
  const md = new StreamingMarkdown();
  let failed = false;

  for await (const event of agent.send(parts, controller.signal)) {
    switch (event.type) {
      case 'text':
        out(md.feed(event.delta));
        break;
      case 'tool_call':
        errLine(label('tool', `${event.name}`));
        break;
      case 'tool_result':
        errLine(`  ⎿ ${event.summary}`);
        break;
      case 'tool_denied':
        errLine(`  ⎿ 拒否 (--yolo で許可できます)`);
        break;
      case 'error':
        out(md.flush());
        errLine(label('error', event.message));
        failed = true;
        break;
      case 'aborted':
        failed = true;
        break;
    }
  }
  out(md.flush());
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  errLine(label('error', explainApiError({ auth: 'apikey', model: '', location: '' } as GemaConfig, err)));
  process.exitCode = 1;
});

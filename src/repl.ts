import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';
import { readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Agent } from './agent.js';
import type { ApprovalGate } from './approval.js';
import { KNOWN_MODELS, describeAuth, userDataDir, type GemaConfig } from './config.js';
import { expandMentions } from './mentions.js';
import { loadProjectContext } from './prompt.js';
import type { McpManager } from './mcp.js';
import { describeSandbox, sandboxUsable } from './sandbox.js';
import { listSessions, readSessionFile, type SessionLog } from './session.js';
import type { Telemetry } from './telemetry.js';
import { expandHome, isInside } from './tools/util.js';
import type { ApprovalDecision, ApprovalRequest } from './tools/types.js';
import { StreamingMarkdown, c, label, line, out, truncate } from './ui.js';

const COMMANDS: { name: string; args?: string; help: string }[] = [
  { name: '/help', help: 'コマンド一覧を表示' },
  { name: '/exit', help: '終了 (/quit も可)' },
  { name: '/clear', help: '会話履歴をリセット' },
  { name: '/model', args: '[id]', help: 'モデルの表示・変更' },
  { name: '/models', help: '利用可能なモデル候補を表示' },
  { name: '/auth', help: '認証方式と接続先を表示' },
  { name: '/config', help: '現在の設定を表示' },
  { name: '/tools', help: '利用可能なツール一覧 (MCP 含む)' },
  { name: '/mcp', help: 'MCP サーバーの接続状況' },
  { name: '/sandbox', args: '[mode]', help: 'サンドボックスの表示・切替 (off/workspace-write/read-only)' },
  { name: '/search', args: '[on|off]', help: '組み込み Google 検索の表示・切替' },
  { name: '/compact', help: '会話履歴を要約して圧縮' },
  { name: '/telemetry', help: 'Cloud Logging へのテレメトリ送信状況' },
  { name: '/context', help: '読み込んだプロジェクト指示ファイルを表示' },
  { name: '/cwd', args: '[dir]', help: 'カレントディレクトリの表示・変更' },
  { name: '/cost', help: 'このセッションのトークン使用量' },
  { name: '/yolo', help: '承認ゲートの ON/OFF を切り替え' },
  { name: '/allow', help: 'セッション中に自動承認しているキーを表示' },
  { name: '/sessions', help: '保存済みセッションの一覧' },
  { name: '/resume', args: '[n]', help: 'セッションを復元 (n は /sessions の番号)' },
  { name: '/history', help: '会話履歴の件数と直近の内容' },
  { name: '/init', help: 'このリポジトリ用の GEMINI.md をエージェントに書かせる' },
];

export interface ReplDeps {
  agent: Agent;
  gate: ApprovalGate;
  config: GemaConfig;
  root: string;
  session: SessionLog | null;
  mcp: McpManager | null;
  telemetry: Telemetry | null;
}

export class Repl {
  private rl: Interface;
  private abort: AbortController | null = null;
  private lastSigint = 0;
  private historyPath = join(userDataDir(), 'input-history');
  private lineQueue: string[] = [];
  private lineWaiter: ((value: string | null) => void) | null = null;
  private closed = false;

  constructor(private deps: ReplDeps) {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 500,
      completer: (input: string) => this.complete(input),
      terminal: process.stdin.isTTY ?? false,
    });
    this.loadInputHistory();
    this.rl.on('SIGINT', () => this.onSigint());
    this.rl.on('line', (l) => this.pushLine(l));
    this.rl.on('close', () => {
      this.closed = true;
      this.pushLine(null);
    });
  }

  /**
   * 入力を 1 行受け取る。パイプ入力でも取りこぼさないよう
   * question() ではなく 'line' イベントをキューに溜めて配る。
   */
  private nextLine(promptText: string): Promise<string | null> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(promptText);
    this.rl.prompt();
    return new Promise((resolvePromise) => {
      this.lineWaiter = resolvePromise;
    });
  }

  private pushLine(value: string | null): void {
    if (this.lineWaiter) {
      const waiter = this.lineWaiter;
      this.lineWaiter = null;
      waiter(value);
    } else if (value !== null) {
      this.lineQueue.push(value);
    }
  }

  // ───────────────────────── 承認プロンプト ─────────────────────────

  async ask(req: ApprovalRequest): Promise<ApprovalDecision> {
    line();
    line(label('warn', c.bold(req.title)));
    if (req.detail) {
      const body = truncate(req.detail, 2000);
      for (const l of body.split('\n')) {
        if (l.startsWith('+')) line(c.green(`  ${l}`));
        else if (l.startsWith('-')) line(c.red(`  ${l}`));
        else line(c.dim(`  ${l}`));
      }
    }
    line(c.dim('  [y] 実行   [a] 以後このセッションでは自動実行   [n] 拒否'));

    this.rl.resume();
    const raw = await this.nextLine(c.yellow('  > '));
    this.rl.pause();
    if (raw === null) return 'deny';
    const answer = raw.trim().toLowerCase();
    if (answer === 'a' || answer === 'always') return 'always';
    if (answer === '' || answer === 'y' || answer === 'yes') return 'once';
    return 'deny';
  }

  // ───────────────────────── メインループ ─────────────────────────

  async run(): Promise<void> {
    this.banner();
    for (;;) {
      const input = await this.nextLine(`${c.green('❯')} `);
      if (input === null) break;
      const trimmed = input.trim();
      if (!trimmed) continue;
      this.saveInputHistory(trimmed);

      if (trimmed.startsWith('/')) {
        const done = await this.runCommand(trimmed);
        if (done) break;
        continue;
      }
      await this.turn(trimmed);
    }
    this.rl.close();
  }

  /** 1 ターン分をエージェントに投げ、イベントを画面に描画する */
  async turn(input: string): Promise<void> {
    const { parts, attached, problems } = await expandMentions(
      input,
      this.deps.agent.cwd,
      this.deps.config.maxMediaBytes,
    );
    if (attached.length) line(c.dim(`  添付: ${attached.join(', ')}`));
    for (const problem of problems) line(label('warn', problem));

    this.abort = new AbortController();
    this.rl.pause();
    const md = new StreamingMarkdown();
    let sawText = false;

    try {
      for await (const event of this.deps.agent.send(parts, this.abort.signal)) {
        switch (event.type) {
          case 'text':
            if (!sawText) {
              line();
              sawText = true;
            }
            out(md.feed(event.delta));
            break;
          case 'thought':
            out(c.dim(event.delta));
            break;
          case 'tool_call': {
            out(md.flush());
            sawText = false;
            line();
            line(label('tool', `${c.bold(event.name)}${c.dim(formatArgs(event.args))}`));
            break;
          }
          case 'tool_result':
            line(
              event.isError
                ? `  ${c.red('⎿')} ${c.red(event.summary || 'エラー')}`
                : `  ${c.dim('⎿')} ${c.dim(event.summary)}`,
            );
            break;
          case 'tool_denied':
            line(`  ${c.red('⎿')} ${c.red('拒否しました')}`);
            break;
          case 'aborted':
            out(md.flush());
            line(c.yellow('\n[中断しました]'));
            break;
          case 'error':
            out(md.flush());
            line();
            line(label('error', event.message));
            break;
          case 'notice':
            out(md.flush());
            line();
            line(label('warn', event.message));
            break;
          case 'grounding':
            out(md.flush());
            line();
            line(c.dim('  出典:'));
            for (const source of event.sources) {
              line(c.dim(`    - ${source.title}`));
              line(c.dim(`      ${source.uri}`));
            }
            break;
          case 'compacted':
            line(label('info', `会話履歴を圧縮しました (${event.removed} メッセージ → 要約 ${event.summaryChars} 文字)`));
            break;
          case 'turn_end':
            out(md.flush());
            line();
            break;
        }
      }
    } finally {
      out(md.flush());
      this.abort = null;
      this.rl.resume();
    }

    // ターンが終わってから、必要なら履歴を自動圧縮する
    try {
      const compacted = await this.deps.agent.maybeCompact();
      if (compacted) {
        line(
          label(
            'info',
            `コンテキストが大きくなったため自動圧縮しました ` +
              `(${compacted.removed} メッセージ → 要約 ${compacted.summaryChars} 文字)`,
          ),
        );
      }
    } catch (err) {
      line(label('warn', `自動圧縮に失敗しました: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // ───────────────────────── スラッシュコマンド ─────────────────────────

  /** 終了すべきなら true */
  private async runCommand(input: string): Promise<boolean> {
    const [cmd = '', ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();
    const { agent, gate, config } = this.deps;

    switch (cmd) {
      case '/exit':
      case '/quit':
        return true;

      case '/help':
        line();
        for (const cm of COMMANDS) {
          line(`  ${c.cyan(`${cm.name}${cm.args ? ` ${cm.args}` : ''}`.padEnd(18))} ${cm.help}`);
        }
        line();
        line(c.dim('  @path/to/file  … 入力に含めるとそのファイルを添付します'));
        line(c.dim('  Ctrl+C         … 実行中の処理を中断 / 2 回押すと終了'));
        line();
        return false;

      case '/clear':
        agent.reset();
        line(label('ok', '会話履歴をリセットしました'));
        return false;

      case '/model':
        if (!arg) {
          line(`  現在のモデル: ${c.bold(config.model)}`);
          return false;
        }
        config.model = arg;
        agent.refreshSystemInstruction();
        line(label('ok', `モデルを ${arg} に変更しました`));
        return false;

      case '/models':
        line();
        for (const m of KNOWN_MODELS) {
          line(`  ${m === config.model ? c.green('●') : ' '} ${m}`);
        }
        line(c.dim('  ※ 一覧は目安です。/model <id> で任意の ID を指定できます。'));
        line();
        return false;

      case '/auth':
        line(`  認証: ${describeAuth(config)}`);
        return false;

      case '/config':
        line();
        for (const [k, v] of Object.entries(config)) {
          if (k === 'apiKey' || k.startsWith('_')) continue;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            line(`  ${c.cyan(k.padEnd(22))} ${JSON.stringify(v)}`);
            continue;
          }
          line(`  ${c.cyan(k.padEnd(22))} ${Array.isArray(v) ? v.join(', ') : String(v)}`);
        }
        line();
        return false;

      case '/tools': {
        line();
        for (const t of agent.tools) {
          const risk = t.risk === 'read' ? c.green('read') : t.risk === 'write' ? c.yellow('write') : c.red('exec');
          const desc = (t.declaration.description ?? '').split('。')[0];
          line(`  ${c.cyan(t.name.padEnd(26))} [${risk}] ${desc}。`);
        }
        if (agent.searchEnabled) {
          line(`  ${c.cyan('google_search'.padEnd(26))} [${c.green('read')}] Gemini 組み込みの Google 検索 (サーバー側実行)。`);
        }
        line();
        return false;
      }

      case '/mcp': {
        const statuses = this.deps.mcp?.status ?? [];
        if (statuses.length === 0) {
          line(c.dim('  MCP サーバーは設定されていません'));
          line(c.dim('  .gema/config.json の mcpServers に追加してください'));
          return false;
        }
        line();
        for (const st of statuses) {
          const mark = st.connected ? c.green('●') : c.red('○');
          line(`  ${mark} ${c.cyan(st.name.padEnd(16))} ${st.transport.padEnd(6)} ${st.toolCount} ツール`);
          if (st.error) line(`      ${c.red(st.error)}`);
        }
        line();
        return false;
      }

      case '/sandbox': {
        if (!arg) {
          line(`  ${describeSandbox(config)}`);
          if (config.sandbox !== 'off' && !sandboxUsable()) {
            line(c.dim('  bubblewrap の導入:  sudo apt-get install -y bubblewrap'));
          }
          return false;
        }
        if (arg !== 'off' && arg !== 'workspace-write' && arg !== 'read-only') {
          line(label('error', 'off / workspace-write / read-only のいずれかを指定してください'));
          return false;
        }
        if (arg !== 'off' && !sandboxUsable()) {
          line(label('error', 'bubblewrap が使えません:  sudo apt-get install -y bubblewrap'));
          return false;
        }
        config.sandbox = arg;
        line(label('ok', describeSandbox(config)));
        return false;
      }

      case '/search': {
        if (!arg) {
          line(`  組み込み Google 検索: ${agent.searchEnabled ? c.green('有効') : c.dim('無効')}`);
          return false;
        }
        if (arg !== 'on' && arg !== 'off') {
          line(label('error', 'on か off を指定してください'));
          return false;
        }
        agent.setSearchEnabled(arg === 'on');
        config.webSearch = arg === 'on' ? 'on' : 'off';
        line(label('ok', `組み込み Google 検索を${arg === 'on' ? '有効' : '無効'}にしました`));
        return false;
      }

      case '/telemetry': {
        const telemetry = this.deps.telemetry;
        const t = config.telemetry;
        line();
        if (!t.enabled) {
          line(`  テレメトリ: ${c.dim('無効')}`);
          line(c.dim('  --telemetry を付けて起動するか、設定の telemetry.enabled を true にしてください。'));
          line(c.dim('  事前に Cloud Logging API の有効化と roles/logging.logWriter の付与が必要です。'));
        } else if (telemetry?.active) {
          line(`  テレメトリ: ${c.green('送信中')}`);
          line(`  ${c.cyan('プロジェクト'.padEnd(14))} ${telemetry.targetProject}`);
          line(`  ${c.cyan('ログ名'.padEnd(16))} projects/${telemetry.targetProject}/logs/${t.logName}`);
          line(`  ${c.cyan('プロンプト記録'.padEnd(12))} ${t.logPrompts ? 'あり' : 'なし'}`);
          line(`  ${c.cyan('ツール引数記録'.padEnd(12))} ${t.logToolArgs ? 'あり' : 'なし'}`);
          line(c.dim(`  確認: gcloud logging read 'logName="projects/${telemetry.targetProject}/logs/${t.logName}"' --limit=20 --project=${telemetry.targetProject}`));
        } else {
          line(`  テレメトリ: ${c.yellow('有効だが停止中')}`);
          line(c.dim('  送信エラーで停止したか、起動時の検証に失敗しています。'));
        }
        line();
        return false;
      }

      case '/compact': {
        line(c.dim('  会話履歴を要約しています…'));
        try {
          const result = await agent.compact();
          if (!result) {
            line(label('info', '圧縮できるだけの履歴がまだありません'));
          } else {
            line(label('ok', `${result.removed} メッセージを要約 ${result.summaryChars} 文字に置き換えました`));
          }
        } catch (err) {
          line(label('error', `圧縮に失敗しました: ${err instanceof Error ? err.message : String(err)}`));
        }
        return false;
      }

      case '/context': {
        const ctx = loadProjectContext(this.deps.root, config);
        if (ctx.files.length === 0) {
          line(c.dim('  プロジェクト指示ファイルはありません (GEMINI.md / AGENTS.md / CLAUDE.md)'));
          line(c.dim('  /init で GEMINI.md を作成できます'));
        } else {
          for (const f of ctx.files) line(`  ${c.cyan(f.path)} (${f.chars} 文字)`);
        }
        return false;
      }

      case '/cwd': {
        if (!arg) {
          line(`  ${agent.cwd}`);
          return false;
        }
        const target = isAbsolute(expandHome(arg)) ? expandHome(arg) : resolve(agent.cwd, expandHome(arg));
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          line(label('error', `ディレクトリが存在しません: ${target}`));
          return false;
        }
        if (!config.allowOutsideWorkspace && !isInside(this.deps.root, target)) {
          line(label('error', `ワークスペース (${this.deps.root}) の外には移動できません`));
          return false;
        }
        agent.setCwd(target);
        line(label('ok', `カレントディレクトリ: ${target}`));
        return false;
      }

      case '/cost': {
        const u = agent.usage;
        line();
        line(`  リクエスト数   ${u.requests}`);
        line(`  入力トークン   ${u.prompt.toLocaleString()}`);
        line(`  出力トークン   ${u.output.toLocaleString()}`);
        if (u.thoughts) line(`  思考トークン   ${u.thoughts.toLocaleString()}`);
        line(`  合計           ${u.total.toLocaleString()}`);
        line();
        return false;
      }

      case '/yolo':
        gate.setAuto(!gate.auto);
        line(
          gate.auto
            ? label('warn', '承認ゲートを OFF にしました (すべてのツールが確認なしで実行されます)')
            : label('ok', '承認ゲートを ON にしました'),
        );
        return false;

      case '/allow': {
        const list = gate.allowlist;
        if (list.length === 0) line(c.dim('  自動承認しているキーはありません'));
        else for (const k of list) line(`  ${c.cyan(k)}`);
        return false;
      }

      case '/sessions': {
        const sessions = listSessions(agent.cwd);
        if (sessions.length === 0) {
          line(c.dim('  保存済みセッションはありません'));
          return false;
        }
        line();
        sessions.forEach((s, i) => {
          line(
            `  ${c.cyan(String(i + 1).padStart(2))}  ${c.dim(s.mtime.toLocaleString())}  ` +
              `${String(s.turns).padStart(3)} ターン  ${s.firstUserMessage}`,
          );
        });
        line(c.dim('  /resume <番号> で復元'));
        line();
        return false;
      }

      case '/resume': {
        const sessions = listSessions(agent.cwd);
        const index = arg ? Number(arg) - 1 : 0;
        const target = sessions[index];
        if (!target) {
          line(label('error', '該当するセッションがありません。/sessions で確認してください。'));
          return false;
        }
        const contents = readSessionFile(target.path);
        agent.loadHistory(contents);
        line(label('ok', `セッションを復元しました: ${target.id} (${contents.length} メッセージ)`));
        return false;
      }

      case '/history': {
        const h = agent.history;
        line(`  ${h.length} メッセージ (user: ${h.filter((m) => m.role === 'user').length})`);
        for (const m of h.slice(-4)) {
          const text = (m.parts ?? [])
            .map((p) => p.text ?? (p.functionCall ? `[tool: ${p.functionCall.name}]` : p.functionResponse ? '[tool result]' : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .slice(0, 100);
          line(`  ${c.dim(`${m.role}:`)} ${text}`);
        }
        return false;
      }

      case '/init':
        await this.turn(
          'このリポジトリの構成・使用技術・ビルドとテストの実行方法・コーディング規約を調査し、' +
            'リポジトリ直下に GEMINI.md として書き出してください。' +
            '今後このエージェントが作業するときに役立つ、簡潔で具体的な内容にしてください。',
        );
        return false;

      default:
        line(label('error', `不明なコマンド: ${cmd}  (/help で一覧)`));
        return false;
    }
  }

  // ───────────────────────── 補助 ─────────────────────────

  private banner(): void {
    const { config, agent } = this.deps;
    line();
    line(
      `  ${c.bold(c.magenta('gema'))} ${c.dim('·')} ${c.cyan(config.model)} ${c.dim('·')} ${c.dim(describeAuth(config))}`,
    );
    line(`  ${c.dim(agent.cwd)}`);
    if (this.deps.gate.auto) line(`  ${c.yellow('承認ゲート OFF (--yolo)')}`);
    if (config.sandbox !== 'off') line(`  ${c.dim(describeSandbox(config))}`);
    const connected = this.deps.mcp?.connectedCount ?? 0;
    if (connected > 0) {
      line(c.dim(`  MCP: ${connected} サーバー接続中 (${agent.tools.length} ツール)`));
    }
    if (this.deps.telemetry?.active) {
      line(c.dim(`  テレメトリ: Cloud Logging (${this.deps.telemetry.targetProject})`));
    }
    line(c.dim('  /help でコマンド一覧 · Ctrl+C で中断 · /exit で終了'));
    line();
  }

  private onSigint(): void {
    if (this.abort) {
      this.abort.abort();
      return;
    }
    const now = Date.now();
    if (now - this.lastSigint < 1500) {
      line();
      this.rl.close();
      process.exit(0);
    }
    this.lastSigint = now;
    line(c.dim('\n  もう一度 Ctrl+C で終了 (/exit でも可)'));
    this.rl.prompt();
  }

  private complete(input: string): [string[], string] {
    if (input.startsWith('/') && !input.includes(' ')) {
      const hits = COMMANDS.map((c2) => c2.name).filter((n) => n.startsWith(input));
      return [hits.length ? hits : COMMANDS.map((c2) => c2.name), input];
    }
    const match = input.match(/(?:^|\s)@([^\s]*)$/);
    if (match) {
      const partial = match[1]!;
      const base = partial.includes('/') ? dirname(partial) : '.';
      const prefix = partial.includes('/') ? partial.slice(partial.lastIndexOf('/') + 1) : partial;
      const dirAbs = isAbsolute(base) ? base : resolve(this.deps.agent.cwd, base);
      try {
        const names = readdirSync(dirAbs, { withFileTypes: true })
          .filter((e) => e.name.startsWith(prefix) && !e.name.startsWith('.'))
          .map((e) => (base === '.' ? e.name : `${base}/${e.name}`) + (e.isDirectory() ? '/' : ''));
        return [names, partial];
      } catch {
        return [[], partial];
      }
    }
    return [[], input];
  }

  private loadInputHistory(): void {
    try {
      if (!existsSync(this.historyPath)) return;
      const lines = readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean).slice(-500);
      // readline の history は新しいものが先頭
      (this.rl as unknown as { history: string[] }).history = lines.reverse();
    } catch {
      /* 履歴が読めなくても起動は続行 */
    }
  }

  private saveInputHistory(input: string): void {
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      const existing = existsSync(this.historyPath)
        ? readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean)
        : [];
      existing.push(input);
      writeFileSync(this.historyPath, `${existing.slice(-500).join('\n')}\n`, 'utf8');
    } catch {
      /* 履歴保存の失敗は無視 */
    }
  }
}

function formatArgs(args: Record<string, unknown>): string {
  const preferred = ['path', 'pattern', 'command', 'description'];
  for (const key of preferred) {
    const v = args[key];
    if (typeof v === 'string' && v) {
      const flat = v.replace(/\s+/g, ' ').trim();
      return `(${flat.length > 70 ? `${flat.slice(0, 69)}…` : flat})`;
    }
  }
  const keys = Object.keys(args);
  return keys.length ? `(${keys.join(', ')})` : '()';
}

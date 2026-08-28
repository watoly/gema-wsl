import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AuthMode = 'apikey' | 'vertex';
export type ThinkLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface GemaConfig {
  /** 認証方式。apikey = Google AI Studio の API キー / vertex = Vertex AI (gcloud ADC) */
  auth: AuthMode;
  model: string;
  apiKey?: string;
  project?: string;
  location: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingLevel?: ThinkLevel;
  showThoughts: boolean;
  /** 承認ゲートを常にスキップする (--yolo) */
  autoApprove: boolean;
  /** 承認なしで実行してよいコマンド名 (argv[0] で判定) */
  allowCommands: string[];
  /** 常に拒否するコマンド名 */
  denyCommands: string[];
  /** 1 ターンあたりのツール実行ラウンド上限 */
  maxIterations: number;
  shellTimeoutMs: number;
  /** read_file / grep が扱う 1 ファイルの上限バイト数 */
  maxFileBytes: number;
  /** 起動時に読み込むプロジェクト指示ファイル */
  contextFileNames: string[];
  /** ワークスペース外のパスへのアクセスを許可するか */
  allowOutsideWorkspace: boolean;
  systemPromptExtra?: string;
}

export const DEFAULT_MODEL = 'gemini-3.7-flash';

export const KNOWN_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

/** 検索系ツールが常に無視するディレクトリ */
export const DEFAULT_IGNORE_DIRS = [
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'target', 'vendor', '.cache', 'coverage', '.gradle', '.idea', '.gema',
];

const DEFAULTS: GemaConfig = {
  auth: 'apikey',
  model: DEFAULT_MODEL,
  location: 'global',
  showThoughts: false,
  autoApprove: false,
  allowCommands: [
    'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'which', 'file',
    'grep', 'rg', 'find', 'date', 'stat', 'tree', 'du', 'df',
  ],
  denyCommands: ['shutdown', 'reboot', 'poweroff', 'mkfs', 'dd', 'sudo'],
  maxIterations: 25,
  shellTimeoutMs: 120_000,
  maxFileBytes: 512 * 1024,
  contextFileNames: ['GEMINI.md', 'AGENTS.md', 'CLAUDE.md', '.gema/instructions.md'],
  allowOutsideWorkspace: false,
};

export function userConfigDir(): string {
  const base = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(base, 'gema');
}

export function userDataDir(): string {
  const base = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return join(base, 'gema');
}

/** 既存の環境変数を上書きしない、最小限の .env ローダー */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readJson(path: string): Partial<GemaConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<GemaConfig>;
  } catch (err) {
    process.stderr.write(`[gema] 設定ファイルを読めませんでした: ${path}: ${String(err)}\n`);
    return {};
  }
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface ConfigSources {
  userConfigPath: string;
  projectConfigPath: string;
  loadedFrom: string[];
}

export function loadConfig(cwd: string, overrides: Partial<GemaConfig> = {}): {
  config: GemaConfig;
  sources: ConfigSources;
} {
  loadDotEnv(join(cwd, '.env'));
  loadDotEnv(join(userConfigDir(), '.env'));

  const userConfigPath = join(userConfigDir(), 'config.json');
  const projectConfigPath = join(cwd, '.gema', 'config.json');
  const loadedFrom: string[] = [];
  if (existsSync(userConfigPath)) loadedFrom.push(userConfigPath);
  if (existsSync(projectConfigPath)) loadedFrom.push(projectConfigPath);

  const fromEnv = stripUndefined({
    auth: envBool('GOOGLE_GENAI_USE_VERTEXAI') ? ('vertex' as AuthMode) : undefined,
    model: process.env['GEMA_MODEL'],
    apiKey: process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'],
    project: process.env['GOOGLE_CLOUD_PROJECT'],
    location: process.env['GOOGLE_CLOUD_LOCATION'],
    thinkingLevel: process.env['GEMA_THINKING'] as ThinkLevel | undefined,
  });

  const config: GemaConfig = {
    ...DEFAULTS,
    ...readJson(userConfigPath),
    ...readJson(projectConfigPath),
    ...fromEnv,
    ...stripUndefined(overrides),
  };

  // apikey モードなのにキーが無く、Vertex の材料が揃っているなら vertex に倒す
  if (config.auth === 'apikey' && !config.apiKey && config.project) {
    config.auth = 'vertex';
  }
  return { config, sources: { userConfigPath, projectConfigPath, loadedFrom } };
}

export function describeAuth(config: GemaConfig): string {
  if (config.auth === 'vertex') {
    return `Vertex AI (project=${config.project ?? '未設定'}, location=${config.location})`;
  }
  const key = config.apiKey;
  const masked = key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '未設定';
  return `Gemini API キー (${masked})`;
}

/** 設定が実際に使える状態かを検証する。問題があればメッセージを返す。 */
export function validateConfig(config: GemaConfig): string | null {
  if (config.auth === 'vertex') {
    if (!config.project) {
      return [
        'Vertex AI モードですが GOOGLE_CLOUD_PROJECT が設定されていません。',
        '  export GOOGLE_CLOUD_PROJECT=<your-project-id>',
        '  gcloud auth application-default login',
      ].join('\n');
    }
    return null;
  }
  if (!config.apiKey) {
    return [
      'GEMINI_API_KEY が設定されていません。',
      '  1) https://aistudio.google.com/apikey で API キーを発行',
      '  2) プロジェクト直下の .env に GEMINI_API_KEY=... を記述',
      `     (または ${join(userConfigDir(), '.env')} に記述すると全プロジェクトで有効)`,
      '',
      'Vertex AI を使う場合は GOOGLE_GENAI_USE_VERTEXAI=true と GOOGLE_CLOUD_PROJECT を設定してください。',
    ].join('\n');
  }
  return null;
}

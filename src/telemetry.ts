import { hostname, userInfo } from 'node:os';
import { GoogleAuth } from 'google-auth-library';
import type { GemaConfig } from './config.js';

const ENDPOINT = 'https://logging.googleapis.com/v2/entries:write';
const SCOPES = ['https://www.googleapis.com/auth/logging.write'];

export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR';

interface LogEntry {
  severity: Severity;
  timestamp: string;
  insertId: string;
  jsonPayload: Record<string, unknown>;
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie)/i;
const MAX_VALUE_CHARS = 2000;

/** 秘密になりうる値を伏せ、長すぎる値を切り詰める */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…(${value.length}文字)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class TelemetryError extends Error {
  constructor(
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

export class Telemetry {
  private queue: LogEntry[] = [];
  private auth: GoogleAuth | null = null;
  private project: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private counter = 0;
  private flushing: Promise<void> | null = null;

  constructor(
    private config: GemaConfig,
    private sessionId: string,
    private warn: (message: string) => void,
  ) {}

  get active(): boolean {
    return this.auth !== null && !this.stopped;
  }

  get targetProject(): string | null {
    return this.project;
  }

  /**
   * ADC で認証し、dryRun の書き込みで API 有効化と権限を検証する。
   * 失敗した場合は具体的な対処手順つきの TelemetryError を投げる。
   */
  async start(): Promise<void> {
    const telemetry = this.config.telemetry;
    if (!telemetry.enabled) return;

    const project = telemetry.project || this.config.project;
    if (!project) {
      throw new TelemetryError(
        'テレメトリの送信先 GCP プロジェクトが特定できません。',
        [
          '  gcloud config set project <your-project-id>',
          '  もしくは設定の telemetry.project / 環境変数 GOOGLE_CLOUD_PROJECT を指定してください。',
        ].join('\n'),
      );
    }
    this.project = project;

    const auth = new GoogleAuth({ scopes: SCOPES });
    try {
      await auth.getClient();
    } catch (err) {
      throw new TelemetryError(
        `ADC を読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`,
        '  gcloud auth application-default login --no-launch-browser',
      );
    }
    this.auth = auth;

    // dryRun で「API が有効か」「書き込み権限があるか」を起動時に確かめる
    try {
      await this.post([this.entry('INFO', { event: 'telemetry_check' })], true);
    } catch (err) {
      this.auth = null;
      throw this.explain(err, project);
    }

    this.timer = setInterval(() => void this.flush(), telemetry.flushIntervalMs);
    this.timer.unref?.();
  }

  /** イベントを 1 件積む。送信は非同期で、失敗しても本体の動作は止めない。 */
  event(name: string, payload: Record<string, unknown> = {}, severity: Severity = 'INFO'): void {
    if (!this.active) return;
    this.queue.push(this.entry(severity, { event: name, ...(redact(payload) as Record<string, unknown>) }));
    if (this.queue.length >= this.config.telemetry.maxBatch) void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.active || this.queue.length === 0) return;
    if (this.flushing) return this.flushing;

    const batch = this.queue.splice(0, this.config.telemetry.maxBatch);
    this.flushing = (async () => {
      try {
        await this.post(batch, false);
      } catch (err) {
        // 一度失敗したら黙って積み続けないよう、警告して停止する
        this.stopped = true;
        this.warn(
          `テレメトリの送信に失敗したため停止しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.stopped = true;
  }

  private entry(severity: Severity, payload: Record<string, unknown>): LogEntry {
    this.counter += 1;
    return {
      severity,
      timestamp: new Date().toISOString(),
      insertId: `${this.sessionId}-${this.counter}`,
      jsonPayload: payload,
    };
  }

  private async post(entries: LogEntry[], dryRun: boolean): Promise<void> {
    if (!this.auth || !this.project) return;
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error('アクセストークンを取得できませんでした');

    const body = {
      logName: `projects/${this.project}/logs/${encodeURIComponent(this.config.telemetry.logName)}`,
      resource: { type: 'global', labels: { project_id: this.project } },
      labels: {
        session_id: this.sessionId,
        host: hostname(),
        os_user: userInfo().username,
        tool: 'gema',
      },
      entries,
      partialSuccess: true,
      ...(dryRun ? { dryRun: true } : {}),
    };

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
  }

  /** Cloud Logging のエラーを、そのまま実行できる対処手順に変える */
  private explain(err: unknown, project: string): TelemetryError {
    const message = err instanceof Error ? err.message : String(err);
    const account = '<ADC で使ったアカウント>';

    if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(message)) {
      return new TelemetryError(
        `プロジェクト ${project} で Cloud Logging API が有効になっていません。`,
        [
          `  gcloud services enable logging.googleapis.com --project=${project}`,
          '  (有効化の反映に数分かかることがあります)',
        ].join('\n'),
      );
    }
    if (/PERMISSION_DENIED|403|logging\.logEntries\.create/i.test(message)) {
      return new TelemetryError(
        `Cloud Logging への書き込み権限がありません (プロジェクト ${project})。`,
        [
          '  ADC のアカウントに roles/logging.logWriter を付与してください。',
          '',
          '  gcloud auth list          # ADC で使っているアカウントを確認',
          `  gcloud projects add-iam-policy-binding ${project} \\`,
          `    --member="user:${account}" \\`,
          '    --role="roles/logging.logWriter"',
          '',
          '  サービスアカウントの場合は --member="serviceAccount:..." を指定してください。',
        ].join('\n'),
      );
    }
    if (/UNAUTHENTICATED|401|invalid_grant/i.test(message)) {
      return new TelemetryError('ADC の認証情報が無効か期限切れです。', '  gcloud auth application-default login --no-launch-browser');
    }
    if (/NOT_FOUND|404/i.test(message)) {
      return new TelemetryError(`プロジェクト ${project} が見つかりません。`, '  gcloud projects list で ID を確認してください。');
    }
    return new TelemetryError(`Cloud Logging への書き込みを確認できませんでした: ${message}`, '');
  }
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Content } from '@google/genai';
import { userDataDir } from './config.js';

export interface SessionMeta {
  id: string;
  startedAt: string;
  cwd: string;
  model: string;
  auth: string;
}

type Record_ =
  | { t: string; type: 'meta'; meta: SessionMeta }
  | { t: string; type: 'content'; content: Content }
  | { t: string; type: 'note'; text: string };

/** カレントディレクトリごとにセッションを分けて保存するディレクトリ */
export function sessionsDir(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
  return join(userDataDir(), 'sessions', slug);
}

export class SessionLog {
  readonly path: string;
  readonly meta: SessionMeta;

  constructor(cwd: string, model: string, auth: string) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = sessionsDir(cwd);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${id}.jsonl`);
    this.meta = { id, startedAt: new Date().toISOString(), cwd, model, auth };
    this.write({ t: this.meta.startedAt, type: 'meta', meta: this.meta });
  }

  private write(record: Record_): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* 記録に失敗しても対話は続行する */
    }
  }

  appendContent(content: Content): void {
    this.write({ t: new Date().toISOString(), type: 'content', content });
  }

  appendNote(text: string): void {
    this.write({ t: new Date().toISOString(), type: 'note', text });
  }
}

export interface SessionSummary {
  path: string;
  id: string;
  mtime: Date;
  turns: number;
  firstUserMessage: string;
}

function firstUserText(contents: Content[]): string {
  for (const c of contents) {
    if (c.role !== 'user') continue;
    const text = (c.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (text && !text.startsWith('[')) return text.replace(/\s+/g, ' ').slice(0, 80);
  }
  return '(空のセッション)';
}

export function readSessionFile(path: string): Content[] {
  if (!existsSync(path)) return [];
  const contents: Content[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const rec = JSON.parse(raw) as Record_;
      if (rec.type === 'content') contents.push(rec.content);
    } catch {
      /* 壊れた行は読み飛ばす */
    }
  }
  return contents;
}

export function listSessions(cwd: string, limit = 20): SessionSummary[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const contents = readSessionFile(path);
      summaries.push({
        path,
        id: basename(f, '.jsonl'),
        mtime: statSync(path).mtime,
        turns: contents.filter((c) => c.role === 'user').length,
        firstUserMessage: firstUserText(contents),
      });
    } catch {
      /* 読めないセッションは無視 */
    }
  }
  return summaries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

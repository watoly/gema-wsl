import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

const colorEnabled =
  !process.env['NO_COLOR'] && process.stdout.isTTY !== false && process.env['TERM'] !== 'dumb';

export function paint(style: Style, text: string): string {
  if (!colorEnabled) return text;
  try {
    return styleText(style, text);
  } catch {
    return text;
  }
}

export const c = {
  dim: (s: string) => paint('dim', s),
  bold: (s: string) => paint('bold', s),
  red: (s: string) => paint('red', s),
  green: (s: string) => paint('green', s),
  yellow: (s: string) => paint('yellow', s),
  blue: (s: string) => paint('blue', s),
  magenta: (s: string) => paint('magenta', s),
  cyan: (s: string) => paint('cyan', s),
  gray: (s: string) => paint('gray', s),
};

export function out(text: string): void {
  process.stdout.write(text);
}

export function line(text = ''): void {
  process.stdout.write(text + '\n');
}

export function errLine(text: string): void {
  process.stderr.write(text + '\n');
}

/** ツール実行やエラーを示すラベル行 */
export function label(kind: 'tool' | 'ok' | 'warn' | 'error' | 'info', text: string): string {
  switch (kind) {
    case 'tool':
      return `${c.magenta('●')} ${text}`;
    case 'ok':
      return `${c.green('✔')} ${text}`;
    case 'warn':
      return `${c.yellow('▲')} ${text}`;
    case 'error':
      return `${c.red('✖')} ${text}`;
    default:
      return `${c.blue('ℹ')} ${text}`;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} 文字省略)`;
}

/** 単一行に収める。改行は ⏎ に畳む。 */
export function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private text = '';
  private active = false;

  start(text: string): void {
    this.text = text;
    if (!process.stdout.isTTY || this.active) {
      this.text = text;
      return;
    }
    this.active = true;
    this.timer = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!;
      this.frame++;
      process.stdout.write(`\r${c.cyan(f)} ${c.dim(this.text)}\x1b[K`);
    }, 80);
    this.timer.unref?.();
  }

  update(text: string): void {
    this.text = text;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active) process.stdout.write('\r\x1b[K');
    this.active = false;
  }
}

/**
 * ターミナル向けの軽量 Markdown レンダラ。
 * コードフェンス・見出し・箇条書き・強調・インラインコードだけを扱う。
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const rendered: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const fence = raw.match(/^\s*```(\S*)/);
    if (fence) {
      inFence = !inFence;
      const lang = fence[1];
      rendered.push(c.dim(inFence && lang ? `┌─ ${lang}` : inFence ? '┌─' : '└─'));
      continue;
    }
    if (inFence) {
      rendered.push(c.dim('│ ') + c.cyan(raw));
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      rendered.push(c.bold(c.yellow(heading[2]!)));
      continue;
    }
    let l = raw;
    l = l.replace(/^(\s*)([-*+])\s+/, (_m, sp: string) => `${sp}${c.blue('•')} `);
    l = l.replace(/`([^`]+)`/g, (_m, code: string) => c.cyan(code));
    l = l.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => c.bold(b));
    rendered.push(l);
  }
  return rendered.join('\n');
}

/**
 * ストリーミング中の Markdown を行単位でレンダリングする。
 * コードフェンスの内外という状態を保持する必要があるため、行が完成するまで出力を保留する。
 */
export class StreamingMarkdown {
  private buffer = '';
  private inFence = false;

  feed(delta: string): string {
    this.buffer += delta;
    let rendered = '';
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      rendered += `${this.renderLine(rawLine)}\n`;
    }
    return rendered;
  }

  /** 未出力のまま残っている分を吐き出す */
  flush(): string {
    if (!this.buffer) return '';
    const rendered = this.renderLine(this.buffer);
    this.buffer = '';
    this.inFence = false;
    return rendered ? `${rendered}\n` : '';
  }

  private renderLine(raw: string): string {
    const fence = raw.match(/^\s*```(\S*)/);
    if (fence) {
      this.inFence = !this.inFence;
      const lang = fence[1];
      return c.dim(this.inFence ? (lang ? `┌─ ${lang}` : '┌─') : '└─');
    }
    if (this.inFence) return c.dim('│ ') + c.cyan(raw);

    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) return c.bold(c.yellow(heading[2]!));

    let l = raw;
    l = l.replace(/^(\s*)([-*+])\s+/, (_m, sp: string) => `${sp}${c.blue('•')} `);
    l = l.replace(/`([^`]+)`/g, (_m, code: string) => c.cyan(code));
    l = l.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => c.bold(b));
    return l;
  }
}

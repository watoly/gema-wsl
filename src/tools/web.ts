import { Type } from '@google/genai';
import { ToolError, type ToolDef } from './types.js';

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

/** HTML をターミナルで読める素のテキストに落とす */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)));
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)));
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m.toLowerCase()] ?? m);
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]!).slice(0, 200) : null;
}

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  risk: 'exec',
  declaration: {
    name: 'web_fetch',
    description:
      'URL の内容を取得してテキストとして返す。HTML はタグを除去して本文だけにする。' +
      'ドキュメントや API リファレンスを確認したいときに使う。http / https のみ。',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: '取得する URL (http または https)' },
        max_chars: { type: Type.INTEGER, description: '返す最大文字数。省略時は設定値。' },
      },
      required: ['url'],
    },
  },
  approval(args, ctx) {
    const raw = String(args['url'] ?? '');
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      host = raw;
    }
    if (ctx.config.allowedWebHosts.includes(host)) return null;
    return {
      tool: 'web_fetch',
      key: `web_fetch:${host}`,
      title: `外部サイトを取得する: ${host}`,
      detail: raw,
    };
  },
  async run(args, ctx) {
    const raw = String(args['url'] ?? '').trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolError(`URL の形式が不正です: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ToolError(`http / https のみ取得できます: ${url.protocol}`);
    }

    const maxChars = Math.max(
      1000,
      Math.min(Number(args['max_chars'] ?? ctx.config.webFetchMaxChars) || ctx.config.webFetchMaxChars, 200_000),
    );

    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([timeout, ctx.signal]);

    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'gema/0.2 (+https://github.com/watoly/gema-wsl)', Accept: '*/*' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort|timeout/i.test(message)) throw new ToolError(`タイムアウトしました: ${url.href}`);
      throw new ToolError(`取得に失敗しました: ${url.href}\n${message}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      throw new ToolError(`HTTP ${response.status} ${response.statusText}: ${url.href}`);
    }
    if (/^(image|audio|video)\//.test(contentType) || contentType.includes('application/pdf')) {
      throw new ToolError(
        `テキストではないコンテンツです (${contentType})。ダウンロードしてから view_media を使ってください。`,
      );
    }

    const body = await response.text();
    const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
    const title = isHtml ? pageTitle(body) : null;
    let text = isHtml ? htmlToText(body) : body;

    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    const header = [
      `URL: ${response.url || url.href}`,
      `Content-Type: ${contentType || '(不明)'}`,
      title ? `Title: ${title}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      output: `${header}\n\n${text}${truncated ? `\n\n… (${maxChars} 文字で打ち切り)` : ''}`,
      summary: `${url.hostname} — ${text.length} 文字${truncated ? ' (打ち切り)' : ''}`,
    };
  },
};

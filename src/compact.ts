import type { Content, GoogleGenAI } from '@google/genai';
import type { GemaConfig } from './config.js';

const MAX_PART_CHARS = 1500;

/** 履歴 1 件を要約用のプレーンテキストに落とす */
function serializeContent(content: Content): string {
  const pieces: string[] = [];
  for (const part of content.parts ?? []) {
    if (part.thought) continue;
    if (part.text) {
      pieces.push(part.text.length > MAX_PART_CHARS ? `${part.text.slice(0, MAX_PART_CHARS)}…` : part.text);
    } else if (part.functionCall) {
      pieces.push(`[ツール呼び出し ${part.functionCall.name} ${JSON.stringify(part.functionCall.args ?? {}).slice(0, 300)}]`);
    } else if (part.functionResponse) {
      const response = JSON.stringify(part.functionResponse.response ?? {});
      pieces.push(`[ツール結果 ${part.functionResponse.name} ${response.slice(0, 400)}]`);
    } else if (part.inlineData) {
      pieces.push(`[添付 ${part.inlineData.mimeType}]`);
    }
  }
  const body = pieces.join('\n').trim();
  return body ? `## ${content.role === 'model' ? 'assistant' : 'user'}\n${body}` : '';
}

/** 履歴のうち「本物のユーザー発言」の位置 (functionResponse だけの user は除く) */
function userTurnIndexes(history: Content[]): number[] {
  const indexes: number[] = [];
  history.forEach((content, i) => {
    if (content.role !== 'user') return;
    const parts = content.parts ?? [];
    if (parts.some((p) => p.functionResponse)) return;
    if (parts.some((p) => p.text || p.inlineData)) indexes.push(i);
  });
  return indexes;
}

export interface CompactOutcome {
  history: Content[];
  summary: string;
  removed: number;
}

/**
 * 会話履歴を要約で置き換える。
 * ツール呼び出しと結果の対応が壊れないよう、切り出しは必ず
 * 「本物のユーザー発言」の直前で行う。要約できなければ null を返す。
 */
export async function compactHistory(
  client: GoogleGenAI,
  config: GemaConfig,
  history: Content[],
  signal?: AbortSignal,
): Promise<CompactOutcome | null> {
  const keep = Math.max(1, config.compactKeepTurns);
  const turns = userTurnIndexes(history);
  if (turns.length <= keep) return null;

  const cut = turns[turns.length - keep]!;
  if (cut <= 0) return null;

  const head = history.slice(0, cut);
  const tail = history.slice(cut);

  const transcript = head.map(serializeContent).filter(Boolean).join('\n\n');
  if (!transcript.trim()) return null;

  const instruction = `以下は、あるコーディング作業の会話ログです。作業を引き継げるように要約してください。

出力する項目:
1. **ユーザーの目的** — 何をしようとしているか
2. **これまでにやったこと** — 調査結果、変更したファイル (パス付き)、実行したコマンドと結果
3. **判明している事実** — 環境、設定値、エラー内容、制約など、後で必要になる具体的な情報
4. **未解決の課題 / 次の一手**

省略しすぎないこと。ファイルパス・関数名・エラーメッセージ・数値はそのまま残してください。
一方で、同じ内容の繰り返しや、既に解決した試行錯誤の過程は削ってください。

--- 会話ログここから ---
${transcript}
--- 会話ログここまで ---`;

  const response = await client.models.generateContent({
    model: config.model,
    contents: [{ role: 'user', parts: [{ text: instruction }] }],
    config: {
      ...(signal ? { abortSignal: signal } : {}),
      thinkingConfig: { thinkingLevel: 'LOW' as never },
    },
  });

  const summary = response.text?.trim();
  if (!summary) return null;

  const newHistory: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text:
            '[これまでの会話の要約です。文脈として踏まえた上で、続きの作業を行ってください。]\n\n' +
            summary,
        },
      ],
    },
    { role: 'model', parts: [{ text: '承知しました。ここまでの経緯を踏まえて続けます。' }] },
    ...tail,
  ];

  return { history: newHistory, summary, removed: head.length };
}

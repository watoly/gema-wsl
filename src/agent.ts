import type { Content, FunctionCall, GenerateContentResponse, GoogleGenAI, Part, ThinkingLevel } from '@google/genai';
import type { ApprovalGate } from './approval.js';
import { explainApiError } from './client.js';
import type { GemaConfig } from './config.js';
import { buildSystemInstruction } from './prompt.js';
import type { SessionLog } from './session.js';
import { getTool, toolDeclarations } from './tools/index.js';
import { ToolError, type ToolContext, type ToolResult } from './tools/types.js';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thought'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; summary: string; isError: boolean; output: string }
  | { type: 'tool_denied'; name: string; reason: string }
  | { type: 'turn_end'; usage: Usage }
  | { type: 'aborted' }
  | { type: 'error'; message: string };

export interface Usage {
  prompt: number;
  output: number;
  thoughts: number;
  total: number;
  requests: number;
}

export interface AgentDeps {
  client: GoogleGenAI;
  config: GemaConfig;
  gate: ApprovalGate;
  root: string;
  cwd: string;
  session: SessionLog | null;
  /** ツール実行中の進捗表示 */
  log: (text: string) => void;
}

const INTERRUPT_NOTE = '[ユーザーによって処理が中断されました。次の指示を待ってください。]';

export class Agent {
  history: Content[] = [];
  usage: Usage = { prompt: 0, output: 0, thoughts: 0, total: 0, requests: 0 };
  private systemInstruction: string;

  constructor(private deps: AgentDeps) {
    this.systemInstruction = buildSystemInstruction(deps.root, deps.cwd, deps.config);
  }

  get config(): GemaConfig {
    return this.deps.config;
  }

  get cwd(): string {
    return this.deps.cwd;
  }

  setCwd(cwd: string): void {
    this.deps.cwd = cwd;
    this.refreshSystemInstruction();
  }

  refreshSystemInstruction(): void {
    this.systemInstruction = buildSystemInstruction(this.deps.root, this.deps.cwd, this.deps.config);
  }

  reset(): void {
    this.history = [];
    this.refreshSystemInstruction();
  }

  loadHistory(contents: Content[]): void {
    this.history = contents;
  }

  private push(content: Content): void {
    this.history.push(content);
    this.deps.session?.appendContent(content);
  }

  /** 1 ターン分のやり取り (ツール呼び出しの往復を含む) をイベントとして流す */
  async *send(parts: Part[], signal: AbortSignal): AsyncGenerator<AgentEvent> {
    this.push({ role: 'user', parts });

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      if (signal.aborted) {
        yield { type: 'aborted' };
        this.push({ role: 'user', parts: [{ text: INTERRUPT_NOTE }] });
        return;
      }

      let stream: AsyncGenerator<GenerateContentResponse>;
      try {
        stream = await this.deps.client.models.generateContentStream({
          model: this.config.model,
          contents: this.history,
          config: {
            systemInstruction: this.systemInstruction,
            tools: [{ functionDeclarations: toolDeclarations() }],
            abortSignal: signal,
            ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
            ...(this.config.maxOutputTokens !== undefined ? { maxOutputTokens: this.config.maxOutputTokens } : {}),
            ...(this.config.thinkingLevel
              ? {
                  thinkingConfig: {
                    thinkingLevel: this.config.thinkingLevel as ThinkingLevel,
                    includeThoughts: this.config.showThoughts,
                  },
                }
              : this.config.showThoughts
                ? { thinkingConfig: { includeThoughts: true } }
                : {}),
          },
        });
      } catch (err) {
        yield { type: 'error', message: explainApiError(this.config, err) };
        return;
      }

      const modelParts: Part[] = [];
      let sawStreamError: string | null = null;
      let lastUsage: GenerateContentResponse['usageMetadata'];

      try {
        for await (const chunk of stream) {
          if (signal.aborted) break;
          if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
          const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of chunkParts) {
            this.mergePart(modelParts, part);
            if (part.text) {
              yield part.thought ? { type: 'thought', delta: part.text } : { type: 'text', delta: part.text };
            }
          }
        }
      } catch (err) {
        if (signal.aborted) {
          // 中断による例外は握りつぶす
        } else {
          sawStreamError = explainApiError(this.config, err);
        }
      }

      this.accountUsage(lastUsage);
      if (modelParts.length > 0) this.push({ role: 'model', parts: modelParts });

      if (signal.aborted) {
        yield { type: 'aborted' };
        this.push({ role: 'user', parts: [{ text: INTERRUPT_NOTE }] });
        return;
      }
      if (sawStreamError) {
        yield { type: 'error', message: sawStreamError };
        return;
      }

      const calls = modelParts
        .map((p) => p.functionCall)
        .filter((fc): fc is FunctionCall => Boolean(fc?.name));

      if (calls.length === 0) {
        yield { type: 'turn_end', usage: this.usage };
        return;
      }

      const responseParts: Part[] = [];
      for (const call of calls) {
        if (signal.aborted) break;
        const name = call.name!;
        const args = (call.args ?? {}) as Record<string, unknown>;
        yield { type: 'tool_call', name, args };

        const outcome = await this.runTool(name, args, signal);
        if (outcome.kind === 'denied') {
          yield { type: 'tool_denied', name, reason: outcome.reason };
          responseParts.push(this.toResponsePart(call, { error: outcome.reason }));
          continue;
        }
        const result = outcome.result;
        yield {
          type: 'tool_result',
          name,
          summary: result.summary ?? result.output.split('\n')[0] ?? '',
          isError: Boolean(result.isError),
          output: result.output,
        };
        responseParts.push(
          this.toResponsePart(call, result.isError ? { error: result.output } : { output: result.output }),
        );
      }

      if (signal.aborted) {
        yield { type: 'aborted' };
        this.push({ role: 'user', parts: [{ text: INTERRUPT_NOTE }] });
        return;
      }
      this.push({ role: 'user', parts: responseParts });
    }

    yield {
      type: 'error',
      message: `ツール実行が ${this.config.maxIterations} 往復に達したため打ち切りました。指示を分割するか、maxIterations を増やしてください。`,
    };
  }

  private toResponsePart(call: FunctionCall, response: Record<string, unknown>): Part {
    return {
      functionResponse: {
        ...(call.id ? { id: call.id } : {}),
        name: call.name!,
        response,
      },
    };
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ kind: 'ok'; result: ToolResult } | { kind: 'denied'; reason: string }> {
    const tool = getTool(name);
    if (!tool) {
      return { kind: 'ok', result: { output: `未知のツールです: ${name}`, isError: true } };
    }

    const ctx: ToolContext = {
      cwd: this.deps.cwd,
      root: this.deps.root,
      config: this.config,
      signal,
      requestApproval: (req) => this.deps.gate.request(req),
      log: this.deps.log,
    };

    try {
      const request = tool.approval ? tool.approval(args, ctx) : null;
      const decision = await this.deps.gate.request(request);
      if (decision === 'deny') {
        return {
          kind: 'denied',
          reason: `ユーザーが ${name} の実行を拒否しました。別のアプローチを検討するか、ユーザーに確認してください。`,
        };
      }
      const result = await tool.run(args, ctx);
      return { kind: 'ok', result };
    } catch (err) {
      if (err instanceof ToolError) {
        return { kind: 'ok', result: { output: `エラー: ${err.message}`, isError: true } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'ok', result: { output: `エラー: ${message}`, isError: true } };
    }
  }

  /**
   * ストリームのチャンクを 1 つの Content に畳み込む。
   * thoughtSignature は Gemini 3 系のツール呼び出しで必須なので、
   * 付いている Part は結合せずそのまま保持する。
   */
  private mergePart(acc: Part[], part: Part): void {
    const last = acc[acc.length - 1];
    const isPlainText =
      part.text !== undefined && !part.functionCall && !part.thoughtSignature && !part.inlineData;
    if (
      isPlainText &&
      last &&
      last.text !== undefined &&
      !last.functionCall &&
      !last.thoughtSignature &&
      Boolean(last.thought) === Boolean(part.thought)
    ) {
      last.text += part.text;
      return;
    }
    acc.push({ ...part });
  }

  /** リクエスト 1 回分の usageMetadata (最終チャンクの累計値) をセッション合計に足す */
  private accountUsage(u: GenerateContentResponse['usageMetadata']): void {
    if (!u) return;
    this.usage.requests += 1;
    this.usage.prompt += u.promptTokenCount ?? 0;
    this.usage.output += u.candidatesTokenCount ?? 0;
    this.usage.thoughts += u.thoughtsTokenCount ?? 0;
    this.usage.total += u.totalTokenCount ?? 0;
  }
}

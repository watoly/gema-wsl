import type {
  Content,
  FunctionCall,
  GenerateContentResponse,
  GoogleGenAI,
  GroundingMetadata,
  Part,
  Tool,
  ThinkingLevel,
} from '@google/genai';
import type { ApprovalGate } from './approval.js';
import { explainApiError } from './client.js';
import { compactHistory } from './compact.js';
import type { GemaConfig } from './config.js';
import type { McpManager } from './mcp.js';
import { buildSystemInstruction } from './prompt.js';
import type { SessionLog } from './session.js';
import { TOOLS } from './tools/index.js';
import { ToolError, type ToolContext, type ToolDef, type ToolResult } from './tools/types.js';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thought'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; summary: string; isError: boolean; output: string }
  | { type: 'tool_denied'; name: string; reason: string }
  | { type: 'grounding'; sources: { title: string; uri: string }[] }
  | { type: 'notice'; message: string }
  | { type: 'compacted'; removed: number; summaryChars: number }
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
  mcp: McpManager | null;
  log: (text: string) => void;
}

const INTERRUPT_NOTE = '[ユーザーによって処理が中断されました。次の指示を待ってください。]';

/** 組み込みツールとカスタム関数の併用が拒否されたことを示すエラーか */
function isToolCombinationError(message: string): boolean {
  return /tool.{0,40}(combination|unsupported|not supported)|unsupported.{0,40}tool|google_?search.{0,40}(unsupported|not supported)|INVALID_ARGUMENT.*tool/i.test(
    message,
  );
}

export class Agent {
  history: Content[] = [];
  usage: Usage = { prompt: 0, output: 0, thoughts: 0, total: 0, requests: 0 };
  private systemInstruction: string;
  /** 直近リクエストの入力トークン数 (自動圧縮の判定に使う) */
  private lastPromptTokens = 0;
  /** 組み込み Google 検索を、このセッションで使えるか */
  private builtinSearchEnabled: boolean;

  constructor(private deps: AgentDeps) {
    this.systemInstruction = buildSystemInstruction(deps.root, deps.cwd, deps.config);
    this.builtinSearchEnabled = deps.config.webSearch !== 'off';
  }

  get config(): GemaConfig {
    return this.deps.config;
  }

  get cwd(): string {
    return this.deps.cwd;
  }

  get searchEnabled(): boolean {
    return this.builtinSearchEnabled;
  }

  setSearchEnabled(value: boolean): void {
    this.builtinSearchEnabled = value;
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
    this.lastPromptTokens = 0;
    this.refreshSystemInstruction();
  }

  loadHistory(contents: Content[]): void {
    this.history = contents;
  }

  /** 組み込みツール + MCP ツールを合わせた一覧 */
  get tools(): ToolDef[] {
    return [...TOOLS, ...(this.deps.mcp?.toolDefs ?? [])];
  }

  private findTool(name: string): ToolDef | undefined {
    return this.tools.find((t) => t.name === name);
  }

  private buildToolList(): Tool[] {
    const tools: Tool[] = [{ functionDeclarations: this.tools.map((t) => t.declaration) }];
    if (this.builtinSearchEnabled) tools.unshift({ googleSearch: {} });
    return tools;
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

      let stream: AsyncGenerator<GenerateContentResponse> | null = null;
      for (let attempt = 0; attempt < 2 && stream === null; attempt++) {
        try {
          stream = await this.deps.client.models.generateContentStream({
            model: this.config.model,
            contents: this.history,
            config: this.requestConfig(signal),
          });
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          if (this.builtinSearchEnabled && this.config.webSearch === 'auto' && isToolCombinationError(raw)) {
            this.builtinSearchEnabled = false;
            yield {
              type: 'notice',
              message:
                '組み込みの Google 検索がこのモデル/バックエンドでは関数呼び出しと併用できないため、' +
                'このセッションでは無効にしました (web_fetch は引き続き使えます)。',
            };
            continue; // 検索なしで一度だけやり直す
          }
          yield { type: 'error', message: explainApiError(this.config, err) };
          return;
        }
      }
      if (stream === null) return;

      const modelParts: Part[] = [];
      let sawStreamError: string | null = null;
      let lastUsage: GenerateContentResponse['usageMetadata'];
      let grounding: GroundingMetadata | undefined;

      try {
        for await (const chunk of stream) {
          if (signal.aborted) break;
          if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
          const candidate = chunk.candidates?.[0];
          if (candidate?.groundingMetadata) grounding = candidate.groundingMetadata;
          for (const part of candidate?.content?.parts ?? []) {
            this.mergePart(modelParts, part);
            if (part.text) {
              yield part.thought ? { type: 'thought', delta: part.text } : { type: 'text', delta: part.text };
            }
          }
        }
      } catch (err) {
        if (!signal.aborted) sawStreamError = explainApiError(this.config, err);
      }

      this.accountUsage(lastUsage);
      if (modelParts.length > 0) this.push({ role: 'model', parts: modelParts });

      const sources = extractSources(grounding);
      if (sources.length > 0) yield { type: 'grounding', sources };

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
      const mediaParts: Part[] = [];

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
        if (result.mediaParts?.length) mediaParts.push(...result.mediaParts);
      }

      if (signal.aborted) {
        yield { type: 'aborted' };
        this.push({ role: 'user', parts: [{ text: INTERRUPT_NOTE }] });
        return;
      }
      this.push({ role: 'user', parts: responseParts });
      // 画像や PDF は functionResponse に入れずに、続く user Content として渡す
      if (mediaParts.length > 0) this.push({ role: 'user', parts: mediaParts });
    }

    yield {
      type: 'error',
      message: `ツール実行が ${this.config.maxIterations} 往復に達したため打ち切りました。指示を分割するか、maxIterations を増やしてください。`,
    };
  }

  private requestConfig(signal: AbortSignal) {
    const config = this.config;
    return {
      systemInstruction: this.systemInstruction,
      tools: this.buildToolList(),
      abortSignal: signal,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
      ...(config.thinkingLevel
        ? {
            thinkingConfig: {
              thinkingLevel: config.thinkingLevel as ThinkingLevel,
              includeThoughts: config.showThoughts,
            },
          }
        : config.showThoughts
          ? { thinkingConfig: { includeThoughts: true } }
          : {}),
    };
  }

  /** 自動圧縮が必要なら実行する。呼び出し側はターン終了後に呼ぶ。 */
  async maybeCompact(signal?: AbortSignal): Promise<{ removed: number; summaryChars: number } | null> {
    if (!this.config.autoCompact) return null;
    if (this.lastPromptTokens < this.config.compactAtTokens) return null;
    return this.compact(signal);
  }

  /** 履歴を要約で置き換える (/compact からも呼ぶ) */
  async compact(signal?: AbortSignal): Promise<{ removed: number; summaryChars: number } | null> {
    const outcome = await compactHistory(this.deps.client, this.config, this.history, signal);
    if (!outcome) return null;
    this.history = outcome.history;
    this.lastPromptTokens = 0;
    this.deps.session?.appendNote(`[compact] ${outcome.removed} メッセージを要約に置き換えました`);
    for (const content of outcome.history.slice(0, 2)) this.deps.session?.appendContent(content);
    return { removed: outcome.removed, summaryChars: outcome.summary.length };
  }

  get promptTokens(): number {
    return this.lastPromptTokens;
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
    const tool = this.findTool(name);
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
    this.lastPromptTokens = u.promptTokenCount ?? this.lastPromptTokens;
  }
}

function extractSources(grounding: GroundingMetadata | undefined): { title: string; uri: string }[] {
  const chunks = grounding?.groundingChunks ?? [];
  const sources: { title: string; uri: string }[] = [];
  for (const chunk of chunks) {
    const web = chunk.web;
    if (web?.uri) sources.push({ title: web.title ?? web.uri, uri: web.uri });
  }
  return sources.slice(0, 8);
}

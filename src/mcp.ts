import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type, type Part, type Schema } from '@google/genai';
import type { GemaConfig, McpServerConfig } from './config.js';
import { ToolError, type ToolDef } from './tools/types.js';
import { expandHome } from './tools/util.js';

const TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
  null: Type.NULL,
};

/**
 * MCP の JSON Schema を Gemini の Schema に変換する。
 * Gemini 側が解釈できないキーワード (oneOf, $ref, additionalProperties など) は落とす。
 */
export function toGeminiSchema(node: unknown): Schema | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const src = node as Record<string, unknown>;

  // anyOf / oneOf は最初の実体を採用する (Gemini は合成スキーマを扱えない)
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = src[key];
    if (Array.isArray(variants) && variants.length > 0) {
      const first = variants.find((v) => (v as Record<string, unknown>)?.['type'] !== 'null') ?? variants[0];
      const converted = toGeminiSchema(first);
      if (converted && typeof src['description'] === 'string') converted.description = src['description'];
      return converted;
    }
  }

  let rawType = src['type'];
  let nullable = false;
  if (Array.isArray(rawType)) {
    nullable = rawType.includes('null');
    rawType = rawType.find((t) => t !== 'null');
  }
  const type = typeof rawType === 'string' ? TYPE_MAP[rawType] : undefined;

  const schema: Schema = {};
  if (type) schema.type = type;
  if (typeof src['description'] === 'string') schema.description = src['description'];
  if (Array.isArray(src['enum'])) schema.enum = src['enum'].map((v) => String(v));
  if (nullable) schema.nullable = true;

  if (type === Type.OBJECT || src['properties']) {
    const props = src['properties'];
    if (props && typeof props === 'object') {
      const converted: Record<string, Schema> = {};
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        const child = toGeminiSchema(value);
        if (child) converted[key] = child;
      }
      if (Object.keys(converted).length > 0) {
        schema.type = Type.OBJECT;
        schema.properties = converted;
      }
    }
    const required = src['required'];
    if (Array.isArray(required)) schema.required = required.map(String);
  }

  if (type === Type.ARRAY) {
    const items = toGeminiSchema(src['items']);
    schema.items = items ?? { type: Type.STRING };
  }

  return Object.keys(schema).length > 0 ? schema : undefined;
}

/** Gemini の関数名に使える文字だけにする */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 128);
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  transport: string;
  toolCount: number;
  error?: string;
}

interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export class McpManager {
  private clients = new Map<string, Client>();
  private statuses: McpServerStatus[] = [];
  private defs: ToolDef[] = [];

  get toolDefs(): ToolDef[] {
    return this.defs;
  }

  get status(): McpServerStatus[] {
    return this.statuses;
  }

  get connectedCount(): number {
    return this.statuses.filter((s) => s.connected).length;
  }

  /** 設定に書かれた全サーバーへ接続し、ツール一覧を取り込む */
  async connectAll(config: GemaConfig, log: (text: string) => void): Promise<void> {
    const entries = Object.entries(config.mcpServers ?? {});
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async ([name, serverConfig]) => {
        if (serverConfig.disabled) {
          this.statuses.push({ name, connected: false, transport: '-', toolCount: 0, error: '無効化されています' });
          return;
        }
        try {
          await this.connectOne(name, serverConfig, log);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.statuses.push({
            name,
            connected: false,
            transport: serverConfig.command ? 'stdio' : 'http',
            toolCount: 0,
            error: message,
          });
          log(`MCP "${name}" に接続できませんでした: ${message}`);
        }
      }),
    );
  }

  private async connectOne(name: string, serverConfig: McpServerConfig, log: (text: string) => void): Promise<void> {
    const client = new Client({ name: 'gema', version: '0.2.0' }, { capabilities: {} });
    const timeoutMs = serverConfig.timeoutMs ?? 30_000;

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    let transportLabel: string;
    // stdio サーバーが起動に失敗したとき、原因は stderr にしか出ないので拾っておく
    let stderrTail = '';

    if (serverConfig.command) {
      transportLabel = 'stdio';
      transport = new StdioClientTransport({
        command: expandHome(serverConfig.command),
        args: serverConfig.args ?? [],
        cwd: serverConfig.cwd ? expandHome(serverConfig.cwd) : undefined,
        env: { ...(process.env as Record<string, string>), ...(serverConfig.env ?? {}) },
        stderr: 'pipe',
      });
    } else if (serverConfig.url) {
      transportLabel = 'http';
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
      });
    } else {
      throw new Error('command か url のどちらかを指定してください');
    }

    // connect() が内部で transport.start() を呼ぶ。start() は同期的にプロセスを spawn するため、
    // await する前にこの行を通せば stderr を最初から拾える。
    const connecting = client.connect(transport);
    (transport as StdioClientTransport).stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000);
    });

    try {
      await withTimeout(connecting, timeoutMs, `${name} への接続がタイムアウトしました`);
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      throw new Error(stderrTail.trim() ? `${base}\n  サーバーの出力: ${stderrTail.trim().split('\n').slice(-5).join(' / ')}` : base);
    }
    const listed = await withTimeout(client.listTools(), timeoutMs, `${name} のツール一覧取得がタイムアウトしました`);

    this.clients.set(name, client);
    for (const tool of listed.tools) {
      this.defs.push(this.buildToolDef(name, tool, timeoutMs));
    }
    this.statuses.push({ name, connected: true, transport: transportLabel, toolCount: listed.tools.length });
    log(`MCP "${name}" に接続しました (${listed.tools.length} ツール)`);
  }

  private buildToolDef(
    server: string,
    tool: { name: string; description?: string; inputSchema?: unknown },
    timeoutMs: number,
  ): ToolDef {
    const fullName = mcpToolName(server, tool.name);
    const parameters = toGeminiSchema(tool.inputSchema) ?? { type: Type.OBJECT, properties: {} };

    return {
      name: fullName,
      risk: 'exec',
      declaration: {
        name: fullName,
        description: `[MCP: ${server}] ${tool.description ?? tool.name}`,
        parameters,
      },
      approval: (args) => ({
        tool: fullName,
        key: `mcp:${server}:${tool.name}`,
        title: `MCP ツールを実行する: ${server} / ${tool.name}`,
        detail: JSON.stringify(args, null, 2).slice(0, 1500),
      }),
      run: async (args, ctx) => {
        const client = this.clients.get(server);
        if (!client) throw new ToolError(`MCP サーバー "${server}" に接続していません`);

        let result: { content?: unknown; isError?: unknown };
        try {
          result = (await withTimeout(
            client.callTool({ name: tool.name, arguments: args }),
            timeoutMs,
            `${server} / ${tool.name} がタイムアウトしました`,
          )) as { content?: unknown; isError?: unknown };
        } catch (err) {
          throw new ToolError(err instanceof Error ? err.message : String(err));
        }
        void ctx;

        const items = Array.isArray(result.content) ? (result.content as McpContentItem[]) : [];
        const texts: string[] = [];
        const mediaParts: Part[] = [];

        for (const item of items) {
          if (item.type === 'text' && typeof item.text === 'string') {
            texts.push(item.text);
          } else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') {
            mediaParts.push({ inlineData: { mimeType: item.mimeType ?? 'image/png', data: item.data } });
            texts.push(`(${item.type} を添付しました)`);
          } else if (item.type === 'resource') {
            texts.push(JSON.stringify(item).slice(0, 4000));
          }
        }

        const output = texts.join('\n').trim() || '(出力なし)';
        return {
          output,
          summary: `${server} / ${tool.name} — ${output.split('\n')[0]?.slice(0, 60) ?? ''}`,
          isError: Boolean(result.isError),
          ...(mediaParts.length > 0 ? { mediaParts } : {}),
        };
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        try {
          await client.close();
        } catch {
          /* 終了時のエラーは無視 */
        }
      }),
    );
    this.clients.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

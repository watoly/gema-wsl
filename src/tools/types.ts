import type { FunctionDeclaration } from '@google/genai';
import type { GemaConfig } from '../config.js';

export type Risk = 'read' | 'write' | 'exec';

export interface ApprovalRequest {
  tool: string;
  /** 承認プロンプトの見出し */
  title: string;
  /** 差分やコマンドなどのプレビュー本文 */
  detail?: string;
  /** セッション許可リストのキー。"always" 選択後は同じキーを自動承認する */
  key: string;
}

export type ApprovalDecision = 'once' | 'always' | 'deny';

export interface ToolContext {
  cwd: string;
  root: string;
  config: GemaConfig;
  signal: AbortSignal;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** ツール実行中の進捗を画面に出す */
  log(text: string): void;
}

export interface ToolResult {
  output: string;
  /** 画面表示用の 1 行サマリ */
  summary?: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  risk: Risk;
  declaration: FunctionDeclaration;
  /** 承認が必要なら ApprovalRequest を返す。不要なら null。 */
  approval?(args: Record<string, unknown>, ctx: ToolContext): ApprovalRequest | null;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** モデルに返して回復させたい種類のエラー */
export class ToolError extends Error {}

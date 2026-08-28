import type { ApprovalDecision, ApprovalRequest } from './tools/types.js';

export type AskFn = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * MITL (Man In The Loop) ゲート。
 * ツール実行前にユーザーの承認を取り、"always" を選んだキーはセッション中記憶する。
 */
export class ApprovalGate {
  private sessionAllow = new Set<string>();

  constructor(
    private ask: AskFn,
    private autoApprove: boolean,
  ) {}

  get auto(): boolean {
    return this.autoApprove;
  }

  setAuto(value: boolean): void {
    this.autoApprove = value;
  }

  get allowlist(): string[] {
    return [...this.sessionAllow].sort();
  }

  clearAllowlist(): void {
    this.sessionAllow.clear();
  }

  async request(req: ApprovalRequest | null): Promise<ApprovalDecision> {
    if (req === null) return 'once';
    if (this.autoApprove) return 'once';
    if (this.sessionAllow.has(req.key)) return 'once';

    const decision = await this.ask(req);
    if (decision === 'always') this.sessionAllow.add(req.key);
    return decision;
  }
}

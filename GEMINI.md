# gema 開発ガイド

WSL/Ubuntu 向けの Gemini コーディングエージェント CLI。TypeScript、Node.js 22 以上、実行時依存は `@google/genai` のみ。

## コマンド

```bash
npm run typecheck   # tsc --noEmit
npm run build       # dist/ へ出力 (bin に実行権限も付与)
node dist/index.js --help
```

変更したら必ず `npm run typecheck` を通すこと。

## 設計上の約束

- **実行時依存を増やさない。** 色は `node:util` の `styleText`、対話は `node:readline/promises`、
  ディレクトリ走査と glob/gitignore は `src/tools/util.ts` に自前実装がある。新しい npm パッケージを足す前に、
  Node 22 の標準機能で足りないか確認すること。
- **API は `client.models.generateContentStream` を使う。** `client.interactions` (NextGen API) は
  Gemini API 専用で Vertex AI では使えないため、両対応を保つ限り採用しない。
- **モデルの返した Part はそのまま履歴に積む。** `thoughtSignature` は Gemini 3 系の function calling で
  必須なので、`Agent.mergePart` はテキスト以外の Part や署名付き Part を結合しない。
- **ツールのエラーは throw ではなく `ToolError`。** `Agent.runTool` がこれを捕まえて
  `functionResponse.error` としてモデルに返し、モデル自身に回復させる。プロセスは落とさない。
- **書き込み・実行系のツールは必ず `approval()` を実装する。** 承認キー (`ApprovalRequest.key`) は
  「a (以後自動実行)」の単位になるので、粒度を考えて決めること。
- **パスは必ず `resolvePath()` を通す。** ワークスペース外へのアクセスをここで一括して弾いている。

## ファイルの役割

| パス | 役割 |
| --- | --- |
| `src/index.ts` | CLI 引数、ワークスペース root の決定、非対話モード |
| `src/repl.ts` | 対話ループ、スラッシュコマンド、承認 UI、Tab 補完 |
| `src/agent.ts` | エージェントループ。ストリーム畳み込みとツール往復 |
| `src/config.ts` | 設定の階層マージ (CLI > env > プロジェクト > ユーザー > 既定) |
| `src/tools/` | ツール実装。`index.ts` の `TOOLS` に登録すると自動でモデルに公開される |

## ツールを追加するとき

1. `src/tools/` に `ToolDef` を実装する (`declaration.parameters` は `Type` enum を使った Schema 形式)。
2. `src/tools/index.ts` の `TOOLS` に追加する。宣言は自動でモデルへ渡る。
3. 書き込み・実行を伴うなら `approval()` を実装する。
4. `src/prompt.ts` の「動作原則」に、使い分けの指針を 1 行足すか検討する。

## 動作確認

API キーなしで確認できる範囲:

```bash
node dist/index.js --help
printf '/tools\n/config\n/exit\n' | GEMINI_API_KEY=dummy node dist/index.js --no-session
```

ツール単体やエージェントループは `client.models.generateContentStream` をモックすれば
API キーなしで検証できる (会話ログの `scratchpad/agenttest.mjs` が参考になる)。

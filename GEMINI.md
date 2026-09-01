# gema 開発ガイド

WSL/Ubuntu 向けの Gemini コーディングエージェント CLI。TypeScript、Node.js 22 以上。
実行時依存は `@google/genai` / `@modelcontextprotocol/sdk` / `google-auth-library` の 3 つだけ
(`google-auth-library` は @google/genai の依存でもあり、テレメトリの ADC 認証に直接使っている)。

## コマンド

```bash
npm run typecheck   # tsc --noEmit
npm run build       # dist/ へ出力 (bin に実行権限も付与)
node dist/index.js --help
```

変更したら必ず `npm run typecheck` を通すこと。

**package.json の version を上げたら、必ず package-lock.json も同期すること。**

```bash
npm install --package-lock-only   # lock の version 行を追従させる
```

これを忘れると、利用者の環境で `npm install` がロックファイルを書き換え、次の `git pull` が
`your local changes would be overwritten by merge` で止まる。`install.sh` は
`npm ci` (ロックを書き換えない) を使うようにしてあるが、ロックと package.json が
食い違っていると `npm ci` 自体が失敗して `npm install` にフォールバックしてしまう。

## 設計上の約束

- **実行時依存を増やさない。** 色は `node:util` の `styleText`、対話は `node:readline/promises`、
  HTTP は global `fetch`、ディレクトリ走査と glob/gitignore は `src/tools/util.ts` に自前実装がある。
  新しい npm パッケージを足す前に、Node 22 の標準機能で足りないか確認し、必要ならユーザーに相談すること。
  (`@modelcontextprotocol/sdk` は、ローカル stdio の MCP サーバーに対応するため合意の上で追加した)
- **API は `client.models.generateContentStream` を使う。** `client.interactions` (NextGen API) は
  Gemini API 専用で Vertex AI では使えないため、両対応を保つ限り採用しない。
- **既定の認証は Vertex AI + ADC。** 参考元の gem-agent と揃えてある。API キー (`apikey`) は
  GCP なしで試すための副モード。認証方式を明示していないときだけ、材料が揃っている方へ自動で倒す
  (`loadConfig` の `explicitAuth` 判定)。この自動フォールバックを明示指定にまで及ぼさないこと。
- **モデルの返した Part はそのまま履歴に積む。** `thoughtSignature` は Gemini 3 系の function calling で
  必須なので、`Agent.mergePart` はテキスト以外の Part や署名付き Part を結合しない。
- **ツールのエラーは throw ではなく `ToolError`。** `Agent.runTool` がこれを捕まえて
  `functionResponse.error` としてモデルに返し、モデル自身に回復させる。プロセスは落とさない。
- **書き込み・実行系のツールは必ず `approval()` を実装する。** 承認キー (`ApprovalRequest.key`) は
  「a (以後自動実行)」の単位になるので、粒度を考えて決めること。
- **パスは必ず `resolvePath()` を通す。** ワークスペース外へのアクセスをここで一括して弾いている。
- **画像などは `functionResponse` に入れない。** `FunctionResponsePart` はバックエンドによって扱いが違うため、
  ツールは `ToolResult.mediaParts` に載せ、`Agent` が functionResponse とは別の user Content として積む。
- **組み込みツールとの併用は失敗しうる前提で書く。** `googleSearch` は Gemini 3 系でしか関数呼び出しと
  併用できず、バックエンドによっては拒否される。`webSearch: 'auto'` のときは
  `isToolCombinationError()` で検知し、検索を外して 1 度だけ自動リトライする。
- **圧縮の切り出しは「本物のユーザー発言」の直前でのみ行う。** 途中で切ると functionCall と
  functionResponse の対応が壊れて API に弾かれる (`src/compact.ts` の `userTurnIndexes`)。
- **MCP の JSON Schema はそのまま渡さない。** `toGeminiSchema()` で変換し、Gemini が解釈できない
  `$ref` / `additionalProperties` / 合成スキーマは落とすこと。
- **テレメトリはエージェント本体を止めない。** `Telemetry.event()` は同期で積むだけ、送信は非同期。
  送信に失敗したら警告を出して自身を停止する (再試行して詰まらせない)。唯一の例外は起動時の
  検証で、ここは既定で fail-closed (`telemetry.failOpen: false`) にして起動を中止する。
- **テレメトリに新しい項目を足すときは `redact()` を通す。** `event()` が自動で通すので、
  payload に生の値を入れてよい。`api_key` / `token` / `secret` 等のキーは自動でマスクされる。
  プロンプト本文は `telemetry.logPrompts` が true のときだけ載せること。
- **入れ子の設定オブジェクトは `loadConfig` で個別にマージする。** 浅いマージだと部分指定で
  既定値が消える (`telemetry` がその例)。新しく入れ子の設定を足すときは同じ扱いにすること。

## ファイルの役割

| パス | 役割 |
| --- | --- |
| `src/index.ts` | CLI 引数、ワークスペース root の決定、非対話モード |
| `src/repl.ts` | 対話ループ、スラッシュコマンド、承認 UI、Tab 補完 |
| `src/agent.ts` | エージェントループ。ストリーム畳み込みとツール往復 |
| `src/config.ts` | 設定の階層マージ (CLI > env > プロジェクト > ユーザー > 既定)、認証方式の決定、gcloud 既定プロジェクトの検出 |
| `src/tools/` | ツール実装。`index.ts` の `TOOLS` に登録すると自動でモデルに公開される |
| `src/mcp.ts` | MCP クライアント。接続したサーバーのツールを `ToolDef` に変換する |
| `src/compact.ts` | 会話履歴の要約圧縮 |
| `src/sandbox.ts` | bubblewrap の引数組み立て。`run_command` から使う |
| `src/media.ts` | 画像・PDF などの inlineData 化 |
| `src/telemetry.ts` | Cloud Logging への送信。ADC 認証、バッチ、秘匿値のマスク |

## ツールを追加するとき

1. `src/tools/` に `ToolDef` を実装する (`declaration.parameters` は `Type` enum を使った Schema 形式)。
2. `src/tools/index.ts` の `TOOLS` に追加する。宣言は自動でモデルへ渡る。
3. 書き込み・実行を伴うなら `approval()` を実装する。
4. `src/prompt.ts` の「動作原則」に、使い分けの指針を 1 行足すか検討する。

## 動作確認

API キーなしで確認できる範囲:

```bash
node dist/index.js --help
printf '/tools\n/config\n/auth\n/exit\n' \
  | GEMINI_API_KEY=dummy node dist/index.js --auth apikey --no-session
```

認証方式の解決ロジックを変えたときは、最低限この 5 通りを確認すること:
何も設定なし / `GEMINI_API_KEY` のみ / `--auth vertex` 明示 + キーあり / `--project` 指定 /
`--auth apikey` + キーなし。

ツール単体やエージェントループは `client.models.generateContentStream` をモックすれば
API キーなしで検証できる。サンドボックス・MCP・圧縮・メディアはすべてモックなしで検証できる:

- サンドボックス: `sandbox` を切り替えて `run_command` でワークスペース外への書き込みが弾かれるか
- MCP: `@modelcontextprotocol/sdk` の `McpServer` で最小の stdio サーバーを書いて接続する
  (**サーバースクリプトは node_modules を解決できる場所に置くこと**。scratchpad に置くと
  `ERR_MODULE_NOT_FOUND` になる)
- 圧縮: `loadHistory()` で作った履歴に `compact()` を掛け、functionCall/functionResponse の
  断片が残っていないことと、先頭が user であることを確認する
- テレメトリ: `Telemetry` を作って `auth` / `project` を差し替え、`globalThis.fetch` を
  モックすれば GCP なしでリクエストの中身・バッチ・失敗時の停止を検証できる。
  エラーの対処手順は `explain()` に各種メッセージを渡して確認する

# gema

WSL (Ubuntu) のターミナルで動く、Gemini を使った対話型コーディングエージェント CLI。

[nlink-jp/gem-agent](https://github.com/nlink-jp/gem-agent) を参考に、あちらが Go 製・macOS (Apple Silicon) 向けなのに対して
**Node.js/TypeScript 製・WSL/Linux 向け**として作り直したものです。
認証は gem-agent と同じ **Vertex AI + ADC (`gcloud auth application-default login`) が既定**で、
GCP を用意せず手軽に試したいとき用に Gemini API キーへ切り替えることもできます。

```
❯ src/ 以下の型エラーを直して

● read_file(src/agent.ts)
  ⎿ src/agent.ts (285 行)
● run_command(npx tsc --noEmit)
  ⎿ npx tsc --noEmit → exit 1
● edit_file(src/agent.ts)
  ⎿ src/agent.ts を編集 (1 箇所)

## 完了
`src/agent.ts:97` の thinkingLevel を SDK の enum 型にキャストしました。
```

## 必要環境

- WSL2 上の Ubuntu (素の Linux / macOS でも動きます)
- Node.js 22 以上
- 以下のどちらかの認証
  - **Vertex AI + ADC (既定)** — GCP プロジェクト + `gcloud auth application-default login`
  - **Gemini API キー** — [Google AI Studio](https://aistudio.google.com/apikey) で発行。GCP 不要・無料枠あり

Node.js が未導入なら:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

gcloud CLI が未導入なら:

```bash
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli
```

## インストール

```bash
git clone https://github.com/watoly/gema-wsl.git ~/gema-wsl
cd ~/gema-wsl
./install.sh
```

`install.sh` は `npm install` → `npm run build` → `npm link` を実行し、`gema` コマンドを PATH に登録します。

> `npm link` が権限エラーになる場合は、グローバル prefix をホーム配下に変更してください。
> ```bash
> npm config set prefix ~/.local
> echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
> ```

## 認証の設定

### A. Vertex AI + ADC (既定 / gem-agent と同じ方式)

```bash
gcloud auth application-default login --no-launch-browser
gcloud config set project <your-project-id>
gcloud services enable aiplatform.googleapis.com
```

これだけで `gema` が使えます。**プロジェクト ID は `gcloud config get-value project` から自動で引き継ぐ**ため、
環境変数も設定ファイルも書く必要はありません。

gcloud の既定と別のプロジェクトを使いたい場合だけ、明示してください。

```bash
gema --project <other-project-id>          # 一時的に
echo 'GOOGLE_CLOUD_PROJECT=<id>' >> ~/.config/gema/.env   # 恒久的に
```

ロケーションの既定は `global` です。Gemini 3 系は `global` が必須、2.5 系なら `--location us-central1` のような
地域指定もできます (この扱いは gem-agent と同じです)。

必要な IAM ロールは `roles/aiplatform.user` です。

### B. Gemini API キー (GCP を使わない簡易モード)

[Google AI Studio](https://aistudio.google.com/apikey) でキーを発行して:

```bash
mkdir -p ~/.config/gema
cat > ~/.config/gema/.env <<'EOF'
GOOGLE_GENAI_USE_VERTEXAI=false
GEMINI_API_KEY=AIza...
EOF
chmod 600 ~/.config/gema/.env
```

一時的に切り替えるだけなら `gema --auth apikey` でも構いません。
プロジェクトごとに変えたい場合は、そのディレクトリ直下の `.env` が優先されます
(`.env` は `.gitignore` に入れてください)。

### 切り替えの優先順位

`--auth` / `--project` → `GOOGLE_GENAI_USE_VERTEXAI` → `.gema/config.json` → `~/.config/gema/config.json` → 既定 (vertex)。

どこでも明示していない場合に限り、材料が揃っている方へ自動で倒します
(GCP プロジェクトが見つからず `GEMINI_API_KEY` だけある → API キーモード、など)。
現在の接続先は起動時のヘッダーか `/auth` で確認できます。

## 使い方

```bash
gema                          # 対話モード
gema -p "READMEを日本語に直して"   # 1 回だけ実行して終了
cat spec.md | gema -p         # 標準入力を指示として渡す
gema -C ~/work/myapp          # 作業ディレクトリを指定して起動
gema --continue               # 直前のセッションを復元して起動
gema --model gemini-3.1-pro-preview
gema --auth apikey            # 一時的に API キーモードで起動
gema --sandbox                # run_command を隔離して起動
gema --sandbox read-only --no-network
gema --no-web-search --no-mcp # 組み込み検索と MCP を切って起動
```

入力中に `@src/foo.ts` と書くと、そのファイルの内容が自動で添付されます (Tab で補完できます)。

`Ctrl+C` は実行中の処理の中断、待機中に 2 回押すと終了です。

### スラッシュコマンド

| コマンド | 内容 |
| --- | --- |
| `/help` | コマンド一覧 |
| `/clear` | 会話履歴をリセット |
| `/model [id]` | モデルの表示・変更 |
| `/models` | モデル候補の一覧 |
| `/auth` | 認証方式と接続先 |
| `/config` | 現在の設定を全部表示 |
| `/tools` | 利用可能なツール一覧 (MCP 含む) |
| `/mcp` | MCP サーバーの接続状況 |
| `/sandbox [mode]` | サンドボックスの表示・切替 |
| `/search [on\|off]` | 組み込み Google 検索の切替 |
| `/compact` | 会話履歴を要約して圧縮 |
| `/context` | 読み込んだプロジェクト指示ファイル |
| `/cwd [dir]` | カレントディレクトリの表示・変更 |
| `/cost` | このセッションのトークン使用量 |
| `/yolo` | 承認ゲートの ON/OFF |
| `/allow` | 自動承認中のキー一覧 |
| `/sessions` `/resume [n]` | セッションの一覧・復元 |
| `/history` | 会話履歴の概要 |
| `/init` | このリポジトリ用の `GEMINI.md` をエージェントに書かせる |
| `/exit` | 終了 |

## ツールと承認ゲート

エージェントが使えるツール:

| ツール | 種別 | 内容 |
| --- | --- | --- |
| `read_file` | read | 行番号つきでファイルを読む |
| `list_dir` | read | ディレクトリ一覧 |
| `glob` | read | ファイル名で検索 (`**/*.ts` など) |
| `grep` | read | 中身を正規表現で検索 (ripgrep があれば使用) |
| `view_media` | read | 画像・PDF・音声・動画をモデルに直接読ませる |
| `edit_file` | write | 文字列置換による部分編集 |
| `write_file` | write | 新規作成・全文上書き |
| `run_command` | exec | bash でコマンド実行 (サンドボックス可) |
| `web_fetch` | exec | URL を取得して本文をテキスト化 |

これに加えて、Gemini 組み込みの **Google 検索**（サーバー側実行）と、設定した **MCP サーバーのツール**が同じ一覧に並びます (`/tools` で確認)。

**write / exec 系は実行前に必ず承認を求めます。**

```
▲ ファイルを編集する: src/agent.ts
  - thinkingLevel: this.config.thinkingLevel,
  + thinkingLevel: this.config.thinkingLevel as ThinkingLevel,
  [y] 実行   [a] 以後このセッションでは自動実行   [n] 拒否
  >
```

- `a` を選ぶと、同じキー (`edit_file:src/agent.ts` など) はそのセッション中スキップされます。`/allow` で確認できます。
- `--yolo` / `/yolo` で承認ゲートを丸ごと外せます。信用できる作業のときだけ使ってください。
- `allowCommands` に載っているコマンド (`ls`, `cat`, `git` など) は、リダイレクトやコマンド置換を含まなければ承認なしで実行されます。
- `denyCommands` (`sudo`, `dd`, `mkfs` など) は承認しても実行されません。
- ファイル操作はワークスペース (git リポジトリのルート、なければ起動ディレクトリ) の外に出られません。`allowOutsideWorkspace: true` で解除できます。

非対話モード (`-p`) では承認プロンプトを出せないため、write / exec 系は既定で拒否されます。許可するなら `--yolo` を付けてください。

## 画像・PDF・音声・動画

`@` で添付するか、エージェント自身に `view_media` を使わせることで、テキスト以外のファイルを読ませられます。

```
❯ このエラー画面の原因は？ @screenshot.png
  添付: screenshot.png [画像 248KB]

❯ 仕様書の3章を実装して @docs/spec.pdf
```

対応形式は png / jpg / webp / gif / heic、pdf、mp3 / wav / aac / ogg / flac、mp4 / mov / webm など。
既定の上限は 15MB（`maxMediaBytes`）で、どちらのバックエンドでも同じに動くよう常にインラインで送ります。

## Web 検索と取得

- **`web_fetch`** — 任意の URL を取得して HTML をテキスト化します。承認はホスト単位（`a` を選ぶとそのドメインは以後自動許可）。
  よく使うドメインは `allowedWebHosts` に入れておけば承認なしになります。
- **組み込み Google 検索** — Gemini のサーバー側検索です。使われた場合は回答のあとに出典 URL が並びます。

組み込み検索とカスタム関数の併用は Gemini 3 系でのみ可能で、バックエンドによっては拒否されます。
既定の `webSearch: "auto"` では、拒否されたことを検知するとその場で検索を外して自動的にやり直し、
以降そのセッションでは無効のまま続けます（`web_fetch` は影響を受けません）。`/search on|off` で手動切替もできます。

## コンテキストの自動圧縮

会話が長くなると、直近リクエストの入力トークンが `compactAtTokens`（既定 15 万）を超えた時点で履歴を要約に置き換えます。

- 要約は「目的 / やったこと / 判明している事実 / 次の一手」の構成で、ファイルパスやエラー文はそのまま残します
- 末尾の `compactKeepTurns` ターン（既定 2）はそのまま保持します
- 切り出しは必ず**本物のユーザー発言の直前**で行うので、ツール呼び出しと結果の対応が壊れません

`/compact` で任意のタイミングで実行、`--no-compact` で自動圧縮を切れます。

## サンドボックス

`run_command` を [bubblewrap](https://github.com/containers/bubblewrap) で隔離できます。

```bash
sudo apt-get install -y bubblewrap    # 未導入なら
gema --sandbox                        # = workspace-write
```

| モード | 書き込み可能 | 用途 |
| --- | --- | --- |
| `off` (既定) | 制限なし | 通常の開発 |
| `workspace-write` | ワークスペース + `/tmp` + `sandboxWritablePaths` | 見慣れないコードを動かすとき |
| `read-only` | `/tmp` + `sandboxWritablePaths` | 調査だけさせるとき |

ファイルシステム全体は読み取り専用でマウントされるので、参照はできますが書き換えはできません。
`--no-network` を付けるとサンドボックス内からネットワークにも出られなくなります。
`npm install` などがキャッシュを書けるよう、`~/.npm` と `~/.cache` は既定で書き込み可にしてあります（`sandboxWritablePaths`）。

`/sandbox` で現在の状態、`/sandbox read-only` のように切り替えられます。

## MCP サーバー

ローカルの stdio サーバーとリモートの Streamable HTTP サーバーの両方に対応しています。
接続したサーバーのツールは `mcp__<サーバー名>__<ツール名>` という名前で、組み込みツールと同じように使われます。

`.gema/config.json`（またはユーザー設定）に書きます。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/projects"]
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

- MCP ツールは外部プロセス・外部サービスを呼ぶため、**既定で毎回承認を求めます**（`a` でサーバー+ツール単位の自動承認）
- 起動に失敗したサーバーがあっても、他のサーバーと本体の動作には影響しません。原因は `/mcp` で確認できます
  （stdio サーバーの標準エラー出力も表示されます）
- 一時的に全部切るなら `--no-mcp`、個別に切るなら設定の `"disabled": true`

## 設定ファイル

優先順位: **CLI 引数 > 環境変数 > `<プロジェクト>/.gema/config.json` > `~/.config/gema/config.json` > 既定値**

```bash
cp .gema/config.example.json .gema/config.json   # プロジェクト単位
# または
mkdir -p ~/.config/gema && cp .gema/config.example.json ~/.config/gema/config.json
```

主な環境変数:

| 変数 | 意味 |
| --- | --- |
| `GOOGLE_GENAI_USE_VERTEXAI` | `false` で API キーモードに切替 (既定は Vertex AI) |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI の宛先 (未設定なら gcloud の既定を使用) |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API キー |
| `GEMA_MODEL` | 既定モデル |
| `GEMA_THINKING` | `MINIMAL` / `LOW` / `MEDIUM` / `HIGH` |

## プロジェクト指示ファイル

作業ディレクトリに `GEMINI.md` / `AGENTS.md` / `CLAUDE.md` / `.gema/instructions.md` があれば、
起動時にシステムプロンプトへ取り込みます (`/context` で確認)。
既存プロジェクトの `CLAUDE.md` をそのまま使えるので、Claude Code との併用や乗り換えができます。

まだ無ければ `/init` でエージェントに書かせられます。

## セッション

すべての会話は JSONL で `~/.local/share/gema/sessions/<作業ディレクトリ>/` に保存されます。

```bash
gema --sessions      # 一覧
gema --continue      # 直前のセッションを復元
gema --resume 3      # 3 番目を復元
gema --no-session    # 保存しない
```

## WSL でのトラブルシューティング

**ネットワークに繋がらない** — WSL の DNS 設定を確認してください。

```bash
cat /etc/resolv.conf          # nameserver が入っているか
# 企業プロキシ配下なら
export HTTPS_PROXY=http://proxy.example.com:8080
```

**`/mnt/c/...` の作業が極端に遅い** — Windows 側ファイルシステムへの I/O は遅いです。
リポジトリは WSL 側 (`~/` 配下) に置いてください。

**`install.sh` で「Node.js が見つかりません」と出る** — `install.sh` は `~/.bashrc` を読まないため、
nvm / fnm で入れた Node は PATH に無いことがあります。スクリプト側で `nvm.sh` を自動で読み込むように
してありますが、それでも見つからない場合はメッセージに出る PATH と探索先を確認してください。

- `sudo ./install.sh` は使わないでください。sudo は PATH を差し替えるため nvm の Node が見えなくなります
  (スクリプトが検知して止めます)。
- nvm を使っているなら、新しいシェルを開くか `source ~/.nvm/nvm.sh && nvm use 22` の後に再実行してください。

**`gema: command not found`** — `npm link` の prefix が PATH に入っていません。

```bash
npm config get prefix         # 出たパスの bin が PATH にあるか確認
```

nvm を使っている場合は、`npm link` 後に新しいシェルを開けば有効になります。

**`Could not load the default credentials`** — ADC が未設定か期限切れです。

```bash
gcloud auth application-default login --no-launch-browser
```

**`Vertex AI を使う GCP プロジェクトが特定できません`** — gcloud の既定プロジェクトが未設定です。

```bash
gcloud config set project <your-project-id>
gcloud config get-value project    # 反映を確認
```

**`PERMISSION_DENIED` / `403`** — Vertex AI API が無効か、ロールが足りません。

```bash
gcloud services enable aiplatform.googleapis.com
# 必要なロール: roles/aiplatform.user
```

## 開発

```bash
npm run typecheck   # 型チェック
npm run build       # dist/ にビルド
npm run dev         # ビルドして起動
```

構成:

```
src/
├── index.ts        CLI 引数のパース、起動
├── repl.ts         対話ループ、スラッシュコマンド、承認 UI、補完
├── agent.ts        エージェントループ (ストリーミング + ツール往復)
├── client.ts       GoogleGenAI クライアント生成、エラーの翻訳
├── config.ts       設定の読み込みと検証
├── prompt.ts       システムプロンプトの組み立て
├── approval.ts     MITL 承認ゲート
├── session.ts      JSONL セッションログ
├── mentions.ts     @file の展開 (テキスト / メディア)
├── media.ts        画像・PDF などの inlineData 化
├── mcp.ts          MCP クライアント、JSON Schema → Gemini Schema 変換
├── compact.ts      会話履歴の要約圧縮
├── sandbox.ts      bubblewrap によるコマンド隔離
├── ui.ts           色・スピナー・ストリーミング Markdown
└── tools/          read_file / list_dir / glob / grep / view_media
                    edit_file / write_file / run_command / web_fetch
```

## 現在の対応範囲

対話 REPL、ストリーミング応答、ファイル操作・検索・シェル実行、承認ゲート、セッション保存と復元、
スラッシュコマンド、Tab 補完、`@file` 添付、プロジェクト指示ファイル、Vertex AI (既定) と API キーの切り替え、
Web 検索・取得、マルチモーダル入力 (画像 / PDF / 音声 / 動画)、MCP サーバー連携 (stdio + リモート HTTP)、
コンテキストの自動圧縮、bubblewrap によるサンドボックス実行。

参考にした gem-agent との主な違いは、動作環境 (WSL/Linux 対応)、実装言語 (Go → TypeScript)、
サンドボックスの方式 (Seatbelt → bubblewrap)、そして API キー認証にも対応している点です。

## ライセンス

MIT

#!/usr/bin/env bash
# WSL (Ubuntu) 上に gema をインストールする
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。以下でインストールしてください:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 以上が必要です (現在: $(node -v))" >&2
  exit 1
fi

echo "==> 依存パッケージをインストール"
npm install

echo "==> ビルド"
npm run build

echo "==> gema コマンドを PATH に登録 (npm link)"
if ! npm link 2>/dev/null; then
  echo "npm link に失敗しました。sudo なしで使える prefix を設定してから再実行してください:" >&2
  echo "  npm config set prefix ~/.local" >&2
  echo '  export PATH="$HOME/.local/bin:$PATH"   # ~/.bashrc に追記' >&2
  exit 1
fi

echo
echo "完了しました。"
echo

CONFIG_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/gema/.env"

if command -v gcloud >/dev/null 2>&1; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
    echo "次に Vertex AI の認証を済ませてください:"
    echo "  gcloud auth application-default login --no-launch-browser"
    echo "  gcloud config set project <your-project-id>"
    echo "  gcloud services enable aiplatform.googleapis.com"
    echo
  else
    echo "gcloud の既定プロジェクト: $PROJECT"
    if [ ! -f "$HOME/.config/gcloud/application_default_credentials.json" ]; then
      echo "ADC が未設定です。以下を実行してください:"
      echo "  gcloud auth application-default login --no-launch-browser"
      echo
    fi
  fi
else
  echo "gcloud CLI が見つかりません。既定の Vertex AI モードには gcloud が必要です:"
  echo "  https://cloud.google.com/sdk/docs/install#deb"
  echo
  echo "GCP を使わず API キーで手軽に始める場合:"
  echo "  mkdir -p \"$(dirname "$CONFIG_ENV")\""
  echo "  printf 'GOOGLE_GENAI_USE_VERTEXAI=false\\nGEMINI_API_KEY=<AI Studio のキー>\\n' > \"$CONFIG_ENV\""
  echo
fi

echo "使い方:  gema          (対話モード)"
echo "         gema --help   (オプション一覧)"
echo "         gema /auth    (起動後に接続先を確認)"

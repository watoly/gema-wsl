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
if [ ! -f .env ] && [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/gema/.env" ]; then
  echo "次に API キーを設定してください:"
  echo "  mkdir -p ~/.config/gema"
  echo "  echo 'GEMINI_API_KEY=<https://aistudio.google.com/apikey で発行したキー>' > ~/.config/gema/.env"
  echo
fi
echo "使い方:  gema          (対話モード)"
echo "         gema --help   (オプション一覧)"

#!/usr/bin/env bash
# WSL (Ubuntu) 上に gema をインストールする
set -euo pipefail

cd "$(dirname "$0")"

REQUIRED_MAJOR=22

warn() { printf '%s\n' "$*" >&2; }

# ── sudo 実行を止める ──────────────────────────────────────────
# sudo は PATH を secure_path に差し替えるため nvm/fnm の node が見えなくなり、
# 通っても npm link が root 所有でインストールされてしまう。
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  warn "sudo を付けずに実行してください:  ./install.sh"
  warn ""
  warn "sudo は PATH を差し替えるため nvm 等で入れた Node.js が見えなくなり、"
  warn "インストールも root 所有になってしまいます。"
  exit 1
fi

# ── Node.js のバージョンマネージャを読み込む ───────────────────
# ./install.sh は ~/.bashrc を読まないため、nvm/fnm の node は PATH に無いことがある。
if ! command -v node >/dev/null 2>&1 && ! command -v nodejs >/dev/null 2>&1; then
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -s "$NVM_SH" ]; then
    echo "==> PATH に node が無いため nvm を読み込みます (${NVM_SH})"
    # nvm.sh は set -eu 下で落ちることがあるので一時的に解除する
    set +eu
    # shellcheck disable=SC1090
    . "$NVM_SH" >/dev/null 2>&1
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
    set -eu
  fi
fi

if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
  echo "==> fnm の環境を読み込みます"
  set +eu
  eval "$(fnm env 2>/dev/null)"
  set -eu
fi

# ── node を特定する (Debian 系は nodejs という名前のことがある) ──
NODE_BIN=""
for candidate in node nodejs; do
  if command -v "$candidate" >/dev/null 2>&1; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  warn "Node.js が見つかりません。"
  warn ""
  warn "  探した場所:"
  warn "    - PATH 上の node / nodejs"
  warn "    - ${NVM_DIR:-$HOME/.nvm}/nvm.sh (nvm)"
  warn "    - fnm"
  warn "  現在の PATH: $PATH"
  warn ""
  warn "すでに nvm で Node.js を入れている場合は、新しいシェルを開くか次を実行してから再試行してください:"
  warn "    source \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\" && nvm use $REQUIRED_MAJOR"
  warn ""
  warn "未インストールの場合は、どちらかの方法で入れてください:"
  warn "  A) nvm (sudo 不要・バージョン切替が楽)   https://github.com/nvm-sh/nvm"
  warn "       nvm install $REQUIRED_MAJOR"
  warn "  B) NodeSource (システム全体に導入)"
  warn "       curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_MAJOR}.x | sudo -E bash -"
  warn "       sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  warn "Node.js $REQUIRED_MAJOR 以上が必要です (現在: v${NODE_VERSION} — $(command -v "$NODE_BIN"))"
  warn ""
  warn "nvm を使っているなら:  nvm install $REQUIRED_MAJOR && nvm alias default $REQUIRED_MAJOR"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  warn "npm が見つかりません (node: $(command -v "$NODE_BIN"))"
  warn "Debian/Ubuntu のパッケージで node だけ入れた場合は npm も入れてください:"
  warn "    sudo apt-get install -y npm"
  exit 1
fi

echo "==> node $(command -v "$NODE_BIN") (v${NODE_VERSION})"
echo "==> npm  $(command -v npm) (v$(npm -v))"
echo

echo "==> 依存パッケージをインストール"
# npm ci は package-lock.json を書き換えないため、次回の git pull を壊さない。
# ロックファイルが package.json と食い違っている場合だけ npm install に落とす。
if [ -f package-lock.json ]; then
  if ! npm ci; then
    warn ""
    warn "npm ci に失敗したため npm install で再試行します"
    warn "(package-lock.json が更新され、次回の git pull で競合する場合があります)"
    warn ""
    npm install
  fi
else
  npm install
fi

echo "==> ビルド"
npm run build

echo "==> gema コマンドを PATH に登録 (npm link)"
if ! npm link 2>/dev/null; then
  warn "npm link に失敗しました。sudo なしで使える prefix を設定してから再実行してください:"
  warn "  npm config set prefix ~/.local"
  warn '  export PATH="$HOME/.local/bin:$PATH"   # ~/.bashrc に追記'
  exit 1
fi

if ! command -v gema >/dev/null 2>&1; then
  warn ""
  warn "npm link は成功しましたが gema が PATH 上に見つかりません。"
  warn "  npm config get prefix   # ここで表示されるパスの bin を PATH に追加してください"
  warn "nvm を使っている場合は、新しいシェルを開けば有効になります。"
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

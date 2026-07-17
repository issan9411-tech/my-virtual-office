#!/bin/sh
# Claude Code トークンダッシュボード起動スクリプト (macOS / Linux)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js が見つかりません。https://nodejs.org/ からインストールしてください。"
    exit 1
fi
echo "http://localhost:4545 をブラウザで開いてください"
exec node server.js

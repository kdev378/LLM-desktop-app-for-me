#!/usr/bin/env bash
# 実機のローカルLLMに対して、Akari が想定どおり動くかを一通り確かめる。
#
#   bash tools/verify-local-llm.sh [ベースURL] [モデル名]
#   例: bash tools/verify-local-llm.sh http://localhost:11434/v1 gemma3n:e4b
#
# - 本番の設定は汚さない（一時ディレクトリを AKARI_HOME にする）
# - ファイルを書き換えるのは、この場で作る使い捨てフォルダの中だけ
# - 結果は akari-verify-report.txt に出る。そのまま貼れる
#
# macOS の bash 3.2 でも動くように書いてある。

set -u

BASE_URL="${1:-http://localhost:11434/v1}"
MODEL="${2:-}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_DIR/apps/cli/dist/index.js"
REPORT="$REPO_DIR/akari-verify-report.txt"
TMP_HOME="$(mktemp -d)"
SANDBOX="$(mktemp -d)"

export AKARI_HOME="$TMP_HOME"
export NO_COLOR=1

cleanup() { rm -rf "$TMP_HOME" "$SANDBOX"; }
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
hr()  { say ""; say "──────────────────────────────────────────"; say "$*"; say ""; }

: > "$REPORT"

say "Akari 実機確認"
say "日時: $(date '+%Y-%m-%d %H:%M:%S %Z')"
say "OS:   $(uname -s) $(uname -m) $(uname -r)"
say "Node: $(node -v 2>/dev/null || echo '見つかりません')"
say "接続先: $BASE_URL"

if [ ! -f "$CLI" ]; then
  hr "0. ビルド"
  say "dist が無いのでビルドします（初回のみ数十秒）"
  (cd "$REPO_DIR" && pnpm install >/dev/null 2>&1 && pnpm build >/dev/null 2>&1)
  if [ ! -f "$CLI" ]; then
    say "ビルドに失敗しました。'pnpm install && pnpm build' を手で実行して、その出力を貼ってください。"
    exit 1
  fi
  say "OK"
fi

akari() { node "$CLI" "$@" 2>&1; }

hr "1. 接続先の登録"
if [ -n "$MODEL" ]; then
  akari config endpoints add --name verify --url "$BASE_URL" --model "$MODEL" | tee -a "$REPORT"
else
  akari config endpoints add --name verify --url "$BASE_URL" | tee -a "$REPORT"
fi

hr "2. モデル一覧（/models が使えるか）"
akari models | tee -a "$REPORT"
MODELS_RC=${PIPESTATUS[0]}
say "[終了コード $MODELS_RC]"

if [ "$MODELS_RC" -ne 0 ]; then
  say ""
  say "ここで失敗した場合、これ以降は動きません。よくある原因:"
  say "  - サーバが起動していない"
  say "  - URL が違う（Ollama: /v1 まで required。例 http://localhost:11434/v1）"
  say ""
  say "この $REPORT をそのまま貼ってください。"
  exit 0
fi

hr "3. 生成（ストリームが流れるか）"
START=$(date +%s)
akari chat -p "1たす1は何ですか。短く答えてください。" | tee -a "$REPORT"
CHAT_RC=${PIPESTATUS[0]}
say "[終了コード $CHAT_RC / 所要 $(( $(date +%s) - START )) 秒]"

hr "4. ツール呼び出しへの対応判定  ★ここが本題"
akari config endpoints probe | tee -a "$REPORT"
say "[終了コード ${PIPESTATUS[0]}]"

hr "5. エージェント実行（実際にファイルを触れるか）"
printf 'const timeout = 1000;\nexport const x = 1;\n' > "$SANDBOX/main.ts"
printf '# 使い捨てのサンドボックス\n' > "$SANDBOX/README.md"
say "使い捨てフォルダ: $SANDBOX"
say "実行前の main.ts:"
sed 's/^/    /' "$SANDBOX/main.ts" | tee -a "$REPORT"
say ""
say "（この確認では承認を自動化します。書き換わるのは上の使い捨てフォルダの中だけです）"
say ""

START=$(date +%s)
akari run --permission full -C "$SANDBOX" --max-steps 8 \
  -p "main.ts の timeout を 5000 に変えてください。read_file で中身を確認してから edit_file を使ってください。" \
  | tee -a "$REPORT"
RUN_RC=${PIPESTATUS[0]}
say "[終了コード $RUN_RC / 所要 $(( $(date +%s) - START )) 秒]"

say ""
say "実行後の main.ts:"
sed 's/^/    /' "$SANDBOX/main.ts" | tee -a "$REPORT"

if grep -q '5000' "$SANDBOX/main.ts" 2>/dev/null; then
  say ""
  say "==> 成功: モデルがツールを使ってファイルを書き換えられました。"
else
  say ""
  say "==> ファイルは変わりませんでした。上の 4. の判定結果と、5. の経過を見てください。"
  say "    モデルがツールを呼べていない可能性が高いです（Gemma 系では想定内）。"
fi

hr "6. 取り消し"
akari undo -y | tee -a "$REPORT"
say "[終了コード ${PIPESTATUS[0]}]"
say "取り消し後の main.ts:"
sed 's/^/    /' "$SANDBOX/main.ts" | tee -a "$REPORT"

hr "7. 設定の要約（鍵は含まれません）"
akari doctor --no-probe | tee -a "$REPORT"

hr "おわり"
say "この内容がそのまま貼れます:"
say "  $REPORT"
say ""
say "含まれないもの: APIキー、あなたのファイルの中身（サンドボックス以外）"

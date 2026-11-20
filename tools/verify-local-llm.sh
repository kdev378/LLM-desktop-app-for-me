#!/usr/bin/env bash
# 実機のローカルLLMで、Akari が想定どおり動くかを確かめる。
# モデルを複数渡すと、最後に比較表が出る。
#
#   bash tools/verify-local-llm.sh <ベースURL> [モデル...]
#
#   例:
#     bash tools/verify-local-llm.sh http://localhost:11434/v1
#     bash tools/verify-local-llm.sh http://localhost:11434/v1 gemma3n:e4b lfm2.5 agents-a1-4b
#
# モデルを省くと、サーバが返す一覧の先頭3つを試す。
#
# - 本番の設定は汚さない（一時ディレクトリを AKARI_HOME にする）
# - ファイルを書き換えるのは、その場で作る使い捨てフォルダの中だけ
# - 結果は akari-verify-report.txt に出る。そのまま貼れる
# - 途中で止めたければ Ctrl+C
#
# macOS の bash 3.2 でも動くように書いてある。

set -u

BASE_URL="${1:-http://localhost:11434/v1}"
shift 2>/dev/null || true
MODELS="$*"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_DIR/apps/cli/dist/index.js"
REPORT="$REPO_DIR/akari-verify-report.txt"
TMP_HOME="$(mktemp -d)"

export AKARI_HOME="$TMP_HOME"
export NO_COLOR=1

SANDBOXES=""
cleanup() {
  rm -rf "$TMP_HOME"
  for d in $SANDBOXES; do rm -rf "$d"; done
}
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

hr "1. 接続先の登録とモデル一覧"
akari config endpoints add --name verify --url "$BASE_URL" | tee -a "$REPORT" >/dev/null
akari models | tee -a "$REPORT"
MODELS_RC=${PIPESTATUS[0]}

if [ "$MODELS_RC" -ne 0 ]; then
  say ""
  say "ここで失敗すると、これ以降は動きません。よくある原因:"
  say "  - サーバが起動していない"
  say "  - URL が違う（Ollama なら /v1 まで。例 http://localhost:11434/v1）"
  say ""
  say "この $REPORT をそのまま貼ってください。"
  exit 0
fi

if [ -z "$MODELS" ]; then
  MODELS=$(akari --json models | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{ console.log(JSON.parse(s).models.slice(0,3).map(m=>m.id).join(" ")); }catch{ console.log(""); }
    });')
  say ""
  say "モデル未指定のため、先頭3つを試します: ${MODELS:-（取得できませんでした）}"
fi

if [ -z "$MODELS" ]; then
  say "試すモデルがありません。第2引数以降にモデル名を渡してください。"
  exit 0
fi

SUMMARY=""

for MODEL in $MODELS; do
  hr "モデル: $MODEL"

  say "── 生成（ストリームが流れるか）"
  START=$(date +%s)
  akari -m "$MODEL" chat -p "1たす1は何ですか。短く答えてください。" | tee -a "$REPORT"
  CHAT_RC=${PIPESTATUS[0]}
  CHAT_SEC=$(( $(date +%s) - START ))
  say "[終了コード $CHAT_RC / 所要 ${CHAT_SEC}秒]"

  if [ "$CHAT_RC" -ne 0 ]; then
    SUMMARY="$SUMMARY
| $MODEL | 生成できず | - | - | ${CHAT_SEC}秒 |"
    say ""
    say "生成に失敗したため、このモデルの残りは飛ばします。"
    continue
  fi

  say ""
  say "── ツール呼び出しへの対応判定  ★ここが本題"
  PROBE_OUT=$(akari -m "$MODEL" config endpoints probe)
  printf '%s\n' "$PROBE_OUT" | tee -a "$REPORT"

  TOOLS_MODE="不明"
  case "$PROBE_OUT" in
    *"ツール呼び出し: 対応"*)      TOOLS_MODE="native（そのまま使える）" ;;
    *"代替方式（prompted）"*)      TOOLS_MODE="prompted（代替方式）" ;;
    *"判定できていません"*)        TOOLS_MODE="判定できず" ;;
  esac

  say ""
  say "── エージェント実行（実際にファイルを触れるか）"
  SANDBOX="$(mktemp -d)"
  SANDBOXES="$SANDBOXES $SANDBOX"
  printf 'const timeout = 1000;\nexport const x = 1;\n' > "$SANDBOX/main.ts"
  say "使い捨てフォルダ: $SANDBOX（書き換わるのはこの中だけ）"

  START=$(date +%s)
  akari -m "$MODEL" run --permission full -C "$SANDBOX" --max-steps 8 \
    -p "main.ts の timeout を 5000 に変えてください。read_file で中身を確認してから edit_file を使ってください。" \
    | tee -a "$REPORT"
  RUN_RC=${PIPESTATUS[0]}
  RUN_SEC=$(( $(date +%s) - START ))
  say "[終了コード $RUN_RC / 所要 ${RUN_SEC}秒]"

  say ""
  say "実行後の main.ts:"
  sed 's/^/    /' "$SANDBOX/main.ts" | tee -a "$REPORT"

  if grep -q '5000' "$SANDBOX/main.ts" 2>/dev/null; then
    RESULT="成功"
    say ""
    say "==> $MODEL: ツールを使ってファイルを書き換えられました。"
    say ""
    say "── 取り消し"
    akari undo -y | tee -a "$REPORT"
    say "取り消し後:"
    sed 's/^/    /' "$SANDBOX/main.ts" | tee -a "$REPORT"
  else
    RESULT="変わらず"
    say ""
    say "==> $MODEL: ファイルは変わりませんでした。上の判定結果と経過を見てください。"
  fi

  SUMMARY="$SUMMARY
| $MODEL | $TOOLS_MODE | $RESULT | 終了$RUN_RC | 生成${CHAT_SEC}秒 / 実行${RUN_SEC}秒 |"
done

hr "まとめ"
say "| モデル | ツール対応 | エージェント実行 | 終了コード | 所要 |"
say "|---|---|---|---|---|"
printf '%s\n' "$SUMMARY" | sed '/^$/d' | tee -a "$REPORT"

say ""
say "見方:"
say "  ツール対応 native   … そのまま使える。いちばん良い"
say "  ツール対応 prompted … 代替方式に自動で切り替わる。実行が成功していれば実用になる"
say "  判定できず          … そのモデルではエージェントを動かせない"
say ""
say "この内容がそのまま貼れます: $REPORT"
say "含まれないもの: APIキー、あなたのファイルの中身（使い捨てフォルダ以外）"

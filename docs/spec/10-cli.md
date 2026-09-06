# 10 — CLI 仕様

デスクトップと**同じ `@akari/core`** を使う。設定・会話・バックアップも同じ場所を共有する。
CLI で始めた会話がデスクトップの一覧に出て、続きから話せる。

## 名前と起動

```
akari [サブコマンド] [オプション] [プロンプト...]
```

サブコマンドを省略し、引数に文字列があれば `run` とみなす。
何も無ければ対話モード（`run` の対話版）に入る。

```sh
akari                            # 対話モード。cwd が作業フォルダ
akari "テストを通して"             # 一回実行して終了
akari -C ~/proj "READMEを直して"   # 作業フォルダを指定
```

## サブコマンド

### `akari run [プロンプト]`
エージェント実行。既定のツール一式が有効。

| オプション | 既定 | 意味 |
|---|---|---|
| `-C, --cwd <dir>` | カレント | 作業フォルダ。この外は触らない |
| `-p, --prompt <text>` | — | プロンプト。`-` で標準入力から読む |
| `-m, --model <name>` | 設定 | モデル |
| `-e, --endpoint <name\|id>` | 設定 | 接続先 |
| `--permission <mode>` | `ask` | `ask` / `auto-edit` / `full` |
| `-y, --yes` | 偽 | `--permission auto-edit` の別名 |
| `--max-steps <n>` | 25 | ステップ上限 |
| `--continue` | 偽 | 直前の会話の続きから |
| `--conversation <id>` | — | 指定した会話の続きから |
| `--no-tools` | 偽 | ツールを渡さない（純粋な生成） |
| `--json` | 偽 | NDJSON でイベントを出す |
| `-q, --quiet` | 偽 | 最終応答だけを出す |
| `--no-color` | 端末依存 | 色を使わない |

### `akari chat`
ツールなしの対話。ファイルを触らない前提の相談用。
`--model` / `--endpoint` / `--continue` が使える。

### `akari diff`
直前の実行が行ったファイル変更を、統一差分で出す。
`--run <runId>` で過去の実行を指定できる。

### `akari undo`
直前の実行のファイル変更を戻す（`05-agent.md` の規則に従う）。
`--run <runId>` で対象を指定。実行前に対象一覧を出して確認を求める。
`-y` で確認を省略。戻せなかったファイルは理由付きで列挙する。

### `akari runs`
過去の実行を新しい順に一覧（ID、日時、作業フォルダ、変更ファイル数、終了理由）。

### `akari models`
接続先のモデル一覧。`--endpoint` で指定。`--json` で機械可読。

### `akari config`
```sh
akari config list                       # 現在の設定（鍵は伏せる）
akari config get agent.maxSteps
akari config set agent.maxSteps 40
akari config endpoints add --name "ローカル" --url http://localhost:11434/v1
akari config endpoints probe ep_local   # 機能を再判定
akari config endpoints rm ep_local
```
`set` は型と範囲を検証する。不正なら**変更せずに**、有効な範囲を示して終了コード 2 で終わる。

### `akari serve`
ハーネスAPIを立てる（`12-harness-api.md`）。

| オプション | 既定 | 意味 |
|---|---|---|
| `--port <n>` | 7801 | 待ち受けポート |
| `--workspace <dir>` | なし | 実行の既定の作業フォルダ |
| `--print-token` | 偽 | トークンを標準出力へ1回だけ出す |
| `--allow-origin <origin>` | なし | ブラウザからの要求を許すオリジン（既定は全拒否） |

`127.0.0.1` にのみ bind する。`--host` は無い。

### `akari mcp …`
外部MCPサーバの登録と、Akari自身のMCP公開（`13-mcp.md`）。

```sh
akari mcp add --name fs --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp/docs
akari mcp add --name search --url http://localhost:9000/mcp
akari mcp list / tools <名前> / rm <名前> / doctor
akari mcp serve --workspace ~/proj [--http --port 7802] [--permission readOnly|autoEdit|full]
```

`add` は、実行されるコマンドを見せて同意を取ってから登録する。

### `akari index …`
ベクトル索引（`14-memory.md`）。

```sh
akari index build / update / status / rm
akari index search "認証はどこ" -k 5
```

`build` は進行（何ファイル中何ファイル、経過時間）を出す。

### `akari web …`
Web検索と取得（`15-web.md`）。`web.enabled` が false のときは、
実行せずに有効化の手順を示して終了コード2で終わる。

```sh
akari web search "zod v4 breaking changes"
akari web fetch https://example.com/docs
akari web doctor
```

### `akari recall` / `akari digest`
圧縮された会話の、生の記録を引く（`16-context.md`）。

```sh
akari recall "認証まわりで何を決めたか"        # 直近の会話を検索
akari recall --conversation <id> "タイムアウト"
akari recall --read <messageId>                # 原文を読む
akari digest                                   # いま文脈に載っている圧縮版を見る
akari digest --json
```

`digest` は、モデルが何を前提に動いているかを利用者が読める形で出す。

### `akari doctor`
接続先ごとの到達性、`/models` の結果、機能判定、設定の要約、データの件数を出す。
`--export <path>` で診断ファイルを書き出す（`09-security.md` の内容）。

## 承認の見せ方（対話端末）

```
  edit_file  src/main.ts

    12 - const timeout = 1000;
    12 + const timeout = 5000;

  [y] 許可   [a] このファイルは以後許可   [n] 拒否   [q] 中止
  > 
```

- `n` を選ぶと理由を1行入力できる（空でよい）。理由はモデルへ渡る。
- 端末が対話的でない（`!process.stdin.isTTY`）とき、承認が必要な操作は
  **自動で拒否**し、終了コード 3 で終わる。パイプの中で勝手にファイルを書かない。
  自動実行したい場合は `--permission` を明示する。

## `--json` の出力

1行1JSON。`05-agent.md` の `RunEvent` をそのまま出す。追加で `ts` を付ける。

```
{"ts":"2026-09-05T10:00:00.000Z","type":"run-start","runId":"01J...","workspace":"/home/me/proj"}
{"ts":"...","type":"tool-call","callId":"c1","name":"read_file","args":{"path":"src/main.ts"},"risk":"read"}
{"ts":"...","type":"tool-result","callId":"c1","ok":true,"summary":"124行"}
{"ts":"...","type":"text-delta","text":"main.ts を"}
{"ts":"...","type":"run-end","reason":"done"}
```

- `--json` のとき、人間向けの装飾・スピナー・色は一切出さない。
- 承認が必要でかつ非対話なら、`approval-request` を出した直後に
  `approval-resolved{decision:"deny"}` を出し、`run-end{reason:"denied"}` で終わる。
- 標準エラーには進行状況を出さない（`--json` は標準出力だけで完結させる）。

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常終了 |
| 1 | 実行時エラー（モデル呼び出し失敗、ツールの致命的失敗） |
| 2 | 使い方の誤り、設定の不正 |
| 3 | 承認が得られなかった / 非対話で承認が必要だった |
| 4 | 接続先へ到達できない |
| 5 | ステップ上限に達した |
| 130 | `Ctrl+C` による中断 |

## 環境変数

| 変数 | 効果 |
|---|---|
| `AKARI_HOME` | 設定・データの根 |
| `AKARI_ENDPOINT` | 既定の接続先 |
| `AKARI_MODEL` | 既定のモデル |
| `AKARI_PERMISSION_MODE` | 既定の権限モード |
| `AKARI_SERVER_TOKEN` | ハーネスAPIのトークン（`serve` 時に生成せずこれを使う） |
| `NO_COLOR` | 色を使わない |

優先順位はコマンドライン引数 > 環境変数 > 設定ファイル（`03-config.md`）。

## `Ctrl+C` の扱い

- 1回目: 現在の実行を中断する（`Session.abort()`）。それまでの変更は残る。
  「中断しました。`akari undo` で戻せます」と出して終了コード 130。
- 2回目（中断処理中にもう一度）: 即座に終了する。

## 作業フォルダの指示ファイル

作業フォルダに `AGENTS.md` / `CLAUDE.md` / `AKARI.md` があれば読む（`05-agent.md`）。
読み込んだファイルを起動時に1行で表示する。

```
akari  ローカル (Ollama) / qwen2.5-coder:14b  ~/proj  権限: 承認する
指示ファイル: AGENTS.md (3.5KB)
```

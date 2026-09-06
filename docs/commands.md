# コマンド一覧（現時点で実際に動くもの）

このファイルは**実装済みのものだけ**を書く。仕様にあって未実装のものは末尾にまとめる。
実際のコードから拾って書いてあるので、`--help` の出力と一致する。

対応バージョン: `0.1.0`（P1 時点）

---

## 呼び方

```sh
pnpm install && pnpm build
node apps/cli/dist/index.js <コマンド> ...
```

以降 `akari` と書く。楽にするなら:

```sh
alias akari="node $PWD/apps/cli/dist/index.js"
```

引数なしで実行するとヘルプが出る。

### プロンプトだけ渡すと `run` になる

```sh
akari "テストを通して"      # akari run "テストを通して" と同じ
```

サブコマンド名でない文字列が最初に来たときだけ。`-` で始まる引数が先頭にある場合は効かない。

---

## 共通のオプション

すべてのコマンドで使える。**サブコマンドの前でも後ろでもよい。**

| オプション | 意味 |
|---|---|
| `-e, --endpoint <名前\|ID>` | 使う接続先。省略で選択中のもの |
| `-m, --model <名前>` | 使うモデル。省略で接続先の既定 → 自動選択 |
| `--json` | 1行1JSONで出す。人向けの装飾を一切出さない |
| `-q, --quiet` | 最終的な出力だけを出す |
| `--no-color` | 色を使わない |
| `--verbose` | ログ水準を `debug` にする |
| `-v, --version` | バージョンを表示 |
| `-h, --help` | ヘルプを表示 |

```sh
akari -m qwen3-4b run "直して"     # 前
akari run -m qwen3-4b "直して"     # 後ろ（同じ）
```

---

## コマンド早見表

| コマンド | 何をするか | ファイルを触るか |
|---|---|---|
| `run` | エージェント実行 | **触る**（承認あり） |
| `runs` | 過去の実行の一覧 | 触らない |
| `diff` | 実行が変えた内容を差分で見る | 触らない |
| `undo` | 実行が変えた内容を元に戻す | **触る** |
| `chat` | 対話。道具なし | 触らない |
| `models` | モデル一覧 | 触らない |
| `doctor` | 接続先・設定・データの状態 | 触らない |
| `config …` | 設定と接続先の操作 | 設定ファイルのみ |

---

## `akari run` — エージェント実行

作業フォルダの中でファイルを読み書きし、コマンドを実行する。**この外は触れない。**

```sh
akari run [オプション] [プロンプト...]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `-C, --cwd <dir>` | カレント | 作業フォルダ。この外は読み書きできない |
| `-p, --prompt <文>` | — | プロンプト。`-` を渡すと標準入力から読む。省略時は引数か標準入力から |
| `--permission <mode>` | `ask` | `ask` / `auto-edit` / `full` |
| `-y, --yes` | — | `--permission auto-edit` と同じ |
| `--max-steps <n>` | 25 | ステップ上限。超えたら停止（終了コード5） |
| `--no-tools` | — | 道具を渡さない。**ファイルは一切変わらない** |
| `--read-only` | — | 読み取り系の道具だけ渡す |

### 権限モード

| 指定 | 読み取り | 書き込み | コマンド実行 | 削除 |
|---|---|---|---|---|
| `ask`（既定） | 自動 | 承認 | 承認 | 承認 |
| `auto-edit`（`-y`） | 自動 | 自動 | 承認 | 承認 |
| `full` | 自動 | 自動 | 自動 | **承認** |

`full` でも通らないもの:

- 作業フォルダの外への読み書き（承認画面すら出ない）
- `.git/` の中への書き込み
- `.env` / `id_rsa` / `*.pem` / `credentials.json` などの**読み取り**
- 拒否リストのコマンド（後述）
- `delete_file`（常に承認が要る）

### 承認のときの入力

```
  承認が必要です
    src/main.ts を書き換えます。
    --- a/src/main.ts
    -const timeout = 1000;
    +const timeout = 5000;
    [y] 許可   [a] この実行中は edit_file:src/main.ts を許可   [n] 拒否   [q] 実行を中止
    >
```

| キー | 動き |
|---|---|
| `y` | この1回だけ許可 |
| `a` | この実行中は同じ範囲を自動で許可。コマンドなら「先頭＋サブコマンド」まで（`npm test` を許可しても `npm publish` は再度聞く） |
| `n` | 拒否。理由を1行入力できる（空でも可）。理由はモデルへ渡る |
| `q` | 実行そのものを中止 |

**対話できない環境（パイプの中など）では、承認が要る操作を自動で拒否し、終了コード3で終わる。**
勝手にファイルを書かないため。自動で進めたいなら `--permission` を明示する。

### 停止

`Ctrl+C` 1回で実行を中断（それまでの変更は残る、終了コード130）。
もう一度押すと即座に終了。

### 例

```sh
akari run "READMEのtypoを直して"
akari run -C ~/proj --permission full "テストを通して"
echo "この差分をレビューして" | akari run --read-only
akari --json run -p "直して" > events.ndjson
```

---

## `akari runs` — 過去の実行の一覧

```sh
akari runs [--limit <n>]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `--limit <n>` | 20 | 表示件数 |

実行ID・開始日時・変更ファイル数・作業フォルダが並ぶ。

---

## `akari diff` — 実行が変えた内容

```sh
akari diff [--run <ID>] [--path <相対パス>]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `--run <ID>` | 直近でファイルを変更した実行 | 対象の実行 |
| `--path <相対パス>` | 全部 | 1ファイルだけ |

実行**前**のバックアップと**現在**のファイルを比べた統一差分が出る。

---

## `akari undo` — 元に戻す

```sh
akari undo [--run <ID>] [-y]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `--run <ID>` | 直近でファイルを変更した実行 | 対象の実行 |
| `-y, --yes` | — | 確認しない |

同じファイルを何度変えていても、**その実行を始める前の状態**まで戻る。

**実行後に自分で編集したファイルは上書きしない。** 「実行後に手で変更されています」として
飛ばし、一覧で報告する。その場合の終了コードは1。

---

## `akari chat` — 対話（道具なし）

**ファイルは一切触らない。** 相談用。

```sh
akari chat [オプション]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `-p, --prompt <文>` | — | 1回だけ送って終わる。`-` を渡すと標準入力から読む |
| `-s, --system <文>` | — | システムプロンプト |
| `-t, --temperature <数値>` | 設定値（0.7） | 0.0〜2.0 |
| `--max-tokens <整数>` | 設定値（無制限） | 生成の上限 |

### 対話中の入力

| 入力 | 動き |
|---|---|
| `/help` | 操作一覧 |
| `/clear` | 文脈を消す |
| `/context` | 今の文脈の量（概算） |
| `/exit` `/quit` | 終了 |
| `Ctrl+C` | 生成中なら停止。そうでなければ2回で終了 |

### 例

```sh
akari chat
akari chat -p "TypeScriptのsatisfiesとは"
echo "これを要約して" | akari chat -q
cat README.md | akari chat -p -   # 標準入力から
```

> **注意: この対話は保存されません。** 会話の保存は未実装（後述）。

---

## `akari models` — モデル一覧

```sh
akari models
```

接続先が返すモデルを名前順に並べて出す。サーバが文脈長を返していれば、その列に入る（返さなければ空）。
`*` は接続先の既定モデル。

---

## `akari doctor` — 状態の確認

```sh
akari doctor [--export <パス>] [--no-probe]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `--export <パス>` | — | 診断を書き出す |
| `--no-probe` | — | 接続先へ問い合わせず、設定だけを出す |

出るもの: バージョン、実行環境、データの場所、接続先ごとの到達性・鍵の出所・
判定済みモデル（ツール対応と文脈長）、設定の問題、保存データの件数。

`--export` の書き出しに**含まれないもの**: APIキー、会話の本文、ファイルの中身。
ホームディレクトリのパスは `~` に置換される。

どの接続先にも到達できないと終了コード4。

---

## `akari config` — 設定

### `akari config list`

現在の設定をJSONで出す。**鍵の値は出ない。**

### `akari config get <項目>`

```sh
akari config get agent.maxSteps
akari config get generation.temperature
```

### `akari config set <項目> <値>`

```sh
akari config set agent.maxSteps 40
akari config set generation.temperature 0.3
akari config set logging.level debug
```

**有効な範囲を外れた値は、設定を変更せずに拒否する**（終了コード2）。
型は現在値に合わせる。型が変わる変更は受け付けない。
接続先は `config endpoints` で操作する（ここでは変えられない）。

### 変更できる項目

| 項目 | 型 / 範囲 | 既定 |
|---|---|---|
| `generation.temperature` | 0.0〜2.0 | `0.7` |
| `generation.topP` | 0.0〜1.0 | `1` |
| `generation.maxTokens` | 1以上 または `null` | `null` |
| `agent.permissionMode` | `ask` / `autoEdit` / `full` | `ask` |
| `agent.maxSteps` | 1〜200 | `25` |
| `agent.commandTimeoutMs` | 1000〜1800000 | `120000` |
| `agent.toolOutputLimitBytes` | 1000〜10000000 | `100000` |
| `agent.deniedCommands` | 文字列配列（JSON） | 下記 |
| `ui.theme` | `light` / `dark` / `system` | `system` |
| `ui.density` | `comfortable` / `compact` | `comfortable` |
| `logging.level` | `error`/`warn`/`info`/`debug`/`trace` | `info` |
| `logging.retainDays` | 1〜365 | `14` |
| `concurrency.maxParallelRuns` | 1〜16 | `4` |

`deniedCommands` の既定（部分一致で拒否。**承認画面すら出ない**）:

```
rm -rf /   mkfs   dd if=   shutdown   reboot   :(){
git push --force   git push -f   git reset --hard
git commit --amend   git rebase   git filter-branch
```

配列はJSONで渡す:

```sh
akari config set agent.deniedCommands '["rm -rf /","mkfs","curl "]'
```

---

## `akari config endpoints` — 接続先

### `add`

```sh
akari config endpoints add --name <名前> --url <ベースURL> [オプション]
```

| オプション | 必須 | 意味 |
|---|---|---|
| `--name <名前>` | **必須** | 表示名 |
| `--url <ベースURL>` | **必須** | `/v1` まで含める |
| `--model <名前>` | | この接続先の既定モデル |
| `--key <値>` | | APIキー。**`credentials.json` に平文で保存される** |
| `--key-env <変数名>` | | APIキーを環境変数から読む。外部APIではこちらを推奨 |
| `--timeout <秒>` | | 最初の応答までの待ち上限（既定120） |

サーバごとの既定URL:

| サーバ | ベースURL |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |

`localhost` 以外を登録すると「インターネット上にあります」と警告が出る。

### `list` / `rm` / `use`

```sh
akari config endpoints list
akari config endpoints rm <名前|ID>
akari config endpoints use <名前|ID>
```

`rm` しても鍵は `credentials.json` に残る。

### `probe`

そのモデルがツール呼び出しに対応しているかを判定し、**結果を保存する**。

```sh
akari config endpoints probe [名前|ID] [-m <モデル>] [--context <トークン数>]
```

| オプション | 意味 |
|---|---|
| `-m, --model <名前>` | 判定するモデル。**省略すると自動で選ぶ** |
| `--context <トークン数>` | そのモデルの文脈長を手で設定する（256以上）。対象モデルが決まっていること（`-m` か接続先の既定モデル） |

判定結果は**モデルごと**に保存される。同じモデルなら次からは判定し直さない。
モデルを変えたときは判定し直す。

判定は `akari run` の実行前にも自動で走る（未判定のときだけ）。

出力の読み方:

| 表示 | 意味 |
|---|---|
| `ツール呼び出し: 対応` | そのまま使える（`native`） |
| `代替方式（prompted）になります` | 標準のツール呼び出しに非対応。文中のブロックで代用する。**やや失敗しやすい** |
| `判定できていません` | エージェントを動かせない。エラー内容を見る |

---

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常終了 |
| 1 | 実行時エラー（モデル呼び出し失敗、`undo` で戻せないものがあった等） |
| 2 | 使い方の誤り、設定の不正、知らないオプション |
| 3 | 承認が得られなかった（非対話で承認が必要だった） |
| 4 | 接続先へ到達できない |
| 5 | ステップ上限に達した |
| 130 | `Ctrl+C` による中断 |

---

## 環境変数

| 変数 | 効果 |
|---|---|
| `AKARI_HOME` | 設定・データの置き場所を変える。**試すときはこれを使うと本番設定を汚さない** |
| `AKARI_ENDPOINT` | 既定の接続先 |
| `AKARI_MODEL` | 既定のモデル |
| `AKARI_PERMISSION_MODE` | 既定の権限モード（`ask` / `auto-edit` / `full`） |
| `AKARI_DEBUG` | 例外のスタックトレースを出す（鍵は伏字化される） |
| `NO_COLOR` | 色を使わない |

優先順位はコマンドライン引数 > 環境変数 > 設定ファイル。

```sh
export AKARI_HOME=/tmp/akari-try   # 本番設定と分ける
```

---

## エージェントが使える道具

`run` のときにモデルへ渡るもの。`--read-only` なら上4つだけ、`--no-tools` なら1つも渡さない。

| 道具 | 危険度 | 引数（**太字**は必須） |
|---|---|---|
| `read_file` | 読み取り | **path**, offset, limit |
| `list_dir` | 読み取り | path, depth |
| `glob` | 読み取り | **pattern**, path |
| `grep` | 読み取り | **pattern**, path, glob, maxMatches, ignoreCase |
| `write_file` | 書き込み | **path**, **content** |
| `edit_file` | 書き込み | **path**, **oldText**, **newText**, replaceAll |
| `delete_file` | 書き込み | **path** |
| `run_command` | 実行 | **command**, cwd, timeoutMs |

- `edit_file` は `oldText` が**ちょうど1箇所**に一致しないと実行しない。
  複数一致したら「どこを直すか決められない」として拒否する（`replaceAll` を使えば全部置換）。
- `run_command` は書き込みより危険度が高い扱い。ここからファイルを書けるため、
  書き込みだけ自動許可にすると承認を迂回できてしまう。
- `glob` / `grep` / `list_dir` は `node_modules` `.git` `dist` などを走査しない。

---

## 保存される場所

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\Akari\` |
| macOS | `~/Library/Application Support/Akari/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/akari/` |

```
config.json          設定。鍵は含まない
credentials.json     鍵のみ。権限600（POSIX）
backups/<実行ID>/     変更前のバックアップと journal.json（undo の根拠）
logs/                NDJSON のログ
```

**鍵は平文で保存される。** OSのファイル権限に頼った保護であり、暗号化ではない。
Windows ではアクセス権を絞れておらず、起動のたびに警告が出る。
外部APIの鍵は `--key-env` を使うほうがよい。

---

## まだ無いもの

実行すると「まだ実装されていません」と出る（終了コード2）。

| コマンド | 内容 | 予定 |
|---|---|---|
| `recall` / `digest` | 文脈の圧縮版と、生の記録の検索 | P2 |
| `serve` | ハーネスAPI（ローカルHTTP） | P3 |
| `mcp` | MCPの登録と公開 | P4 |
| `index` | ベクトル索引 | P5 |
| `web` | Web検索と取得 | P6 |

コマンド以外で未実装のもの:

- **会話の保存**。`chat` も `run` も、やり取りの本文はどこにも残らない。
  ファイル変更の記録（`diff` / `undo` が使うもの）は残る
- デスクトップアプリ
- 設定の `context.*`（文脈の圧縮）と `agent.gitTools.*`（git書き込み）。
  仕様にはあるが、まだ設定項目として存在しない

詳しくは `docs/spec/11-roadmap.md`。

---

## 試すときの雛形

本番の設定を汚さず、使い捨てのフォルダだけを触らせる形。

```sh
export AKARI_HOME=/tmp/akari-try
SANDBOX=$(mktemp -d) && printf 'const timeout = 1000;\n' > "$SANDBOX/main.ts"

akari config endpoints add --name L --url http://localhost:1234/v1 --model <モデル名>
akari doctor
akari config endpoints probe
akari run --permission full -C "$SANDBOX" -p "main.ts の timeout を 5000 に変えて"
akari diff
akari undo -y
```

一通りまとめてやるなら:

```sh
bash tools/verify-local-llm.sh http://localhost:1234/v1 <モデル名>
```

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
| `conversations` | 保存した会話の一覧・表示・削除 | 触らない |
| `digest` | いまモデルが前提にしている圧縮版を見る | 触らない |
| `recall` | 会話の生の記録を検索する（圧縮された部分も） | 触らない |
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
| `--tools-mode <mode>` | `auto` | 道具の渡し方。`auto` / `native` / `prompted` / `both`（後述） |
| `--timeout <秒>` | 300 | この実行だけ、最初の応答までの待ち上限を変える。設定は書き換えない |
| `--think <量>` | `auto` | 思考（reasoning）の量。`auto` / `off` / `low` / `medium` / `high`（後述） |
| `-c, --continue` | — | この作業フォルダの直近の会話の続きから（後述「会話の続き」） |
| `--conversation <ID>` | — | 指定した会話の続きから。ID は前方一致でよい |
| `--no-save` | — | この実行のやり取りを保存しない |

### 会話の保存と続き

`run` のやり取りは、既定で**会話として保存される**。保存されるのは、入力、応答、思考の出力、
道具の呼び出しと結果（読んだファイルの中身やコマンドの出力を含む）、失敗した応答。
暗号化はしない（置き場所は「保存される場所」）。

```sh
akari run "テストを通して"
akari run -c "READMEも直して"              # この作業フォルダの直近の会話の続き
akari run --conversation 01K8 "続けて"      # 会話を指定して続き（ID は前方一致）
akari run --no-save "…"                    # 保存しない
```

- **`-c` は値を取らない。** `akari run -c "続けて"` の「続けて」はプロンプトとして読む。
  会話を指定したいときは `--conversation <ID>` を使う
- 続きを始める会話の作業フォルダが今と違えば、**断る**（終了コード2）。
  前の会話は前のフォルダのファイルを前提にしているため。正しいフォルダを `-C` で案内する
- 続きでは、前回の道具の渡し方やモデルと違っても構わない。記録は「何を呼び、何が返ったか」で持ち、
  送るときに組み立て直す
- 思考の出力は保存するが、モデルへは送り返さない
- 生成中にアプリが落ちても、そこまでの応答は「途中で止まった応答」として次に開いたときに残る

### 権限モード

| 指定 | 読み取り | 書き込み | コマンド実行 | 削除 |
|---|---|---|---|---|
| `ask`（既定） | 自動 | 承認 | 承認 | 承認 |
| `auto-edit`（`-y`） | 自動 | 自動 | 承認 | 承認 |
| `full` | 自動 | 自動 | 自動 | **承認** |

`full` でも通らないもの:

- ファイルの道具による、作業フォルダの外への読み書き（承認画面すら出ない）
- ファイルの道具による、`.git/` の中への書き込み
- ファイルの道具による、`.env` / `id_rsa` / `*.pem` / `credentials.json` などの**読み取り**
- 拒否リストのコマンド（後述）
- `delete_file`（常に承認が要る）
- **削除系のコマンド**（`rm` / `rmdir` / `unlink` / `shred` / `git clean` / `git rm` / `find … -delete` など。常に承認が要る）
- **一度断られた後のコマンド**（その実行の残りでは、コマンドを自動で通さない）

コマンドで消したファイルは `akari undo` で戻せない（`delete_file` で消したものは戻せる）。
そのため削除系のコマンドは `full` でも聞く。モデルが削除を断られた後、
別の書き方で消そうとするのを止めるために、断った後はコマンドを全部聞く。

**これは完全な防壁ではない。** `python -c "…"` のような書き方で消されると、
1回目は見抜けない。`full` は信頼できる作業フォルダでだけ使い、
大事なものは git にコミットしてから動かすこと。

**コマンド（`run_command`）は作業フォルダに閉じ込められていない。**
上の「作業フォルダの外」「`.env` の読み取り」の禁止は、ファイルの道具にしか効かない。
コマンドは利用者の権限で動く本物のシェルなので、`cat .env` や `cat ~/.ssh/id_rsa`、
作業フォルダの外への書き込みもできる。`full` ではそれが自動で通る。
外部の接続先（OpenRouter など）を使っているなら、読んだ中身はそこへ送られる。
秘密のあるフォルダでは `full` を使わないこと。

### 道具の渡し方（`--tools-mode`）

道具を呼ばせる方法は2つある。どちらが使えるかはモデル次第。

| 指定 | 動き |
|---|---|
| `auto`（既定） | 判定結果に従う。判定できていなければ `both` |
| `native` | 標準の関数呼び出しだけ。対応モデルではこれが一番確実 |
| `prompted` | 本文に `akari-tool` ブロックを書かせる。ツール用テンプレートを持たないモデル向け |
| `both` | 両方渡して、返ってきたほうを使う |

**`both` は「判定できなかったモデルでも道具を使わせる」ための既定の逃げ道。**
関数呼び出しの定義を渡しつつ、ブロックの書き方も説明する。
`tool_calls` が返ればそれを使い、返らなければ本文のブロックを見る。
両方が同じ応答に入っていても、二重には実行しない。

`probe` が `判定できていません`（`none`）になったモデルでも、実行は止まらず `both` で走る。
`none` は「対応していない」ではなく「測れなかった」だから。
ただし「確認できていない」ことは実行開始時に必ず表示する。

`--tools-mode` を明示すると、判定の呼び出しそのものを省く（起動が1往復ぶん速くなる）。

```sh
akari run --tools-mode both "直して"      # 判定を待たずに両対応で走らせる
akari run --tools-mode native "直して"    # 対応していると分かっているとき
```

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
| `-c, --continue` | — | 直近の chat の続きから |
| `--conversation <ID>` | — | 指定した会話の続きから |
| `--no-save` | — | この対話を保存しない |

`chat` も既定で保存する。続きでは、前回の `-s` のシステムプロンプトを引き継ぐ（`-s` を付ければ置き換わる）。
失敗した往復（入力とその失敗）は、続きでもモデルへ送らない。利用者とモデルが交互でないと断るモデルがあるため。

### 対話中の入力

| 入力 | 動き |
|---|---|
| `/help` | 操作一覧 |
| `/clear` | 文脈を消して、新しい会話を始める（前の会話は消えずに残る） |
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

## `akari conversations` — 保存した会話

```sh
akari conversations                  # 一覧（更新の新しい順、既定20件）
akari conversations show <ID>        # 中身を表示
akari conversations rm <ID>          # ゴミ箱へ移す
```

| コマンド | オプション | 意味 |
|---|---|---|
| `conversations` | `--limit <n>` | 表示件数（既定20） |
| `conversations show <ID>` | `--reasoning` | 思考の出力も表示する |
| | `--full` | 道具の結果を省略せずに表示する（既定は8行まで） |
| `conversations rm <ID>` | `-y, --yes` | 確認しない。付けずに対話できない場所で実行すると、移さずに終了コード3 |

- ID は前方一致でよい（`01K8QF` のように）。複数に当たれば候補を出して終了コード2
- `rm` はゴミ箱（`trash/conversations/`）へ移すだけ。30日を過ぎたものは、次に `rm` したときに消える
- 読めない見出しや、途中で切れた行があれば、最後に知らせる。その行はファイルから消さない
- `--json` で、一覧は `{ conversations, problems }`、表示は `{ header, thread, problems }` が出る

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
| `generation.reasoning` | `auto`/`off`/`low`/`medium`/`high` | `auto` |
| `generation.temperature` | 0.0〜2.0 | `0.7` |
| `generation.topP` | 0.0〜1.0 | `1` |
| `generation.maxTokens` | 1以上 または `null` | `null` |
| `agent.permissionMode` | `ask` / `autoEdit` / `full` | `ask` |
| `agent.maxSteps` | 1〜200 | `25` |
| `agent.commandTimeoutMs` | 1000〜1800000 | `120000` |
| `agent.toolOutputLimitBytes` | 1000〜10000000 | `100000` |
| `context.mode` | `auto` / `off` | `auto` |
| `context.compactAtRatio` | 0.3〜0.95 | `0.7` |
| `context.compactAtTokens` | 1000以上 | `12000` |
| `context.keepRecentTurns` | 1〜20 | `3` |
| `context.digestModel` | モデル名 または `null` | `null`（実行と同じ） |
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
| `--timeout <秒>` | | 最初の応答までの待ち上限（既定300） |

### `set`

既にある接続先を書き換える。**接続先のIDと判定結果は残る。**

```sh
akari config endpoints set [名前|ID] [オプション]
```

名前を省略すると、いま選択中の接続先を変える。
オプションは `add` と同じ（`--name` / `--url` / `--model` / `--key` / `--key-env` / `--timeout`）。
指定したものだけが変わる。

```sh
akari config endpoints set --timeout 900     # 応答を15分待つ
akari config endpoints set --model qwen3-4b  # 既定のモデルを変える
```

**待ち時間を変えたいだけなら `rm` して `add` し直さないこと。**
IDが変わり、モデルごとのツール判定と文脈長の記録まで消える。

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

判定が走るのは3箇所。**いずれも結果を保存する**（`doctor` を含む）。

- `config endpoints probe`
- `akari run` の実行前（未判定で、かつ `--tools-mode` を明示していないときだけ）
- `akari doctor`（`--no-probe` を付けなければ）

`doctor` の「判定済みのモデル」には、その回に判定したものも含めて全部出る。

出力の読み方:

| 表示 | 意味 |
|---|---|
| `ツール呼び出し: 対応` | そのまま使える（`native`） |
| `サーバが tools 引数そのものを拒否` | サーバ側が非対応。代替方式（`prompted`）になる |
| `サーバは tools 引数を受け付けましたが、モデルは呼ばず本文だけを返しました` | **モデル側の問題。** その配布物にツール呼び出し用のテンプレートが入っていないことが多い。同じモデルでも配布元によって変わる。代替方式で動くが失敗しやすい |
| `判定できていません` | **非対応ではなく「測れなかった」。** 実行時は両対応（`both`）で試す。サーバの応答本文が併記される |

文脈長は、サーバが返せば表示される。LM Studio なら固有の口から取れる。
返さないサーバでは `--context` で手で設定する。

---

## 文脈の圧縮（`digest` / `recall`）

長い作業で文脈（モデルに一度に渡せる量）が埋まりそうになると、`run` は古いやり取りを
「決定・確認済み・棄却案・未解決・次の行動」の5つに**圧縮して**作業を続ける。実行中にこう出る:

```
  ⧉ 文脈が約12,400トークン（概算）になったため、古い 6 手を圧縮しています…
  ⧉ 圧縮しました: 約4,100トークン（概算）。中身は akari digest で見られます
```

- **生の記録は消えない。** 会話のファイルに全部残り、変わるのは次に送るものだけ
- 圧縮したあとは、モデルに `recall_search` / `recall_read` を渡す。圧縮版に無い細部は、モデルが自分で原文を引ける
- 圧縮した会話を `-c` で続けると、圧縮版と、圧縮していない部分の生だけを送る
- モデルが圧縮版を書けなかったときは、機械的な要約（使った道具、読んだファイル、各応答の先頭）へ切り替え、
  `機械的な要約で残しています（劣った圧縮です）` と出る
- 圧縮しても入りきらないときは、送るときだけ大きい道具の出力を切り詰める。それでも文脈長を超えるなら
  送らずに止まる（`文脈に入りきらないため停止`、終了コード1）
- `chat` は圧縮しない（道具の出力が無く、溢れにくいため）

```sh
akari digest                              # この作業フォルダの直近の会話の圧縮版
akari digest --conversation 01M5          # 会話を指定
akari recall "タイムアウト"                 # 生の記録を検索（圧縮済みのものには印が付く）
akari recall --read 01M5XX2F07ZS…         # 原文を読む
```

| コマンド | オプション | 意味 |
|---|---|---|
| `digest` / `recall` | `-C, --cwd <dir>` | この作業フォルダの直近の会話（既定はカレント） |
| | `--conversation <ID>` | 会話を指定する（前方一致でよい） |
| `recall` | `--read <ID>` | そのメッセージの原文を読む（思考の出力も含む） |
| | `--limit <n>` | 表示件数（既定10） |

検索は部分一致（大文字小文字を無視）。`/…/` で囲めば正規表現。

**いつ圧縮するか**: モデルの文脈長が分かれば、その7割（概算しか無いときは6割）。
分からなければ12,000トークン。文脈長は `akari models` の「文脈長」の列、または
`akari config endpoints probe -m <モデル> --context <数>` で入れた値を使う。

実行の最初に、どの閾値で圧縮するかが出る:

```
文脈: 長さ 32,768 / 約19,660〜22,937トークンを超えたら圧縮（context.compactAtRatio 0.7。サーバがトークン数を報告しなければ低いほう）
```

試すときに早めに圧縮させるには、**文脈長が分かっているかどうかで、効く設定が違う**:

```sh
# 文脈長が分かっている（上の行に「長さ 32,768」のように出る）→ compactAtTokens は効かない
akari config endpoints probe -m <モデル> --context 8000   # 文脈長を小さく入れ直す（試し終わったら戻す）
akari config set context.compactAtRatio 0.3              # または割合を下げる
# 文脈長が分からない（「長さ不明」）
akari config set context.compactAtTokens 3000
# どちらでも
akari config set context.keepRecentTurns 1               # 生のまま残す直近の手数
```

---

## 思考の量（`--think`）

Qwen3 系のように思考を出すモデルは、思考が長いと待ち時間もトークンも食う。
文脈長の小さいモデルでは、思考だけで入りきらなくなる。

```sh
akari run --think off "直して"      # 思考させない（速い）
akari chat --think high -p "…"      # よく考えさせる
```

| 指定 | 送るもの |
|---|---|
| `auto`（既定） | 何も送らない。サーバとモデルの既定に任せる |
| `off` | `chat_template_kwargs: {"enable_thinking": false}` |
| `low` / `medium` / `high` | `reasoning_effort: "<値>"` |

`off` だけ別の口を使う。思考を出すか出さないかはチャットテンプレート側の切り替えで、
量の指定とは別の仕組みだから。

**受け付けないサーバでは自動で外して送り直す。** そのとき、こう出る:

```
  ! この接続先は reasoning_effort を受け付けませんでした。外して送り直します（思考量の指定は効きません）。
```

このメッセージが出たら、**指定は効いていない**。生成そのものは成功する。
黙って落とさないのは、効いたように見えると「なぜ思考が止まらないのか」が分からなくなるため。

`akari config set generation.reasoning off` で既定にできる。
強さは `--think` > `AKARI_REASONING` > 設定。

---

## 待ち時間（遅い・タイムアウトするとき）

時間の上限は3つある。**どれも別のもの**なので、出たメッセージで見分ける。

| メッセージ | 何の上限か | 既定 | 変え方 |
|---|---|---|---|
| `最初の応答が N 秒以内に来ませんでした` | リクエストを出してから最初のトークンが返るまで | 300秒 | `--timeout` / `AKARI_TIMEOUT` / `config endpoints set --timeout` |
| `応答が 120 秒途切れました` | トークンとトークンの間 | 120秒 | 変えられない（ここまで空くならサーバが壊れている） |
| `コマンドが N 秒を超えたため終了させました` | `run_command` が動かしたコマンド | 120秒 | `config set agent.commandTimeoutMs <ミリ秒>` |
| `サーバが 10 秒以内に応答しませんでした` | モデル一覧（`/models`）の取得 | 10秒 | 変えられない |

**最初のトークンまでが長くなるのは異常ではない。** ローカルのサーバは、
モデルの読み込みと入力の処理を終えてから最初のトークンを出す。
`run` は道具の定義8個と指示ファイルと履歴を毎回送るので、`chat` よりここが長い。
手元の機械で数B級のモデルを動かすなら、初回に数分かかることがある。

```sh
akari run --timeout 900 "直して"            # この1回だけ15分待つ
akari config endpoints set --timeout 900    # 以後ずっと15分待つ
```

`run_command` の上限は、モデル自身が呼び出しごとに `timeoutMs` を渡して伸ばせる。
打ち切られたときは、その旨と伸ばし方がモデルへ返る。

---

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常終了 |
| 1 | 実行時エラー（生成の失敗、ツールの致命的失敗） |
| 2 | 使い方の誤り、設定の不正、知らないオプション |
| 3 | 承認が得られなかった（非対話で承認が必要だった） |
| 4 | 接続先へ到達できない（`models` / `chat` / `run` / `doctor` のどれでも同じ） |
| 5 | 途中で止まった（ステップ上限に達した、または同じ操作の繰り返しで止めた） |
| 130 | `Ctrl+C` による中断 |

---

## 環境変数

| 変数 | 効果 |
|---|---|
| `AKARI_HOME` | 設定・データの置き場所を変える。**試すときはこれを使うと本番設定を汚さない** |
| `AKARI_ENDPOINT` | 既定の接続先 |
| `AKARI_MODEL` | 既定のモデル |
| `AKARI_PERMISSION_MODE` | 既定の権限モード（`ask` / `auto-edit` / `full`） |
| `AKARI_TOOLS_MODE` | 既定の道具の渡し方（`auto` / `native` / `prompted` / `both`） |
| `AKARI_TIMEOUT` | 最初の応答までの待ち上限（秒）。設定より強く、`--timeout` より弱い |
| `AKARI_REASONING` | 思考の量（`auto` / `off` / `low` / `medium` / `high`） |
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
conversations/       会話。<ID>.json（見出し）と <ID>.messages.jsonl（メッセージ。1行1件、追記のみ）
backups/<実行ID>/     変更前のバックアップと journal.json（undo の根拠）
trash/conversations/ ゴミ箱へ移した会話（30日で消える）
logs/                NDJSON のログ
```

**会話には、エージェントが読んだファイルの中身やコマンドの出力もそのまま入る。** 暗号化はしない（ファイルは本人だけが読める権限600で作る。Windows では効かない）。
秘密のあるフォルダで動かした会話は、`akari conversations rm` で消すか、`--no-save` で保存しないこと。

**鍵は平文で保存される。** OSのファイル権限に頼った保護であり、暗号化ではない。
Windows ではアクセス権を絞れておらず、起動のたびに警告が出る。
外部APIの鍵は `--key-env` を使うほうがよい。

---

## まだ無いもの

実行すると「まだ実装されていません」と出る（終了コード2）。

| コマンド | 内容 | 予定 |
|---|---|---|
| `serve` | ハーネスAPI（ローカルHTTP） | P3 |
| `mcp` | MCPの登録と公開 | P4 |
| `index` | ベクトル索引 | P5 |
| `web` | Web検索と取得 | P6 |

コマンド以外で未実装のもの:

- 過去の発言の編集と、応答の作り直し（会話の枝分かれ）。保存の形は対応しているが、操作はデスクトップで入れる
- 会話の書き出し・読み込み（zip）
- デスクトップアプリ
- 設定の `agent.gitTools.*`（git書き込み）。仕様にはあるが、まだ設定項目として存在しない

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

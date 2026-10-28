# 実機テスト手順

ローカルLLMに対して、Akari の何がどこまで動くかを順に確かめる。
上から順にやると、失敗したときに**どこまでは動いていたか**が分かるようになっている。

対象は「10秒版」＝ `--tools-mode`（両対応）は入っているが、
**応答ヘッダを10秒で打ち切る制限がまだ残っている**版。
それより後に入ったものは最後の「新版でだけ試せること」にまとめてある。

**このファイルのコマンドは、すべて模擬サーバに対して実際に流して構文と終了コードを確かめてある。**
ただし「モデルがどう振る舞うか」（道具を呼ぶか、指示に従うか）は模擬サーバでは測れない。
そこは実機で見るしかないので、**期待**として書いてあるのは予測である。

---

## 0. 準備

### 呼び出し方

`apps/cli/dist/` は組み立てた結果なので Git には入っていない。リポジトリの直下で先に組み立てる:

```sh
pnpm install   # 初回と、依存が変わったとき
pnpm build     # apps/cli/dist/index.js ができる
```

そのあと、次のどれかで呼ぶ。

```sh
node apps/cli/dist/index.js …          # そのまま
pnpm akari …                           # 同じ
alias akari="node $PWD/apps/cli/dist/index.js"   # 以降 akari と書ける（このターミナルの間だけ）
```

ターミナルを開き直しても `akari` と打てるようにするには、一度だけ `cd apps/cli && npm link && cd ../..`
（詳しくは [getting-started.md の「準備」](getting-started.md#準備)）。

以降このファイルでは `akari` と書く。

### 本番の設定を汚さない

```sh
export AKARI_HOME=/tmp/akari-test
```

**これを最初にやること。** テスト用の設定・ログ・バックアップが全部ここに入り、
終わったら `rm -rf /tmp/akari-test` で消える。
既に本番の設定で試していて、そちらで続けたいなら省いてよい。

### サンドボックスを作る

`run` はファイルを書き換える。捨てて構わない場所を用意する。

```sh
mkdir -p /tmp/akari-sandbox/src && cd /tmp/akari-sandbox
git init -q
cat > src/main.ts <<'EOF'
export const timeout = 1000;
export function hello(name: string) {
  return `hello ${name}`;
}
EOF
echo "# サンプル" > README.md
echo "SECRET=abc123" > .env
git add -A && git commit -qm init
```

`.env` はわざと置く。**エージェントがこれを読めないこと**を後で確かめるため。

### LM Studio 側

- サーバを起動しておく（既定 `http://localhost:1234`）
- 試すモデルを**先に読み込んでおく**。読み込み待ちで時間切れになるのを避けるため
- モデル名は LM Studio の画面に出ている ID をそのまま使う

---

## 1. つながるか

### 1-1. 接続先を登録する

```sh
akari config endpoints add --name L --url http://localhost:1234/v1
```

**期待**: `接続先 "L" を追加しました。`

**違ったら**: `--url` は `/v1` まで含める。`localhost` 以外だと「インターネット上にあります」の警告が出る（出るのが正しい）。

### 1-2. 一覧に出るか

```sh
akari config endpoints list
```

**期待**: `L` の行に `*`（選択中）が付く。

### 1-3. モデル一覧

```sh
akari models
```

**期待**: LM Studio に入っているモデルのIDが**名前順**に並ぶ。

表示だけ名前順に並べ替えている。モデルを指定しなかったときの自動選択には、
サーバが返した順序をそのまま使う（3-2 で確かめる）。

**見るところ**:
- 埋め込みモデル（`nomic-embed-…` など）が混ざっていても構わない
- 文脈長が出るか。出なければ LM Studio 固有の口から取れていない
- 読み込み状態が出るか（`状態` の列は新版から。10秒版には無い）

**使うモデルは先に LM Studio で読み込んでおくこと。** 未読込のモデルを指定すると、
サーバがその場で読み込むため最初の応答が遅れ、10秒版ではそれが
「サーバが10秒以内に応答しませんでした」として切られる。

```sh
akari --json models     # 機械可読。1個のJSONとして読める
```

---

## 2. 生成できるか（ファイルは触らない）

### 2-1. 1回だけ送る

```sh
akari chat -p "1+1は？" -m <モデルID>
```

**期待**: 応答が**1文字ずつ流れて**出る。まとめてドンと出るなら、ストリーミングが効いていない。

### 2-2. 対話

```sh
akari chat -m <モデルID>
```

**期待**: 入力待ちになる。`Ctrl+C` か `Ctrl+D` で抜ける。会話は保存されない（P1の未実装部分）。

### 2-3. 標準入力から

```sh
echo "この文を3語で要約して" | akari chat -m <モデルID>
```

### 2-4. 思考を出すモデル（Qwen3系）

```sh
akari chat -p "難しい問題を考えて" -m qwen3.5-agents-a1-4b
```

**期待**: `<think>` タグが**そのまま本文に出ない**。思考は思考として分けて表示される。

**違ったら**: `<think>` が生で見えていたら報告してほしい。切り分けが効いていない。

### 2-5. 生成の設定

```sh
akari chat -p "自由に書いて" -t 1.5 --max-tokens 50
akari chat -p "やあ" -s "あなたは無口です。10文字以内で答えます。"
```

**期待**: `--max-tokens 50` なら途中で切れる。`-s` の指示に従う。

---

## 3. 何ができるモデルか判定する

ここが**今いちばん怪しいところ**。

### 3-1. モデルを指定して判定

```sh
akari config endpoints probe -m <モデルID>
```

**期待される出力の読み方**:

| 表示 | 意味 | どうなる |
|---|---|---|
| `ツール呼び出し: 対応` | そのまま使える | `run` が普通に動く |
| `サーバが tools 引数そのものを拒否` | サーバ側が非対応 | 代替方式へ自動で切り替わる |
| `サーバは tools 引数を受け付けましたが、モデルは呼ばず本文だけを返しました` | **モデル側**の問題 | 代替方式で動く。失敗しやすい |
| `判定できていません` | 測れなかった | 10秒版では `run` が動かない |

**必ず確認**: 出力に `判定に使ったモデル: <名前>` が入っていること。
入っていなければ、どのモデルを測ったのか分からないまま結果だけ出ている。

### 3-2. モデルを指定しないで判定

```sh
akari config endpoints probe
```

**期待**: 埋め込みモデル（`nomic-embed-…` など）を**飛ばして**会話用モデルを選ぶ。
`判定に使ったモデル` が埋め込みモデルになっていたら不具合。

### 3-3. モデルごとに覚えているか

```sh
akari config endpoints probe -m qwen3.5-agents-a1-4b
akari config endpoints probe -m lfm2.5
akari doctor
```

**期待**: `doctor` の「判定済みのモデル」に**2つとも**出る。
1つしか出ない、または最初に測ったものしか出ないなら不具合。

### 3-4. 文脈長

```sh
akari config endpoints probe -m <モデルID>
```

**期待**: `文脈長: 32,768 トークン（サーバの申告）` のように出る。

**出なければ**: LM Studio 固有の口（`/api/v0/models`）から取れていない。手で入れられる:

```sh
akari config endpoints probe -m <モデルID> --context 32768
```

### 3-5. 全体の状態

```sh
akari doctor
akari doctor --no-probe          # 問い合わせず設定だけ
akari doctor --export /tmp/diag.txt
cat /tmp/diag.txt
```

**期待**: 書き出したファイルに**APIキーと会話本文が入っていない**。
入っていたら重大な不具合なので、そこで止めて報告してほしい。

---

## 4. エージェント実行

**ここからファイルが変わる。** サンドボックスの中でやること。

```sh
cd /tmp/akari-sandbox
```

### 4-1. まず読ませるだけ

```sh
akari run --read-only "src/main.ts が何をしているか説明して" -m <モデルID>
```

**期待**: `read_file` などが呼ばれ、中身を踏まえた説明が返る。ファイルは変わらない。
ヘッダに `ツール: 読み取りのみ 4種（--read-only）` と出る。

**モデルが道具を呼ばずに答えたら**: そのモデルはツール呼び出しができていない。3-1 の結果と突き合わせる。

### 4-2. 道具を渡さない

```sh
akari run --no-tools "ソートの関数を書いて" -m <モデルID>
```

**期待**: **実行前に**次の表示が出る。コードは本文として出るだけで、保存されない。

```
ツールを渡していないため、ファイルの読み書きとコマンド実行はできません。
ファイルを触らせるには --no-tools を外してください。
```

### 4-3. 承認つきで書き換える（既定）

```sh
akari run "src/main.ts の timeout を 5000 に変えて" -m <モデルID>
```

**期待**: 差分つきの承認画面が出る。

```
  承認が必要です
    src/main.ts を書き換えます。
    -export const timeout = 1000;
    +export const timeout = 5000;
    [y] 許可   [a] この実行中は … を許可   [n] 拒否   [q] 実行を中止
```

- `y` で1回だけ許可
- `n` で拒否。**理由を1行入力できる**。その理由がモデルへ渡る
- `q` で実行ごと中止

### 4-4. 編集は自動、コマンドは承認

```sh
akari run -y "README.md に使い方の節を足して" -m <モデルID>
```

**期待**: 書き換えは聞かれない。`run_command` を使おうとしたときだけ聞かれる。

### 4-5. すべて自動

```sh
akari run --permission full "src/main.ts に足し算の関数を足して" -m <モデルID>
```

**期待**: 何も聞かれずに終わる。ただし `delete_file` だけは `full` でも必ず聞かれる。

### 4-6. 削除は必ず聞く

```sh
akari run --permission full "README.md を消して" -m <モデルID>
```

**期待**: `full` なのに承認画面が出る。**出なければ不具合**。

モデルが `delete_file` を使っても、`rm` などのコマンドを使っても、どちらでも聞かれる。
コマンドのときは「ファイルを削除するコマンド（rm）です。コマンドで消したファイルは
akari undo で戻せないため、確認します。」と理由が出る。

承認で `n`（拒否）を選んだ後、モデルが別の手で消そうとしても、
`断られた操作があったため、この実行の残りではコマンドを自動で実行しません` と出て、
以降のコマンドも全部聞かれる。**ファイルが消えていたら不具合。**

対話できない場所で試す（`< /dev/null`）と、どちらも自動で拒否され、ファイルは残り、終了コード3。

### 4-7. コマンドを実行させる

```sh
akari run --permission full "git status を実行して結果を教えて" -m <モデルID>
```

**期待**: コマンドの出力が流れながら出る。

### 4-8. ステップ上限

```sh
akari run --max-steps 2 "たくさんのファイルを1つずつ読んで" -m <モデルID>
echo "終了コード: $?"
```

**期待**: 2ステップで止まり、**終了コード5**。`ステップ上限（2）に達しました。` と出る。

### 4-9. 中断

```sh
akari run "長い作業をして" -m <モデルID>
# 途中で Ctrl+C
```

**期待**: 1回で中断（そこまでの変更は残る、終了コード130）。もう一度で即終了。

### 4-10. プロンプトの渡し方

```sh
akari run "直して"                       # 引数
akari run -p "直して"                    # オプション
echo "直して" | akari run                # 標準入力
echo "直して" | akari run -p -           # 明示的に標準入力
akari "直して"                           # run を省略できる
```

**期待**: 全部同じように動く。

### 4-11. 道具の渡し方を決め打ちする

```sh
akari run --tools-mode both     "README を読んで要約して" -m <モデルID>
akari run --tools-mode native   "…" -m <モデルID>
akari run --tools-mode prompted "…" -m <モデルID>
```

**期待**: ヘッダに `ツール: 8種 / 両対応`（または `関数呼び出し` / `本文ブロック（代替方式）`）と出る。
`--tools-mode` を付けると**判定が走らない**ぶん、実行の開始が速い。

判定が `判定できていません` だったモデルでも、`both` なら道具を使って動く。
`Agents-A1-4B` はここが本命。

---

## 5. 安全性（ここは必ず全部やってほしい）

**どれか1つでも通ってしまったら、そこで止めて報告してほしい。**

### 5-1. 作業フォルダの外へ出られない

```sh
akari run --permission full "../secret.txt に何か書いて" -m <モデルID>
```

**期待**: 承認画面**すら出ずに**拒否される。`作業フォルダの外` と出る。

モデルがその後コマンド（`echo … > ../secret.txt` など）で書こうとしたら、
`断られた操作があったため…` と出て承認を求められるはず。ただし、**最初からコマンドで
書かれると `full` では止まらない**（既知の限界。下の表を参照）。

### 5-2. シンボリックリンクでも出られない

```sh
ln -s /tmp /tmp/akari-sandbox/escape
akari run --permission full "escape/pwned.txt に書いて" -m <モデルID>
ls /tmp/pwned.txt      # 無いこと
```

**期待**: 拒否される。`/tmp/pwned.txt` ができていないこと。

### 5-3. 秘密ファイルを読めない

```sh
akari run --read-only ".env の中身を教えて" -m <モデルID>
```

**期待**: 読めない。`SECRET=abc123` が出てこないこと。

### 5-4. .git の中を書き換えられない

```sh
akari run --permission full ".git/config を書き換えて" -m <モデルID>
```

**期待**: 拒否される。

### 5-5. 危ないコマンドは full でも通らない

```sh
akari run --permission full "git reset --hard を実行して" -m <モデルID>
```

**期待**: `拒否リストの "git reset --hard" に一致` と出て実行されない。

拒否リストの中身:

```sh
akari config get agent.deniedCommands
```

### 5-6. 広すぎる場所では実行しない

```sh
akari run -C ~ "何かして" -m <モデルID>
echo "終了コード: $?"
```

**期待**: `ホームディレクトリそのものを作業フォルダにはできません` と断られる。終了コード2。

### 5-7. 対話できない場所では自動で拒否

```sh
akari run --permission ask "README.md を書き換えて" -m <モデルID> < /dev/null
echo "終了コード: $?"
```

**期待**: 勝手に書かず、**終了コード3**で終わる。

---

## 6. 変えたものを見る・戻す

### 6-1. 何を変えたか

```sh
akari diff                      # 直近の実行
akari diff --run <実行ID>
akari diff --path src/main.ts   # 1ファイルだけ
```

### 6-2. 過去の実行

```sh
akari runs
akari runs --limit 5
```

**期待**: 実行ID・日時・変更ファイル数が並ぶ。

### 6-3. 元に戻す

```sh
akari undo          # 確認あり
akari undo -y       # 確認なし
akari undo --run <実行ID>
```

**期待**: ファイルが実行前の状態に戻る。`git diff` で確認できる。

### 6-4. 手で直したファイルは上書きしない

```sh
akari run --permission full "src/main.ts の timeout を 9999 に変えて" -m <モデルID>
echo "// 自分で足した行" >> src/main.ts     # 実行後に手で編集
akari undo -y
```

**期待**: そのファイルは**戻されず**、「実行後に手で変更されています」と理由が出る。
自分の編集が消えていないこと。終了コードは0（戻せなかったことは異常ではなく、報告して終わる）。

### 6-5. 複数回変えてから戻す

```sh
akari run --permission full "timeout を 2000 に" -m <モデルID>
akari run --permission full "timeout を 3000 に" -m <モデルID>
akari undo -y      # 直近の実行だけ戻る（2000 に戻る）
```

**期待**: 実行1回ぶんだけ戻る。全部まとめて最初に戻ったりしない。

---

## 7. 出力の形式

### 7-1. 機械可読

```sh
akari --json run -p "README を読んで" -m <モデルID> > /tmp/events.ndjson
cat /tmp/events.ndjson | while read -r l; do echo "$l" | python3 -c "import json,sys;json.load(sys.stdin)" || echo "壊れた行: $l"; done
tail -1 /tmp/events.ndjson
```

**期待**: 全行が単独のJSONとして読める。最後の行が `run-end`。
人向けの装飾行が標準エラーにも出ない。

### 7-2. 静かに

```sh
akari -q chat -p "1+1は？"
```

**期待**: 最終的な出力だけ。

### 7-3. パイプで切っても壊れない

```sh
akari --json chat -p "長めに説明して" | head -2
echo "終了コード: ${PIPESTATUS[0]}"
```

**期待**: 終了コード0。`EPIPE` のスタックトレースが出ないこと。

### 7-4. 色を使わない

```sh
akari --no-color doctor
NO_COLOR=1 akari doctor
```

---

## 8. 設定

```sh
akari config list                             # 全部（鍵は伏せる）
akari config get agent.maxSteps
akari config set agent.maxSteps 40
akari config set agent.permissionMode full
akari config set agent.commandTimeoutMs 600000    # コマンドの上限を10分に
akari config set agent.deniedCommands '["rm -rf /","mkfs"]'
```

### 8-1. 範囲外は変更しない

```sh
akari config set agent.maxSteps 9999
echo "終了コード: $?"
akari config get agent.maxSteps       # 変わっていないこと
```

**期待**: 終了コード2。**有効な範囲を示して**終わる。設定は変わらない。

### 8-2. 無い項目

```sh
akari config set agent.nonexistent 1
echo "終了コード: $?"
```

**期待**: 終了コード2。

---

## 9. モデルの指定方法（4通り）

```sh
akari -m <モデルID> run "…"        # サブコマンドの前
akari run -m <モデルID> "…"        # 後ろ
export AKARI_MODEL=<モデルID>      # 環境変数
akari config endpoints add --name L --url … --model <モデルID>   # 接続先の既定
```

**期待**: 全部効く。強さは 引数 > 環境変数 > 接続先の既定 > サーバの先頭。

同じように接続先も指定できる:

```sh
akari -e L doctor
AKARI_ENDPOINT=L akari doctor
```

---

## 10. 異常系と終了コード

| 試すこと | コマンド | 期待コード |
|---|---|---|
| 正常 | `akari doctor` | 0 |
| 接続できない | サーバを止めて `akari chat -p x` | 4（10秒版は1） |
| 使い方の誤り | `akari run --nonexistent` | 2 |
| 知らない項目 | `akari config get x.y` | 2 |
| 承認できない | `akari run … < /dev/null` | 3 |
| ステップ上限 | `akari run --max-steps 1 …` | 5 |
| 同じ操作の繰り返しで停止 | （モデル次第。模擬サーバの台本で同じ呼び出しを3回） | 5 |
| 中断 | `Ctrl+C` | 130 |
| ヘルプ | `akari --help` | 0 |
| バージョン | `akari --version` | 0 |

```sh
akari doctor; echo "→ $?"
```

### 10-1. サーバが落ちているとき

LM Studio のサーバを止めてから:

```sh
akari doctor
akari chat -p "やあ"
echo "終了コード: $?"
```

**期待**: 「接続できません」＋ URLと起動の確認手順が出る。スタックトレースが出ないこと。

終了コードは版による:

| 版 | `models` | `chat` / `run` |
|---|---|---|
| 10秒版 | 4 | **1**（不一致。新版で修正済み） |
| 新版 | 4 | 4 |

### 10-2. 未実装のコマンド

```sh
akari serve
akari mcp
echo "終了コード: $?"
```

**期待**: `serve はまだ実装されていません。` のように出て、終了コード2。
**あるように見せかけて動かない、が最悪。** そうなっていたら報告してほしい。

---

## 11. 新版でだけ試せること（`git pull` が要る）

10秒版には入っていない。試すなら先に更新する。

```sh
git pull && pnpm install && pnpm build
```

### 11-1. 思考の量を変える

```sh
akari chat --think off  -p "1+1は？" -m qwen3.5-agents-a1-4b
akari chat --think high -p "難しい問題を考えて" -m qwen3.5-agents-a1-4b
akari run  --think off  "README を要約して" -m <モデルID>
```

**期待**: `off` なら思考が出ないぶん速く返る。`high` なら思考が長くなる。

**次のメッセージが出たら、指定は効いていない**（生成そのものは成功する）:

```
  ! この接続先は reasoning_effort を受け付けませんでした。外して送り直します（思考量の指定は効きません）。
```

**ここは実機で見たい**。どちらの口（`reasoning_effort` / `chat_template_kwargs`）が
LM Studio で通るかは確認できていない。上のメッセージが出るか出ないかを、
モデルごとに教えてほしい。

### 11-2. 読み込み状態が見える

```sh
akari models
```

**期待**: `状態` の列に `読込済` / `未読込` が出る。

### 11-3. 待ち時間を延ばす

```sh
akari run --timeout 900 "…"                  # この1回だけ15分
akari config endpoints set --timeout 900     # 以後ずっと15分
```

`endpoints set` は接続先のIDと判定結果を保つ。
（10秒版には `set` が無いので、`rm` して `add` し直すしかなく、判定結果が消える）

### 11-4. 応答ヘッダの待ち

10秒版では、**モデルの読み込み待ちが「サーバが10秒以内に応答しませんでした」で切られる**ことがある。
新版ではこれが `--timeout` の範囲に入る。

10秒版で「接続できない」と言われたら、**モデルを先に読み込んでから**もう一度試すと通ることがある。

### 11-5. 会話の保存と続き

```sh
cd /tmp/akari-sandbox
akari run --permission full "src/main.ts を読んで、何をしているか覚えておいて" -m <モデルID>
akari conversations
akari run -c "さっき読んだファイルに何が書いてあった？" -m <モデルID>
```

**期待**:
- 1回目の実行の最初に `会話: 01…（新規）`、最後に `続けるには: akari run -c "…"` と出る
- `akari conversations` に、その会話が `run` として出る（作業フォルダとタイトル付き）
- 2回目は `会話: 01… の続き（これまで N 件）` と出て、**モデルが前回読んだ中身を覚えている**
  （ファイルを読み直さずに答えられれば、前のやり取りが渡っている）

```sh
akari conversations show <ID>              # 中身を見る
akari conversations show <ID> --reasoning  # 思考も見る（Qwen3 系なら出る）
```

**期待**: 入力・応答・道具の呼び出しと結果が順に出る。実行ごとに `── 実行 01…（完了）` の区切りが入る。

**別のフォルダでは続けられない**:

```sh
cd /tmp && akari run -c "続けて" -m <モデルID>
echo "終了コード: $?"
```

**期待**: 「続ける会話がありません」と出て終了コード2。`--conversation <ID>` で指定した場合は、
正しいフォルダ（`-C …`）を案内して終了コード2。

**落ちても残る**:

```sh
cd /tmp/akari-sandbox
akari run "長い説明を書いて" -m <モデルID>
# 応答が流れている途中で Ctrl+C を2回（即座に終了させる）
akari conversations show <ID>
```

**期待**: 途中までの応答が `途中で止まった（プロセスが終了）` の印付きで残っている。

**保存しない・消す**:

```sh
akari run --no-save --no-tools "保存しないで" -m <モデルID>   # 一覧に増えない
akari conversations rm <ID>                                    # 確認のあとゴミ箱へ
```

### 11-6. 文脈の圧縮（P2）

早めに圧縮が起きるようにしてから、ファイルを何度も読ませる。

**どの設定が効くかは、そのモデルの文脈長が分かっているかで変わる。** 実行の最初に出る `文脈:` の行で確かめる。

```
文脈: 長さ 32,768 / 約19,660〜22,937トークンを超えたら圧縮（context.compactAtRatio 0.7 …）   ← 文脈長が分かっている
文脈: 長さ不明 / 約12,000トークンを超えたら圧縮（context.compactAtTokens）                    ← 分からない
```

- 文脈長が分かっている（LM Studio・OpenRouter はふつうこちら）→ **`compactAtTokens` は効かない。**
  いちばん簡単なのは、文脈長を小さく入れ直すこと（試し終わったら元に戻す）:
  ```sh
  akari config endpoints probe -m <モデルID> --context 8000
  ```
  または割合を下げる: `akari config set context.compactAtRatio 0.3`（文脈長が大きいモデルでは、これでも届かないことがある）
- 文脈長が分からない → `akari config set context.compactAtTokens 3000`

```sh
akari config endpoints probe -m <モデルID> --context 8000
akari config set context.keepRecentTurns 1
cd /tmp/akari-sandbox
for i in 1 2 3 4 5; do seq 1 300 | sed "s/^/$i: 行 /" > part$i.txt; done
echo "合言葉はりんごパイ" >> part1.txt
akari run --read-only "read_file で part1.txt を全行読んでから、最後の行を教えて" -m <モデルID>
for i in 2 3 4 5; do
  akari run -c --read-only "read_file で part$i.txt を全行読んでから、最後の行を教えて" -m <モデルID>
done
```

`--read-only` で読み取りの道具だけを渡すのは、コマンドを渡すと `tail -n 1` で最後の1行だけを取る
モデルがあるため（gemma-4-e4b。同じ指示でも実行ごとに `read_file` と `tail` が入れ替わり、
「read_file で」と書いても無視されることがあった）。それだと文脈が増えず、圧縮が起きない。
読み取りの道具は承認が要らないので、`--permission` は付けなくてよい。

小さいモデルでは時間がかかる。lfm3-1.7b は圧縮版を書けず、1回の実行に6〜13分かかった（2026-10-28）。

1ファイルずつ別の実行で読ませるのは、圧縮できる「古い手」を作るため。1回で5ファイルを頼むと、
モデルによっては1手でまとめて読み、それが「直近の手」なので圧縮できない。そのときは圧縮ではなく、
`文脈に入りきらないため、道具の出力 N 件を…切り詰めました（短いもので 2000 字…）` が出て続く
（これも正しい動き。ただし圧縮の試験にはならない）。

**期待**:
- 2本目以降のどこかで `⧉ 文脈が約…トークンになったため、古い N 手を圧縮しています…` と `⧉ 圧縮しました` が出る
- 圧縮のあとも作業が続き、各実行がその回のファイルの最後の行を答える（同じファイルを読み直し続けたりしない）
- 読み取りだけでも、`read_file` の offset で末尾だけを読むなど、全体を読まずに済ませるモデルはありうる。
  圧縮が1度も出なければ試験にならないので、そのときはモデルを変えるか、`context.compactAtRatio` を下げる

```sh
akari digest
```

**ここがいちばん見たいところ**: 5分類（決定・確認済み・棄却案・未解決・次の行動）が、**中身のある文**で埋まっているか。
`機械的な要約で残しています` と出ていたら、そのモデルは決められた形で圧縮版を書けなかった。
**モデルごとに、どちらになったかを教えてほしい。** 4B級のモデルで書けるかどうかは、まだ誰も確かめていない。

```sh
akari recall "りんごパイ"                       # 圧縮済みの part1 の中身が見つかる
akari run -c --read-only "part1.txt の合言葉は何だった？" -m <モデルID>
```

**期待**: `recall` で「圧縮済み」の印付きで見つかる。続きでは、モデルが圧縮版か `recall_search` を使って
「りんごパイ」と答える（ファイルを読み直して答えてもよいが、読み直さずに答えられれば recall が効いている）。

終わったら設定を戻す（文脈長は、元の値を `akari models` で確かめて入れ直す）:

```sh
akari config endpoints probe -m <モデルID> --context <元の文脈長>
akari config set context.compactAtRatio 0.7
akari config set context.compactAtTokens 12000
akari config set context.keepRecentTurns 3
```

**読み取りの上限に注意**: `read_file` は既定で2000行までしか読まない。それより長いファイルで試すと、
読まれなかった部分は圧縮の対象にも入らない。

### 11-7. 対話画面（`akari`）

**これは人が端末で触る試験。** Muse の台本（パイプの中）では画面が出ないので、手で試す。
模擬サーバでの動きはこちらで疑似端末を使って確かめてある。**見てほしいのは、こちらで試せない端末ごとの違い**。

```sh
git pull && pnpm install && pnpm build    # Node 22 以上が要る（node --version で確かめる）
cd /tmp/akari-sandbox
akari -m <モデルID>
```

使っている端末アプリの名前（ターミナル / iTerm2 / Ghostty など）を報告に書いてほしい。

| 試すこと | 期待 |
|---|---|
| 起動直後 | 枠の中に接続先・モデル・作業フォルダ・権限・会話。下に入力欄と状態の行 |
| **日本語を変換しながら打つ** | 変換中の文字が入力欄のカーソルの位置に出る。確定後に文字がずれたり、二重になったりしない |
| `Shift+Enter` | 改行になる（送られない）。**macOS 標準のターミナルでは効かない**（Enter と同じ信号しか来ないため） |
| `Ctrl+J` | 改行になる（どの端末でも効くはず） |
| `一行目\` と打って Enter | `\` が消えて改行になる（送られない） |
| `read_file で README.md を読んで要約して` と送る | 道具の行と ✓ が出て、応答が流れ、最後に `完了  N秒` |
| `hello.txt に挨拶を書いて` と送る | 差分つきの承認の枠。↑↓ で選べ、`y` で書かれる。`n` なら理由を1行入れられる |
| 生成中に `Esc` | 止まって `中断` と出る。入力欄に戻る |
| `Shift+Tab` | 状態の行の権限が「承認する → 編集は自動 → すべて自動」と変わる |
| `/help` → `/undo` → `y` | 直前の1回の変更が戻る |
| `Ctrl+C` を2回 | 終わって `続けるには: akari -c  （会話 …）` と出る。**その行の先頭や画面のどこかに `u` などの余計な文字が出ないか** |
| `akari -c` | `会話: … の続き（これまで N 件）` で始まり、前の話を覚えている |
| 白い背景と黒い背景の端末 | 黄緑の枠と文字が、どちらでも読める |
| `cd ~ && akari` | `ホームディレクトリそのものを作業フォルダにはできません` と出て、道具なしの会話で始まる |

**終了時の `u` について**: Shift+Enter を見分けるため、起動時に端末へ「キーを区別して送って」と頼み、
終了時に元へ戻している（kitty キーボード方式）。対応していない端末はこの頼みを無視するはずだが、
macOS 標準のターミナルで本当に無視されるかは確かめていない。余計な文字が出たら教えてほしい。

---

## 12. 報告してほしいこと

うまくいかなかったときは、次があると原因が追える。

```sh
akari doctor --export /tmp/diag.txt      # 鍵と会話本文は入らない
```

- どのモデルで、どのコマンドを打ったか
- 出たメッセージ（そのまま）
- 終了コード（`echo $?`）
- `/tmp/diag.txt`

スタックトレースが要るときだけ:

```sh
AKARI_DEBUG=1 akari run "…"     # 鍵は伏字になる
akari --verbose run "…"         # ログを debug に
```

---

## 既知の問題（報告不要）

| 症状 | 状況 |
|---|---|
| モデルの読み込み中に「サーバが10秒以内に応答しませんでした」 | 10秒版の問題。新版で修正済み |
| 判定が `判定できていません` だと `run` が動かない | 10秒版の問題。新版は両対応で実行する |
| `Agents-A1-4B` が `tool_calls` を返さない | モデルの配布物にツール用テンプレートが無いため。Akari 側の不具合ではない。代替方式で動く |
| サーバが落ちているとき `chat` / `run` の終了コードが 1（`models` は 4） | 10秒版の不一致。新版で 4 に統一済み |
| `akari config keys rm …` が動かない | `endpoints rm` の案内文が、まだ無いコマンドを指している |
| `full` のとき、コマンド（`cat .env` など）なら作業フォルダの外や秘密ファイルを読み書きできる | 作業フォルダの境界はファイルの道具にしか効かない。コマンドを閉じ込める仕組みはまだ無い（ロードマップ P3+） |
| LM Studio で読み込まれていないモデルを指定すると失敗する / 遅い | サーバ側がその場で読み込むため。新版では `akari models` に `読込済`/`未読込` が出る。先に読み込んでおくのが確実 |

---

## 後片付け

```sh
rm -rf /tmp/akari-test /tmp/akari-sandbox /tmp/diag.txt /tmp/events.ndjson
```

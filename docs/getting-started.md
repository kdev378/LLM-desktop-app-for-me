# 動かし方（P1 時点）

現在できるのは **CLI から、ローカルLLMと会話すること**と、
**エージェントに作業フォルダの中で手を動かさせること**まで。
デスクトップアプリ、ハーネスAPI、MCP、記憶、Web はまだ無い（`docs/spec/11-roadmap.md`）。

## 用意するもの

- Node.js 20 以上
- pnpm 9 以上（`corepack enable pnpm` で入る）
- ローカルLLMサーバ 1つ。無くても、同梱の模擬サーバで一通り試せる。

## 準備

```sh
pnpm install
pnpm build
```

以降、`node apps/cli/dist/index.js` が `akari` コマンドにあたる。
短くしたいなら `alias akari="node $PWD/apps/dist/index.js"`（パスは各自の環境に合わせる）。

## 本物のローカルLLMに繋ぐ

サーバごとの既定URL:

| サーバ                     | ベースURL                   |
| -------------------------- | --------------------------- |
| Ollama                     | `http://localhost:11434/v1` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1`  |
| LM Studio                  | `http://localhost:1234/v1`  |
| vLLM                       | `http://localhost:8000/v1`  |

```sh
node apps/cli/dist/index.js config endpoints add \
  --name "ローカル" --url http://localhost:11434/v1

node apps/cli/dist/index.js doctor     # 到達するか、何に対応しているか
node apps/cli/dist/index.js models     # モデル一覧
node apps/cli/dist/index.js chat       # 対話（/exit で終了）
```

期待される結果:

- `doctor` … 接続先の行が緑の `●` になり、`/models: N件` と、ツール呼び出しに対応しているかが出る。
- `models` … モデル名が並ぶ。
- `chat` … `> ` が出て、入力するとトークンが少しずつ流れて表示される。`Ctrl+C` で生成を止められる。

繋がらないときは、原因の種類（到達不可 / 鍵 / 非互換）が分けて表示される。
`akari doctor --export akari-diagnostics.txt` で、鍵と会話本文を除いた診断が1ファイルに出る。

## 本物が無いときの確認（模擬サーバ）

```sh
node tools/mock-llm-server.mjs 11499       # 別の端末で起動したままにする
```

```sh
export AKARI_HOME=/tmp/akari-try           # 本番の設定を汚さない
node apps/cli/dist/index.js config endpoints add --name "模擬" --url http://127.0.0.1:11499/v1
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js chat -p "テストです"
```

模擬サーバは入力をなぞった固定文を返すだけで、モデルは動いていない。
Akari 側の挙動（ストリーム表示、エラー分類、設定、診断）を確かめるためのもの。

### エージェントの動きを試す

模擬サーバに台本を渡すと、決まった順でツールを呼ばせられる。

```sh
AKARI_MOCK_SCRIPT='[
  {"name":"read_file","arguments":{"path":"main.ts"}},
  {"name":"edit_file","arguments":{"path":"main.ts","oldText":"1000","newText":"5000"}},
  {"text":"直しました"}
]' node tools/mock-llm-server.mjs 11499
```

## エージェントに手を動かさせる

```sh
cd ~/なにかのリポジトリ
node /path/to/apps/cli/dist/index.js run "README のtypoを直して"
```

期待される結果:

- 使う接続先・モデル・作業フォルダ・権限モードが最初の1行に出る。
- ツールを使うたびに `read_file main.ts` のような行が出て、結果が `✓` / `✗` で続く。
- **ファイルを書き換える前と、コマンドを実行する前に承認を求められる。**
  差分が出るので、見てから `y`（許可）/ `a`（以後このファイルは許可）/ `n`（拒否）/ `q`（中止）を選ぶ。
- 終わると「変更したファイル」と、元に戻すコマンドが出る。

```sh
akari diff        # その実行が何を変えたか
akari undo        # 元に戻す（確認あり。-y で確認なし）
akari runs        # 過去の実行の一覧
```

### 安全の仕組み（実際に確かめられます）

| やってみること | 起きること |
|---|---|
| `akari run -C ~ "…"` | ホームディレクトリは範囲が広すぎるので断られる |
| モデルが `../` で外を触ろうとする | 承認画面すら出ずに拒否される（`--permission full` でも） |
| `akari run "…" < /dev/null`（パイプの中） | 承認が要る操作は自動で拒否され、終了コード3で終わる |
| 実行後に自分でファイルを直してから `akari undo` | そのファイルは上書きされず「手で変更されています」と報告される |

### 権限モード

| 指定 | 読み取り | 書き込み | コマンド | 削除 |
|---|---|---|---|---|
| （既定）`--permission ask` | 自動 | 承認 | 承認 | 承認 |
| `--permission auto-edit`（`-y`） | 自動 | 自動 | 承認 | 承認 |
| `--permission full` | 自動 | 自動 | 自動 | 承認 |

`full` でも、作業フォルダの外と拒否リストのコマンドは通りません。

## いま使えるコマンド

| コマンド | 何をするか |
|---|---|
| `config endpoints add/list/rm/use/probe` | 接続先の登録・切替・機能判定 |
| `config list/get/set` | 設定の確認と変更（範囲外の値は変更せずに拒否する） |
| `models` | モデル一覧 |
| `chat` | 対話。ファイルは触らない |
| `run` | エージェント実行。作業フォルダの中だけ |
| `diff` / `undo` / `runs` | 実行が変えたものの確認・取り消し・一覧 |
| `doctor` | 状態の確認。`--export` で診断の書き出し |

`serve`（ハーネスAPI）/ `mcp` / `index` / `web` は未実装。
実行すると「まだ実装されていません」と出る。

## 保存される場所

| OS      | 場所                                   |
| ------- | -------------------------------------- |
| Windows | `%APPDATA%\Akari\`                     |
| macOS   | `~/Library/Application Support/Akari/` |
| Linux   | `~/.config/akari/`                     |

`AKARI_HOME` で変えられる。中身は JSON なので、そのまま開いて読める。

**鍵について**: `credentials.json` に平文で保存される（ファイル権限600）。
暗号化ではない。外部APIの鍵は `--key-env 変数名` を使い、環境変数から読ませるほうがよい。

## 開発

```sh
pnpm typecheck      # 型検査
pnpm test           # 全テスト（core 99件 + CLI 21件）
pnpm format         # 整形
```

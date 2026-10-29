# 13 — MCP（使う側 / なる側）

MCP（Model Context Protocol）は、モデルに道具を渡すための共通の口。
Akari は**両方向**で使う。

| 方向 | 何をするか | 何のため |
|---|---|---|
| **使う側**（クライアント） | 外部のMCPサーバを登録し、そのツールをエージェントへ渡す | 道具を毎回自作しない |
| **なる側**（サーバ） | Akari のツールをMCP経由で外へ出す | Claude Code 等から、取り消し可能な編集を使える |

独自のプラグイン機構は作らない。**外への口はMCPひとつにする**（`00-overview.md`）。

---

## 使う側（MCPクライアント）

### 設定

`config.json` に足す。

```jsonc
{
  "mcpServers": [
    {
      "id": "mcp_fs",
      "name": "filesystem",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/docs"],
      "env": { "SOME_VAR": "value" },
      "cwd": null,
      "startupTimeoutMs": 15000,
      "toolTimeoutMs": 60000,
      "trust": "ask"
    },
    {
      "id": "mcp_remote",
      "name": "search",
      "enabled": true,
      "transport": "http",
      "url": "http://localhost:9000/mcp",
      "headers": {},
      "auth": { "type": "bearer", "token": "env:SEARCH_TOKEN" },
      "trust": "ask",
      "consent": { "fingerprint": "sha256:…", "at": "2026-10-29T…" }
    }
  ]
}
```

ヘッダの値と `auth.token` は `env:NAME`（環境変数から読む）で書ける。鍵を設定ファイルに平文で書かずに済むようにするため
（`03-config.md` の鍵の規則と同じ）。

| 項目 | 意味 |
|---|---|
| `transport` | `stdio`（子プロセス）または `http`（Streamable HTTP） |
| `trust` | `ask`（毎回承認。「この実行中は許可」も出さない）/ `readOnly`（読み取り注釈のあるツールだけ自動）/ `full`（権限モードに従う） |
| `startupTimeoutMs` | ここまでに `initialize` が返らなければ起動失敗として扱う |
| `toolTimeoutMs` | ツール1回の上限。超えたら中断して、その旨をモデルへ返す |
| `auth` | HTTP の認証。`{"type":"none"}`（既定）/ `{"type":"bearer","token":"env:NAME"}`。**`oauth` は後から足す**（下の「認証」） |
| `consent` | 利用者が同意したときの、起動する内容の指紋（下の「追加時の確認」）。無ければ起動しない |

### 認証（OAuth を後から足す前提）

今は `none` と `bearer`（固定の鍵をヘッダで送る）だけ。ブラウザでログインする OAuth は**まだ入れない**
（オーナー承認、2026-10-29）。理由: ログイン後に保存し続ける更新用トークンは長く使える鍵で、
Akari にはまだ鍵を暗号化してしまう場所（OS のキーチェーンなど）が無い。平文で増やさない。

後から足すための土台:

- `auth` は種類（`type`）で分ける形にしてある。`oauth` を足しても、ほかの種類と設定の形は変わらない
- 認証は「認証の担当」1か所（`core/mcp/auth.ts`）で作り、HTTP の接続に差し込む。
  公式 SDK の `AuthProvider`（要求のたびにトークンを返す）/ `OAuthClientProvider`（OAuth の一式）の口を使う。
  OAuth を足すときは、ここで `OAuthClientProvider` を返すだけにする
- トークンの保存先は「鍵の置き場」として差し替えられる形にする（今は環境変数を読むだけ。
  OAuth を足すときに、OS のキーチェーンを置き場として足す）
- OAuth を足すときに決めること: ログインの戻り先（localhost の一時的な待ち受け）、トークンの置き場、
  `akari mcp login <名前>` の操作

### ツール名の付け方

外部ツールは `mcp__<サーバ名>__<ツール名>` として、Akari 自身のツールと同じ表に並べる。

- 名前が衝突したら、後から登録した方に `_2` を付ける。黙って上書きしない。
- モデルへ渡せる名前は英数字・`_`・`-` で64文字まで（OpenAI互換の制限）。外れる文字は `_` にし、
  長すぎるものは末尾を短い指紋に置き換える。元の名前は説明文に残す。
- Akari 自身のツール名（`read_file` 等）は**予約**。MCPサーバがその名前を出しても、
  接頭辞が付くので衝突しない。

### 危険度の決め方

MCPサーバが何をするかは**Akari には分からない**。だから既定を厳しくする。

| 条件 | 危険度 |
|---|---|
| ツールに `readOnlyHint: true` の注釈がある | `read` |
| 注釈が無い、または `false` | **`execute`**（最も厳しい） |

- 注釈は**サーバの自己申告**であり、検証できない。
  `trust: "readOnly"` を選ぶことは「そのサーバの自己申告を信じる」と決めることであり、
  設定画面とCLIにそう書く。
- `trust: "ask"`（既定）では、注釈にかかわらず毎回承認を取る。
- 承認が要るかは、`trust` と Akari の権限モード（`05-agent.md`）の**厳しいほう**で決める。
  例: `trust: "full"` でも、権限が `ask` なら `execute` の道具は聞く。
- この実行で一度断った操作があれば、`trust: "full"`・権限 `full` でも実行系の MCP の道具は聞く
  （`run_command` と同じ。断られた後の迂回を止める）。
- 「この実行中は許可」は道具ごと（`mcp:<道具名>`）。何が対象かを Akari が知らないため、引数では分けない。
- MCPツールの実行も、Akari自身のツールと**同じ承認・同じログ・同じ上限**を通る。
  ただし**変更記録（取り消し）の対象にはならない**。何を書き換えたかを Akari が知らないため。
  承認画面とCLIに「この操作は取り消せません」と明示する。

### 起動と生存

- **会話の間は接続を保つ**（オーナー承認、2026-10-29）。対話画面は画面を閉じるまで、ヘッドレスの `run` と
  ハーネスAPI は1回の実行の間。送るたびに起動し直すと、毎回数秒待たされるため。
- 接続したときに `tools/list` を取る（続きのページも全部）。
- 起動に失敗したサーバは、**その実行では使わない**。エラーを1度表示し、他は続行する。
  1つのMCPサーバが壊れているだけで作業全体を止めない。
- `stdio` の子プロセスは、Akari の終了・実行の中断でプロセスグループごと終了させる。
  公式 SDK の stdio の接続は直接の子しか止めない（`npx` が起こした孫が残る）ので、ここだけ自前で作る。
- `stdio` の子プロセスには、Akari の環境変数をそのまま渡さない。`PATH` `HOME` など動くのに要るものと、
  設定の `env` だけを渡す（鍵らしい名前の変数を漏らさない）。
- MCP サーバは**コマンドの閉じ込め（`05-agent.md`）の外で動く**（オーナー承認、2026-10-29）。
  ファイル操作のサーバなどは、指定した場所を読む必要があるため。そのぶん追加時の確認で、制限を受けないことを示す。
- サーバの `stderr` はログへ流す（`mcp.stderr`、debug）。画面には出さない。
- 道具を渡さない実行（`--no-tools`、API の `tools: []`）では、MCP サーバにつながない（プログラムを起こさない）。
  読み取りのみ（`--read-only`）では、読み取りの注釈がある道具だけを渡す。
  対話画面を道具なしで起動した場合は、後から `/tools all` にしても MCP にはつながない（起動し直す）。
- ハーネスAPI の `tools` を指定したときは、名前を挙げた MCP の道具（`mcp__…`）だけを渡す。
  見つからない名前は実行の知らせに出す（実行の受け付け時点ではまだつないでいないので、断らない）。
- ツールの結果が `toolOutputLimitBytes` を超えたら、Akari自身のツールと同じ規則で切る。

### 追加時の確認

**MCPサーバを登録することは、そのプログラムを自分のPCで動かすことと同じ**。
`stdio` なら任意のコマンドが起動される。だから追加時に1度、次を示して同意を取る。

```
このMCPサーバを追加すると、次のコマンドがあなたのPCで実行されます。
  npx -y @modelcontextprotocol/server-filesystem /home/me/docs
このプログラムは Akari の作業フォルダの制限を受けません。
提供元を信頼できる場合だけ追加してください。
```

同意なしに追加しない。

- 同意したときの「起動する内容」（`transport` / `command` / `args` / `env` / `cwd` / `url`）の指紋を `consent` に残す。
  **後で設定ファイルの内容が変わっていたら、同意し直すまで起動しない**（オーナー承認、2026-10-29）。
  誰かが設定を書き換えて別のプログラムを動かす手口を塞ぐため。
- 設定ファイルを手で書いた・内容を変えた場合は、`akari mcp trust <名前>` で同じ確認を出して同意する。
  同意していないサーバは起動せず、実行の最初にそのことを出す（黙って飛ばさない）。
- 非対話（パイプの中）の `akari mcp add` / `trust` は、`-y` が無ければ断る。

### CLI

```sh
akari mcp add --name filesystem --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /home/me/docs
akari mcp add --name search --url http://localhost:9000/mcp --bearer-env SEARCH_TOKEN
akari mcp list                 # 登録済みと同意の状態（つながない。速い）
akari mcp tools <名前>          # そのサーバへつなぎ、ツール一覧と注釈を出す
akari mcp trust <名前>          # 手で書いた・変えた設定に同意する
akari mcp rm <名前>
akari mcp doctor               # 有効な全サーバへ接続して、起動時間とツール数を出す。失敗があれば終了コード1
```

- `add` の他のオプション: `--env 名前=値`（繰り返し可。値は `env:NAME` で書ける）、`--cwd`、
  `--header "名前: 値"`、`--trust ask|read-only|full`、`-y`。
- `list` はつながない（2026-10-29 変更）。`npx` で起こすサーバは一覧のたびに数秒かかるため、
  つながるか・ツール何件かは `doctor` で見る。

---

## なる側（AkariがMCPサーバになる）

```sh
akari mcp serve --workspace ~/proj                          # stdio、読み取りだけ
akari mcp serve --workspace ~/proj --permission auto-edit   # + ファイルの編集
akari mcp serve --workspace ~/proj --http --port 7802       # 未実装（下の「未解決」）
```

Claude Code や他のMCPクライアントから、Akari のツールを使えるようにする。
利点は、**Akari の安全装置がそのまま付いてくる**こと。

- パス境界（作業フォルダの外は拒否）
- 変更前のバックアップと、実行単位の取り消し
- 変更記録

### 出すツール

`05-agent.md` のツールから、次を出す。

| ツール | 注釈 |
|---|---|
| `read_file` `list_dir` `glob` `grep` | `readOnlyHint: true` |
| `write_file` `edit_file` | `readOnlyHint: false`, `destructiveHint: true` |
| `run_command` | `readOnlyHint: false`, `destructiveHint: true` |
| `memory_search` | `readOnlyHint: true`（`14-memory.md`）。**記憶（P5）ができてから出す** |
| `akari_undo_last` | この接続の変更（前回 `akari_undo_last` した後の分）をまとめて戻す。`--permission` が auto-edit 以上のとき |
| `akari_changes` | この接続で変更したファイルと差分（`readOnlyHint: true`） |

`delete_file` は**出さない**。MCP経由では承認の相手が誰か分からないため。
同じ理由で、`run_command` でもファイルを削除するコマンド（`rm` など。`05-agent.md` の判定と同じ）は実行しない。

- `akari_undo_last` で戻した後の変更は、新しい記録に書く（同じ記録を2度戻そうとして、
  「手で変えられた」と誤って飛ばすのを避ける）。
- 秘密のファイル（`.env` など）は読めない。許可を求める道具（`request_secret_access`）は出さない
  （承認する人がいないため）。読ませたいなら設定の `agent.sandbox.allowWorkspaceSecrets`。
- `run_command` には Akari の閉じ込め（`05-agent.md`）がそのまま効く。

### 承認

MCPクライアント側には Akari の承認UIが無い。そこで:

- 既定は `--permission readOnly`。読み取りツールだけを公開する。
- 書き込み・実行を出すには `--permission autoEdit` / `--permission full` を明示する。
  起動時に、何が承認なしで実行されるかを標準エラーへ一覧表示する。
- どのモードでも、パス境界と変更記録は必ず効く。ここは外せない。

### セッション

MCPの1接続を1つの「実行」として扱い、変更記録をまとめる。
記録は最初に書く道具を呼んだときに作る（読むだけの接続で空の記録を増やさない）。
記録は変更のたびに書き出すので、接続が切れたときに確定し直すことは無い。
`akari runs` に「MCP経由」として並び、`akari diff` / `akari undo --run <ID>` がそのまま使える。
変更記録（`journal.json`）には任意の項目 `"origin": "mcp"` を足した（無ければ Akari 自身の実行。形式の版は上げない）。

標準出力は MCP の通り道なので、`mcp serve` の案内は全部標準エラーへ出す。

---

## 未解決

- MCPの仕様はまだ動いている。実装時点の最新仕様を確認してから作る
  （`context/generic/dependencies-and-research.md`: 一次資料を見る）。
  ここに書いたフィールド名は、実装前に必ず現物と突き合わせる。
- `http` transport の認証方式（使う側）。`none` / `bearer` は入れた。OAuth は上の「認証」。
- **なる側の HTTP（`mcp serve --http`）は未実装**（2026-10-29）。Claude Code などは stdio で起こすので、
  まず stdio だけにした。HTTP で出すなら、ハーネスAPIと同じ守り（127.0.0.1 だけ、Host / Origin の検査、トークン）と、
  公式 SDK の HTTP の口（`@modelcontextprotocol/node`）を足す。今は `--http` を付けると、未実装と言って終わる。
- 使う側で `resources` と `prompts` を扱うかは未定。まず `tools` だけ（2026-10-29、道具だけで始める）。
  サーバからの `sampling`（モデル呼び出しの依頼）と `elicitation`（利用者への問い合わせ）も、まだ受けない。
- 道具の結果のうち、画像・音声は「〜があった」とだけ伝える（モデルへ渡す形をまだ持たない）。

## 実装メモ（2026-10-29）

- 公式の TypeScript SDK v2（`@modelcontextprotocol/client` / `@modelcontextprotocol/server`）を使う。
  2026-07 に正式版。プロトコルの版は 2025-11-25 から 2024-11-05 まで話せる。
  手順を自作すると、仕様が動くたびに追いかける必要があり、相手との食い違いの元になるため。
- 例外: `stdio` の接続（上の「起動と生存」）。

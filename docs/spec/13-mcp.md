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
      "trust": "ask"
    }
  ]
}
```

| 項目 | 意味 |
|---|---|
| `transport` | `stdio`（子プロセス）または `http`（Streamable HTTP） |
| `trust` | `ask`（毎回承認）/ `readOnly`（読み取り注釈のあるツールだけ自動）/ `full`（全部自動） |
| `startupTimeoutMs` | ここまでに `initialize` が返らなければ起動失敗として扱う |
| `toolTimeoutMs` | ツール1回の上限。超えたら中断して、その旨をモデルへ返す |

### ツール名の付け方

外部ツールは `mcp__<サーバ名>__<ツール名>` として、Akari 自身のツールと同じ表に並べる。

- 名前が衝突したら、後から登録した方に `_2` を付ける。黙って上書きしない。
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
- MCPツールの実行も、Akari自身のツールと**同じ承認・同じログ・同じ上限**を通る。
  ただし**変更記録（取り消し）の対象にはならない**。何を書き換えたかを Akari が知らないため。
  承認画面とCLIに「この操作は取り消せません」と明示する。

### 起動と生存

- 実行の開始時に、有効なサーバへ接続して `tools/list` を取る。
- 起動に失敗したサーバは、**その実行では使わない**。エラーを1度表示し、他は続行する。
  1つのMCPサーバが壊れているだけで作業全体を止めない。
- `stdio` の子プロセスは、Akari の終了・実行の中断でプロセスグループごと終了させる。
- サーバの `stderr` はログへ流す（`mcp.stderr`）。画面には出さない。
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

同意なしに追加しない。設定ファイルを手で書いた場合は、初回起動時に同じ確認を出す。

### CLI

```sh
akari mcp add --name filesystem --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /home/me/docs
akari mcp add --name search --url http://localhost:9000/mcp
akari mcp list                 # 登録済み。接続できるか、ツール何件か
akari mcp tools <名前>          # そのサーバのツール一覧と注釈
akari mcp rm <名前>
akari mcp doctor               # 全サーバへ接続して、起動時間とツール数を出す
```

---

## なる側（AkariがMCPサーバになる）

```sh
akari mcp serve --workspace ~/proj                 # stdio
akari mcp serve --workspace ~/proj --http --port 7802
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
| `memory_search` | `readOnlyHint: true`（`14-memory.md`） |
| `akari_undo_last` | 直前のMCP経由の変更をまとめて戻す |
| `akari_changes` | このセッションで変更したファイルと差分 |

`delete_file` は**出さない**。MCP経由では承認の相手が誰か分からないため。

### 承認

MCPクライアント側には Akari の承認UIが無い。そこで:

- 既定は `--permission readOnly`。読み取りツールだけを公開する。
- 書き込み・実行を出すには `--permission autoEdit` / `--permission full` を明示する。
  起動時に、何が承認なしで実行されるかを標準エラーへ一覧表示する。
- どのモードでも、パス境界と変更記録は必ず効く。ここは外せない。

### セッション

MCPの1接続を1つの「実行」として扱い、変更記録をまとめる。
接続が切れたら記録を確定する。`akari runs` に `mcp` として並ぶ。

---

## 未解決

- MCPの仕様はまだ動いている。実装時点の最新仕様を確認してから作る
  （`context/generic/dependencies-and-research.md`: 一次資料を見る）。
  ここに書いたフィールド名は、実装前に必ず現物と突き合わせる。
- `http` transport の認証方式。ローカル前提なので当面はヘッダ直書きで足りるが、
  外部のMCPサーバを使うなら鍵の扱いを `03-config.md` の規則に合わせる必要がある。
- 使う側で `resources` と `prompts` を扱うかは未定。まず `tools` だけ。

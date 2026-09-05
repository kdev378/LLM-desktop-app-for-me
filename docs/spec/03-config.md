# 03 — 設定と資格情報

## 置き場所

| OS | 設定・データの根 |
|---|---|
| Windows | `%APPDATA%\Akari\` |
| macOS | `~/Library/Application Support/Akari/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/akari/` |

環境変数 `AKARI_HOME` が設定されていれば、それを根として使う（テストと持ち運び用）。
デスクトップとCLIは**同じ根**を使う。片方で追加した接続先が、もう片方でそのまま見える。

```
<root>/
  config.json          # 設定。秘密を含まない
  credentials.json     # 鍵のみ。パーミッション 0600
  server.json          # ハーネスAPIのトークンとポート。パーミッション 0600
  conversations/
  projects/
  backups/             # 実行ごとの変更前バックアップと journal.json
  worktrees/           # 実行ごとの git worktree（12-harness-api.md）
  index/               # ベクトル索引（14-memory.md）
  logs/
  akari.lock           # 多重起動の検出用
```

## config.json

```jsonc
{
  "schemaVersion": 1,
  "endpoints": [
    {
      "id": "ep_local",
      "name": "ローカル (Ollama)",
      "baseUrl": "http://localhost:11434/v1",
      "apiKeyRef": null,
      "defaultModel": "qwen2.5-coder:14b",
      "headers": {},
      "timeoutMs": 120000,
      "capabilities": { "tools": "auto", "vision": "auto", "usageReported": false, "streamsToolCalls": false }
    }
  ],
  "activeEndpointId": "ep_local",
  "generation": { "temperature": 0.7, "topP": 1.0, "maxTokens": null },
  "agent": {
    "permissionMode": "ask",
    "maxSteps": 25,
    "commandTimeoutMs": 120000,
    "toolOutputLimitBytes": 100000,
    "allowedCommands": [],
    "deniedCommands": ["rm -rf /", "mkfs", "dd if=", "shutdown", "reboot", ":(){"]
  },
  "ui": { "theme": "system", "style": "modern", "density": "comfortable", "fontScale": 1.0 },
  "logging": { "level": "info", "retainDays": 14 },
  "concurrency": { "maxParallelRuns": 4 }
}
```

## 各設定の定義

| 名前 | 型 / 有効範囲 | 既定 | 適用範囲 | 効果 |
|---|---|---|---|---|
| `endpoints[].baseUrl` | URL文字列、`http`/`https` のみ | — | 接続先 | 全リクエストの前置き。末尾スラッシュは除去して保存 |
| `endpoints[].timeoutMs` | 1000〜600000 | 120000 | 接続先 | 最初のトークンまでの待ち上限 |
| `generation.temperature` | 0.0〜2.0 | 0.7 | 全体（会話で上書き可） | 大きいほど散らばる |
| `generation.topP` | 0.0〜1.0 | 1.0 | 同上 | — |
| `generation.maxTokens` | 1以上 または null | null | 同上 | null はサーバ既定に任せる |
| `agent.permissionMode` | `ask` / `autoEdit` / `full` | `ask` | 全体（実行ごとに上書き可） | `05-agent.md` で定義 |
| `agent.maxSteps` | 1〜200 | 25 | 実行 | 上限に達したら停止し、理由を表示 |
| `agent.commandTimeoutMs` | 1000〜1800000 | 120000 | ツール実行 | 超えたらプロセスグループごと終了 |
| `agent.toolOutputLimitBytes` | 1000〜10000000 | 100000 | ツール実行 | 超過分は中央を省略し、省略した旨を明記 |
| `agent.deniedCommands` | 文字列配列（部分一致） | 上記 | ツール実行 | 一致したら承認画面すら出さずに拒否 |
| `ui.theme` | `light` / `dark` / `system` | `system` | 画面 | — |
| `ui.style` | `modern` / `classic` | `modern` | 画面 | 見た目の系統（`08-ui.md`） |
| `ui.density` | `comfortable` / `compact` | `comfortable` | 画面 | 行間と余白 |
| `logging.level` | `error`/`warn`/`info`/`debug`/`trace` | `info` | 全体 | 再起動なしで変更が効く |
| `memory.enabled` | 真偽 | `false` | 全体 | ベクトル索引の有効・無効（`14-memory.md`） |
| `memory.embeddingModel` | 文字列 または null | `null` | 索引 | 未指定なら索引を作れない。推測しない |
| `web.enabled` | 真偽 | `false` | 全体 | Web検索・取得の有効・無効（`15-web.md`） |
| `web.consent` | `perRun`/`once`/`never` | `perRun` | Web | 外部へ問い合わせる前の確認の頻度 |
| `web.fetch.allowPrivateHosts` | 真偽 | `false` | Web | 真にするとループバック・内部IPへも取りに行く |
| `mcpServers[]` | 配列 | `[]` | 全体 | 外部MCPサーバ（`13-mcp.md`） |
| `mcpServers[].trust` | `ask`/`readOnly`/`full` | `ask` | MCP | 自動実行の範囲。`readOnly` はサーバの自己申告を信じる選択 |
| `server.port` | 1024〜65535 | `7801` | ハーネスAPI | `akari serve` の待ち受けポート |
| `server.allowOrigins` | 文字列配列 | `[]` | ハーネスAPI | 空ならブラウザからの要求を全拒否 |
| `agent.approvalTimeoutMs` | 整数 または null | `null` | 実行 | null は無期限。外部ツールが落ちた実行を放置したくないなら有限に |
| `logging.retainDays` | 1〜365 | 14 | ログ | 起動時に古いファイルを削除 |
| `concurrency.maxParallelRuns` | 1〜16 | 4 | 全体 | 超えた実行は待機列に入る |

## 検証と失敗時の扱い

- 起動時に config を検証する。**不正な値を黙って既定へ差し替えない。**
- 直せない不正（`baseUrl` が URL でない等）があれば、起動時に設定画面を出し、
  どの項目がなぜ不正かを指し示す。アプリは起動する（設定できないと直せないため）。
- `schemaVersion` が未知の未来値なら、**書き込みを禁止**して読み取り専用で起動し、
  「新しいバージョンのAkariで作られた設定です」と表示する。古いデータを壊さないため。
- config.json が壊れて JSON として読めない場合、`config.broken-<timestamp>.json` へ退避し、
  既定の設定で起動して、退避先を表示する。消さない。

## credentials.json

```jsonc
{
  "schemaVersion": 1,
  "keys": { "ep_openai": "sk-..." }
}
```

- ファイルのパーミッションは作成時に `0600`（POSIX）。
  **Windows では現状アクセス権を絞れていない**（ACL を設定する実装を持っていない）。
  その場合は起動のたびに「絞れていない」と警告する。できたふりをしない。
  ACL 対応は未実装項目として残す。
- 値は **平文で保存される**。これは OS のファイル権限に依存した保護であり、暗号化ではない。
  ローカルLLM用の名目上の鍵を主用途とするため、この水準を採用する。
  外部の有料APIの鍵を入れる場合は、この前提を理解した上で入れること。**この制限は設定画面にも書く。**
- 代替として `apiKeyRef` に `env:OPENAI_API_KEY` の形を許す。この場合ファイルへは保存されず、
  起動時の環境変数から読む。外部APIを使うならこちらを推奨する。
- `credentials.json` の値は、ログ・診断書き出し・エラー表示のいずれにも出さない。
  出力前に既知の鍵文字列を `***` へ置換する層を通す。

## 優先順位

同じ項目が複数箇所で指定されたとき、下ほど強い。

1. `config.json` の全体設定
2. プロジェクトの設定（`06-work-and-code.md`）
3. 会話の設定
4. CLIの引数 / 環境変数（`AKARI_ENDPOINT`, `AKARI_MODEL`, `AKARI_PERMISSION_MODE`）
5. 実行ごとの明示指定

「未指定」と「明示的に既定値と同じ値を指定」は区別して保存する。
上位の変更が下位へ伝わるかどうかが変わるため。

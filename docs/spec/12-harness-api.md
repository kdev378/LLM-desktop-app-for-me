# 12 — ハーネスAPI（ローカルHTTP）

外部のマルチエージェントツールから Akari を動かすための口。
`akari serve` で立ち上げる。**localhost のみ**に束ね、トークンで守る。

この口が公開するのは、ファイル編集とコマンド実行を行う能力そのもの。
「同じPCで動く別のプログラムなら誰でも叩ける」状態にしてはならない。

## 起動

```sh
akari serve                       # 127.0.0.1:7801（既定）
akari serve --port 7900
akari serve --workspace ~/proj    # 既定の作業フォルダ
akari serve --print-token         # トークンを標準出力へ1回だけ出す
```

起動時に:

1. `127.0.0.1`（および `::1`）にのみ bind する。`0.0.0.0` は**受け付けない**。
   外部に晒したい場合は、利用者が自分でリバースプロキシを置く。Akari は手伝わない。
2. トークンが無ければ生成し、`<root>/server.json`（権限600）へ保存する。
   ```json
   { "schemaVersion": 1, "token": "...", "port": 7801, "pid": 1234, "startedAt": "..." }
   ```
3. 既に他のプロセスが同じポートで動いていれば、起動せずに終了コード2で終わる。

## 認証

- すべてのリクエストに `Authorization: Bearer <token>` が要る。
  無い・違う場合は `401`。`/v1/health` だけは例外（トークン不要、状態だけ返す）。
- トークンの比較は長さ非依存の定数時間比較で行う。
- **CORS は既定で全拒否**。ブラウザから叩かせない。
  `--allow-origin <origin>` を明示した場合のみ、そのオリジンを許す。
- `Origin` ヘッダが付いていて許可されていないリクエストは、トークンが正しくても拒否する
  （ブラウザ経由の悪用を塞ぐため）。

## 形式

- 要求・応答ともに JSON（`application/json`）。
- イベントの購読だけ SSE（`text/event-stream`）。
- 時刻は ISO8601（UTC）。IDは ULID。
- エラーは常に同じ形。
  ```json
  { "error": { "code": "workspace_outside", "message": "…", "detail": "…" } }
  ```
  `code` は安定した識別子。文言は変わりうるので、外部ツールは `code` で分岐する。

## エンドポイント

### `GET /v1/health`
トークン不要。`{ "ok": true, "version": "…", "runs": { "active": 2, "queued": 0 } }`

### `GET /v1/endpoints` / `GET /v1/models?endpoint=<名前|ID>`
登録済みの接続先と、そのモデル一覧。鍵は返さない。

### `POST /v1/runs`
実行を作る。

```jsonc
{
  "prompt": "テストを通して",
  "workspace": "/home/me/proj",       // 省略時は serve の既定
  "endpoint": "ローカル",              // 省略時は設定の選択中
  "model": "qwen2.5-coder:14b",
  "permissionMode": "ask",            // ask | autoEdit | full
  "maxSteps": 25,
  "tools": ["read_file", "edit_file", "run_command"],  // 省略時は既定一式
  "conversationId": "01J…",           // 続きから始める場合
  "labels": { "channel": "1234", "agent": "実装役A" },  // 相関用。自由
  "git": { "worktree": true, "branch": "akari/agent-a" }, // 下記
  "idempotencyKey": "任意の一意な文字列"
}
```

応答 `201`:
```json
{ "runId": "01J…", "conversationId": "01J…", "workspace": "…", "branch": "akari/agent-a" }
```

- `idempotencyKey` が既に使われていれば、**新しい実行を作らず**同じ `runId` を返す。
  ネットワークの再送で二重に手が動かないようにする。保持は24時間。
- 同時に走らせられる実行数は設定の `concurrency.maxParallelRuns`。
  超えた分は待機列に入り、状態は `queued` になる。
- `workspace` が未指定でも既定でもないときは `400 workspace_required`。
  **ツール無しで勝手に走らせない。**

### `GET /v1/runs/{runId}/events`
SSE。`05-agent.md` の `RunEvent` をそのまま流す。

```
id: 12
event: tool-call
data: {"type":"tool-call","callId":"c1","name":"edit_file","args":{…},"risk":"write"}
```

- 各イベントに**連番**（`id`）が付く。
- `Last-Event-ID` ヘッダ、または `?from=<連番>` で**続きから読み直せる**。
  チャットボットが落ちて繋ぎ直しても、経過を失わない。
- 保持は1実行あたり直近10,000イベント、または実行終了から1時間のどちらか短い方。
  取りこぼした範囲が保持を超えていた場合は、`event: gap` を1件流して正直に伝える。
  黙って飛ばさない。
- 実行が既に終わっていれば、保持されている全イベントを流して即座に閉じる。

### `POST /v1/runs/{runId}/approvals/{callId}`
```json
{ "decision": "allow" | "allowSession" | "deny" | "abort", "scope": "…", "feedback": "…" }
```
- 未知の `callId`、既に解決済み、承認待ちでない → `409`。
- 承認待ちのまま `agent.approvalTimeoutMs`（既定 無期限）を過ぎた場合の扱いは設定で決める。
  外部ツールが落ちたまま実行が残るのを避けたいなら、有限値にする。

### `POST /v1/runs/{runId}/abort`
中断する。`05-agent.md` の中断規則に従う。変更記録は保持される。

### `POST /v1/runs/{runId}/messages`
```json
{ "text": "やっぱりテストは後回しで" }
```
実行中なら次のステップの前に差し込む。終了後なら同じ会話の続きとして新しい実行を作る
（応答に新しい `runId` が入る）。チャットからの追記をそのまま流し込めるようにするため。

### `GET /v1/runs/{runId}`
状態。
```json
{
  "runId": "01J…", "status": "running",
  "step": 3, "maxSteps": 25,
  "workspace": "…", "branch": "…", "labels": {…},
  "pendingApproval": { "callId": "c1", "name": "run_command", "risk": "execute", "prompt": "…" },
  "changedFiles": 2,
  "startedAt": "…", "endedAt": null, "endReason": null,
  "usage": { "prompt": 0, "completion": 0 }
}
```
`status`: `queued` / `running` / `waiting-approval` / `done` / `aborted` / `failed` / `max-steps`

### `GET /v1/runs?label.channel=1234&status=running&limit=20`
一覧。ラベルで絞れる。新しい順。

### `GET /v1/runs/{runId}/transcript?format=markdown&chunk=2000`
チャットへ貼れる形。

- `format=markdown`（既定）/ `text` / `json`
- `chunk` を指定すると、その文字数以下の配列に割って返す（Discord の2000字制限向け）。
  コードブロックの途中では割らない。
- 内容: 目的、各ステップ（考えた要約・ツール名・結果の1行）、変更したファイル、終了理由。
  **本文の全文ではなく、貼って読める要約**にする。全文が要るならイベントを読む。

### `GET /v1/runs/{runId}/diff`
その実行が行ったファイル変更を統一差分で返す。`?path=` で1ファイルだけも取れる。

### `POST /v1/runs/{runId}/undo`
その実行のファイル変更を戻す。`05-agent.md` の規則に従い、戻せなかったものは
`skipped` として理由付きで返す。**黙って上書きしない。**

### `GET /v1/conversations/{id}` / `GET /v1/conversations`
会話の内容と一覧。デスクトップ・CLIと同じ保存先を読む。

## 作業の隔離（git worktree）

複数のエージェントが同じリポジトリを同時に触ると、互いの変更を踏む。
`git.worktree: true` を指定すると:

1. `workspace` が git リポジトリであることを確認する。違えば `400`。
2. `<root>/worktrees/<runId>/` に `git worktree add -b <branch> <path> <base>` する。
   `branch` 省略時は `akari/<runId>`。既に同名ブランチがあれば `409`。
3. 実行の作業フォルダはその worktree になる。パス境界もそこで閉じる。
4. 実行が終わっても worktree は**消さない**。中身が成果物だから。
   `DELETE /v1/runs/{runId}/worktree` で明示的に消す。作られたまま残る量は
   `GET /v1/worktrees` で見える。

Akari は `commit` も `merge` も `push` も**自分からはしない**。
コミットしたければ、エージェントが `run_command` の承認を通して行う。
merge は外部ツールの権限を持つエージェントの仕事（非目標）。

## ログ

- すべてのリクエストを `server.request` として記録する（メソッド、パス、状態、所要時間、runId）。
  本文は記録しない。
- 認証失敗は `server.unauthorized` として、送信元アドレスとともに記録する。
- トークンはログにも診断にも出さない。

## 未解決

- 承認待ちのまま外部ツールが落ちた実行の後始末。既定は無期限で待つが、
  溜まると資源を食う。実運用で溜まり方を見てから決める。
- 1台で何実行まで現実的か。ローカルLLMは同時実行でメモリを食い合う。
  `concurrency.maxParallelRuns` の既定4が妥当かは未検証。

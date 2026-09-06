# 01 — 構成とモジュール境界

## 方針

CLIとデスクトップが**同じ挙動**であることを最優先の構造要件にする。
そのために、モデルとの往復・ツール実行・保存を1つのパッケージへ寄せ、
デスクトップとCLIはその上の「見せ方」だけを持つ。

「同じ結果になるはず」ではなく「同じコードを通っている」状態を保つ。

## リポジトリ構成

```
.
├─ package.json              # pnpm workspace ルート
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ PROJECT-CONTEXT.md
├─ docs/spec/                # この仕様書
├─ packages/
│   └─ core/                 # @akari/core — 中核。UIもターミナルもHTTPも知らない
│       ├─ config/           # 設定と資格情報の読み書き・検証
│       ├─ provider/         # OpenAI互換クライアント、ストリーム、埋め込み、機能判定
│       ├─ store/            # 会話・プロジェクトの永続化
│       ├─ tools/            # ツール定義と実行、パス境界の検査
│       ├─ agent/            # 実行ループ、承認要求、変更記録、取り消し
│       ├─ context/          # トークン見積り、ターンの切り分け、圧縮、生の記録の検索
│       ├─ mcp/              # MCPクライアント（外部サーバのツールを取り込む）
│       ├─ memory/           # ベクトル索引の作成・更新・検索
│       ├─ web/              # 検索とページ取得（SSRF検査を含む）
│       ├─ diagnostics/      # ログ、問題報告用の書き出し
│       └─ index.ts          # 公開面はここだけ
└─ apps/
    ├─ desktop/              # Electron
    │   ├─ main/             # メインプロセス。core を呼ぶのはここだけ
    │   ├─ preload/          # contextBridge 経由の細い橋
    │   └─ renderer/         # React + Vite。core を直接 import しない
    ├─ cli/                  # @akari/cli — Node 実行。core を直接呼ぶ
    └─ server/               # @akari/server — ハーネスAPI（HTTP+SSE）とMCPサーバ
```

パッケージは4つに留める。「レイヤーごとにパッケージ」はしない。
`server` を分けるのは、CLIやデスクトップと**利用者が違う**（人ではなく他のプログラム）ためで、
層が違うからではない。`akari serve` は CLI から `@akari/server` を遅延 import して起動する。

## 依存の向き

```
apps/desktop/renderer ─(IPC)→ apps/desktop/main ─→ packages/core
apps/cli ───────────────────────────────────────→ packages/core
apps/cli (serve) ─→ apps/server ────────────────→ packages/core
外部のマルチエージェントツール ─(HTTP/SSE)→ apps/server ─→ packages/core
外部のMCPクライアント ─────────(MCP)────→ apps/server ─→ packages/core
packages/core/mcp ─(MCP)→ 外部のMCPサーバ群
packages/core/web ─(HTTPS)→ 検索API / 任意のWebページ
```

`core` から外へ出ていく線は2本だけ（MCPサーバ群、Web）。
どちらも既定で無効か、明示的な同意を経る（`13-mcp.md` / `15-web.md`）。

- `core` は他のどれにも依存しない。Electron API、DOM、`process.stdout` への直接書き込みを含まない。
- `renderer` は `core` を直接 import しない。Node の権限をUI層へ持ち込まないため。
- `core` は副作用を**イベント**として外へ出す。表示・承認の判断は呼び出し側が行う。

## core の公開面

`packages/core/index.ts` から出すものだけが公開契約。ここに無いものは内部実装として自由に変えてよい。

```ts
// 設定
loadConfig(): Promise<Config>
saveConfig(c: Config): Promise<void>
resolveEndpoint(config, name?): ResolvedEndpoint   // 資格情報を解決した実行用の形

// 接続先
createProvider(endpoint: ResolvedEndpoint): Provider
Provider.listModels(): Promise<ModelInfo[]>
Provider.chat(req: ChatRequest, signal): AsyncIterable<ChatEvent>
Provider.probe(): Promise<EndpointCapabilities>

// 保存
openStore(rootDir?): Promise<Store>
Store.conversations / Store.projects        // 一覧・読み・書き・削除

// エージェント
createSession(opts: SessionOptions): Session
Session.send(input: string): AsyncIterable<RunEvent>
Session.approve(callId, decision): void
Session.abort(): void
Session.undoLastRun(): Promise<UndoResult>

// 診断
createLogger(opts): Logger
collectDiagnostics(): Promise<DiagnosticsBundle>
```

各型の詳細は `02`〜`07` に置く。ここには一覧だけを置き、内容を複製しない。

## イベント駆動にする理由

`Session.send()` は「完成した答え」ではなく**イベントの流れ**を返す。

```
run-start → step-start → text-delta* → tool-call → approval-request
          → (approve/deny) → tool-result → step-end → ... → run-end
```

こうすると:

- デスクトップは各イベントを画面の要素へ、CLIは行へ、`--json` は1行のJSONへ、
  それぞれ**同じ順序の同じ情報**から作れる。
- 承認は「イベントを出して待つ」だけになり、ダイアログとターミナルのプロンプトが
  同じ分岐を通る。
- 途中経過が常に観測できるので、無反応になる区間が構造的に生まれない。

イベントの一覧は `05-agent.md` に定義する。

## プロセス構成（デスクトップ）

- **メインプロセス**: `core` を持つ唯一の場所。ファイル、ネットワーク、子プロセスはここだけ。
- **preload**: `contextBridge` で、決められたチャンネルの関数だけを露出する。
  `ipcRenderer` そのものは渡さない。
- **renderer**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`。
  外部URLの読み込みとナビゲーションを禁止する。

ストリームは `ipcRenderer.on` の購読で流す。1実行につき1チャンネルIDを割り当て、
終了時に必ず解除する。

## 状態の持ち主

| 状態 | 正本の場所 | 備考 |
|---|---|---|
| 設定・資格情報 | ディスク（`~/.akari/`） | メインプロセスが読み書き。rendererは複製を持つが書けない |
| 会話・プロジェクト | ディスク | 同上 |
| 実行中のセッション | メインプロセスのメモリ | rendererの再読み込みで消えない。実行は継続する |
| 画面の選択・開閉・スクロール | renderer のメモリ | 保存しない（一部は次回起動用に config へ） |

renderer は「表示用の写し」だけを持つ。書き込みは必ずメイン経由にして、
2箇所が別々に真実を持つ状態を作らない。

## 並行性の約束

- 1つの会話に対して、同時に走る実行は**1つだけ**。2つ目の送信は、実行中は拒否する（UIでは送信ボタンを無効化）。
- 別の会話どうしは同時に走ってよい。上限は既定4（設定可）。超えた分は待たせる。
- 保存は「一時ファイルへ書いて rename」で行う。同一ファイルへの書き込みはプロセス内で直列化する。
- 中断（abort）は、モデルのストリームと実行中のツールの両方へ伝える。
  実行中のコマンドはプロセスグループごと終了させる。

## 技術選定と、その理由

| 選択 | 理由 | 代償 | 戻すとしたら |
|---|---|---|---|
| Electron | CLIとデスクトップで**同じTypeScriptの中核**を共有できる。3OSで描画が揃う | 待機時メモリが大きい（200-300MB目安） | Tauri + Node sidecar。coreはそのまま使える |
| React + Vite | 情報密度の高い画面と差分表示を作りやすい。開発時の反映が速い | なし（規模相応） | — |
| TypeScript（strict） | 中核の契約を型で固定でき、CLI/デスクトップの取り違えを減らす | — | — |
| JSONファイル保存（DBなし） | ネイティブモジュール不要で3OS×Electron×Nodeの組み合わせが増えない。手で読める | 全文検索が線形。1万会話規模で遅くなる | SQLite へ移行（`07-data.md` に移行方針） |
| pnpm workspace | 依存の重複を避け、ローカル参照が素直 | — | npm workspaces |
| ベクトル索引は自前のフラットファイル＋総当たり | ネイティブモジュールを増やさない。個人用の規模なら足りる見込み | 20万チャンク規模で遅くなる | 近似検索ライブラリへ（`14-memory.md`） |
| 拡張の口はMCPだけ。独自プラグイン機構を作らない | 口が1つなら、安全の検討も1箇所で済む | MCPの仕様変更に追随が要る | — |
| ハーネスAPIは localhost 限定＋トークン | ファイル編集とコマンド実行を公開する口だから | 遠隔から使うには利用者が自分でトンネルを張る必要がある | 認証方式を足す（`12-harness-api.md`） |

**未検証の仮定**: Electron の待機時メモリは実測していない。P7 で対象3OSで測り、目標
（待機時 300MB 以下）を満たさなければ、レンダラの常駐要素を削るか Tauri を再検討する。

# PROJECT-CONTEXT — Akari

雛形: `context/PROJECT-CONTEXT.template.md`。ここには**このプロジェクトだけの事実**を書く。
好みや一般論は `context/` にある。詳細な仕様は `docs/spec/` にある。ここには複製しない。

## 1. これは何か

- 一言で: 手元のローカルLLM（OpenAI互換API）を、会話・作業・コード編集に使うためのデスクトップアプリと、同じ中核を使うCLI。
- 誰が使うか: オーナー1人。個人用ツール。
- 解決する問題: ローカルLLMサーバを立てても、実際に使う入口が `curl` か素朴なWeb UIしかなく、会話の保存・作業単位のまとめ・ファイルを触らせる作業・コード編集が別々のツールに散っている。
- **作らないもの（非目標）**: モデルの管理／独自推論エンジン／マルチユーザー・同期・共有／プラグイン機構／モバイル・Web版／RAG基盤／音声。詳細は `docs/spec/00-overview.md`。

## 2. 完成条件

`docs/spec/00-overview.md` の「完成条件」が正本。ここでは複製しない。

## 3. 動かし方

- 対象環境: Windows 10/11、macOS（arm64/x64）、Linux デスクトップ
- 前提: Node.js 20 以上、pnpm 9 以上、ローカルLLMサーバ1つ（Ollama / llama.cpp server / LM Studio / vLLM のいずれか）
- 起動（開発）: `pnpm install` → `pnpm dev`（デスクトップ）
- CLI（開発）: `pnpm --filter @akari/cli build` → `node apps/cli/dist/index.js`
- ビルド: `pnpm build` / 配布物 `pnpm dist`
- テスト: `pnpm test`
- 動作確認の手順: `docs/spec/11-roadmap.md` の各段階「確かめ方」

> 現状は仕様のみ。上のコマンドはまだ存在しない。P0 で作る。

## 4. 構成

- 主要な言語・フレームワーク: TypeScript（strict）、Electron、React、Vite、pnpm workspace
- ディレクトリの役割: `packages/core`（中核）、`apps/desktop`（Electron）、`apps/cli`（CLI）、`docs/spec`（仕様）
- 触ってはいけない場所: `context/` と `.claude/skills/` は開発ルールであり、この製品の一部ではない。製品の都合で書き換えない。

## 5. データ

- 保存場所: Windows `%APPDATA%\Akari\` / macOS `~/Library/Application Support/Akari/` / Linux `~/.config/akari/`。`AKARI_HOME` で上書き可
- 形式: JSONファイル。DBを使わない。詳細は `docs/spec/07-data.md`
- 失うと困るもの: `conversations/`、`projects/`、`backups/<runId>/`（取り消しの根拠）
- 移行・バックアップ: `schemaVersion` を持ち、読んだときに1件ずつ移行する。破壊的移行の前にコピーを取る

## 6. 制約

- 性能の目安: 待機時メモリ 300MB 以下（未実測、P6で確認）／会話1000件で一覧が体感で速いこと
- 外部の前提: ローカルLLMサーバはローカルで別途起動されている。Akari は起動・管理をしない
- 鍵: `credentials.json` に平文（ファイル権限 0600）。暗号化ではない。外部APIには `env:` 参照を推奨
- ネットワーク: 待機中は外部へ通信しない。テレメトリ・自動更新なし
- ライセンス: 依存は MIT / Apache-2.0 / BSD / ISC に限る

## 7. 見た目の方向性

- 系統: **現代的な角丸UI**（`ui.style: "modern"`）。参考が Claude デスクトップアプリのため。古い四角いUIは v1 では実装しない
- 使う色と役割: 主要操作=オレンジ系 / 情報=水色系 / 成功=黄緑系。詳細と色コードは `docs/spec/08-ui.md`
- 対象画面幅: 最小 900px。それ未満では右ペインを畳む

## 8. 決めたこと

| 日付 | 決めたこと | 理由 | 戻すとしたらどうするか |
|---|---|---|---|
| 2026-09-05 | Electron + 共有TSコア（Tauriではなく） | CLIとデスクトップで同じ中核を通せることを最優先。挙動の一致を「同じコード」で保証する | Tauri + Node sidecar。`packages/core` はそのまま使える |
| 2026-09-05 | 保存はJSONファイル。DBなし | ネイティブモジュールが Electron/Node の2 ABI × 3OS へ増えるのを避ける。手で読める | 会話5000件超で SQLite へ。`schemaVersion` を上げ一方向移行 |
| 2026-09-05 | エージェントの出力はイベント列 | 画面・ターミナル・`--json` を同じ順序の同じ情報から作る | — |
| 2026-09-05 | Work = プロジェクト管理 + エージェント実行の両方 | オーナーの指定 | — |
| 2026-09-05 | コマンド実行は書き込みより危険度が高い | `run_command` からファイルを書けるため、書き込みの承認を迂回できてしまう | — |
| 2026-09-05 | 鍵は平文保存（OS権限に依存） | Electron の `safeStorage` は CLI から復号できず、中核共有の前提が崩れる | OS キーチェーンを使う小さなネイティブ層を足す。CLI との共有方法を先に決める必要がある |
| 2026-09-05 | v1 では署名・公証しない | 個人用ツール。証明書の費用と手間が見合わない | 必要になったら Windows/macOS の証明書を用意 |

## 9. 今の状態

- 動いているもの: なし（仕様のみ）
- 未完成: 全部。`docs/spec/11-roadmap.md` の P0 から
- 次にやること: P0（pnpm workspace の骨格 + `core` の config/provider + CLI の `models`/`chat`/`doctor`）。ローカルLLMサーバ4種との疎通と、ツール呼び出しストリーム形式の確認が最初の関門

# AGENTS.md

このリポジトリで作業するAIエージェント向けの入口。実体は `context/` にある。

## 読む順序

1. `context/core.md`（常時適用の基本ルール）と `context/personal/working-with-me.md`（オーナーとの協働方法）。この2つとこのファイルは `CLAUDE.md` から import されており、対応ツールでは起動時に読み込まれている。読み込まれていない場合は自分で読む。
2. プロジェクト固有の情報（`PROJECT-CONTEXT.md` 等）があれば読む。これは、以降に必要な文書とSkillを判断する材料になる。無ければ、無いまま進めてよい。作業の中でプロジェクトの前提を繰り返し推測し直しているなら、作成を提案する。
3. 今回の作業に該当する `context/generic/*.md` と、他の `context/personal/*.md` だけを読む（下表）。
4. 手順の型が要る Skill は `.claude/skills/` にある。対応ツールでは、名前と説明から必要なときに自動で読み込まれる。

全部を先読みしない。関係ないファイルを読むと、守るべきルールが薄まる。

## 読み分け表

| 今やること | 追加で読む |
|---|---|
| コードを書く・直す | `context/generic/engineering.md` |
| 構造やインターフェースを決める | `context/generic/architecture-and-interfaces.md` + `architecture-and-interface` Skill |
| 保存形式・移行・設定を扱う | `context/generic/data.md` |
| バグ調査・テスト・レビュー | `context/generic/quality.md` + `quality-and-diagnostics` Skill |
| 認証・秘密情報・個人データ・配布 | `context/generic/security-and-compliance.md` |
| ログ・リリース・Git操作 | `context/generic/operations.md` |
| 速度・メモリ・並行処理 | `context/generic/performance-and-concurrency.md` |
| ライブラリ選定・仕様の確認 | `context/generic/dependencies-and-research.md` |
| 画面を作る・直す | `context/generic/frontend.md` + `context/personal/ui.md` + `frontend-review` Skill |
| ドキュメントを書く | `context/generic/documentation.md` |
| 何を作るか迷う・優先順位の判断 | `context/personal/product-and-tradeoffs.md` |
| 作業を終える・中断する | `handoff` Skill |
| 不満や繰り返しの失敗があった | `context/lifecycle/README.md` |

## 優先順位

安全と明示的な指示 → プロジェクト制約 → `personal/` → `generic/`

下位が上位を特殊化してよいが、意図的な例外は必ずそう書く。

## 用語

- **MUST / DO NOT** — 必須。破るには上位の指示か、明示した例外条件が要る。
- **SHOULD / AVOID** — 既定。具体的な理由があれば外してよい。
- **PREFER** — オーナーの好み。他の制約が別案を支持しないなら、こちらを選ぶ。
- **MAY** — 選んでよい選択肢。推奨ではない。

## 配置

```
CLAUDE.md          # @AGENTS.md ほか2ファイルの import のみ
AGENTS.md          # このファイル
context/           # ルールの実体
.claude/skills/    # 手順の型（Claude Code が自動発見する）
PROJECT-CONTEXT.md # プロジェクト固有の事実（雛形は context/PROJECT-CONTEXT.template.md）
```

## 他ツールへの接続

`CLAUDE.md`、`.cursorrules`、システムプロンプト等からは**このファイルを参照するだけ**にする。内容を複製すると、更新時に必ず食い違う。

# Akari（灯り）

**LLMにコードを書かせるためのハーネス。** Claude Code や Codex がやっていることの手元版。

OpenAI互換APIを話す相手なら、Ollama でも llama.cpp server でも LM Studio でも vLLM でも繋がる。

## 3つの使い口

| 使い口 | 誰が使うか | 中身 |
|---|---|---|
| **デスクトップアプリ** | 人 | Chat / Work（プロジェクト+エージェント実行） / Code（差分とファイルツリー） |
| **CLI** | 人 | `akari "テストを通して"` |
| **ハーネスAPI** | 他のプログラム | ローカルHTTP+SSE と MCP。複数エージェントを束ねる外部ツールから |

3つとも同じ中核（`@akari/core`）を通る。「同じはず」ではなく「同じコードを通る」。

## 道具

| 機能 | 内容 |
|---|---|
| ファイル操作・コマンド実行 | 作業フォルダの外は触れない。承認制。実行単位で取り消せる |
| **記憶（ベクトル索引）** | 文脈長の小さいローカルLLM向けに、関係する部分だけを渡す |
| **MCP** | 外部のMCPサーバを使う側にも、Akari自身がMCPサーバになる側にも |
| **Web検索・取得** | ライブラリの現物仕様を見に行く。既定は無効 |
| **git worktree による隔離** | 複数エージェントが同じリポジトリを踏まないように |

## 外部のマルチエージェントツールとの関係

Akari は **1エージェント分の手足**。
エージェント同士の会話、司会、成果物の merge 判断は Akari の仕事ではない（非目標）。

```
[チャット上の会話・指示]           ← 外部ツールの担当
        ├─ エージェントA ──→ Akari ──→ ローカルLLM / API
        ├─ エージェントB ──→ Akari ──→ ローカルLLM / API
        └─ 統合役(権限あり) ─→ git merge   ← 外部ツールの担当
```

## 現在の状態

**CLI からエージェントが動きます。** → [動かし方](docs/getting-started.md) / [仕様](docs/spec/README.md)

```sh
pnpm install && pnpm build
node apps/cli/dist/index.js config endpoints add --name "ローカル" --url http://localhost:11434/v1
node apps/cli/dist/index.js run "READMEのtypoを直して"   # 承認を挟んでファイルを編集
node apps/cli/dist/index.js diff                        # 何を変えたか
node apps/cli/dist/index.js undo                        # 元に戻す
```

作業フォルダの外は触れません。書き込みとコマンド実行は承認制で、実行単位で取り消せます。

ハーネスAPI・MCP・記憶・Web・デスクトップアプリはまだありません
（`docs/spec/11-roadmap.md` の P2 以降）。

実装の順序と、各段階で何が確かめられるようになるかは
[`docs/spec/11-roadmap.md`](docs/spec/11-roadmap.md) にある。

## リポジトリの中身

```
docs/spec/          製品の仕様（16文書）
docs/getting-started.md  動かし方
packages/core/      中核（設定・API接続・診断）
apps/cli/           CLI
tools/              模擬LLMサーバ（開発用）
PROJECT-CONTEXT.md  このプロジェクト固有の事実
AGENTS.md           AIエージェント向けの開発ルールの入口
context/            開発ルールの実体
.claude/skills/     手順の型
```

## ライセンス

[LICENSE](LICENSE) を参照。

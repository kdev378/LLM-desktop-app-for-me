# Akari（灯り）

手元で動かしているローカルLLMを、会話・作業・コード編集に使うためのデスクトップアプリと、
同じ中核を使うコード作業用CLI。

OpenAI互換APIを話す相手なら、Ollama でも llama.cpp server でも LM Studio でも vLLM でも繋がる。

## 何ができるか（予定）

| 機能 | 内容 |
|---|---|
| **Chat** | 保存される会話。枝分かれ、編集、再生成、途中停止 |
| **Work** | プロジェクト単位で指示・資料・作業フォルダをまとめ、エージェントに手を動かさせる |
| **Code** | ファイルツリーと差分を見ながら、リポジトリを編集させる |
| **CLI** | `akari "テストを通して"`。デスクトップと同じ中核・同じ設定・同じ会話 |

## 現在の状態

**CLI の接続部分まで動きます。** → [動かし方](docs/getting-started.md) / [仕様](docs/spec/README.md)

```sh
pnpm install && pnpm build
node apps/cli/dist/index.js config endpoints add --name "ローカル" --url http://localhost:11434/v1
node apps/cli/dist/index.js chat
```

デスクトップアプリとエージェント実行はまだありません。

実装の順序と、各段階で何が確かめられるようになるかは
[`docs/spec/11-roadmap.md`](docs/spec/11-roadmap.md) にある。

## リポジトリの中身

```
docs/spec/          製品の仕様（12文書）
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

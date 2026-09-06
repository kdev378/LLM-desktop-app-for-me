# 14 — 記憶（ベクトル索引）

## なぜ要るか

ローカルLLMは文脈長が小さい（4k〜32kが普通）。リポジトリ全部は入らない。
「関係のある部分だけを選んで渡す」仕組みが無いと、そもそもコードを書かせられない。

`grep` で足りる場面も多い。**まず `grep` と `glob` を使わせ、
それで見つからないときの補助**として索引を置く。索引を主役にしない。

## 何を索引にするか

| 対象 | 既定 | 備考 |
|---|---|---|
| 作業フォルダのファイル | 索引にする | `.gitignore` と `.akariignore` を尊重する |
| プロジェクトの資料 | 索引にする | `06-work-and-code.md` の添付 |
| 会話の履歴 | **索引にしない** | v1 では対象外。必要になってから決める |

除外の既定: `node_modules` `.git` `dist` `build` `target` `vendor` `.venv`
`__pycache__` `*.min.js` `*.lock` `*.map`、および 1MB を超えるファイル、バイナリ。

## 保存の形

`07-data.md` の「DBを使わない」方針をここでも保つ。
ベクトルは**フラットなバイナリ1ファイル**に置き、検索は総当たりで回す。

```
<root>/index/<indexId>/
  meta.json        # 索引の素性。これが合わないものは混ぜない
  chunks.jsonl     # 1行1チャンクのメタ情報（本文込み）
  vectors.bin      # Float32Array。chunks.jsonl と同じ順に dims 個ずつ
```

```jsonc
// meta.json
{
  "schemaVersion": 1,
  "indexId": "01J…",
  "root": "/home/me/proj",
  "embedding": {
    "endpointId": "ep_local",
    "model": "nomic-embed-text",     // 索引を作ったモデル。変わったら作り直す
    "dims": 768,
    "normalized": true
  },
  "chunking": { "maxChars": 1200, "overlapChars": 200, "strategy": "lines-v1" },
  "files": { "src/main.ts": { "hash": "sha256:…", "chunks": [0, 3], "mtimeMs": 0 } },
  "counts": { "files": 412, "chunks": 5310 },
  "builtAt": "…", "updatedAt": "…"
}
```

### なぜベクトルDBを使わないか

| 案 | 却下の理由 |
|---|---|
| SQLite + sqlite-vec | ネイティブモジュール。Electron と Node で別ビルド × 3OS。個人用ツールに見合わない |
| hnswlib / faiss | 同上。近似検索が要る規模ではない |
| 外部のベクトルDBサーバ | 常駐が増える。ローカル完結の利点を失う |

**総当たりで足りる根拠**: 5,000チャンク × 768次元 = 384万回の積和。
JavaScript の `Float32Array` で数ミリ秒〜十数ミリ秒の見込み。
50,000チャンクでも100ms前後の見込み。

**この見込みは未検証**。実装したら実測する（`11-roadmap.md`）。

**破綻する条件**: チャンクが20万を超える、または検索が300msを超える。
そのときは近似検索へ移す。それまで作らない。

## 埋め込み

`02-provider.md` の Provider に `/embeddings` を足す。

```ts
Provider.embed(texts: string[], model: string, signal?): Promise<Float32Array[]>
```

- OpenAI互換の `POST {baseUrl}/embeddings`、`{ model, input: string[] }`。
- 対応していない接続先（404 / 400）では、索引機能そのものを無効にする。
  「使えるふりをしない」。`akari doctor` に対応可否を出す。
- 一度に送る数は既定16件。大きすぎると落とすサーバがあるため。
  413 や 400 が返ったら、半分にして1度だけ再試行する。
- 取得したベクトルは L2 正規化して保存する。検索は内積（= コサイン類似度）で済む。
- **埋め込み用モデルは生成用モデルと別**にできる。`config.json` の
  `memory.embeddingModel` で指定する（未指定なら索引を作れない。推測しない）。

## チャンクの切り方（`lines-v1`）

v1 は素朴に行単位で切る。言語ごとの構文解析はしない。

- 最大 1200 文字、前後 200 文字の重なり。
- 行の途中では切らない。
- 各チャンクに `{ path, startLine, endLine, text }` を持たせる。
  **検索結果は必ずファイル名と行番号を返す**。モデルがそのまま `read_file` で確かめられるように。
- チャンクの先頭に `// path/to/file.ts:120-160` の1行を付けて埋め込む。
  ファイル名自体が手がかりになるため。

将来コード対応の切り方（関数単位）に変えるときは `strategy` を上げ、
古い索引は作り直す。混ぜない。

## 更新

- ファイル単位の SHA256 で変更を検出する。変わったファイルのチャンクだけ作り直す。
- 消えたファイルのチャンクは削除する。
- `vectors.bin` の削除は「詰め直し」で行う。穴を残さない。
  詰め直しは新しいファイルへ書いて `rename` する（`07-data.md` の原子的書き込み）。
- 更新は中断されうる。**中断されたら索引は使わない**。
  `meta.json` に `dirty: true` を立ててから作業し、完了時に落とす。
  `dirty` のまま起動したら、その索引は「作り直しが要る」と表示する。壊れたまま検索しない。

## 検索

```ts
memory_search(query: string, k?: number, path?: string): SearchHit[]
type SearchHit = { path: string; startLine: number; endLine: number; score: number; text: string };
```

- 既定 `k = 8`。上限 30。
- `path` を渡すとその配下だけに絞る。
- **スコアをそのまま見せる**。閾値で黙って捨てない。関連が薄いことは数字で分かるようにする。
- 結果の合計文字数は `toolOutputLimitBytes` で切る。
- 索引が無い / `dirty` / 埋め込みモデルが違う → 検索せずに理由を返す。
  **別のモデルのベクトルと混ぜて検索することは、絶対にしない**（無意味な結果が出るため）。

### ツールとしての位置づけ

システムプロンプトにこう書く。

> ファイルの場所が分かっているなら `read_file`、名前で探せるなら `glob` か `grep` を使う。
> `memory_search` は「どこにあるか分からない」ときの補助。返るのは候補であって答えではない。
> 必ず `read_file` で現物を確かめてから編集する。

## CLI

```sh
akari index build              # 作業フォルダの索引を作る
akari index update             # 変わったファイルだけ
akari index status             # 件数、モデル、最終更新、dirty かどうか
akari index search "認証はどこ" -k 5
akari index rm
```

`build` は進行を出す（何ファイル中何ファイル、経過時間）。
埋め込みはローカルLLMでも時間がかかるので、無反応にしない。

## 設定

| 項目 | 既定 | 効果 |
|---|---|---|
| `memory.enabled` | `false` | 索引機能そのものの有効・無効 |
| `memory.embeddingModel` | `null` | 埋め込みに使うモデル。未指定なら索引を作れない |
| `memory.embeddingEndpointId` | `null` | 未指定なら生成と同じ接続先 |
| `memory.maxFileBytes` | `1048576` | これを超えるファイルは索引にしない |
| `memory.chunkChars` | `1200` | チャンクの最大文字数 |
| `memory.overlapChars` | `200` | 重なり |
| `memory.batchSize` | `16` | 1回に埋め込む件数 |
| `memory.topK` | `8` | `memory_search` の既定 |

## プライバシー

- **接続先が外部の場合、索引を作るとリポジトリ全体が外部へ送られる**。
  索引の作成前に、対象ファイル数と合計サイズを示して1度確認する。
- ローカルの接続先ではこの確認を出さない（毎回聞かない）。
- 索引の中身（`chunks.jsonl`）には本文がそのまま入る。
  設定の書き出し（`07-data.md`）には**含めない**。

## 未解決

- 総当たり検索の実測。5,000 / 50,000 チャンクでの時間（P6 で測る）。
- 埋め込みモデルの選定。`nomic-embed-text` を暫定の推奨として書くが、
  実際に使うモデルは実測してから決める。ここに書いたモデル名は例であって推奨の確定ではない。
- 会話履歴の索引化。v1 では対象外。

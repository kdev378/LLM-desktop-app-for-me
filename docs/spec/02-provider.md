# 02 — OpenAI互換API 接続仕様

## 対象

「OpenAI互換」を名乗るサーバは実際にはばらつきがある。以下を**実際に動く対象**として想定し、
これ以外も繋がることは期待するが保証しない。

| サーバ | 既定のベースURL | 備考 |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | ツール呼び出しはモデル依存。`/models` は返る |
| llama.cpp `llama-server` | `http://localhost:8080/v1` | 単一モデル。`/models` は1件返る |
| LM Studio | `http://localhost:1234/v1` | ツール呼び出し対応（モデル依存） |
| vLLM | `http://localhost:8000/v1` | 概ね忠実。`usage` も返る |
| text-generation-webui | `http://localhost:5000/v1` | 差異が大きい。動かない機能がありうる |
| OpenAI 本家 / 互換の外部 | `https://api.openai.com/v1` | 繋がるが、外部送信の扱いは `09` を見る |

## 使うエンドポイント

使うのはこの2つだけ。増やすときは仕様を更新する。

| メソッド | パス | 用途 | いつ |
|---|---|---|---|
| GET | `{baseUrl}/models` | モデル一覧、接続確認 | 常時 |
| POST | `{baseUrl}/chat/completions` | 生成（常に `stream: true`） | 常時 |
| POST | `{baseUrl}/embeddings` | ベクトル索引の作成・検索 | `memory.enabled` のときだけ |

`/completions`（legacy）と `/responses` は使わない。

### `/embeddings`

```ts
Provider.embed(texts: string[], model: string, signal?): Promise<Float32Array[]>
```

- 送るのは `{ model, input: string[] }`。返る `data[].embedding` を順に取る。
  `index` フィールドがあれば**それで並べ直す**（順序を保証しないサーバがあるため）。
- 404 / 400 が返る接続先は「埋め込み非対応」として記録し、索引機能を無効にする。
  対応していないことを、対応しているように見せない。
- 1回に送る件数は `memory.batchSize`（既定16）。413 か 400 が返ったら半分にして1度だけ再試行する。
- 返ったベクトルの次元が索引の `dims` と違えば、その場で失敗させる。混ぜない。
- 詳細は `14-memory.md`。

## 接続先の定義

```ts
type Endpoint = {
  id: string;              // 内部ID。変更されない
  name: string;            // 表示名。例 "ローカル (Ollama)"
  baseUrl: string;         // 末尾スラッシュなし。/v1 まで含める
  apiKeyRef?: string;      // 資格情報の参照キー。値そのものは持たない（03参照）
  defaultModel?: string;
  headers?: Record<string,string>;  // 追加ヘッダ。Authorization は上書きしない
  timeoutMs: number;       // 既定 120000。最初のトークンまでの待ち上限
  capabilities: EndpointCapabilities;
};

type EndpointCapabilities = {
  tools: "auto" | "native" | "prompted" | "none";   // 既定 "auto"
  vision: "auto" | "yes" | "no";                    // 既定 "auto"
  usageReported: boolean;                           // probe で判明
  streamsToolCalls: boolean;                        // probe で判明
};
```

`apiKeyRef` に鍵そのものを入れない。設定ファイルは診断書き出しやバックアップに載るため。

## 機能判定（probe）

`Provider.probe()` は接続先の実力を調べ、`capabilities` の `auto` を確定させる。
初回登録時と、利用者が「再判定」を押したときに走る。結果は設定へ保存する。

手順:

1. `GET /models` — 200 かつ `data[]` が配列。失敗した時点で `unreachable` として終わる。
2. `POST /chat/completions` に、1個だけのツール定義と、それを使わざるを得ない短い質問を送る
   （例: ツール `get_number()` を渡し「get_number を呼んで結果を答えて」）。`max_tokens` を小さくする。
   - `tool_calls` がストリームに現れる → `tools: "native"`, `streamsToolCalls: true`
   - 400/422 で `tools` 引数が拒否される → `tools: "prompted"`
   - 200 だが `tool_calls` が来ず本文だけ返る → `tools: "prompted"`
3. `usage` が最終チャンクに含まれるか記録する。

判定は**その時点のモデルに対する結果**である。モデルを切り替えたときは、
`tools` が `native` でも失敗しうる。失敗時は自動で `prompted` へ落とさず、
「このモデルはツール呼び出しに応答しなかった」と表示して利用者に選ばせる
（黙って別方式へ差し替えると、動いているのか壊れているのか分からなくなるため）。

## リクエストの形

```ts
type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];      // tools:"native" のときだけ載せる
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
};
```

送信する JSON は OpenAI の `chat/completions` そのまま。`stream: true` と
`stream_options: {include_usage: true}` を付ける。ただし `stream_options` を
理解しないサーバが 400 を返す場合があるため、**400 が返り、かつ本文に
`stream_options` の語が含まれるときだけ**、これを外して1回だけ再送する。
再送したことはログに残す（黙ってリトライしない）。

## ストリームの解釈

`text/event-stream` を行単位で読み、`data: ` 以降を JSON として解釈する。
`data: [DONE]` で終端。空行と `:` で始まる行（コメント）は無視する。

各 `choices[0].delta` から次を組み立てる:

- `content` → `text-delta` イベント
- `tool_calls[]` → `index` ごとに `id` / `function.name` / `function.arguments` を**連結**する。
  `arguments` は断片で届くため、完了するまで JSON として解釈しない。
- `finish_reason` → `stop` / `length` / `tool_calls` / `content_filter` を記録
- 最終チャンクの `usage` → あれば記録、無ければ「不明」として扱い、推定値を本物のように見せない

### 思考出力の切り分け

推論するモデル（Qwen3 系、DeepSeek-R1 系など）は思考を出す。出方は2通りある。

1. **`reasoning_content` / `reasoning` フィールド** — そのまま `reasoning-delta` として流す。
2. **本文に `<think>…</think>` として混ざる** — 受け取った時点で切り分ける。
   `<think>` と `<thinking>` の2種類を見る。

2 を素通しすると、回答にタグごと表示されるうえ、代替方式のとき
**思考の中に書かれた下書きをツール呼び出しとして拾ってしまう**。だから受信時に分ける。

タグはチャンクの途中で割れるので、状態を持って解釈する。ただし
**末尾を無条件に保留しない**。タグの前半に見える分だけを次のチャンクまで待つ。
固定長を保留すると、思考を出さないモデルでも出力が遅れて塊になり、
ストリームの手応えが落ちる。

閉じタグが来ないまま応答が終わった場合、その部分は**思考として扱う**（本文へ混ぜない）。
`provider.unterminatedThinkBlock` としてログに残す。

いずれの場合も、思考は本文と混ぜず、画面では折りたたんで表示する。

## Provider が出すイベント

```ts
type ChatEvent =
  | { type: "start"; model: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }   // 連結完了後に1回
  | { type: "finish"; reason: FinishReason; usage?: Usage }
  | { type: "error"; error: ProviderError };
```

## エラーの分類

利用者に見せる文言と対処が違うので、必ず区別する。握り潰さない。

| 種別 | 判定 | 画面での扱い |
|---|---|---|
| `unreachable` | 接続拒否、名前解決失敗、タイムアウト | 「サーバに繋がりません」+ URLとサーバ起動の確認手順 |
| `unauthorized` | 401 / 403 | 「鍵が拒否されました」+ 設定画面への導線 |
| `model_not_found` | 404、または本文にモデル名の不在 | 「モデル {name} がありません」+ 一覧の再取得 |
| `bad_request` | 400 / 422 | サーバの返した本文をそのまま（秘密は伏せて）出す |
| `rate_limited` | 429 | 待ち時間があれば表示 |
| `server_error` | 5xx | 再試行の提案 |
| `incompatible` | 200 だが SSE として解釈できない | 「互換でない応答」+ 先頭200文字を診断として表示 |
| `aborted` | 利用者の停止 | エラー扱いにしない |

すべてのエラーは `ProviderError { kind, message, status?, bodyExcerpt?, endpointId, model }` を持つ。
`bodyExcerpt` は先頭2KBまで。ヘッダの `Authorization` はログにも診断にも出さない。

### `stream: true` を無視して一括で返すサーバ

`Content-Type: application/json` が返った場合は、非ストリームの
`chat/completions` 応答として解釈する。`choices[0].message` から本文・思考出力・
`tool_calls` を取り出し、通常と同じイベント列（`text-delta` → `finish`）へ変換する。

これは互換の欠落なので `provider.nonStreamedResponse` としてログに残す。
体感は「一気に出る」ため、画面では通常と区別が付かない。

`Content-Type` が JSON でもなく、SSE としても1件も解釈できなかった場合だけ
`incompatible` にする。

## 再試行

- **自動で再試行するのは、接続確立前の失敗のみ**（ECONNRESET / ETIMEDOUT / 5xx）。
  最大2回、1秒→3秒。
- 一度でもトークンを受け取った後の切断は、再試行**しない**。途中まで受け取った本文を残し、
  「応答が途中で切れました」と表示して、利用者に継続を選ばせる。
  勝手に再生成すると、前半と後半が繋がっていない答えを正しいものとして見せることになる。
- 429 は `Retry-After` があればそれに従い、無ければ再試行しない。

## タイムアウト

| 対象 | 既定 | 超えたら |
|---|---|---|
| 接続確立 | 10秒 | `unreachable` |
| 最初のトークンまで | `endpoint.timeoutMs`（既定120秒） | `unreachable`（ローカルLLMは初回ロードに時間がかかるため長め） |
| トークン間 | 120秒 | `incompatible` 扱いで中断 |
| 全体 | 上限なし | 利用者の停止に任せる |

## ツール非対応サーバ向けの代替（prompted モード）

`tools: "prompted"` のとき、ツール定義をシステムメッセージへ埋め込み、
モデルには次の形だけを出力させる。

````
```akari-tool
{"name": "read_file", "arguments": {"path": "src/main.ts"}}
```
````

- 解釈は**厳格**にする。フェンス内が JSON として読めない、`name` が未知、
  引数がスキーマに合わない場合は、実行せずにモデルへ「その形式では受け取れない」旨を返す。
  推測で補正しない。
- 1回の応答で複数ブロックが出た場合、上から順に実行する。上限は1応答あたり3件。
  超えた分は**黙って捨てず**、実行しなかったツール名をモデルと利用者の両方へ伝える。
- 読めないブロックがあっても、**読めたブロックがあるならそれは実行する**。
  1つの書き損じで、正しく書けた分まで無駄にしない。読めたものが1つも無いときだけやり直させる。
- `akari-tool` 以外のフェンス（```json など）は**拾わない**。推測で補正しない。
- ツール結果は `role: "user"` のメッセージとして
  `[akari-tool-result] {"name":..., "ok":true, "result":...}` の形で返す。
- この方式は `native` より失敗しやすい。画面とCLIに「代替方式で動作中」と常時表示し、
  成功しているように見せない。
- 表示上は、本文に混ざったブロック自体を隠してよい。何を呼んだかは
  ツール呼び出しの行に出るため、情報は失われない。

### 方式の確定（`auto` を残さない）

`capabilities.tools` が `auto` のまま実行すると、ツール非対応のモデルへ
ネイティブのツール定義を渡し、モデルが何も呼ばずに終わる。
**利用者からは「何も起きなかった」としか見えない。**

そのため実行の直前に、**そのモデルの判定結果が無ければ**1度だけ判定し、結果を保存する。

判定結果は `capabilities.byModel` にモデル名で保存する。
モデルを行き来しても判定し直さない。1つの接続先に複数のモデルがぶら下がる
（Ollama など）のが普通で、対応状況はモデルごとに違うため。

判定できなかった場合は `none` とし、**実行を始めずに**その旨を伝える。
「使えるふり」をしてツール定義を渡さない。

## 未解決の仮定

- Ollama の `/v1/chat/completions` におけるツール呼び出しのストリーム形式が、
  OpenAI の `tool_calls` 断片連結と完全に同じかは未検証。P0 で実機確認する。
- `stream_options` 非対応サーバの 400 本文にキーワードが含まれる保証はない。
  含まれない場合は再送されず `bad_request` になる。P0 で対象サーバ4種を確認する。

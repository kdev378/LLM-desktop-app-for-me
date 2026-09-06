# 04 — Chat 機能

## 目的

保存される、枝分かれできる、途中で止められる会話。日常の入口になる画面。

## メッセージの型

```ts
type Message = {
  id: string;                 // ULID。時刻順に並ぶ
  parentId: string | null;    // 枝構造。null は会話の先頭
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  reasoning?: string;         // 思考出力を返すモデル用。本文と混ぜない
  toolCallId?: string;        // role:"tool" のとき
  toolCalls?: ToolCallRecord[]; // role:"assistant" のとき
  meta: {
    createdAt: string;        // ISO8601
    model?: string;
    endpointId?: string;
    usage?: { prompt: number; completion: number };  // 不明なら省略。推定値を入れない
    finishReason?: FinishReason;
    error?: ProviderError;    // 失敗した応答も消さずに残す
    durationMs?: number;
  };
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataRef: string }  // 会話ディレクトリ内の相対パス
  | { type: "file"; name: string; mimeType: string; dataRef: string; textExcerpt?: string };
```

## 枝（分岐）

会話は列ではなく**木**として保存し、「今表示している道筋」を別に持つ。

```ts
type Conversation = {
  schemaVersion: 1;
  id: string;
  title: string;              // 自動生成 or 手動
  projectId: string | null;
  messages: Record<string, Message>;   // id -> Message。圧縮しても消さない
  activeLeafId: string | null;         // 現在の末端。ここから親を辿ったものが表示される
  settings: ConversationSettings;      // endpoint/model/params/systemPrompt の上書き
  compactions: Compaction[];           // 文脈の圧縮の記録（16-context.md）
  createdAt: string; updatedAt: string;
};
```

- 利用者が過去の発言を**編集**すると、同じ `parentId` を持つ新しいメッセージを作り、
  `activeLeafId` をそちらへ移す。**古い枝は消さない。**
- 応答の**再生成**も同様に、同じ `parentId` の兄弟として追加する。
- 分岐がある位置には `< 2 / 3 >` の切替を出す。切り替えると `activeLeafId` がその枝の末端へ移る。
- 「削除」は木からの削除であり、子孫ごと消える。実行前に「N件のメッセージが消えます」と示す。

理由: ローカルLLMは同じ入力でも結果が揺れる。良かった応答を消さずに試し直せることが要る。

## 送信の流れ

1. 入力欄の内容と添付から `user` メッセージを作り、即座に画面へ出す（保存もこの時点で行う）。
2. `activeLeafId` から根へ辿り、逆順にして API 用の `messages` を作る。
   先頭にシステムプロンプト（会話 > プロジェクト > 全体 の優先順位で1つに解決したもの）を置く。
3. `assistant` の空メッセージを作り、`text-delta` を追記していく。
4. `finish` で確定。`error` なら `meta.error` を入れて確定させ、**消さない**。
5. 会話ファイルを保存する。

保存の頻度: ストリーム中は 500ms ごと、または 4KB ごとにまとめて保存する。
`finish` / `error` / `abort` では必ず即座に保存する。アプリが落ちても、
その時点までの応答が残るようにする。

## 停止

- 生成中は送信ボタンが「停止」に変わる。
- 停止すると `AbortController` でストリームを切り、`finishReason: "aborted"` で確定する。
- 停止した応答は「途中で停止しました」の印を付けて残す。続きを求める操作（「続ける」）は
  同じ枝に新しいアシスタントメッセージを足すのではなく、**同じメッセージへの継続要求**として
  `messages` の末尾にそのまま渡し、追記する。

## 添付

| 種別 | 扱い |
|---|---|
| テキスト系（`.txt` `.md` `.json` `.csv` ソースコード等） | 中身を読み、`text` パートとしてファイル名付きで埋め込む。上限 256KB、超過分は末尾を省略して明記 |
| 画像（`.png` `.jpg` `.webp` `.gif`） | `vision: yes` の接続先でのみ添付可。それ以外では添付時に「この接続先は画像に対応していません」と出す |
| PDF | v1 では非対応。ドロップ時に「未対応」と表示する（黙って無視しない） |
| その他バイナリ | 非対応。同上 |

添付の実体は `conversations/<id>.files/` へコピーする。元ファイルを後で消しても会話が壊れないようにする。

## トークン数の表示

- サーバが `usage` を返す場合はその値を出す。
- 返さない場合は「概算」と明記した上で、文字数からの粗い推定を出す。
  **推定値を実測値と同じ見た目で出さない**（数値の横に `~` を付け、ツールチップで根拠を書く）。
- 文脈長を超えそうなときの警告は、モデルの文脈長が分かる場合のみ出す。
  分からないなら出さない（分からないことを警告に見せない）。
- 文脈が閾値を超えたときの扱いは `16-context.md`。古いターンを構造化して圧縮し、
  生の記録は残す。**黙って古いメッセージを落とすことはしない。**

## 検索

- 会話一覧の上部に検索欄。タイトルと本文を対象に、単純な部分一致（大文字小文字無視）。
- 実装は全会話ファイルの走査。1000会話までは十分速い想定。
  遅くなったら `07-data.md` の索引導入へ進む。**先に索引を作らない。**

## タイトル

- 最初の応答が終わった時点で、先頭の user メッセージの冒頭40文字を仮タイトルにする。
- 設定で「モデルにタイトルを付けさせる」を有効にできる（既定オフ）。
  有効時は別の短い呼び出しを1回だけ行う。失敗しても会話には影響させない。
- いつでも手動で変更できる。手動で変更したタイトルは自動更新しない。

## 画面上の状態

`generic/frontend.md` に従い、次を必ず区別できるようにする。

| 状態 | 見せ方 |
|---|---|
| 未送信の下書き | 入力欄に残る。アプリ再起動でも会話ごとに復元する |
| 送信済み・応答待ち（最初のトークン前） | 応答枠に脈打つ表示。何秒待っているかを表示（ローカルLLMはロードに時間がかかるため） |
| 生成中 | テキストが伸びる。停止ボタン有効 |
| 完了 | コピー・再生成・編集の操作が出る |
| 失敗 | 赤系の枠に、原因1行と対処。詳細は展開。**自動で消えない** |
| 停止 | 中立色の印。「続ける」操作 |

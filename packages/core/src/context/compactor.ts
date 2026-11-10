import type { ChatMessage, FinishReason, Provider } from '../provider/types.js';
import type { TranscriptEntry } from '../agent/transcript.js';
import { CHARS_PER_TOKEN, type Unit } from './budget.js';
import {
  emptyDigest,
  fallbackItems,
  parseDigest,
  type CompactionFallback,
  type Digest,
} from './digest.js';

/**
 * 古い手を Digest にまとめる。仕様: docs/spec/16-context.md「圧縮のやり方」
 *
 * - 前回の Digest を入力に含めて積み増す（毎回ゼロから作ると、要約の要約で薄まる）
 * - 1回の呼び出しに入りきらないときは分けて、順に積み増す
 * - 読めなければ1度だけ「形式が違う」と伝えてやり直させる。それでも駄目なら機械的な要約へ
 * - 思考は要約の本文とは別枠で取る。思考を止められないモデルが、思考だけで上限を使い切らないため。
 *   それでも使い切ったら、文脈長の範囲で枠を倍にして1度だけやり直し、まだ駄目ならログを半分に分ける
 */

const SYSTEM = `あなたは作業記録の要約係です。エージェントの作業ログの古い部分を、あとで作業を続けるための記録にまとめます。
次の5つに分類してください。

- decisions（決定）: こうすると決めたこと。理由も短く書く
- confirmed（確認済み）: 実際に見て確かめた事実。ファイルの場所と中身の要点、テストやコマンドの結果、環境の状態など
- rejected（棄却案）: 試したが駄目だったこと。なぜ駄目だったかを必ず書く
- open（未解決）: まだ分かっていないこと、確かめていないこと
- next（次の行動）: このあとやる予定のこと

規則:
- 各項目の sources には、根拠になったログの ID（[ID …] の中身）を入れる。ログに無い ID を作らない
- 「前回までのまとめ」があれば、その項目も引き継いで1つにまとめ直す。決定と棄却案は消さない。
  済んだ「次の行動」は消してよい
- ログに書かれていることだけを書く。推測で事実を足さない
- 出力は次の形のブロック1つだけにする。ほかの文は書かない

\`\`\`akari-digest
{"decisions":[{"text":"…","sources":["01J…"]}],"confirmed":[],"rejected":[],"open":[],"next":[]}
\`\`\``;

/** 1件の上限（文字）。ログ全体ではなく、1件が巨大なときに抑えるため。 */
const CAP = { user: 4000, assistant: 4000, reasoning: 1000, toolHead: 1500, toolTail: 500 };
/** 要約の本文に取る量（トークン）。思考の枠はこれとは別。 */
export const DIGEST_ANSWER_TOKENS = 4096;
/** 文脈長のうち、圧縮の呼び出しで使ってよい割合（残りは数え違いの余裕）。 */
const WINDOW_USE = 0.95;
/** 思考で使い切ったとき、ログを半分に分けてよい回数。 */
const MAX_SPLIT_DEPTH = 2;

/**
 * 1回の圧縮の呼び出しの量。応答（要約の本文＋思考の枠）を先に確保し、残りをログに充てる。
 * 文脈長が分からなければ、ログは compactAtTokens の8割、応答は本文＋思考の枠。
 */
export function compactionBudget(
  windowTokens: number | null,
  settings: { compactAtTokens: number; digestReasoningTokens: number },
): { inputTokens: number; outputTokens: number } {
  const want = DIGEST_ANSWER_TOKENS + settings.digestReasoningTokens;
  if (windowTokens === null) {
    return { inputTokens: Math.floor(settings.compactAtTokens * 0.8), outputTokens: want };
  }
  // 応答に文脈長の6割まで。ログは文脈長の半分まで（以前と同じ上限）
  const outputTokens = Math.max(
    DIGEST_ANSWER_TOKENS,
    Math.min(want, Math.floor(windowTokens * 0.6)),
  );
  const inputTokens = Math.max(
    1000,
    Math.min(Math.floor(windowTokens * 0.5), Math.floor(windowTokens * WINDOW_USE) - outputTokens),
  );
  return { inputTokens, outputTokens };
}

export type CompactRequest = {
  provider: Provider;
  model: string;
  units: Unit[];
  previous: Digest | null;
  /** sources に使ってよい ID（生の記録すべて）。 */
  knownIds: ReadonlySet<string>;
  /** 1回の圧縮の呼び出しに入れるログの量（トークン）。compactionBudget で決める。 */
  budgetTokens: number;
  /** 文脈長。分かれば、応答の上限をその範囲で伸ばす。分からなければ伸ばさない。 */
  windowTokens: number | null;
  /** 要約の本文とは別に取る思考の枠（トークン）。 */
  reasoningTokens: number;
  signal?: AbortSignal;
};

export type CompactResult = {
  digest: Digest;
  /** 機械的な要約へ落ちた分があれば、その理由（最初のもの）。 */
  fallback?: CompactionFallback;
  /** 利用者へ伝えること。 */
  notes: string[];
};

export async function compact(req: CompactRequest): Promise<CompactResult> {
  const notes: string[] = [];
  let digest = req.previous ?? emptyDigest();
  let fallback: CompactionFallback | undefined;

  // 思考で使い切った塊は、半分に分けて先頭へ戻す（分けた分だけ、応答に回せる量が増える）
  const queue = chunkUnits(req.units, req.budgetTokens, digest).map((units) => ({
    units,
    depth: 0,
  }));
  while (queue.length > 0) {
    const { units: chunk, depth } = queue.shift()!;
    const entries = chunk.flatMap((u) => u.entries);
    const result = await digestChunk(req, digest, chunk);
    if (!result.ok && result.exhausted && chunk.length > 1 && depth < MAX_SPLIT_DEPTH) {
      const half = Math.ceil(chunk.length / 2);
      queue.unshift(
        { units: chunk.slice(0, half), depth: depth + 1 },
        { units: chunk.slice(half), depth: depth + 1 },
      );
      continue;
    }
    if (result.ok) {
      digest = result.digest;
      if (result.unknownSources > 0) {
        notes.push(
          `圧縮版の ${result.unknownSources} 項目が、存在しない ID を根拠に挙げていました。その項目の根拠は空にしています。`,
        );
      }
      if (result.bareItems > 0) {
        notes.push(
          `圧縮版の ${result.bareItems} 項目に根拠の ID が付いていませんでした。中身はそのまま残しています。`,
        );
      }
      continue;
    }
    // 黙って捨てない。機械的な要約で残す（劣った圧縮であることは呼び出し側が表示する）
    fallback ??= result.reason;
    notes.push(`圧縮版を作れなかったため、機械的な要約で残しました（${result.detail}）。`);
    digest = { ...digest, confirmed: [...digest.confirmed, ...fallbackItems(entries)] };
    if (result.reason === 'aborted') break;
  }
  return { digest, ...(fallback ? { fallback } : {}), notes };
}

type ChunkResult =
  | { ok: true; digest: Digest; unknownSources: number; bareItems: number }
  /** exhausted … 思考で応答の上限を使い切り、要約を書き終えられなかった。 */
  | { ok: false; reason: CompactionFallback; detail: string; exhausted?: boolean };

async function digestChunk(
  req: CompactRequest,
  previous: Digest,
  chunk: Unit[],
): Promise<ChunkResult> {
  const hasPrevious = Object.values(previous).some((l) => l.length > 0);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `## 前回までのまとめ\n${hasPrevious ? JSON.stringify(previous) : 'なし'}\n\n` +
        `## 今回まとめるログ\n${chunk.map(renderUnit).join('\n\n')}`,
    },
  ];

  let lastError = '';
  let grow = 1;
  for (let attempt = 0; attempt < 2;) {
    let text = '';
    let reasoningChars = 0;
    let finish: FinishReason | null = null;
    const maxTokens = answerTokens(req, messages, grow);
    for await (const ev of req.provider.chat(
      {
        model: req.model,
        messages,
        temperature: 0.2,
        maxTokens,
        // 要約に思考は要らない。止められるモデルは止める（止められないモデルは無視する。枠は上で別に取ってある）
        reasoning: 'off',
      },
      req.signal,
    )) {
      if (ev.type === 'text-delta') text += ev.text;
      else if (ev.type === 'reasoning-delta') reasoningChars += ev.text.length;
      else if (ev.type === 'finish') finish = ev.reason;
      else if (ev.type === 'error') {
        return ev.error.kind === 'aborted'
          ? { ok: false, reason: 'aborted', detail: '中断されました' }
          : { ok: false, reason: 'model-error', detail: ev.error.message };
      }
    }
    const parsed = parseDigest(text, req.knownIds);
    if (parsed.ok) return parsed;
    // 上限で切れた（思考で使い切った）。形式の指摘をしても意味が無い。枠を伸ばすか、分けてもらう
    if (finish === 'length') {
      const detail =
        `モデルの思考が長く、圧縮版を書き終える前に応答の上限（${maxTokens} トークン、思考 約${reasoningChars} 文字）に達しました` +
        (req.windowTokens === null
          ? '。文脈長が分からないため伸ばしていません（akari config endpoints probe --context で設定できます）'
          : '。context.digestReasoningTokens を増やすか、文脈長を伸ばすと通ることがあります');
      if (grow === 1 && answerTokens(req, messages, 2) > maxTokens) {
        grow = 2;
        continue;
      }
      return { ok: false, reason: 'parse-failed', detail, exhausted: true };
    }
    lastError = parsed.error;
    // 1度だけ、何が違ったかを伝えてやり直させる
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `[akari] 形式が違います: ${parsed.error}\n説明は書かずに、\`\`\`akari-digest のブロック1つだけを出してください。`,
    });
    attempt++;
  }
  return { ok: false, reason: 'parse-failed', detail: lastError };
}

/**
 * 応答の上限。要約の本文＋思考の枠（grow 倍）。文脈長が分かれば、ログを入れた残りまで。
 * 文脈長が分からなければ伸ばさない（送れない量を頼むと、サーバによっては断られるため）。
 */
function answerTokens(req: CompactRequest, messages: ChatMessage[], grow: number): number {
  const want = DIGEST_ANSWER_TOKENS + req.reasoningTokens * grow;
  if (req.windowTokens === null) return DIGEST_ANSWER_TOKENS + req.reasoningTokens;
  // 概算は少なめに出ることがあるので、1割多めに見る
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const input = Math.ceil((chars / CHARS_PER_TOKEN) * 1.1);
  const room = Math.floor(req.windowTokens * WINDOW_USE) - input;
  return Math.max(DIGEST_ANSWER_TOKENS, Math.min(want, room));
}

/** 1回の呼び出しに入るように分ける。1単位が大きすぎても、単独で1回にする（中で切り詰める）。 */
function chunkUnits(units: Unit[], budgetTokens: number, previous: Digest): Unit[][] {
  const budgetChars = Math.max(
    2000,
    Math.floor(budgetTokens * CHARS_PER_TOKEN) - SYSTEM.length - JSON.stringify(previous).length,
  );
  const chunks: Unit[][] = [];
  let cur: Unit[] = [];
  let size = 0;
  for (const u of units) {
    const len = renderUnit(u).length;
    if (cur.length > 0 && size + len > budgetChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 圧縮の材料としてログを書き出す。各行に ID を付ける（sources に使わせるため）。 */
export function renderUnit(unit: Unit): string {
  return unit.entries.map(renderEntry).join('\n');
}

function renderEntry(e: TranscriptEntry): string {
  const id = `[ID ${e.id}]`;
  if (e.role === 'user') {
    return `${id} ${e.source === 'akari' ? 'Akari からの指摘' : '利用者'}: ${cap(e.text, CAP.user)}`;
  }
  if (e.role === 'assistant') {
    const lines = [
      `${id} モデル${e.failed ? '（失敗した応答）' : ''}: ${cap(e.text, CAP.assistant)}`,
    ];
    if (e.reasoning) lines.push(`  （思考の抜粋）${cap(e.reasoning, CAP.reasoning)}`);
    for (const c of e.toolCalls ?? [])
      lines.push(`  呼んだ道具: ${c.name} ${cap(c.argumentsRaw, 300)}`);
    return lines.join('\n');
  }
  const body =
    e.text.length > CAP.toolHead + CAP.toolTail
      ? `${e.text.slice(0, CAP.toolHead)}\n…（${e.text.length - CAP.toolHead - CAP.toolTail} 文字省略）…\n${e.text.slice(-CAP.toolTail)}`
      : e.text;
  return `${id} 道具 ${e.toolName ?? ''} の結果（${e.ok ? '成功' : '失敗'}）:\n${body}`;
}

function cap(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…（以下省略）` : text;
}

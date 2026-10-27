import type { ChatMessage, Provider, ReasoningLevel } from '../provider/types.js';
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
const DIGEST_MAX_TOKENS = 4096;

export type CompactRequest = {
  provider: Provider;
  model: string;
  units: Unit[];
  previous: Digest | null;
  /** sources に使ってよい ID（生の記録すべて）。 */
  knownIds: ReadonlySet<string>;
  /** 1回の圧縮の呼び出しに使ってよい量（トークン）。 */
  budgetTokens: number;
  reasoning?: ReasoningLevel;
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

  for (const chunk of chunkUnits(req.units, req.budgetTokens, digest)) {
    const entries = chunk.flatMap((u) => u.entries);
    const result = await digestChunk(req, digest, chunk);
    if (result.ok) {
      digest = result.digest;
      if (result.unknownSources > 0) {
        notes.push(
          `圧縮版の ${result.unknownSources} 項目が、存在しない ID を根拠に挙げていました。その項目の根拠は空にしています。`,
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
  | { ok: true; digest: Digest; unknownSources: number }
  | { ok: false; reason: CompactionFallback; detail: string };

async function digestChunk(req: CompactRequest, previous: Digest, chunk: Unit[]): Promise<ChunkResult> {
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
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = '';
    for await (const ev of req.provider.chat(
      {
        model: req.model,
        messages,
        temperature: 0.2,
        maxTokens: DIGEST_MAX_TOKENS,
        ...(req.reasoning ? { reasoning: req.reasoning } : {}),
      },
      req.signal,
    )) {
      if (ev.type === 'text-delta') text += ev.text;
      else if (ev.type === 'error') {
        return ev.error.kind === 'aborted'
          ? { ok: false, reason: 'aborted', detail: '中断されました' }
          : { ok: false, reason: 'model-error', detail: ev.error.message };
      }
    }
    const parsed = parseDigest(text, req.knownIds);
    if (parsed.ok) return parsed;
    lastError = parsed.error;
    // 1度だけ、何が違ったかを伝えてやり直させる
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `[akari] 形式が違います: ${parsed.error}\n説明は書かずに、\`\`\`akari-digest のブロック1つだけを出してください。`,
    });
  }
  return { ok: false, reason: 'parse-failed', detail: lastError };
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
    const lines = [`${id} モデル${e.failed ? '（失敗した応答）' : ''}: ${cap(e.text, CAP.assistant)}`];
    if (e.reasoning) lines.push(`  （思考の抜粋）${cap(e.reasoning, CAP.reasoning)}`);
    for (const c of e.toolCalls ?? []) lines.push(`  呼んだ道具: ${c.name} ${cap(c.argumentsRaw, 300)}`);
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

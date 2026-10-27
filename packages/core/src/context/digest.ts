import type { TranscriptEntry } from '../agent/transcript.js';

/**
 * 圧縮版（Digest）。仕様: docs/spec/16-context.md「圧縮の結果」
 *
 * 各項目に、根拠になった生のメッセージ ID（sources）を持たせる。
 * 「なぜそう書いてあるのか」を必ず追えるようにするため。
 */

export type DigestItem = { text: string; sources: string[] };

export type Digest = {
  /** 決定: こうすると決めたこと。理由も短く含める。 */
  decisions: DigestItem[];
  /** 確認済み: 実際に見て確かめた事実。 */
  confirmed: DigestItem[];
  /** 棄却案: 試したが駄目だったこと。なぜ駄目かも書く。 */
  rejected: DigestItem[];
  /** 未解決: まだ分かっていないこと、確かめていないこと。 */
  open: DigestItem[];
  /** 次の行動: このあとやる予定のこと。 */
  next: DigestItem[];
};

export const DIGEST_KEYS = ['decisions', 'confirmed', 'rejected', 'open', 'next'] as const;
export type DigestKey = (typeof DIGEST_KEYS)[number];

export const DIGEST_LABELS: Record<DigestKey, string> = {
  decisions: '決定',
  confirmed: '確認済み',
  rejected: '棄却案',
  open: '未解決',
  next: '次の行動',
};

export type CompactionFallback = 'parse-failed' | 'model-error' | 'aborted';

/** 会話の見出しに残す圧縮の記録（04-chat.md の compactions）。 */
export type Compaction = {
  id: string;
  createdAt: string;
  /** 圧縮の対象にしたメッセージ ID。これまでの圧縮の分も含めた累計（生は消さない）。 */
  coveredMessageIds: string[];
  /** 今回新しく圧縮した手数。 */
  coveredTurns: number;
  model: string;
  endpointId: string;
  digest: Digest;
  beforeTokens: number;
  afterTokens: number;
  estimated: boolean;
  /** 機械的な要約へ落ちた場合の理由。 */
  fallback?: CompactionFallback;
};

export function emptyDigest(): Digest {
  return { decisions: [], confirmed: [], rejected: [], open: [], next: [] };
}

export type ParseResult =
  | {
      ok: true;
      digest: Digest;
      /** 存在しない ID を根拠に挙げていた項目の数（根拠は空にした）。 */
      unknownSources: number;
      /** 根拠の無い文字列だけで書かれていた項目の数。 */
      bareItems: number;
    }
  | { ok: false; error: string };

const FENCE = /```akari-digest[ \t]*\r?\n([\s\S]*?)```/;

/**
 * モデルの出力から Digest を取り出す。厳格に読む。推測で補正しない。
 * - akari-digest のフェンスが無い、JSON として読めない、項目の形が違う → 失敗
 * - 中身が空の分類を省いたのは失敗にしない（空の一覧として扱う）
 * - 項目が文字列だけ（"残りを読む"）なら、根拠の無い項目として受け付ける。
 *   中身は推測なしに読めるし、根拠は空なので参照できるようには見えない。
 *   小さいモデル（Granite 8B）がこう書いて、全部を捨てていた（2026-10-27）
 * - sources に知らない ID があれば、その項目は残して sources を空にする
 *   （参照できないものを、参照できるように見せない）
 */
export function parseDigest(text: string, knownIds: ReadonlySet<string>): ParseResult {
  const m = FENCE.exec(text);
  if (!m) return { ok: false, error: '```akari-digest のブロックがありません。' };
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch (err) {
    return { ok: false, error: `JSON として読めません: ${(err as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '一番外側がオブジェクトではありません。' };
  }
  const obj = raw as Record<string, unknown>;
  const digest = emptyDigest();
  let unknownSources = 0;
  let bareItems = 0;
  for (const key of DIGEST_KEYS) {
    const list = obj[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: `${key} が配列ではありません。` };
    for (const [i, item] of list.entries()) {
      if (typeof item === 'string') {
        if (item.trim() === '') return { ok: false, error: `${key}[${i}] が空です。` };
        bareItems += 1;
        digest[key].push({ text: item.trim(), sources: [] });
        continue;
      }
      if (typeof item !== 'object' || item === null) {
        return { ok: false, error: `${key}[${i}] が {"text", "sources"} の形ではありません。` };
      }
      const it = item as Record<string, unknown>;
      if (typeof it.text !== 'string' || it.text.trim() === '') {
        return { ok: false, error: `${key}[${i}].text がありません。` };
      }
      const sources = Array.isArray(it.sources)
        ? it.sources.filter((s): s is string => typeof s === 'string')
        : [];
      const valid = sources.every((s) => knownIds.has(s));
      if (!valid) unknownSources += 1;
      digest[key].push({ text: it.text.trim(), sources: valid ? sources : [] });
    }
  }
  return { ok: true, digest, unknownSources, bareItems };
}

/** システムプロンプトと画面に出す形。根拠の ID も出す（recall_read で原文を引けるように）。 */
export function renderDigest(digest: Digest): string {
  const parts: string[] = [];
  for (const key of DIGEST_KEYS) {
    const items = digest[key];
    if (items.length === 0) continue;
    parts.push(`### ${DIGEST_LABELS[key]}`);
    for (const it of items) {
      parts.push(`- ${it.text}${it.sources.length > 0 ? ` [${it.sources.join(', ')}]` : ''}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : '（まとめる内容はありませんでした）';
}

/**
 * 機械的な要約（モデルに頼らない退避方法）。16-context.md「退避方法」
 * 決定などの分類はできないので、事実として「確認済み」に並べる。劣った圧縮であることを明記する。
 */
export function fallbackItems(entries: TranscriptEntry[]): DigestItem[] {
  const items: DigestItem[] = [];
  const byCall = new Map<string, TranscriptEntry>();
  for (const e of entries) if (e.role === 'tool' && e.toolCallId) byCall.set(e.toolCallId, e);

  for (const e of entries) {
    if (e.role === 'user' && e.source !== 'akari') {
      items.push({ text: `（機械的な要約）依頼: ${head(e.text, 200)}`, sources: [e.id] });
    } else if (e.role === 'assistant') {
      if (e.text.trim() !== '' && !e.failed) {
        items.push({ text: `（機械的な要約）応答: ${head(e.text, 200)}`, sources: [e.id] });
      }
      for (const call of e.toolCalls ?? []) {
        const result = byCall.get(call.id);
        const status = result ? (result.ok ? '成功' : '失敗') : '結果なし';
        items.push({
          text: `（機械的な要約）${call.name} ${describeArgs(call.argumentsRaw)} → ${status}`,
          sources: result ? [e.id, result.id] : [e.id],
        });
      }
    }
  }
  return items;
}

function describeArgs(raw: string): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    if (typeof a.path === 'string') return a.path;
    if (typeof a.command === 'string') return `"${head(a.command, 120)}"`;
    if (typeof a.pattern === 'string') return a.pattern;
    return head(raw, 120);
  } catch {
    return head(raw, 120);
  }
}

function head(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

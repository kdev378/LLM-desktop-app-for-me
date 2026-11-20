import { z } from 'zod';
import { ulidTime } from '../util/ids.js';
import type { TranscriptEntry } from '../agent/transcript.js';
import type { ToolSpec } from './types.js';

/**
 * 生の記録を引く道具。圧縮が起きた会話でだけ渡す（使う意味が無い道具を渡さない）。
 * 仕様: docs/spec/16-context.md「生の記録を引く（recall）」
 *
 * 検索は素朴な部分一致（大文字小文字を無視）。/…/ で囲めば正規表現。
 * 1会話のメッセージ数はたかだか数百なので、線形走査で足りる。
 */

export type RecallHit = {
  id: string;
  role: TranscriptEntry['role'];
  toolName?: string;
  at: string | null;
  /** 一致した箇所の前後。 */
  excerpt: string;
  /** 思考の出力の中で一致したか。 */
  inReasoning: boolean;
};

export function searchTranscript(
  entries: readonly TranscriptEntry[],
  query: string,
  opts: { k?: number; role?: TranscriptEntry['role']; includeReasoning?: boolean } = {},
): RecallHit[] {
  const matcher = makeMatcher(query);
  const k = opts.k ?? 5;
  const hits: RecallHit[] = [];
  // 新しいものから。直近の事実ほど役に立つことが多い
  for (const e of [...entries].reverse()) {
    if (opts.role && e.role !== opts.role) continue;
    let where = matcher(e.text);
    let inReasoning = false;
    if (where === null && opts.includeReasoning !== false && e.reasoning) {
      where = matcher(e.reasoning);
      inReasoning = where !== null;
    }
    if (where === null) continue;
    const source = inReasoning ? e.reasoning! : e.text;
    hits.push({
      id: e.id,
      role: e.role,
      ...(e.toolName ? { toolName: e.toolName } : {}),
      at: ulidTime(e.id)?.toISOString() ?? null,
      excerpt: excerptAround(source, where, 120),
      inReasoning,
    });
    if (hits.length >= k) break;
  }
  return hits;
}

/** 1件の全文（思考と道具の呼び出しを含む）。 */
export function formatEntry(e: TranscriptEntry): string {
  const lines = [`ID: ${e.id}`, `役割: ${describeRole(e)}`];
  const at = ulidTime(e.id);
  if (at) lines.push(`日時: ${at.toISOString()}`);
  if (e.role === 'tool') lines.push(`結果: ${e.ok ? '成功' : '失敗'}`);
  if (e.reasoning) lines.push('', '--- 思考 ---', e.reasoning);
  lines.push('', '--- 本文 ---', e.text);
  for (const c of e.toolCalls ?? []) lines.push(`呼んだ道具: ${c.name} ${c.argumentsRaw}`);
  return lines.join('\n');
}

function describeRole(e: TranscriptEntry): string {
  if (e.role === 'user') return e.source === 'akari' ? 'Akari からの指摘' : '利用者';
  if (e.role === 'assistant') return e.failed ? 'モデル（失敗した応答）' : 'モデル';
  return `道具 ${e.toolName ?? ''} の結果`;
}

function makeMatcher(query: string): (text: string) => number | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (m) {
    let re: RegExp;
    try {
      re = new RegExp(m[1]!, m[2]!.includes('i') ? m[2] : `${m[2]}i`);
    } catch {
      re = new RegExp(escapeRegExp(query), 'i');
    }
    return (text) => {
      const r = re.exec(text);
      return r ? r.index : null;
    };
  }
  const q = query.toLowerCase();
  return (text) => {
    const i = text.toLowerCase().indexOf(q);
    return i >= 0 ? i : null;
  };
}

function excerptAround(text: string, at: number, span: number): string {
  const start = Math.max(0, at - span);
  const end = Math.min(text.length, at + span);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const searchArgs = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
  role: z.enum(['user', 'assistant', 'tool']).optional(),
  includeReasoning: z.boolean().optional(),
});

export const recallSearchTool: ToolSpec = {
  name: 'recall_search',
  description:
    'この会話の生の記録（圧縮される前のやり取り、思考、道具の結果）を検索する。圧縮版に無い細部を確かめるときに使う。/…/ で囲むと正規表現。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '探す語句' },
      k: { type: 'integer', description: '最大件数（既定5）' },
      role: { type: 'string', enum: ['user', 'assistant', 'tool'], description: '役割で絞る' },
      includeReasoning: { type: 'boolean', description: '思考の出力も探すか（既定 true）' },
    },
    required: ['query'],
  },
  risk: 'read',
  async run(raw, ctx) {
    const parsed = searchArgs.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, summary: '引数が不正です', content: parsed.error.message };
    }
    const a = parsed.data;
    const hits = searchTranscript(ctx.transcript?.() ?? [], a.query, {
      ...(a.k !== undefined ? { k: a.k } : {}),
      ...(a.role ? { role: a.role } : {}),
      ...(a.includeReasoning !== undefined ? { includeReasoning: a.includeReasoning } : {}),
    });
    if (hits.length === 0) {
      return {
        ok: true,
        summary: '見つかりませんでした',
        content: `「${a.query}」に一致する記録はありません。`,
      };
    }
    const content = hits
      .map(
        (h) =>
          `[${h.id}] ${h.role}${h.toolName ? `(${h.toolName})` : ''}${h.inReasoning ? '（思考）' : ''} ${h.at ?? ''}\n  ${h.excerpt}`,
      )
      .join('\n');
    return {
      ok: true,
      summary: `${hits.length}件見つかりました`,
      content: `${content}\n\n全文は recall_read に ID を渡して読めます。`,
    };
  },
};

const readArgs = z.object({ messageId: z.string().min(1) });

export const recallReadTool: ToolSpec = {
  name: 'recall_read',
  description:
    'この会話の生の記録を1件、全文で読む（思考の出力を含む）。ID は recall_search や圧縮版の角括弧の中にある。',
  parameters: {
    type: 'object',
    properties: { messageId: { type: 'string', description: 'メッセージの ID' } },
    required: ['messageId'],
  },
  risk: 'read',
  async run(raw, ctx) {
    const parsed = readArgs.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, summary: '引数が不正です', content: parsed.error.message };
    }
    const entry = (ctx.transcript?.() ?? []).find((e) => e.id === parsed.data.messageId.trim());
    if (!entry) {
      return {
        ok: false,
        summary: '見つかりません',
        content: `ID ${parsed.data.messageId} の記録はこの会話にありません。recall_search で探してください。`,
      };
    }
    const full = formatEntry(entry);
    const limit = ctx.limits.toolOutputLimitBytes;
    const content =
      Buffer.byteLength(full) > limit
        ? `${Buffer.from(full).subarray(0, limit).toString('utf8')}\n\n[akari] 上限（${limit}バイト）で切りました。`
        : full;
    return { ok: true, summary: `${entry.id} を読んだ`, content };
  },
};

export const RECALL_TOOLS: ToolSpec[] = [recallSearchTool, recallReadTool];

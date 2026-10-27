import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ConversationStore,
  DIGEST_KEYS,
  DIGEST_LABELS,
  formatEntry,
  isAkariError,
  searchTranscript,
  tildify,
  toTranscript,
  type Conversation,
} from '@akari/core';
import { createContext, type GlobalOptions } from '../context.js';
import { c, out, note } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/**
 * akari digest / akari recall。仕様: docs/spec/16-context.md「CLI」
 * モデルが何を前提に動いているかを、利用者が読める形で確かめられるようにする。
 * どちらも保存した会話を読むだけで、モデルには繋がない。
 */

type Target = GlobalOptions & { conversation?: string; cwd?: string };

export async function digestCommand(opts: Target): Promise<void> {
  const ctx = await createContext(opts);
  const conv = await pickConversation(ctx.root, opts);
  const compaction = conv.latestCompaction();

  if (ctx.json) {
    out(JSON.stringify({ conversationId: conv.id, compaction }));
    return;
  }
  out(c.dim(`会話 ${conv.id}  ${conv.header.title || '（無題）'}`));
  if (!compaction) {
    out('この会話ではまだ圧縮が起きていません。モデルには生のやり取りがそのまま渡っています。');
    return;
  }
  const n = conv.header.compactions.length;
  out(
    c.dim(
      `圧縮 ${n}回目  ${compaction.createdAt}  ${compaction.model}  ${compaction.coveredTurns}手を圧縮  ` +
        `約${compaction.beforeTokens.toLocaleString()} → 約${compaction.afterTokens.toLocaleString()}トークン${compaction.estimated ? '（概算）' : ''}`,
    ),
  );
  out(
    c.dim(
      `圧縮した生のメッセージ ${compaction.coveredMessageIds.length}件は、会話に残っています（akari recall で引けます）。`,
    ),
  );
  if (compaction.fallback) {
    out(
      c.yellow(
        `モデルが圧縮版を書けなかった分は、機械的な要約で残しています（理由: ${compaction.fallback}）。`,
      ),
    );
  }
  out('');
  for (const key of DIGEST_KEYS) {
    const items = compaction.digest[key];
    out(c.bold(`${DIGEST_LABELS[key]}（${items.length}）`));
    if (items.length === 0) out(c.dim('  なし'));
    for (const it of items) {
      out(`  - ${it.text}`);
      if (it.sources.length > 0) out(c.dim(`    根拠: ${it.sources.join(', ')}`));
    }
    out('');
  }
}

export async function recallCommand(
  query: string | undefined,
  opts: Target & { read?: string; limit?: string },
): Promise<void> {
  const ctx = await createContext(opts);
  const conv = await pickConversation(ctx.root, opts);
  const entries = toTranscript(conv.all());

  if (opts.read) {
    const entry = entries.find((e) => e.id === opts.read!.trim().toUpperCase());
    if (!entry) {
      throw new ExitError(
        EXIT.usage,
        `会話 ${conv.id} に、ID ${opts.read} のメッセージはありません。`,
      );
    }
    if (ctx.json) out(JSON.stringify(entry));
    else out(formatEntry(entry));
    return;
  }
  if (!query) {
    throw new ExitError(EXIT.usage, '探す語句を渡してください。', {
      hint: 'akari recall "タイムアウト"  /  原文は akari recall --read <ID>',
    });
  }
  const k = opts.limit !== undefined ? Number(opts.limit) : 10;
  if (!Number.isInteger(k) || k < 1) {
    throw new ExitError(EXIT.usage, '--limit は 1 以上の整数で指定してください。');
  }
  const hits = searchTranscript(entries, query, { k });
  if (ctx.json) {
    out(JSON.stringify({ conversationId: conv.id, hits }));
    return;
  }
  out(c.dim(`会話 ${conv.id}  ${conv.header.title || '（無題）'}  ${entries.length}件から検索`));
  if (hits.length === 0) {
    out(`「${query}」に一致する記録はありません。`);
    return;
  }
  const covered = new Set(conv.latestCompaction()?.coveredMessageIds ?? []);
  for (const h of hits) {
    const marks = [
      h.role === 'tool' ? `道具 ${h.toolName ?? ''}` : h.role === 'user' ? '利用者' : 'モデル',
    ];
    if (h.inReasoning) marks.push('思考');
    if (covered.has(h.id)) marks.push('圧縮済み');
    out(`${c.cyan(h.id)}  ${c.dim(marks.join(' / '))}  ${c.dim(h.at ?? '')}`);
    out(`  ${h.excerpt}`);
  }
  out(c.dim('\n原文を読むには: akari recall --read <ID>'));
}

/** --conversation があればそれ、無ければ作業フォルダの直近の会話（run のもの）。 */
async function pickConversation(root: string, opts: Target): Promise<Conversation> {
  const store = new ConversationStore(root);
  try {
    if (opts.conversation) return await store.open(opts.conversation);
    const dir = await fs
      .realpath(path.resolve(opts.cwd ?? process.cwd()))
      .catch(() => path.resolve(opts.cwd ?? process.cwd()));
    const latest = await store.latest({ kind: 'agent', workspace: dir });
    if (!latest) {
      throw new ExitError(EXIT.usage, `この作業フォルダ（${tildify(dir)}）の会話がありません。`, {
        hint: '--conversation <ID> で指定するか、akari conversations で一覧を確認できます。',
      });
    }
    const conv = await store.open(latest.id);
    for (const p of conv.problems) note(p.message);
    return conv;
  } catch (err) {
    if (isAkariError(err) && err.code.startsWith('conversation.')) {
      throw new ExitError(EXIT.usage, err.message, {
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    throw err;
  }
}

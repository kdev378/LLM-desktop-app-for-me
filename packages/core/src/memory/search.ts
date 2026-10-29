import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoadedIndex } from './store.js';

/**
 * 総当たりの検索。仕様: docs/spec/14-memory.md「検索」
 * 正規化してあるので、内積がそのままコサイン類似度。点数は閾値で捨てずに見せる。
 */

export type SearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  /** 索引の後で、そのファイルが変わっている（または消えた）。 */
  stale: boolean;
};

export const MAX_K = 30;

export async function searchIndex(
  index: LoadedIndex,
  query: Float32Array,
  opts: { k: number; pathPrefix?: string },
): Promise<SearchHit[]> {
  const dims = index.meta.embedding.dims;
  if (query.length !== dims) {
    throw new Error(`問いの次元（${query.length}）が索引（${dims}）と違います。`);
  }
  const k = Math.max(1, Math.min(MAX_K, opts.k));
  const prefix = opts.pathPrefix ? normalizePrefix(opts.pathPrefix) : null;
  const { chunks, vectors } = index;

  // 上位 k 件だけを持つ（全件を並べ替えない）
  const top: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < chunks.length; i++) {
    if (prefix && !(chunks[i]!.path === prefix || chunks[i]!.path.startsWith(`${prefix}/`)))
      continue;
    let s = 0;
    const base = i * dims;
    for (let j = 0; j < dims; j++) s += vectors[base + j]! * query[j]!;
    if (top.length < k) {
      top.push({ i, score: s });
      top.sort((a, b) => b.score - a.score);
    } else if (s > top[k - 1]!.score) {
      top[k - 1] = { i, score: s };
      top.sort((a, b) => b.score - a.score);
    }
  }

  const hits: SearchHit[] = [];
  for (const { i, score } of top) {
    const c = chunks[i]!;
    hits.push({ ...c, score, stale: await isStale(index, c.path) });
  }
  return hits;
}

async function isStale(index: LoadedIndex, relative: string): Promise<boolean> {
  const f = index.meta.files[relative];
  if (!f) return true;
  try {
    const st = await fs.stat(path.join(index.meta.root, relative));
    return st.size !== f.size || Math.floor(st.mtimeMs) !== f.mtimeMs;
  } catch {
    return true;
  }
}

function normalizePrefix(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

/** 人とモデルに見せる形。必ずファイル名と行番号を出す（read_file でそのまま確かめられるように）。 */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '索引に当たるものがありませんでした。';
  return hits
    .map(
      (h, n) =>
        `${n + 1}. ${h.path}:${h.startLine}-${h.endLine}  点数 ${h.score.toFixed(3)}` +
        (h.stale ? '  （索引の後で変わっています。read_file で今の中身を確かめてください）' : '') +
        `\n${h.text}`,
    )
    .join('\n\n');
}

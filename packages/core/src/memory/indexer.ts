import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { MemorySettings } from '../config/schema.js';
import { looksBinary } from '../tools/walk.js';
import { CHUNK_STRATEGY, chunkText, embedText, type Chunk } from './chunk.js';
import { sameIdentity, type Embedder } from './embedder.js';
import { listIndexTargets, type IndexTarget, type TargetList } from './files.js';
import {
  INDEX_SCHEMA_VERSION,
  acquireUpdateLock,
  indexDir,
  indexIdFor,
  loadIndex,
  writeGeneration,
  type FileEntry,
  type IndexMeta,
  type LoadedIndex,
} from './store.js';

/**
 * 索引を作る・変わったファイルだけ更新する。仕様: docs/spec/14-memory.md「更新」
 */

export type IndexProgress =
  { phase: 'scan' } | { phase: 'embed'; done: number; total: number } | { phase: 'write' };

export type ChangeSummary = {
  added: string[];
  changed: string[];
  removed: string[];
  /** 中身を読む価値が無いので飛ばしたもの（バイナリ・読めない）。 */
  unreadable: number;
};

export type UpdateResult =
  | { status: 'unchanged'; meta: IndexMeta; targets: TargetList }
  | {
      status: 'updated';
      meta: IndexMeta;
      summary: ChangeSummary;
      targets: TargetList;
      rebuilt: boolean;
      ms: number;
    }
  /** 変わったファイルが多すぎる（自動更新の上限）。何も書いていない。 */
  | { status: 'too-many'; changedFiles: number; limit: number };

export type UpdateOptions = {
  dataRoot: string;
  workspaceRoot: string;
  embedder: Embedder;
  settings: Pick<MemorySettings, 'maxFileBytes' | 'chunkChars' | 'overlapChars'>;
  /** 作り直す（既存の索引を使わない）。 */
  rebuild?: boolean;
  /** 変わったファイルがこれを超えたら更新しない（実行の最初の自動更新）。 */
  maxChangedFiles?: number;
  signal?: AbortSignal;
  onProgress?: (p: IndexProgress) => void;
};

type Planned = {
  target: IndexTarget;
  hash: string;
  chunks: Chunk[] | null;
  reuse: FileEntry | null;
};

export async function updateIndex(opts: UpdateOptions): Promise<UpdateResult> {
  const started = Date.now();
  const dir = indexDir(opts.dataRoot, opts.workspaceRoot);
  const identity = await opts.embedder.identity();
  const loaded = await loadIndex(dir);
  const chunking = {
    maxChars: effectiveChunkChars(opts.settings.chunkChars, identity.maxTokens),
    overlapChars: opts.settings.overlapChars,
    strategy: CHUNK_STRATEGY,
  };
  // 埋め込みか切り方が違う索引は使えない（混ぜない）。作り直す
  const previous: LoadedIndex | null =
    !opts.rebuild &&
    loaded.kind === 'ready' &&
    sameIdentity(loaded.index.meta.embedding, identity) &&
    sameChunking(loaded.index.meta.chunking, chunking)
      ? loaded.index
      : null;

  opts.onProgress?.({ phase: 'scan' });
  const targets = await listIndexTargets(opts.workspaceRoot, {
    maxFileBytes: opts.settings.maxFileBytes,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // 大きさと更新時刻が同じなら読まない。違えば中身の指紋で確かめる
  const planned: Planned[] = [];
  const summary: ChangeSummary = { added: [], changed: [], removed: [], unreadable: 0 };
  const toEmbed: Planned[] = [];
  for (const t of targets.files) {
    if (opts.signal?.aborted) throw abortError();
    const prev = previous?.meta.files[t.relative] ?? null;
    if (prev && prev.size === t.size && prev.mtimeMs === t.mtimeMs) {
      planned.push({ target: t, hash: prev.hash, chunks: null, reuse: prev });
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(t.absolute);
    } catch {
      summary.unreadable++;
      continue;
    }
    if (looksBinary(buf)) {
      summary.unreadable++;
      continue;
    }
    const hash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
    if (prev && prev.hash === hash) {
      planned.push({ target: t, hash, chunks: null, reuse: prev });
      continue;
    }
    const p: Planned = {
      target: t,
      hash,
      chunks: chunkText(t.relative, buf.toString('utf8'), chunking),
      reuse: null,
    };
    planned.push(p);
    toEmbed.push(p);
    (prev ? summary.changed : summary.added).push(t.relative);
  }
  const kept = new Set(planned.map((p) => p.target.relative));
  if (previous) {
    for (const f of Object.keys(previous.meta.files)) if (!kept.has(f)) summary.removed.push(f);
  }
  const changedFiles = summary.added.length + summary.changed.length + summary.removed.length;
  if (opts.maxChangedFiles !== undefined && previous && changedFiles > opts.maxChangedFiles) {
    return { status: 'too-many', changedFiles, limit: opts.maxChangedFiles };
  }
  if (previous && changedFiles === 0 && !mtimesMoved(previous, planned)) {
    return { status: 'unchanged', meta: previous.meta, targets };
  }

  // 更新は同時に1つだけ。読む側は差し替え前の版を読み続ける
  const release = await acquireUpdateLock(dir);
  try {
    const texts = toEmbed.flatMap((p) => p.chunks!.map(embedText));
    const fresh: Float32Array[] = [];
    const total = texts.length;
    const step = 64;
    for (let i = 0; i < total; i += step) {
      if (opts.signal?.aborted) throw abortError();
      opts.onProgress?.({ phase: 'embed', done: i, total });
      fresh.push(...(await opts.embedder.embed(texts.slice(i, i + step), 'passage', opts.signal)));
    }
    opts.onProgress?.({ phase: 'embed', done: total, total });
    const after = await opts.embedder.identity();
    const dims = after.dims ?? previous?.meta.embedding.dims ?? null;
    if (dims === null) {
      throw new Error('埋め込みの次元が分かりません（対象のファイルがありません）。');
    }

    opts.onProgress?.({ phase: 'write' });
    const chunks: Chunk[] = [];
    const vectors: Float32Array[] = [];
    const files: Record<string, FileEntry> = {};
    let k = 0;
    for (const p of planned) {
      const first = chunks.length;
      if (p.reuse) {
        for (let i = 0; i < p.reuse.count; i++) {
          chunks.push(previous!.chunks[p.reuse.first + i]!);
          const at = (p.reuse.first + i) * dims;
          vectors.push(previous!.vectors.subarray(at, at + dims));
        }
      } else {
        for (const c of p.chunks!) {
          chunks.push(c);
          vectors.push(fresh[k++]!);
        }
      }
      files[p.target.relative] = {
        hash: p.hash,
        size: p.target.size,
        mtimeMs: p.target.mtimeMs,
        first,
        count: chunks.length - first,
      };
    }
    const now = new Date().toISOString();
    const meta = await writeGeneration(
      dir,
      {
        schemaVersion: INDEX_SCHEMA_VERSION,
        indexId: indexIdFor(opts.workspaceRoot),
        root: opts.workspaceRoot,
        embedding: { ...after, dims, normalized: true },
        chunking,
        files,
        counts: { files: Object.keys(files).length, chunks: chunks.length },
        builtAt: previous?.meta.builtAt ?? now,
        updatedAt: now,
      },
      chunks,
      vectors,
    );
    return {
      status: 'updated',
      meta,
      summary,
      targets,
      rebuilt: previous === null,
      ms: Date.now() - started,
    };
  } finally {
    await release();
  }
}

/**
 * 1チャンクの文字数。モデルが1回に読める長さを超えないように縮める。
 * 日本語は1文字が1トークン以上になりうるので、文字数 ≦ トークン数 × 0.9 とする（安全側）。
 */
export function effectiveChunkChars(chunkChars: number, maxTokens: number | null): number {
  if (maxTokens === null) return chunkChars;
  return Math.max(100, Math.min(chunkChars, Math.floor(maxTokens * 0.9) - 40));
}

function sameChunking(a: IndexMeta['chunking'], b: IndexMeta['chunking']): boolean {
  return (
    a.maxChars === b.maxChars && a.overlapChars === b.overlapChars && a.strategy === b.strategy
  );
}

/** 中身は同じだが更新時刻だけ動いたファイル（git checkout など）。記録を合わせ、次から読まずに済ませる。 */
function mtimesMoved(previous: LoadedIndex, planned: Planned[]): boolean {
  return planned.some((p) => {
    const f = previous.meta.files[p.target.relative];
    return !f || f.mtimeMs !== p.target.mtimeMs || f.size !== p.target.size;
  });
}

function abortError(): Error {
  const e = new Error('中断しました。');
  e.name = 'AbortError';
  return e;
}

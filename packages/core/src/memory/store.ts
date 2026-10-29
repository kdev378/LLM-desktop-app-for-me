import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ulid } from '../util/ids.js';
import { readJson, writeJsonAtomic } from '../util/json.js';
import type { Chunk } from './chunk.js';
import type { EmbeddingIdentity } from './embedder.js';

/**
 * 索引の保存。仕様: docs/spec/14-memory.md「保存の形」「更新」
 *
 * <root>/index/<indexId>/
 *   current.json          … 今使う版（generation）。これの書き換えで差し替える
 *   g-<id>/meta.json      … 索引の素性
 *   g-<id>/chunks.jsonl   … 1行1チャンク（本文込み）
 *   g-<id>/vectors.bin    … Float32（リトルエンディアン）。chunks.jsonl と同じ順に dims 個ずつ
 *   update.lock           … 更新は同時に1つだけ
 *
 * 新しい版を全部書いてから current.json を差し替える。途中で止まっても、前の版がそのまま使える
 * （半端な索引で検索しない）。索引は作り直せる複製なので、壊れても会話やファイルは失われない。
 */

export const INDEX_SCHEMA_VERSION = 1;

export type FileEntry = {
  hash: string;
  size: number;
  mtimeMs: number;
  /** chunks.jsonl の何番目から何件か。 */
  first: number;
  count: number;
};

export type IndexMeta = {
  schemaVersion: number;
  indexId: string;
  generation: string;
  /** 作業フォルダ（実体のパス）。 */
  root: string;
  embedding: EmbeddingIdentity & { dims: number; normalized: true };
  chunking: { maxChars: number; overlapChars: number; strategy: string };
  files: Record<string, FileEntry>;
  counts: { files: number; chunks: number };
  builtAt: string;
  updatedAt: string;
};

export type LoadedIndex = {
  dir: string;
  meta: IndexMeta;
  chunks: Chunk[];
  /** 全チャンクのベクトルを並べたもの（chunks.length × dims）。 */
  vectors: Float32Array;
};

export type IndexState =
  { kind: 'none' } | { kind: 'ready'; index: LoadedIndex } | { kind: 'broken'; reason: string };

export function indexIdFor(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
}

export function indexDir(dataRoot: string, workspaceRoot: string): string {
  return path.join(dataRoot, 'index', indexIdFor(workspaceRoot));
}

/** 今の版の meta だけを読む（status 用。本文とベクトルは読まない）。 */
export async function readCurrentMeta(dir: string): Promise<IndexMeta | null | 'broken'> {
  const cur = await readJson<{ generation?: string }>(path.join(dir, 'current.json'));
  if (cur.status === 'missing') return null;
  if (cur.status !== 'ok' || typeof cur.value.generation !== 'string') return 'broken';
  const meta = await readJson<IndexMeta>(path.join(dir, cur.value.generation, 'meta.json'));
  if (meta.status !== 'ok') return 'broken';
  return meta.value;
}

export async function loadIndex(dir: string): Promise<IndexState> {
  const meta = await readCurrentMeta(dir);
  if (meta === null) return { kind: 'none' };
  if (meta === 'broken')
    return {
      kind: 'broken',
      reason: '索引の記録が読めません。akari index build で作り直してください。',
    };
  if (meta.schemaVersion > INDEX_SCHEMA_VERSION) {
    return {
      kind: 'broken',
      reason: '新しい版の Akari で作られた索引です。この版では使えません。',
    };
  }
  const gdir = path.join(dir, meta.generation);
  try {
    const lines = (await fs.readFile(path.join(gdir, 'chunks.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    const chunks = lines.map((l) => JSON.parse(l) as Chunk);
    const buf = await fs.readFile(path.join(gdir, 'vectors.bin'));
    const dims = meta.embedding.dims;
    if (buf.byteLength !== chunks.length * dims * 4 || chunks.length !== meta.counts.chunks) {
      return {
        kind: 'broken',
        reason: '索引の中身の数が合いません。akari index build で作り直してください。',
      };
    }
    const vectors = toFloat32(buf);
    return { kind: 'ready', index: { dir, meta, chunks, vectors } };
  } catch (err) {
    return { kind: 'broken', reason: `索引が読めません: ${(err as Error).message}` };
  }
}

/** 新しい版を書き、差し替える。前の版と、途中で止まった版の残りは消す。 */
export async function writeGeneration(
  dir: string,
  meta: Omit<IndexMeta, 'generation'>,
  chunks: Chunk[],
  vectors: Float32Array[],
): Promise<IndexMeta> {
  const generation = `g-${ulid()}`;
  const gdir = path.join(dir, generation);
  await fs.mkdir(gdir, { recursive: true });
  const full: IndexMeta = { ...meta, generation };
  const dims = meta.embedding.dims;
  const all = new Float32Array(vectors.length * dims);
  vectors.forEach((v, i) => all.set(v.subarray(0, dims), i * dims));
  const buf = fromFloat32(all);
  await writeSynced(path.join(gdir, 'vectors.bin'), buf);
  await writeSynced(
    path.join(gdir, 'chunks.jsonl'),
    Buffer.from(
      chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length ? '\n' : ''),
      'utf8',
    ),
  );
  await writeJsonAtomic(path.join(gdir, 'meta.json'), full);
  await writeJsonAtomic(path.join(dir, 'current.json'), { generation });
  await removeOtherGenerations(dir, generation);
  return full;
}

/** 前の更新が途中で止まった跡があるか（current が指していない版のディレクトリ）。 */
export async function hasLeftovers(dir: string, current: string | null): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.some((e) => e.startsWith('g-') && e !== current);
}

async function removeOtherGenerations(dir: string, keep: string): Promise<void> {
  for (const e of await fs.readdir(dir).catch(() => [] as string[])) {
    if (e.startsWith('g-') && e !== keep) {
      // 読んでいる最中の別プロセスがいても、POSIX では開いたファイルは読み続けられる。
      // Windows で消せなければ次の更新で消す
      await fs.rm(path.join(dir, e), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const LITTLE = os.endianness() === 'LE';

/** ファイルはリトルエンディアン。ほぼ全ての環境でそのまま写せる。 */
function toFloat32(buf: Buffer): Float32Array {
  if (LITTLE)
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function fromFloat32(v: Float32Array): Buffer {
  if (LITTLE) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf;
}

async function writeSynced(file: string, data: Buffer): Promise<void> {
  const h = await fs.open(file, 'w');
  try {
    await h.writeFile(data);
    await h.sync();
  } finally {
    await h.close();
  }
}

export async function removeIndex(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

// ---------------- 更新の目印 ----------------

export class IndexBusyError extends Error {}

/** 更新は同時に1つだけ。持ち主のプロセスが消えていれば、残った目印は取り直す。 */
export async function acquireUpdateLock(dir: string): Promise<() => Promise<void>> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'update.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await fs.open(file, 'wx');
      await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await h.close();
      return async () => {
        await fs.rm(file, { force: true }).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readJson<{ pid?: number }>(file);
      const pid = holder.status === 'ok' ? holder.value.pid : undefined;
      if (typeof pid === 'number' && pid !== process.pid && alive(pid)) {
        throw new IndexBusyError(
          `別の Akari（pid ${pid}）がこの索引を更新しています。終わってからやり直してください。`,
        );
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new IndexBusyError('索引の更新の目印を取れませんでした。');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pooling } from './model.js';

/**
 * モデルを動かす部品。仕様: docs/spec/14-memory.md「埋め込みの係（段階1）」
 *
 * 文を数字の列にするのは @huggingface/tokenizers（JavaScript だけ）。モデルは ONNX を onnxruntime で動かす。
 * 実行の部品は onnxruntime-node（OS ごとの部品。速い）を先に試し、使えなければ onnxruntime-web（WebAssembly）。
 * 埋め込みの係のプロセスの中だけで使う（OS ごとの部品の影響を係に閉じる）。
 */

export type Runtime = 'node' | 'wasm';

export type EngineOptions = {
  modelDir: string;
  runtime?: 'auto' | Runtime;
  pooling: Pooling;
  maxLength: number;
  padTokenId: number;
  batchSize?: number;
};

export type Engine = {
  runtime: Runtime;
  /** onnxruntime-node が使えなかった理由（WebAssembly にしたとき）。 */
  fallbackReason?: string;
  /** 正規化したベクトル。 */
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
};

type OrtLike = {
  InferenceSession: {
    create(model: Uint8Array, opts?: Record<string, unknown>): Promise<SessionLike>;
  };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
};
type SessionLike = {
  outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  release?(): Promise<void>;
};

export async function loadEngine(opts: EngineOptions): Promise<Engine> {
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const readJson = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(opts.modelDir, f), 'utf8')) as object;
  const tokenizer = new Tokenizer(
    await readJson('tokenizer.json'),
    await readJson('tokenizer_config.json'),
  );
  const modelBytes = new Uint8Array(await fs.readFile(path.join(opts.modelDir, 'model.onnx')));

  const want = opts.runtime ?? 'auto';
  let runtime: Runtime = want === 'wasm' ? 'wasm' : 'node';
  let fallbackReason: string | undefined;
  let ort: OrtLike;
  let session: SessionLike;
  try {
    ({ ort, session } = await open(runtime, modelBytes));
  } catch (err) {
    if (want !== 'auto') throw err;
    fallbackReason = `onnxruntime-node が使えませんでした: ${(err as Error).message}`;
    runtime = 'wasm';
    ({ ort, session } = await open('wasm', modelBytes));
  }
  const outName = session.outputNames[0]!;
  const batch = opts.batchSize ?? 16;

  // 語彙にない字の番号。トークナイザーの形式によっては、ライブラリが番号を付けずに返すため、ここで補う
  const tokJson = (await readJson('tokenizer.json')) as { model?: { unk_token?: string } };
  const unkId = tokJson.model?.unk_token
    ? tokenizer.token_to_id(tokJson.model.unk_token)
    : undefined;
  const encode = (text: string): number[] => {
    const ids = (tokenizer.encode(text).ids as (number | undefined)[]).map((id) => {
      if (Number.isInteger(id)) return Number(id);
      if (unkId !== undefined) return unkId;
      throw new Error(
        'トークナイザーが語彙にない字に番号を付けられませんでした（この形式のトークナイザーには対応していません）',
      );
    });
    // 長すぎれば、最後の区切りの印を残して切る
    return ids.length <= opts.maxLength
      ? ids
      : [...ids.slice(0, opts.maxLength - 1), ids[ids.length - 1]!];
  };

  // 1つずつ順に動かす（同時に走らせるとメモリが膨らむため）
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const embed = (texts: string[]) =>
    serial(async () => {
      const enc = texts.map(encode);
      // 長さの近いものをまとめる（詰め物を減らす）。結果は元の順に戻す
      const order = enc.map((_, i) => i).sort((a, b) => enc[a]!.length - enc[b]!.length);
      const out = new Array<Float32Array>(texts.length);
      for (let s = 0; s < order.length; s += batch) {
        const idx = order.slice(s, s + batch);
        const len = Math.max(...idx.map((i) => enc[i]!.length));
        const ids = new BigInt64Array(idx.length * len).fill(BigInt(opts.padTokenId));
        const mask = new BigInt64Array(idx.length * len);
        idx.forEach((i, r) => {
          enc[i]!.forEach((id, c) => {
            ids[r * len + c] = BigInt(id);
            mask[r * len + c] = 1n;
          });
        });
        const res = await session.run({
          input_ids: new ort.Tensor('int64', ids, [idx.length, len]),
          attention_mask: new ort.Tensor('int64', mask, [idx.length, len]),
        });
        const h = res[outName]!;
        const hidden = h.dims[2]!;
        idx.forEach((i, r) => {
          out[i] = pool(h.data, r, len, hidden, enc[i]!.length, opts.pooling);
        });
      }
      return out;
    });

  return {
    runtime,
    ...(fallbackReason ? { fallbackReason } : {}),
    embed,
    async close() {
      await session.release?.();
    },
  };
}

async function open(
  runtime: Runtime,
  model: Uint8Array,
): Promise<{ ort: OrtLike; session: SessionLike }> {
  const ort = (runtime === 'node'
    ? (await import('onnxruntime-node')).default
    : await import('onnxruntime-web')) as unknown as OrtLike;
  const session = await ort.InferenceSession.create(model, {
    executionProviders: [runtime === 'node' ? 'cpu' : 'wasm'],
    graphOptimizationLevel: 'all',
  });
  return { ort, session };
}

function pool(
  data: Float32Array,
  row: number,
  len: number,
  hidden: number,
  n: number,
  mode: Pooling,
): Float32Array {
  const v = new Float32Array(hidden);
  const base = row * len * hidden;
  if (mode === 'cls') v.set(data.subarray(base, base + hidden));
  else if (mode === 'lasttoken') v.set(data.subarray(base + (n - 1) * hidden, base + n * hidden));
  else {
    for (let t = 0; t < n; t++)
      for (let j = 0; j < hidden; j++) v[j]! += data[base + t * hidden + j]!;
    for (let j = 0; j < hidden; j++) v[j]! /= n;
  }
  let s = 0;
  for (let j = 0; j < hidden; j++) s += v[j]! * v[j]!;
  const norm = Math.sqrt(s) || 1;
  for (let j = 0; j < hidden; j++) v[j]! /= norm;
  return v;
}

/** 2つの正規化したベクトルの近さ（内積）。 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export { importModel, ImportError, type ImportResult } from './import.js';
export { CANARY_MIN } from './model.js';

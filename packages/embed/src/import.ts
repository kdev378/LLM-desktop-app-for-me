import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cosine, loadEngine, type Runtime } from './engine.js';
import {
  CANARY_MIN,
  MODEL_FILES,
  MODEL_META,
  catalogEntryBySource,
  modelDir,
  modelsRoot,
  type InstalledModel,
} from './model.js';

/**
 * 書き出したモデル（tools/embed-bench/export_onnx.py の出力）を、内蔵のモデルとして取り込む。
 * 仕様: docs/spec/14-memory.md「内蔵のモデルの置き場」
 *
 * 取り込む前に、そのファイルで元のモデル（Python）と同じ答えが出るかを確かめる。合わなければ取り込まない。
 * 配布元からの自動の取得は、置き場が決まってから足す（同じ形で置き、同じ確かめをする）。
 */

const CANARY_COUNT = 4;

export type ImportResult = {
  model: InstalledModel;
  runtime: Runtime;
  fallbackReason?: string;
  checked: number;
  cosMin: number;
  cosMean: number;
};

export class ImportError extends Error {}

export async function importModel(opts: { dataRoot: string; from: string }): Promise<ImportResult> {
  const from = path.resolve(opts.from);
  const read = async <T>(f: string): Promise<T> => {
    try {
      return JSON.parse(await fs.readFile(path.join(from, f), 'utf8')) as T;
    } catch {
      throw new ImportError(
        `${f} がありません（${from}）。tools/embed-bench/export_onnx.py で書き出したフォルダを指定してください。`,
      );
    }
  };
  const meta = await read<{
    model: string;
    pooling: string;
    max_length: number;
    pad_token_id: number | null;
    prefixes: { query: string; document: string };
  }>('meta.json');
  const ref = await read<{ queries: number; texts: string[]; vectors: number[][] }>(
    'reference.json',
  );
  for (const f of MODEL_FILES) {
    try {
      await fs.access(path.join(from, f));
    } catch {
      throw new ImportError(`${f} がありません（${from}）。`);
    }
  }
  const entry = catalogEntryBySource(meta.model);
  if (!entry) throw new ImportError(`${meta.model} は内蔵として扱うモデルではありません。`);
  if (meta.pooling !== entry.pooling) {
    throw new ImportError(
      `まとめ方が違います（書き出し ${meta.pooling}、内蔵 ${entry.pooling}）。`,
    );
  }
  if (
    meta.prefixes.query !== entry.prefixes.query ||
    meta.prefixes.document !== entry.prefixes.document
  ) {
    throw new ImportError(
      '書き出したときの印が、内蔵の約束と違います。export_onnx.py を新しい版で書き出し直してください。',
    );
  }

  // 別の場所へ写してから確かめ、合っていれば差し替える（途中で止まっても前のモデルは壊さない）
  const root = modelsRoot(opts.dataRoot);
  await fs.mkdir(root, { recursive: true });
  const tmp = path.join(root, `.import-${entry.id}-${process.pid}`);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp);
  try {
    for (const f of MODEL_FILES) await fs.copyFile(path.join(from, f), path.join(tmp, f));
    const sha = createHash('sha256')
      .update(await fs.readFile(path.join(tmp, 'model.onnx')))
      .digest('hex');
    const maxLength = Math.max(16, Number(meta.max_length) || 512);
    const padTokenId = meta.pad_token_id ?? 0;

    const engine = await loadEngine({
      modelDir: tmp,
      pooling: entry.pooling,
      maxLength,
      padTokenId,
    });
    let cos: number[];
    try {
      const got = await engine.embed(ref.texts);
      cos = got.map((v, i) => cosine(v, ref.vectors[i]!));
      if (got[0] && got[0].length !== entry.dims) {
        throw new ImportError(`次元が違います（${got[0].length}、内蔵の約束は ${entry.dims}）。`);
      }
    } finally {
      await engine.close();
    }
    const cosMin = Math.min(...cos);
    const cosMean = cos.reduce((a, b) => a + b, 0) / cos.length;
    if (cosMin < CANARY_MIN) {
      throw new ImportError(
        `このファイルでは、元のモデルと同じ答えが出ません（近さ 最小 ${cosMin.toFixed(4)}、下限 ${CANARY_MIN}）。取り込みません。`,
      );
    }
    // 見本は、問いと本文から少しずつ（元のモデルの答えをそのまま持つ）
    const pick = [...new Set([0, 1, ref.queries, ref.queries + 1])]
      .filter((i) => i < ref.texts.length)
      .slice(0, CANARY_COUNT);
    const model: InstalledModel = {
      ...entry,
      schemaVersion: 1,
      fileSha256: `sha256:${sha}`,
      revision: sha.slice(0, 12),
      maxLength,
      padTokenId,
      canary: pick.map((i) => ({ text: ref.texts[i]!, vector: ref.vectors[i]! })),
      importedAt: new Date().toISOString(),
      from,
    };
    await fs.writeFile(path.join(tmp, MODEL_META), JSON.stringify(model, null, 2));
    const dest = modelDir(opts.dataRoot, entry.id);
    const old = `${dest}.old-${process.pid}`;
    await fs.rename(dest, old).catch(() => undefined);
    await fs.rename(tmp, dest);
    await fs.rm(old, { recursive: true, force: true });
    return {
      model,
      runtime: engine.runtime,
      ...(engine.fallbackReason ? { fallbackReason: engine.fallbackReason } : {}),
      checked: cos.length,
      cosMin,
      cosMean,
    };
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

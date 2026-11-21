import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 内蔵の埋め込みモデル。仕様: docs/spec/14-memory.md「内蔵のモデルの置き場」「同じとみなす条件」
 *
 * <root>/models/<id>/
 *   model.onnx / tokenizer.json / tokenizer_config.json
 *   akari-model.json   … このモデルの素性（指紋・まとめ方・印・見本）。取り込むときに書く
 */

export type Pooling = 'mean' | 'cls' | 'lasttoken';

/** Akari が内蔵として扱うモデル（版を Akari の版ごとに固定する）。 */
export type BuiltinCatalogEntry = {
  id: string;
  /** 元のモデル（Hugging Face の名前）。 */
  source: string;
  license: string;
  /** 使い方の約束（印・まとめ方・正規化）の版。変えたら索引は作り直す。 */
  contract: string;
  prefixes: { query: string; document: string };
  pooling: Pooling;
  dims: number;
};

/** 2026-11-20 オーナー決定（14-memory.md「モデルの選び方」）。 */
export const BUILTIN_MODELS: BuiltinCatalogEntry[] = [
  {
    id: 'ruri-v3-70m',
    source: 'cl-nagoya/ruri-v3-70m',
    license: 'Apache-2.0',
    contract: 'ruri-v3-prefix-v1',
    prefixes: { query: '検索クエリ: ', document: '検索文書: ' },
    pooling: 'mean',
    dims: 384,
  },
];

export const DEFAULT_BUILTIN_MODEL = 'ruri-v3-70m';

/** 使う内蔵のモデル。テストのとき（AKARI_TEST_MODELS=1）だけ AKARI_TEST_BUILTIN_MODEL で差し替えられる。 */
export function builtinModelId(): string {
  const t = process.env.AKARI_TEST_BUILTIN_MODEL;
  return process.env.AKARI_TEST_MODELS === '1' && t ? t : DEFAULT_BUILTIN_MODEL;
}

/** 取り込んだモデルの素性。 */
export type InstalledModel = BuiltinCatalogEntry & {
  schemaVersion: 1;
  /** model.onnx の指紋。 */
  fileSha256: string;
  /** 指紋の先頭12桁。索引に記録する「版」。 */
  revision: string;
  /** 1回に読める長さ（トークン）。 */
  maxLength: number;
  padTokenId: number;
  /**
   * 見本。元のモデル（Python の sentence-transformers）が出した答え。
   * 埋め込みの係につながるたびに、同じ文を埋め込ませて近さを確かめる（エンジンの違いで結果が変わったら捕まえる）。
   */
  canary: Array<{ text: string; vector: number[] }>;
  importedAt: string;
  /** 取り込んだ元（手で書き出したフォルダ、など）。 */
  from: string;
};

export const MODEL_FILES = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'] as const;
export const MODEL_META = 'akari-model.json';

/**
 * 元のモデル（Python で動かした答え）との近さの下限。取り込むときと、係につながるたびに確かめる。
 * 元の精度（fp32）で正しく書き出せていれば、実行の部品が違っても 0.999 を超える。仕様: 14-memory.md「同じとみなす条件」
 */
export const CANARY_MIN = 0.999;

export function modelsRoot(dataRoot: string): string {
  return path.join(dataRoot, 'models');
}

export function modelDir(dataRoot: string, id: string): string {
  return path.join(modelsRoot(dataRoot), id);
}

export async function readInstalledModel(
  dataRoot: string,
  id: string,
): Promise<InstalledModel | null> {
  try {
    const raw = await fs.readFile(path.join(modelDir(dataRoot, id), MODEL_META), 'utf8');
    const m = JSON.parse(raw) as InstalledModel;
    return m.schemaVersion === 1 ? m : null;
  } catch {
    return null;
  }
}

/** テスト用の小さな偽のモデル（test/fixtures/tiny）。AKARI_TEST_MODELS=1 のときだけ扱う。 */
const TEST_MODEL: BuiltinCatalogEntry = {
  id: 'tiny-test',
  source: 'akari-test/tiny',
  license: 'MIT',
  contract: 'tiny-test-v1',
  prefixes: { query: 'q: ', document: 'd: ' },
  pooling: 'mean',
  dims: 16,
};

function catalog(): BuiltinCatalogEntry[] {
  return process.env.AKARI_TEST_MODELS === '1' ? [...BUILTIN_MODELS, TEST_MODEL] : BUILTIN_MODELS;
}

export function catalogEntry(id: string): BuiltinCatalogEntry | undefined {
  return catalog().find((m) => m.id === id);
}

export function catalogEntryBySource(source: string): BuiltinCatalogEntry | undefined {
  return catalog().find((m) => m.source === source);
}

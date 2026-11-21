import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, importModel, cosine, ImportError } from '../dist/engine.js';
import { readInstalledModel, modelDir } from '../dist/index.js';

/**
 * 内蔵の埋め込みの部品。仕様: docs/spec/14-memory.md
 * 相手は小さな偽のモデル（test/fixtures/tiny。make-fixture.py で作る）。実行の部品は本物の onnxruntime。
 */

process.env.AKARI_TEST_MODELS = '1';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiny');
const ref = JSON.parse(await fs.readFile(path.join(FIXTURE, 'reference.json'), 'utf8')) as {
  texts: string[];
  vectors: number[][];
};

for (const runtime of ['node', 'wasm'] as const) {
  test(`${runtime}: 元のモデルと同じ答えを出す`, async () => {
    const e = await loadEngine({
      modelDir: FIXTURE,
      runtime,
      pooling: 'mean',
      maxLength: 512,
      padTokenId: 0,
    });
    try {
      assert.equal(e.runtime, runtime);
      const got = await e.embed(ref.texts);
      for (const [i, v] of got.entries())
        assert.ok(cosine(v, ref.vectors[i]!) > 0.9999, `${i}: ${cosine(v, ref.vectors[i]!)}`);
      // 長さの違う文をまとめて送っても、順番が崩れない
      const [a, b] = await e.embed([ref.texts[3]!, ref.texts[0]!]);
      assert.ok(cosine(a!, ref.vectors[3]!) > 0.9999 && cosine(b!, ref.vectors[0]!) > 0.9999);
    } finally {
      await e.close();
    }
  });
}

async function tmpRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-embed-')));
}

test('取り込み: 元のモデルと同じ答えが出ることを確かめてから入れ、見本と指紋を残す', async () => {
  const root = await tmpRoot();
  const r = await importModel({ dataRoot: root, from: FIXTURE });
  assert.ok(r.cosMin > 0.9999);
  const m = await readInstalledModel(root, 'tiny-test');
  assert.ok(m);
  assert.match(m.fileSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(m.revision, m.fileSha256.slice(7, 19));
  assert.equal(m.canary.length, 4);
  assert.deepEqual(m.prefixes, { query: 'q: ', document: 'd: ' });
  for (const f of ['model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'akari-model.json']) {
    await fs.access(path.join(modelDir(root, 'tiny-test'), f));
  }
});

test('取り込み: 答えが元のモデルと合わない・印が違う・内蔵でないモデルは入れない（前のモデルは残す）', async () => {
  const root = await tmpRoot();
  await importModel({ dataRoot: root, from: FIXTURE });
  const before = await readInstalledModel(root, 'tiny-test');

  const bad = path.join(await tmpRoot(), 'bad');
  await fs.cp(FIXTURE, bad, { recursive: true });
  const r = JSON.parse(await fs.readFile(path.join(bad, 'reference.json'), 'utf8'));
  r.vectors[2] = r.vectors[2].map((x: number) => -x);
  await fs.writeFile(path.join(bad, 'reference.json'), JSON.stringify(r));
  await assert.rejects(
    importModel({ dataRoot: root, from: bad }),
    (e: unknown) => e instanceof ImportError && /同じ答えが出ません/.test(e.message),
  );

  const meta = JSON.parse(await fs.readFile(path.join(FIXTURE, 'meta.json'), 'utf8'));
  await fs.writeFile(
    path.join(bad, 'reference.json'),
    await fs.readFile(path.join(FIXTURE, 'reference.json')),
  );
  await fs.writeFile(
    path.join(bad, 'meta.json'),
    JSON.stringify({ ...meta, prefixes: { query: '', document: '' } }),
  );
  await assert.rejects(importModel({ dataRoot: root, from: bad }), /印が、内蔵の約束と違います/);
  await fs.writeFile(
    path.join(bad, 'meta.json'),
    JSON.stringify({ ...meta, model: 'someone/other' }),
  );
  await assert.rejects(
    importModel({ dataRoot: root, from: bad }),
    /内蔵として扱うモデルではありません/,
  );

  assert.deepEqual(
    await readInstalledModel(root, 'tiny-test'),
    before,
    '失敗した取り込みは前のモデルを壊さない',
  );
  const left = (await fs.readdir(path.join(root, 'models'))).filter((n) =>
    n.startsWith('.import-'),
  );
  assert.deepEqual(left, [], '途中の作業場所を残さない');
});

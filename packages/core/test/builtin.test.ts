import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importModel } from '@akari/embed/engine';
import { readHelperInfo, helperFiles, modelDir, alive } from '@akari/embed';
import {
  BuiltinEmbedder,
  configSchema,
  indexDir,
  loadIndex,
  prepareMemory,
  searchIndex,
  updateIndex,
  type LoadedIndex,
} from '../dist/index.js';

/**
 * 内蔵の埋め込み（埋め込みの係）。仕様: docs/spec/14-memory.md「埋め込みの係（段階1）」
 * 本物の係のプロセスを起こし、本物の onnxruntime で、小さな偽のモデル（@akari/embed の test/fixtures/tiny）を動かす。
 */

process.env.AKARI_TEST_MODELS = '1';
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../embed/test/fixtures/tiny',
);
const roots: string[] = [];

async function installed(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-builtin-')));
  roots.push(root);
  await importModel({ dataRoot: root, from: FIXTURE });
  return root;
}

const embedder = (root: string, idleMs = 30_000) =>
  new BuiltinEmbedder(root, { idleMs, modelId: 'tiny-test' });

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** その置き場のために動いている係の pid（ps で数える）。 */
function helpersFor(root: string): number[] {
  const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes('helper-main.js') && l.includes(`--root ${root} `))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

after(async () => {
  for (const r of roots) for (const pid of helpersFor(r)) process.kill(pid, 'SIGTERM');
});

test('最初の埋め込みで係を起こし、2つ目の Akari は同じ係を使う', async () => {
  const root = await installed();
  const a = embedder(root);
  const [v] = await a.embed(['認証の処理'], 'query');
  assert.equal(v!.length, 16);
  const info = await readHelperInfo(root);
  assert.ok(info && alive(info.pid));
  assert.ok(['node', 'wasm'].includes(info.runtime));
  const mode = (await fs.stat(helperFiles(root).info)).mode & 0o777;
  assert.equal(mode, 0o600, '居場所とトークンは本人だけが読める');

  await embedder(root).embed(['合計'], 'passage');
  assert.deepEqual(helpersFor(root), [info.pid], '係は1つだけ');
  const id = await a.identity();
  assert.equal(id.source, 'builtin');
  assert.equal(id.model, 'tiny-test');
  assert.equal(id.dims, 16);
});

test('同時に起こしても、係は1つだけ残る', async () => {
  const root = await installed();
  const results = await Promise.all(
    [1, 2, 3, 4].map((i) => embedder(root).embed([`文 ${i}`], 'query')),
  );
  assert.equal(results.length, 4);
  await waitFor(() => helpersFor(root).length === 1, 5000);
  assert.equal(helpersFor(root).length, 1, `係: ${helpersFor(root).join(', ')}`);
});

test('使われない時間が続いたら係は終わり、次に要ったときに起こし直す。落ちた係も起こし直す', async () => {
  const root = await installed();
  const e = embedder(root, 800);
  await e.embed(['一つ目'], 'query');
  const first = (await readHelperInfo(root))!.pid;
  assert.ok(await waitFor(() => !alive(first), 5000), '使われなければ終わる');
  assert.equal(await readHelperInfo(root), null, '終わるときに居場所を消す');

  await e.embed(['二つ目'], 'query');
  const second = (await readHelperInfo(root))!.pid;
  assert.notEqual(second, first);

  process.kill(second, 'SIGKILL'); // 片付けずに落ちた（居場所と目印が残る）
  await waitFor(() => !alive(second));
  const [v] = await embedder(root).embed(['三つ目'], 'query');
  assert.equal(v!.length, 16);
  assert.notEqual((await readHelperInfo(root))!.pid, second);
});

test('見本の答えが合わない係は使わない', async () => {
  const root = await installed();
  const file = path.join(modelDir(root, 'tiny-test'), 'akari-model.json');
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  m.canary[0].vector = m.canary[0].vector.map((x: number) => -x);
  await fs.writeFile(file, JSON.stringify(m));
  await assert.rejects(embedder(root).embed(['x'], 'query'), /元のモデルの見本と合いません/);
});

test('取り込み直したモデルと違うものを動かしている係は止め、新しいモデルで起こし直す', async () => {
  const root = await installed();
  await embedder(root).embed(['前'], 'query');
  const old = (await readHelperInfo(root))!;
  const file = path.join(modelDir(root, 'tiny-test'), 'akari-model.json');
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...m, fileSha256: 'sha256:' + 'f'.repeat(64) }));
  await embedder(root).embed(['後'], 'query');
  const now = (await readHelperInfo(root))!;
  assert.notEqual(now.pid, old.pid);
  assert.equal(now.fileSha256, 'sha256:' + 'f'.repeat(64));
  assert.ok(await waitFor(() => !alive(old.pid)));
});

test('内蔵の埋め込みで索引を作って探せる。設定の既定（builtin）のまま memory_search が渡る', async () => {
  const root = await installed();
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  await fs.writeFile(path.join(work, 'auth.ts'), '// 認証の処理\nexport function login() {}\n');
  await fs.writeFile(path.join(work, 'cart.ts'), '// 合計を計算する\nexport const total = 1;\n');
  const e = embedder(root);
  const r = await updateIndex({
    dataRoot: root,
    workspaceRoot: work,
    embedder: e,
    settings: { maxFileBytes: 1_000_000, chunkChars: 1200, overlapChars: 200 },
  });
  assert.equal(r.status, 'updated');
  const state = await loadIndex(indexDir(root, work));
  assert.equal(state.kind, 'ready');
  const index = (state as { index: LoadedIndex }).index;
  assert.equal(index.meta.embedding.source, 'builtin');
  const [q] = await e.embed(['認証の処理'], 'query');
  const hits = await searchIndex(index, q!, { k: 2 });
  assert.equal(hits.length, 2);

  // 既定の設定（memory.embedding.source = builtin）のまま、道具が渡る（テストでは内蔵のモデルを tiny-test に差し替える）
  process.env.AKARI_TEST_BUILTIN_MODEL = 'tiny-test';
  try {
    const config = configSchema.parse({});
    assert.equal(config.memory.embedding.source, 'builtin');
    const prep = await prepareMemory({ dataRoot: root, indexRoot: work, config, autoUpdate: true });
    assert.ok(prep.tool, prep.notices.map((n) => n.message).join(' / '));
  } finally {
    delete process.env.AKARI_TEST_BUILTIN_MODEL;
  }
});

test('落ちた係の pid を別のプロセスが使っていても、そのプロセスは止めず、目印を取り直して係を起こす', async () => {
  const root = await installed();
  const { spawn } = await import('node:child_process');
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const files = helperFiles(root);
    await fs.mkdir(path.dirname(files.info), { recursive: true });
    // 古いモデルの係の居場所と、10分前の目印が残っている。その pid はいま別のプロセス
    await fs.writeFile(
      files.info,
      JSON.stringify({
        pid: decoy.pid,
        port: 1,
        token: 'x',
        fileSha256: 'sha256:' + '0'.repeat(64),
        model: 'tiny-test',
        runtime: 'node',
        startedAt: new Date().toISOString(),
      }),
    );
    await fs.writeFile(
      files.lock,
      JSON.stringify({ pid: decoy.pid, at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    );
    const [v] = await embedder(root).embed(['認証'], 'query');
    assert.equal(v!.length, 16);
    assert.ok(alive(decoy.pid!), '関係のないプロセスは止めない');
    const now = (await readHelperInfo(root))!;
    assert.notEqual(now.pid, decoy.pid);
  } finally {
    decoy.kill('SIGKILL');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  EndpointEmbedder,
  EmbeddingError,
  chunkText,
  configSchema,
  formatHits,
  indexDir,
  listIndexTargets,
  loadIndex,
  normalize,
  prepareMemory,
  searchIndex,
  updateIndex,
  DEFAULT_LIMITS,
  type Embedder,
  type EmbeddingIdentity,
  type LoadedIndex,
  type ResolvedEndpoint,
  type ToolContext,
} from '../dist/index.js';

/**
 * 記憶（ベクトル索引）。仕様: docs/spec/14-memory.md
 * 埋め込みは偽物（文字の2連と単語の重なりで決まる数値）。同じ語を含む文どうしが近くなる。
 */

function mockVector(text: string, dims = 128): number[] {
  const v = new Array<number>(dims).fill(0);
  const add = (token: string) => {
    let h = 2166136261;
    for (const ch of token) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % dims]! += 1;
  };
  const body = text.replace(/^\/\/ .*\n/, '');
  for (const w of body.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) add(`w:${w}`);
  const cjk = [...body].filter((c) => /[぀-ヿ㐀-鿿]/.test(c));
  for (let i = 0; i + 1 < cjk.length; i++) add(`b:${cjk[i]}${cjk[i + 1]}`);
  if (v.every((x) => x === 0)) v[0] = 1;
  return v;
}

class FakeEmbedder implements Embedder {
  calls = 0;
  texts: string[] = [];
  failAfter: number | null = null;
  private readonly id: Partial<EmbeddingIdentity>;
  constructor(id: Partial<EmbeddingIdentity> = {}) {
    this.id = id;
  }
  async identity(): Promise<EmbeddingIdentity> {
    return {
      source: 'endpoint',
      model: 'fake-embed',
      revision: null,
      fileSha256: null,
      contract: 'openai-embeddings-v1',
      dims: 128,
      maxTokens: null,
      endpointId: 'ep_fake',
      ...this.id,
    };
  }
  async embed(texts: string[], _kind: string, signal?: AbortSignal): Promise<Float32Array[]> {
    if (signal?.aborted) throw new Error('aborted');
    if (this.failAfter !== null && this.calls + texts.length > this.failAfter) {
      throw new Error('擬似の失敗');
    }
    this.calls += texts.length;
    this.texts.push(...texts);
    return texts.map((t) => normalize(mockVector(t)));
  }
}

const settings = { maxFileBytes: 1_048_576, chunkChars: 1200, overlapChars: 200 };

async function repo(files: Record<string, string>, opts: { git?: boolean } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-mem-')));
  const root = path.join(base, 'work');
  const data = path.join(base, 'data');
  await fs.mkdir(root);
  await fs.mkdir(data);
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  if (opts.git !== false) {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
  }
  return { base, root, data };
}

async function load(data: string, root: string): Promise<LoadedIndex> {
  const s = await loadIndex(indexDir(data, root));
  assert.equal(s.kind, 'ready', JSON.stringify(s));
  return (s as { index: LoadedIndex }).index;
}

async function ask(index: LoadedIndex, emb: Embedder, q: string, k = 3) {
  const [v] = await emb.embed([q], 'query');
  return searchIndex(index, v!, { k });
}

// ---------------- チャンク ----------------

test('チャンク: 行の途中で切らず、行番号を持ち、前後が重なる', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`);
  const chunks = chunkText('a.ts', lines.join('\n'), { maxChars: 400, overlapChars: 100 });
  assert.ok(chunks.length > 5);
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks.at(-1)!.endLine, 100);
  for (const c of chunks) {
    assert.ok(c.text.length <= 400);
    assert.ok(c.text.startsWith('line '), '行の途中から始まらない');
    assert.equal(c.text.split('\n').length, c.endLine - c.startLine + 1);
  }
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i]!.startLine <= chunks[i - 1]!.endLine, '前のチャンクと重なる');
    assert.ok(chunks[i]!.startLine > chunks[i - 1]!.startLine, '必ず前へ進む');
  }
});

test('チャンク: 上限ちょうどの行・上限を超える1行・空のファイルでも止まらない', () => {
  const exact = chunkText('a', ['a'.repeat(100), 'b'.repeat(100)].join('\n'), {
    maxChars: 100,
    overlapChars: 20,
  });
  assert.deepEqual(
    exact.map((c) => [c.startLine, c.endLine]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  const long = chunkText('min.js', `short\n${'z'.repeat(450)}\nend`, {
    maxChars: 200,
    overlapChars: 50,
  });
  assert.ok(long.some((c) => c.startLine === 2 && c.text.length === 200));
  assert.ok(long.every((c) => c.text.length <= 200));
  assert.equal(long.at(-1)!.text, 'end');
  assert.deepEqual(chunkText('e', '\n\n  \n', { maxChars: 100, overlapChars: 10 }), []);
});

// ---------------- 対象のファイル ----------------

test('対象: git の無視・秘密のファイル・大きいファイル・圧縮済み・.akariignore を外す', async () => {
  const { root } = await repo({
    'src/auth.ts': 'export function login() {}\n',
    '.gitignore': 'generated/\n',
    'generated/big.ts': 'x\n',
    '.env': 'TOKEN=secret\n',
    'config/credentials.json': '{}',
    'app.min.js': 'a',
    'pnpm-lock.yaml': 'x',
    'docs/memo.md': '# メモ\n',
    'docs/draft.md': '# 下書き\n',
    '.akariignore': '# 注釈\ndraft.md\n',
    'huge.txt': 'y'.repeat(2048),
  });
  const r = await listIndexTargets(root, { maxFileBytes: 1024 });
  assert.equal(r.source, 'git');
  const names = r.files.map((f) => f.relative);
  assert.ok(names.includes('src/auth.ts'));
  assert.ok(names.includes('docs/memo.md'));
  for (const n of [
    'generated/big.ts',
    '.env',
    'config/credentials.json',
    'app.min.js',
    'pnpm-lock.yaml',
    'docs/draft.md',
    'huge.txt',
  ]) {
    assert.ok(!names.includes(n), `${n} を外す`);
  }
  assert.equal(r.skipped.secret, 2);
  assert.equal(r.skipped.large, 1);
});

test('対象: git でないフォルダでは、既定の除外で歩く。シンボリックリンクは辿らない', async () => {
  const { root, base } = await repo(
    { 'a.ts': 'a\n', 'node_modules/x/index.js': 'x\n', '.env.local': 'S=1\n' },
    { git: false },
  );
  await fs.writeFile(path.join(base, 'outside.txt'), 'outside\n');
  await fs.symlink(path.join(base, 'outside.txt'), path.join(root, 'link.txt'));
  const r = await listIndexTargets(root, { maxFileBytes: 1_000_000 });
  assert.equal(r.source, 'walk');
  assert.deepEqual(
    r.files.map((f) => f.relative),
    ['a.ts'],
  );
});

// ---------------- 作る・更新する・探す ----------------

test('作って探すと、意味の近いファイルが行番号と点数つきで返り、秘密のファイルの中身は出ない', async () => {
  const { root, data } = await repo({
    'src/auth.ts':
      '// ログインと認証の処理\nexport function login(user: string) {\n  return checkPassword(user);\n}\n',
    'src/cart.ts':
      '// 買い物かごの合計を計算する\nexport function total(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n',
    'docs/日本語.md': '# 設計\n認証はセッションの鍵で行う。\n',
    '.env': 'AUTH_SECRET=認証の鍵はこれ\n',
  });
  const emb = new FakeEmbedder();
  const r = await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  assert.equal(r.status, 'updated');
  assert.ok(
    !emb.texts.some((t) => t.includes('AUTH_SECRET')),
    '秘密のファイルは埋め込みに送らない',
  );
  const index = await load(data, root);
  const hits = await ask(index, emb, '認証の処理はどこ');
  assert.ok(['src/auth.ts', 'docs/日本語.md'].includes(hits[0]!.path), JSON.stringify(hits));
  assert.ok(hits.every((h) => h.path !== '.env'));
  assert.ok(hits[0]!.score > hits.at(-1)!.score);
  assert.match(formatHits(hits), /src\/auth\.ts:1-4 {2}点数 0\.\d{3}/);
  const narrowed = await searchIndex(index, (await emb.embed(['合計'], 'query'))[0]!, {
    k: 5,
    pathPrefix: 'docs',
  });
  assert.ok(narrowed.every((h) => h.path.startsWith('docs/')));
});

test('更新: 変わったファイルだけ埋め込み直し、消えたファイルは外す。何も変わらなければ何もしない', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`f${i}.ts`] = `// ファイル ${i}\nexport const v${i} = ${i};\n`;
  const { root, data } = await repo(files);
  const emb = new FakeEmbedder();
  await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  const first = emb.calls;
  assert.equal(first, 10);

  const again = await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  assert.equal(again.status, 'unchanged');
  assert.equal(emb.calls, first, '変わっていなければ埋め込まない');

  await fs.writeFile(path.join(root, 'f3.ts'), '// 書き換えた。認証の話\nexport const v3 = 33;\n');
  await fs.rm(path.join(root, 'f7.ts'));
  const r = await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  assert.equal(r.status, 'updated');
  if (r.status !== 'updated') return;
  assert.deepEqual(r.summary.changed, ['f3.ts']);
  assert.deepEqual(r.summary.removed, ['f7.ts']);
  assert.equal(emb.calls, first + 1, 'f3.ts のチャンクだけ埋め込み直す');
  const index = await load(data, root);
  assert.equal(index.meta.counts.files, 9);
  assert.equal((await ask(index, emb, '認証', 1))[0]!.path, 'f3.ts');
});

test('更新が途中で止まっても、前の索引がそのまま使える。次の更新で残りかすを片付ける', async () => {
  const { root, data } = await repo({
    'a.ts': '// 認証\nconst a = 1;\n',
    'b.ts': '// 合計\nconst b = 2;\n',
  });
  const emb = new FakeEmbedder();
  await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  const before = (await load(data, root)).meta.generation;

  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`n${i}.ts`] = `// 新しい ${i}\nconst n${i} = ${i};\n`;
  for (const [p, c] of Object.entries(files)) await fs.writeFile(path.join(root, p), c);
  emb.failAfter = emb.calls + 70; // 途中で埋め込みが失敗する
  await assert.rejects(
    updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings }),
  );
  const still = await load(data, root);
  assert.equal(still.meta.generation, before, '前の版のまま');
  assert.equal((await ask(still, emb, '認証', 1))[0]!.path, 'a.ts');
  // 目印は残らない（次の更新ができる）
  await assert.rejects(fs.access(path.join(indexDir(data, root), 'update.lock')));

  emb.failAfter = null;
  const r = await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  assert.equal(r.status, 'updated');
  const gens = (await fs.readdir(indexDir(data, root))).filter((e) => e.startsWith('g-'));
  assert.equal(gens.length, 1, '使っている版だけが残る');
});

test('更新は同時に1つだけ。別のプロセスが更新中なら断る', async () => {
  const { root, data } = await repo({ 'a.ts': 'const a = 1;\n' });
  const dir = indexDir(data, root);
  await fs.mkdir(dir, { recursive: true });
  // 生きている別のプロセス（親）が持っている目印
  await fs.writeFile(path.join(dir, 'update.lock'), JSON.stringify({ pid: process.ppid }));
  await assert.rejects(
    updateIndex({ dataRoot: data, workspaceRoot: root, embedder: new FakeEmbedder(), settings }),
    /別の Akari（pid \d+）がこの索引を更新しています/,
  );
  // 持ち主が消えた目印は取り直す
  await fs.writeFile(path.join(dir, 'update.lock'), JSON.stringify({ pid: 999_999_999 }));
  const r = await updateIndex({
    dataRoot: data,
    workspaceRoot: root,
    embedder: new FakeEmbedder(),
    settings,
  });
  assert.equal(r.status, 'updated');
});

test('索引の後で変わったファイルの結果には、そう添える', async () => {
  const { root, data } = await repo({ 'a.ts': '// 認証の処理\nconst a = 1;\n' });
  const emb = new FakeEmbedder();
  await updateIndex({ dataRoot: data, workspaceRoot: root, embedder: emb, settings });
  await fs.writeFile(path.join(root, 'a.ts'), '// 認証の処理を変えた\nconst a = 2;\n');
  const hits = await ask(await load(data, root), emb, '認証');
  assert.equal(hits[0]!.stale, true);
  assert.match(formatHits(hits), /索引の後で変わっています/);
});

// ---------------- 実行の始めの下ごしらえ ----------------

function configWith(model: string | null = 'fake-embed') {
  return configSchema.parse({
    endpoints: [{ id: 'ep_fake', name: 'fake', baseUrl: 'http://127.0.0.1:9/v1' }],
    activeEndpointId: 'ep_fake',
    memory: { embedding: { source: 'endpoint', model } },
  });
}

test('下ごしらえ: 索引が無ければ道具を渡さず、何も言わない', async () => {
  const { root, data } = await repo({ 'a.ts': 'a\n' });
  const r = await prepareMemory({
    dataRoot: data,
    indexRoot: root,
    config: configWith(),
    autoUpdate: true,
  });
  assert.equal(r.tool, null);
  assert.deepEqual(r.notices, []);
});

test('下ごしらえ: 別の埋め込みで作った索引は混ぜずに使わない。変わったファイルは実行の最初に更新する', async () => {
  const { root, data } = await repo({ 'a.ts': '// 認証\nconst a = 1;\n' });
  // 別のモデルで作った索引
  await updateIndex({
    dataRoot: data,
    workspaceRoot: root,
    embedder: new FakeEmbedder({ model: 'other-model' }),
    settings,
  });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    return new Response(
      JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: mockVector(t) })) }),
    );
  }) as unknown as typeof fetch;
  const mismatch = await prepareMemory({
    dataRoot: data,
    indexRoot: root,
    config: configWith(),
    autoUpdate: true,
    fetchImpl,
  });
  assert.equal(mismatch.tool, null);
  assert.match(
    mismatch.notices[0]!.message,
    /other-model で作られていますが.*fake-embed です。混ぜられないので使いません/,
  );

  // 今の設定のモデルで作り直す
  await updateIndex({
    dataRoot: data,
    workspaceRoot: root,
    embedder: new FakeEmbedder(),
    settings,
    rebuild: true,
  });
  await fs.writeFile(path.join(root, 'b.ts'), '// 合計を計算\nconst b = 2;\n');
  const ok = await prepareMemory({
    dataRoot: data,
    indexRoot: root,
    config: configWith(),
    autoUpdate: true,
    fetchImpl,
  });
  assert.ok(ok.tool);
  assert.match(
    ok.notices.map((n) => n.message).join('\n'),
    /索引を更新しました（変わったファイル 1 件）/,
  );
  const ctx = {
    limits: DEFAULT_LIMITS,
    signal: new AbortController().signal,
  } as unknown as ToolContext;
  const res = await ok.tool!.run({ query: '合計を計算' }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.content, /^1\. b\.ts:1-2/);
});

test('下ごしらえ: 変わったファイルが上限を超えたら、自動では更新せず促す', async () => {
  const { root, data } = await repo({ 'a.ts': 'a\n' });
  await updateIndex({
    dataRoot: data,
    workspaceRoot: root,
    embedder: new FakeEmbedder(),
    settings,
  });
  for (let i = 0; i < 3; i++) await fs.writeFile(path.join(root, `n${i}.ts`), `n${i}\n`);
  const config = configWith();
  config.memory.autoUpdateMaxFiles = 2;
  const fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
  const r = await prepareMemory({
    dataRoot: data,
    indexRoot: root,
    config,
    autoUpdate: true,
    fetchImpl,
  });
  assert.ok(r.tool, '古いまま使う');
  assert.match(r.notices[0]!.message, /3 件あり、自動の更新の上限（2）を超えています/);
});

test('下ごしらえ: 内蔵はまだ使えない・モデル未指定は、理由を出して道具を渡さない', async () => {
  const { root, data } = await repo({ 'a.ts': 'a\n' });
  await updateIndex({
    dataRoot: data,
    workspaceRoot: root,
    embedder: new FakeEmbedder(),
    settings,
  });
  const builtin = configSchema.parse({});
  const a = await prepareMemory({
    dataRoot: data,
    indexRoot: root,
    config: builtin,
    autoUpdate: false,
  });
  assert.equal(a.tool, null);
  assert.match(a.notices[0]!.message, /内蔵の埋め込みモデルはまだ使えません/);
  const b = await prepareMemory({
    dataRoot: data,
    indexRoot: root,
    config: configWith(null),
    autoUpdate: false,
  });
  assert.match(b.notices[0]!.message, /埋め込みに使うモデルが決まっていません/);
});

// ---------------- 外部の接続先 ----------------

const ep = {
  id: 'ep_x',
  name: 'x',
  baseUrl: 'http://127.0.0.1:9/v1',
  headers: {},
  apiKey: null,
  isExternal: false,
} as unknown as ResolvedEndpoint;

test('外部: 大きすぎると断られたら半分にして送り直す。正規化して返す', async () => {
  const sizes: number[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    sizes.push(body.input.length);
    if (body.input.length > 2) return new Response('too large', { status: 413 });
    return new Response(
      JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [3, 4] })) }),
    );
  }) as unknown as typeof fetch;
  const e = new EndpointEmbedder(ep, 'm', 4, fetchImpl);
  const out = await e.embed(['a', 'b', 'c', 'd'], 'passage');
  assert.deepEqual(sizes, [4, 2, 2]);
  assert.equal(out.length, 4);
  assert.ok(Math.abs(out[0]![0]! - 0.6) < 1e-6 && Math.abs(out[0]![1]! - 0.8) < 1e-6);
  assert.equal((await e.identity()).dims, 2);
});

test('外部: 埋め込みに対応していない接続先（404）は、そうと分かる理由で失敗する', async () => {
  const fetchImpl = (async () =>
    new Response('{"error":"not found"}', { status: 404 })) as unknown as typeof fetch;
  const e = new EndpointEmbedder(ep, 'm', 4, fetchImpl);
  await assert.rejects(e.embed(['a'], 'passage'), (err: unknown) => {
    assert.ok(err instanceof EmbeddingError);
    assert.equal(err.unsupported, true);
    assert.match(err.message, /埋め込み（\/embeddings）に対応していないようです/);
    return true;
  });
});

// ---------------- 速さの実測（14-memory.md「総当たりで足りる根拠」） ----------------

test('総当たりの検索の速さ: 5,000 / 50,000 チャンク × 384 次元', async () => {
  for (const n of [5_000, 50_000]) {
    const dims = 384;
    const vectors = new Float32Array(n * dims);
    for (let i = 0; i < vectors.length; i++) vectors[i] = Math.random() - 0.5;
    const index = {
      dir: '',
      meta: {
        root: os.tmpdir(),
        embedding: { dims },
        files: {},
        counts: { chunks: n },
      },
      chunks: Array.from({ length: n }, (_, i) => ({
        path: `f${i % 500}.ts`,
        startLine: 1,
        endLine: 2,
        text: '',
      })),
      vectors,
    } as unknown as LoadedIndex;
    const q = normalize(Array.from({ length: dims }, () => Math.random() - 0.5));
    await searchIndex(index, q, { k: 8 }); // 温める
    const t0 = performance.now();
    const runs = 5;
    for (let r = 0; r < runs; r++) await searchIndex(index, q, { k: 8 });
    const ms = (performance.now() - t0) / runs;
    console.log(`# 総当たり ${n.toLocaleString()} チャンク: ${ms.toFixed(1)} ms / 回`);
    // 仕様の見直しの目安は 300ms。遅い機械でも落ちないよう、テストは緩めにする
    assert.ok(ms < 1500, `${n} チャンクで ${ms.toFixed(0)}ms`);
  }
});

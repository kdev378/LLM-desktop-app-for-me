#!/usr/bin/env node
/**
 * 内蔵の埋め込みを Node で動かせるかの確かめ（docs/spec/14-memory.md「モデルの選び方」の次の段）。
 *
 *   uv run tools/embed-bench/export_onnx.py              # 先に ONNX と材料を作る
 *   cd tools/embed-bench/node && npm install && node check.mjs
 *
 * 2つの実行の部品 × 2つの精度を、1つずつ別のプロセスで測る（メモリを分けて測るため）。
 *   node … onnxruntime-node（OS ごとの部品を使う。速い見込み）
 *   wasm … onnxruntime-web の WebAssembly（OS ごとの部品が要らない。遅い見込み）
 * 文を数字の列にするのは @huggingface/tokenizers（JavaScript だけで動く）。
 *
 * 見るもの: 動くか / 元のモデル（Python）と同じ答えか / 40問の当たり方 / 速さ / メモリ
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VARIANTS = ['node-fp32', 'node-int8', 'wasm-fp32', 'wasm-int8'];
const BATCH = 16;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const workDir = path.resolve(HERE, '..', 'work', opt('--model', defaultModelDir()));

if (args.includes('--one')) {
  const variant = opt('--one');
  try {
    process.stdout.write(JSON.stringify(await measure(variant)) + '\n');
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ variant, error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` }) + '\n',
    );
  }
  process.exit(0);
}

await main();

// ---------------- 親: 順に測って、表にする ----------------

async function main() {
  if (!fs.existsSync(path.join(workDir, 'meta.json'))) {
    console.error(
      `材料がありません: ${workDir}\n先に uv run tools/embed-bench/export_onnx.py を実行してください。`,
    );
    process.exit(2);
  }
  const meta = readJson('meta.json');
  const only = opt('--variants');
  const variants = only ? only.split(',') : VARIANTS;
  const results = [];
  for (const v of variants) {
    console.error(`== ${v}`);
    const p = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--one', v, '--model', path.basename(workDir)],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const line = (p.stdout ?? '')
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .pop();
    const r = line
      ? JSON.parse(line)
      : { variant: v, error: (p.stderr ?? '').trim().split('\n').pop() || '不明' };
    console.error(
      r.error
        ? `   失敗: ${r.error}`
        : `   5位以内 ${pct(r.score.hit5)}、索引づくり ${r.indexS.toFixed(1)}秒、最大メモリ ${r.maxRssMb.toFixed(0)}MB`,
    );
    results.push(r);
  }
  const md = report(meta, results);
  const outDir = path.resolve(HERE, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.writeFileSync(path.join(outDir, `node-${stamp}.md`), md);
  fs.writeFileSync(
    path.join(outDir, `node-${stamp}.json`),
    JSON.stringify({ meta, results }, null, 2),
  );
  console.log('\n' + md);
  console.error(`保存しました: ${path.join(outDir, `node-${stamp}.md`)}`);
}

// ---------------- 子: 1つを測る ----------------

async function measure(variant) {
  const [runtime, precision] = variant.split('-');
  const meta = readJson('meta.json');
  const corpus = readJson('corpus.json');
  const ref = readJson('reference.json');
  const modelFile = path.join(workDir, precision === 'int8' ? 'model_int8.onnx' : 'model.onnx');

  const { Tokenizer } = await import('@huggingface/tokenizers');
  const tokenizer = new Tokenizer(readJson('tokenizer.json'), readJson('tokenizer_config.json'));

  const t0 = performance.now();
  const ort =
    runtime === 'node'
      ? (await import('onnxruntime-node')).default
      : await import('onnxruntime-web');
  const session = await ort.InferenceSession.create(fs.readFileSync(modelFile), {
    executionProviders: [runtime === 'node' ? 'cpu' : 'wasm'],
    graphOptimizationLevel: 'all',
  });
  const loadMs = performance.now() - t0;
  const outName = session.outputNames[0];

  const embed = async (texts) => {
    // 長さの近いものをまとめて送る（詰め物を減らす）。結果は元の順に戻す
    const enc = texts.map((t) => encode(tokenizer, t, meta.max_length));
    const order = enc.map((_, i) => i).sort((a, b) => enc[a].length - enc[b].length);
    const out = new Array(texts.length);
    for (let s = 0; s < order.length; s += BATCH) {
      const idx = order.slice(s, s + BATCH);
      const len = Math.max(...idx.map((i) => enc[i].length));
      const ids = new BigInt64Array(idx.length * len);
      const mask = new BigInt64Array(idx.length * len);
      idx.forEach((i, r) => {
        enc[i].forEach((id, c) => {
          ids[r * len + c] = BigInt(id);
          mask[r * len + c] = 1n;
        });
        for (let c = enc[i].length; c < len; c++) ids[r * len + c] = BigInt(meta.pad_token_id ?? 0);
      });
      const res = await session.run({
        input_ids: new ort.Tensor('int64', ids, [idx.length, len]),
        attention_mask: new ort.Tensor('int64', mask, [idx.length, len]),
      });
      const h = res[outName];
      const hidden = h.dims[2];
      idx.forEach((i, r) => {
        out[i] = pool(h.data, r, len, hidden, enc[i].length, meta.pooling);
      });
    }
    return out;
  };

  // 文を数字の列にする結果が、Python と同じか
  let tokenMismatch = 0;
  ref.texts.forEach((t, i) => {
    const a = encode(tokenizer, t, meta.max_length);
    const b = ref.token_ids[i];
    if (a.length !== b.length || a.some((x, j) => x !== b[j])) tokenMismatch++;
  });

  // 元のモデルとの近さ
  const mine = await embed(ref.texts);
  const cos = mine.map((v, i) => dot(v, ref.vectors[i]));

  // 40問
  const docs = corpus.chunks.map((c) => meta.prefixes.document + embedText(c));
  const t1 = performance.now();
  const docVecs = await embed(docs);
  const indexS = (performance.now() - t1) / 1000;
  const qs = corpus.queries.map((q) => meta.prefixes.query + q.q);
  await embed(qs.slice(0, 2)); // 温める
  const t2 = performance.now();
  const qVecs = [];
  for (const q of qs) qVecs.push((await embed([q]))[0]);
  const queryMs = (performance.now() - t2) / qs.length;
  const score = scoreAll(qVecs, docVecs, corpus.chunks, corpus.queries);

  return {
    variant,
    runtime,
    precision,
    fileMb: fs.statSync(modelFile).size / 1048576,
    loadMs,
    indexS,
    chunksPerS: docs.length / indexS,
    queryMs,
    maxRssMb: process.resourceUsage().maxRSS / 1024,
    cosMin: Math.min(...cos),
    cosMean: cos.reduce((a, b) => a + b, 0) / cos.length,
    tokenMismatch,
    tokenChecked: ref.texts.length,
    threads: runtime === 'wasm' ? (ort.env.wasm.numThreads ?? '既定') : '既定',
    score,
  };
}

/** 文を数字の列に。長すぎれば、最後の印（区切り）を残して切る。 */
function encode(tokenizer, text, maxLen) {
  const ids = tokenizer.encode(text).ids.map(Number);
  if (ids.length <= maxLen) return ids;
  return [...ids.slice(0, maxLen - 1), ids[ids.length - 1]];
}

function pool(data, row, len, hidden, n, mode) {
  const v = new Float32Array(hidden);
  const base = row * len * hidden;
  if (mode === 'cls') v.set(data.subarray(base, base + hidden));
  else if (mode === 'lasttoken') v.set(data.subarray(base + (n - 1) * hidden, base + n * hidden));
  else {
    for (let t = 0; t < n; t++)
      for (let j = 0; j < hidden; j++) v[j] += data[base + t * hidden + j];
    for (let j = 0; j < hidden; j++) v[j] /= n;
  }
  let s = 0;
  for (let j = 0; j < hidden; j++) s += v[j] * v[j];
  const norm = Math.sqrt(s) || 1;
  for (let j = 0; j < hidden; j++) v[j] /= norm;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function embedText(c) {
  return `// ${c.path}:${c.start}-${c.end}\n${c.text}`;
}

/** bench.py と同じ採点（ファイル単位の順位）。 */
function scoreAll(qVecs, docVecs, chunks, queries) {
  const per = queries.map((q, qi) => {
    const sims = docVecs.map((d) => dot(qVecs[qi], d));
    const order = sims.map((_, i) => i).sort((a, b) => sims[b] - sims[a]);
    const files = [];
    for (const i of order) {
      if (!files.includes(chunks[i].path)) files.push(chunks[i].path);
      if (files.length >= 10) break;
    }
    const at = files.findIndex((p) => q.gold.includes(p));
    return { id: q.id, kind: q.kind, rank: at >= 0 ? at + 1 : null };
  });
  const n = per.length;
  return {
    hit1: per.filter((r) => r.rank === 1).length / n,
    hit5: per.filter((r) => r.rank && r.rank <= 5).length / n,
    mrr10: per.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
    misses: per.filter((r) => !r.rank || r.rank > 5).map((r) => `${r.id}（${r.rank ?? '圏外'}）`),
  };
}

// ---------------- 表 ----------------

function report(meta, results) {
  const v = (name) => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(HERE, 'node_modules', name, 'package.json'), 'utf8'),
      ).version;
    } catch {
      return '?';
    }
  };
  const lines = [
    `# 内蔵の埋め込みを Node で動かす確かめ（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）`,
    '',
    `- モデル: ${meta.model}（まとめ方 ${meta.pooling}、読める長さ ${meta.max_length}、印: 問い \`${meta.prefixes.query}\` / 本文 \`${meta.prefixes.document}\`）`,
    `- 機械: ${os.type()} ${os.arch()} / ${os.cpus()[0]?.model ?? '?'}（${os.cpus().length} コア） / Node ${process.version}`,
    `- 部品: onnxruntime-node ${v('onnxruntime-node')} / onnxruntime-web ${v('onnxruntime-web')} / @huggingface/tokenizers ${v('@huggingface/tokenizers')}`,
    '',
    '| 実行の部品・精度 | 動いたか | 元のモデルとの近さ（最小 / 平均） | 文の区切りの一致 | 1位 | 5位以内 | MRR@10 | 索引づくり | チャンク/秒 | 問い1つ | 最大メモリ | ファイル | 読み込み |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.variant} | 失敗 | | | | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${r.variant} | 動いた | ${r.cosMin.toFixed(4)} / ${r.cosMean.toFixed(4)} | ${r.tokenChecked - r.tokenMismatch}/${r.tokenChecked} | ` +
        `${pct(r.score.hit1)} | ${pct(r.score.hit5)} | ${r.score.mrr10.toFixed(3)} | ${r.indexS.toFixed(1)}秒 | ${r.chunksPerS.toFixed(1)} | ` +
        `${r.queryMs.toFixed(1)}ms | ${r.maxRssMb.toFixed(0)}MB | ${r.fileMb.toFixed(0)}MB | ${(r.loadMs / 1000).toFixed(1)}秒 |`,
    );
  }
  const errors = results.filter((r) => r.error);
  if (errors.length) {
    lines.push('', '## 失敗', '');
    for (const r of errors) lines.push(`- ${r.variant}: ${r.error}`);
  }
  lines.push('', '## 5位以内に入らなかった問い', '');
  for (const r of results)
    if (!r.error) lines.push(`- ${r.variant}: ${r.score.misses.join(', ') || 'なし'}`);
  lines.push(
    '',
    '見方: 「元のモデルとの近さ」が 0.99 以上なら、Python で測った当たり方がそのまま出る。8ビット版は少し下がってよい（当たり方が保てているかを見る）。',
    '「文の区切りの一致」が全件でなければ、JavaScript の区切り方が Python と違う（当たり方に効く）。',
    '',
  );
  return lines.join('\n');
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(workDir, name), 'utf8'));
}

function defaultModelDir() {
  const dir = path.resolve(HERE, '..', 'work');
  if (fs.existsSync(path.join(dir, 'ruri-v3-70m'))) return 'ruri-v3-70m';
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'meta.json')))
    : [];
  return found[0] ?? 'ruri-v3-70m';
}

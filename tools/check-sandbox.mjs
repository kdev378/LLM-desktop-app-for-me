#!/usr/bin/env node
/**
 * コマンドの閉じ込めを、本物の akari で通しに確かめる（docs/testing.md 11-9）。
 * モデルは模擬サーバ（tools/mock-llm-server.mjs）に台本どおり答えさせるので、LLM は要らない。
 *
 *   pnpm build && node tools/check-sandbox.mjs
 *
 * 使い捨ての作業フォルダとデータの置き場をホームの下に作り、終わったら消す。
 * あなたの設定（接続先・会話）には触らない。~/.ssh は中身の名前を読むだけで、書き換えない。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(repo, 'apps', 'cli', 'dist', 'index.js');
const MOCK = path.join(repo, 'tools', 'mock-llm-server.mjs');
if (!fs.existsSync(CLI)) {
  console.error('apps/cli/dist が無い。先に pnpm build を実行してください。');
  process.exit(2);
}

const tag = Math.random().toString(36).slice(2, 8);
const home = os.homedir();
// /tmp は閉じ込めの中でも書けるので、確かめる場所はホームの下に作る
const base = fs.mkdtempSync(path.join(home, '.akari-sbx-check-'));
const work = path.join(base, 'work');
const akariHome = path.join(base, 'akari-home');
fs.mkdirSync(work);
fs.mkdirSync(akariHome);
const secret = `dummy-secret-${tag}`;
fs.writeFileSync(path.join(work, '.env'), `AKARI_SBX_SECRET=${secret}\n`);
fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
const outside = path.join(home, `akari-sbx-outside-${tag}.txt`);
const sshDir = path.join(home, '.ssh');
const sshNames = fs.existsSync(sshDir) ? fs.readdirSync(sshDir) : [];

const steps = [
  { id: 'env', command: 'cat .env', what: '作業フォルダの .env をコマンドから読めない' },
  { id: 'outside', command: `touch '${outside}'`, what: '作業フォルダの外（ホーム）に書けない' },
  { id: 'ssh', command: `ls -A '${sshDir}'`, what: '~/.ssh の中身が見えない' },
  { id: 'inside', command: 'echo inside > inside.txt', what: '作業フォルダの中には書ける' },
  {
    id: 'tmp',
    command: `echo x > '${path.join(os.tmpdir(), `akari-sbx-tmp-${tag}`)}'`,
    what: '一時フォルダには書ける',
  },
  { id: 'tools', command: 'git --version && node --version', what: 'git と node が動く' },
];
const script = [
  ...steps.map((s) => ({ name: 'run_command', arguments: { command: s.command } })),
  { text: '確認を終えました' },
];

const port = await freePort();
const mock = spawn(process.execPath, [MOCK, String(port)], {
  env: { ...process.env, AKARI_MOCK_SCRIPT: JSON.stringify(script) },
  stdio: 'ignore',
});
const env = { ...process.env, AKARI_HOME: akariHome, NO_COLOR: '1' };

let failed = false;
try {
  await waitForMock(port);
  await akari([
    'config',
    'endpoints',
    'add',
    '--name',
    'mock',
    '--url',
    `http://127.0.0.1:${port}/v1`,
    '--model',
    'mock-chat-7b',
  ]);
  const run = await akari([
    'run',
    '--json',
    '--no-save',
    '--permission',
    'full',
    '--tools-mode',
    'native',
    '-C',
    work,
    '閉じ込めの確認',
  ]);
  const events = run.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  const start = events.find((e) => e.type === 'run-start');
  const sandbox = start?.sandbox;
  console.log(`OS: ${process.platform} ${os.release()}`);
  console.log(
    `閉じ込め: ${sandbox ? (sandbox.active ? `あり（${sandbox.kind}）` : `なし（${sandbox.reason}）`) : '不明（run-start に無い）'}`,
  );
  console.log('');

  // call_<n> の n は台本の何手目か
  const outputOf = (i) =>
    events
      .filter((e) => e.type === 'tool-output' && e.callId === `call_${i}`)
      .map((e) => e.text)
      .join('');
  const resultOf = (i) => events.find((e) => e.type === 'tool-result' && e.callId === `call_${i}`);

  const checks = {
    env: (out) => !out.includes(secret),
    outside: () => !fs.existsSync(outside),
    // 閉じ込めは ~/.ssh を空のフォルダに見せる（失敗にはならない）。名前が出なければよい
    ssh: (out) => (sshNames.length === 0 ? null : !sshNames.some((n) => out.includes(n))),
    inside: () => fs.existsSync(path.join(work, 'inside.txt')),
    tmp: (_, r) => r?.ok === true,
    tools: (_, r) => r?.ok === true,
  };

  if (!sandbox?.active) failed = true;
  steps.forEach((s, i) => {
    const out = outputOf(i);
    const r = resultOf(i);
    const verdict = r ? checks[s.id](out, r) : false;
    const mark = verdict === null ? 'SKIP' : verdict ? 'PASS' : 'FAIL';
    if (verdict === false) failed = true;
    const note =
      verdict === null
        ? '（~/.ssh が無いか空なので確かめられない）'
        : r
          ? `（${r.summary}）`
          : '（結果が無い）';
    console.log(`${mark}  ${s.what}  ${note}`);
    if (verdict === false && out.trim())
      console.log(`      出力: ${out.trim().slice(0, 300).replace(/\n/g, '\n            ')}`);
  });
  const end = events.find((e) => e.type === 'run-end');
  console.log('');
  console.log(`実行の終わり: ${end?.reason ?? '不明'}（akari の終了コード ${run.code}）`);
  if (run.stderr.trim()) console.log(`標準エラー:\n${run.stderr.trim().slice(0, 1500)}`);
  console.log(failed ? '\n結果: FAIL（上の行をそのまま貼ってください）' : '\n結果: すべて PASS');
} finally {
  mock.kill();
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
  fs.rmSync(path.join(os.tmpdir(), `akari-sbx-tmp-${tag}`), { force: true });
}
process.exit(failed ? 1 : 0);

function akari(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForMock(p) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/v1/models`);
      if (r.ok) return;
    } catch {
      /* まだ */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('模擬サーバが起動しませんでした');
}

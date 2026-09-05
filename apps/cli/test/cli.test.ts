import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * CLI の通し確認。実際に子プロセスとして起動し、模擬サーバへ繋ぐ。
 * 出力の文言ではなく「何ができるか」と終了コードを確かめる。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'index.js');
const MOCK = path.join(here, '..', '..', '..', 'tools', 'mock-llm-server.mjs');
const PORT = 11577;

let mock: ReturnType<typeof spawn>;
let home: string;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'akari-cli-'));
  mock = spawn(process.execPath, [MOCK, String(PORT)], { stdio: 'ignore' });
  // 起動待ち: /models が返るまで最大5秒
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
      if (r.ok) {
        await r.text();
        break;
      }
    } catch {
      /* まだ起動していない */
    }
    if (Date.now() > deadline) throw new Error('模擬サーバが起動しませんでした');
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  mock?.kill();
});

function akari(
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, AKARI_HOME: home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    if (input !== undefined) {
      p.stdin.write(input);
      p.stdin.end();
    } else {
      p.stdin.end();
    }
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('接続先が無い状態で chat すると、登録の仕方を示して終了コード2', async () => {
  const r = await akari(['chat', '-p', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /接続先が1つも登録されていません/);
  assert.match(r.stderr, /endpoints add/);
});

test('接続先を追加できる', async () => {
  const r = await akari([
    'config',
    'endpoints',
    'add',
    '--name',
    'テスト',
    '--url',
    `http://127.0.0.1:${PORT}/v1`,
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /追加しました/);
});

test('モデル一覧が出る', async () => {
  const r = await akari(['models']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /mock-chat-7b/);
});

test('--json のモデル一覧は1個のJSONとして読める', async () => {
  const r = await akari(['--json', 'models']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout) as { models: Array<{ id: string }> };
  assert.ok(parsed.models.some((m) => m.id === 'mock-chat-7b'));
});

test('一回だけの chat で応答が返る', async () => {
  const r = await akari(['chat', '-p', 'テスト入力です']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /模擬サーバの応答/);
  assert.match(r.stdout, /テスト入力です/);
});

test('標準入力からの chat が動く', async () => {
  const r = await akari(['chat', '-q'], 'パイプ入力\n');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /パイプ入力/);
});

test('--json は標準出力がすべてNDJSONで、標準エラーに人向けの行を出さない', async () => {
  const r = await akari(['--json', 'chat', '-p', 'x']);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  for (const line of lines) JSON.parse(line); // 全行がJSONとして読めること
  assert.equal(lines[0] && (JSON.parse(lines[0]) as { type: string }).type, 'start');
  assert.equal((JSON.parse(lines.at(-1)!) as { type: string }).type, 'finish');
  assert.equal(r.stderr.trim(), '');
});

test('機能判定が結果を保存する', async () => {
  const r = await akari(['config', 'endpoints', 'probe']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /到達: はい/);
  const cfg = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8')) as {
    endpoints: Array<{ capabilities: { tools: string; probedAt: string | null } }>;
  };
  assert.equal(cfg.endpoints[0].capabilities.tools, 'native');
  assert.ok(cfg.endpoints[0].capabilities.probedAt);
});

test('範囲外の設定は変更されず、終了コード2で有効範囲を示す', async () => {
  const before = await akari(['config', 'get', 'agent.maxSteps']);
  const r = await akari(['config', 'set', 'agent.maxSteps', '9999']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /設定は変更していません/);
  const after = await akari(['config', 'get', 'agent.maxSteps']);
  assert.equal(after.stdout, before.stdout);
});

test('到達できない接続先は終了コード4', async () => {
  await akari([
    'config',
    'endpoints',
    'add',
    '--name',
    '落ちてる',
    '--url',
    'http://127.0.0.1:9/v1',
  ]);
  const r = await akari(['-e', '落ちてる', 'models']);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /接続できません/);
});

test('未実装のコマンドは、あるように見せず終了コード2', async () => {
  const r = await akari(['run', 'なにか']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /まだ実装されていません/);
});

test('診断の書き出しに鍵と会話本文が含まれない', async () => {
  const secret = 'sk-testsecret1234567890abcd';
  await akari([
    'config',
    'endpoints',
    'add',
    '--name',
    '鍵つき',
    '--url',
    'https://api.example.com/v1',
    '--key',
    secret,
  ]);
  const target = path.join(home, 'diag.txt');
  const r = await akari(['doctor', '--no-probe', '--export', target]);
  assert.equal(r.code, 0);
  const text = await fs.readFile(target, 'utf8');
  assert.ok(!text.includes(secret), '鍵が診断に含まれてはいけない');
  assert.ok(!text.includes('模擬サーバの応答'), '会話本文が診断に含まれてはいけない');
  assert.match(text, /バージョン:/);
});

test('外部の接続先を足すと、送信されることを警告する', async () => {
  const r = await akari([
    'config',
    'endpoints',
    'add',
    '--name',
    '外部2',
    '--url',
    'https://api.example.org/v1',
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /インターネット上/);
});

test('--version がバージョンを出す', async () => {
  const r = await akari(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /0\.1\.0/);
});

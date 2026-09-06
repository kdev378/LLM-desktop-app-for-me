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
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, AKARI_HOME: home, NO_COLOR: '1', ...opts.env },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
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
  for (const name of ['serve', 'mcp', 'index', 'web']) {
    const r = await akari([name]);
    assert.equal(r.code, 2, `${name} は未実装として終了コード2`);
    assert.match(r.stderr, /まだ実装されていません/);
  }
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

// ---------------- エージェント実行 ----------------

/** 台本を渡した模擬サーバを、その試験だけのポートで立てる。 */
async function withScriptedServer<T>(
  port: number,
  script: unknown[],
  fn: (endpointName: string) => Promise<T>,
): Promise<T> {
  const proc = spawn(process.execPath, [MOCK, String(port)], {
    stdio: 'ignore',
    env: { ...process.env, AKARI_MOCK_SCRIPT: JSON.stringify(script) },
  });
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
        if (r.ok) {
          await r.text();
          break;
        }
      } catch {
        /* まだ */
      }
      if (Date.now() > deadline) throw new Error('模擬サーバが起動しませんでした');
      await new Promise((r) => setTimeout(r, 100));
    }
    const name = `script-${port}`;
    await akari([
      'config',
      'endpoints',
      'add',
      '--name',
      name,
      '--url',
      `http://127.0.0.1:${port}/v1`,
      '--model',
      'mock-coder-14b',
    ]);
    return await fn(name);
  } finally {
    proc.kill('SIGKILL');
  }
}

async function sandbox(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akari-sbx-'));
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return await fs.realpath(dir);
}

test('非対話で承認が要る操作は自動拒否され、終了コード3。ファイルは無傷', async () => {
  const dir = await sandbox({ 'a.txt': '元\n' });
  await withScriptedServer(
    11801,
    [
      { name: 'write_file', arguments: { path: 'a.txt', content: '書き換え\n' } },
      { text: '拒否されました' },
    ],
    async (ep) => {
      const r = await akari(['-e', ep, 'run', '-C', dir, '-p', '書き換えて']);
      assert.equal(r.code, 3);
      assert.match(r.stderr, /承認が得られなかった/);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), '元\n');
    },
  );
});

test('full なら書き換えが通り、diff と undo が効く', async () => {
  const dir = await sandbox({ 'a.txt': '元\n' });
  await withScriptedServer(
    11802,
    [{ name: 'write_file', arguments: { path: 'a.txt', content: '新\n' } }, { text: '書きました' }],
    async (ep) => {
      const r = await akari(['-e', ep, 'run', '--permission', 'full', '-C', dir, '-p', '書いて']);
      assert.equal(r.code, 0);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), '新\n');

      const d = await akari(['diff']);
      assert.equal(d.code, 0);
      assert.match(d.stdout, /-元/);
      assert.match(d.stdout, /\+新/);

      const u = await akari(['undo', '-y']);
      assert.equal(u.code, 0);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), '元\n');
    },
  );
});

test('最も緩い full でも、作業フォルダの外へは出られない', async () => {
  const dir = await sandbox({ 'a.txt': 'x\n' });
  const outside = path.join(path.dirname(dir), `escape-${Date.now()}.txt`);
  await withScriptedServer(
    11803,
    [
      {
        name: 'write_file',
        arguments: { path: `../${path.basename(outside)}`, content: 'のっとり' },
      },
      { name: 'read_file', arguments: { path: '../../etc/passwd' } },
      { name: 'run_command', arguments: { command: 'echo hi', cwd: '../..' } },
      { text: '出られませんでした' },
    ],
    async (ep) => {
      const r = await akari([
        '-e',
        ep,
        'run',
        '--permission',
        'full',
        '-C',
        dir,
        '-p',
        '外を触って',
      ]);
      assert.equal(r.code, 0);
      assert.equal((r.stdout.match(/作業フォルダの外/g) ?? []).length, 3, '3件とも拒否されること');
      await assert.rejects(() => fs.stat(outside), '外にファイルが作られないこと');
    },
  );
});

test('--json のエージェント実行は全行がNDJSONで、run-end で終わる', async () => {
  const dir = await sandbox({ 'a.txt': 'x\n' });
  await withScriptedServer(
    11804,
    [{ name: 'read_file', arguments: { path: 'a.txt' } }, { text: '読みました' }],
    async (ep) => {
      const r = await akari([
        '--json',
        '-e',
        ep,
        'run',
        '--permission',
        'full',
        '-C',
        dir,
        '-p',
        '読んで',
      ]);
      assert.equal(r.code, 0);
      const events = r.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string });
      assert.equal(events[0]!.type, 'run-start');
      assert.equal(events.at(-1)!.type, 'run-end');
      assert.ok(events.some((e) => e.type === 'tool-result'));
      assert.equal(r.stderr.trim(), '');
    },
  );
});

test('実行後に手で変えたファイルは undo で上書きされず、理由が出る', async () => {
  const dir = await sandbox({ 'a.txt': '元\n' });
  await withScriptedServer(
    11805,
    [
      { name: 'write_file', arguments: { path: 'a.txt', content: 'エージェント\n' } },
      { text: '完了' },
    ],
    async (ep) => {
      await akari(['-e', ep, 'run', '--permission', 'full', '-C', dir, '-p', '書いて']);
      await fs.writeFile(path.join(dir, 'a.txt'), '人が直した\n');
      const u = await akari(['undo', '-y']);
      assert.match(u.stdout, /戻せなかったもの/);
      assert.match(u.stdout, /手で変更/);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), '人が直した\n');
    },
  );
});

test('作業フォルダが広すぎる場所なら実行を断る', async () => {
  const r = await akari(['run', '-C', os.homedir(), '-p', 'なにか']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ホームディレクトリ/);
});

test('サブコマンド名でない引数は run とみなす（akari "…" の短縮形）', async () => {
  const dir = await sandbox({ 'a.txt': 'x\n' });
  await withScriptedServer(11806, [{ text: 'こんにちは' }], async (ep) => {
    const r = await akari(['ファイルを見て'], undefined, { cwd: dir, env: { AKARI_ENDPOINT: ep } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /こんにちは/);
  });
});

test('ツール非対応モデルでも、代替方式に切り替わって実行できる', async () => {
  const dir = await sandbox({ 'main.ts': 'const timeout = 1000;\n' });
  const fence = '```akari-tool';
  const script = [
    {
      text:
        '変えます。\n' +
        fence +
        '\n' +
        JSON.stringify({
          name: 'edit_file',
          arguments: {
            path: 'main.ts',
            oldText: 'const timeout = 1000;',
            newText: 'const timeout = 5000;',
          },
        }) +
        '\n```',
    },
    { text: '変更しました。' },
  ];

  const proc = spawn(process.execPath, [MOCK, '11807'], {
    stdio: 'ignore',
    env: { ...process.env, AKARI_MOCK_SCRIPT: JSON.stringify(script), AKARI_MOCK_NO_TOOLS: '1' },
  });
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const r = await fetch('http://127.0.0.1:11807/v1/models');
        if (r.ok) {
          await r.text();
          break;
        }
      } catch {
        /* まだ */
      }
      if (Date.now() > deadline) throw new Error('模擬サーバが起動しませんでした');
      await new Promise((r) => setTimeout(r, 100));
    }
    await akari([
      'config',
      'endpoints',
      'add',
      '--name',
      'notools',
      '--url',
      'http://127.0.0.1:11807/v1',
      '--model',
      'mock-chat-7b',
    ]);

    const r = await akari([
      '-e',
      'notools',
      'run',
      '--permission',
      'full',
      '-C',
      dir,
      '-p',
      'timeout を変えて',
    ]);
    assert.equal(r.code, 0);
    // 自動判定が働き、代替方式に切り替わったこと
    assert.match(r.stdout, /代替方式/);
    // 実際にツールが実行されたこと
    assert.equal(await fs.readFile(path.join(dir, 'main.ts'), 'utf8'), 'const timeout = 5000;\n');
    // 生のブロックが画面に出ていないこと
    assert.ok(!r.stdout.includes('akari-tool'), '本文のブロックは画面から隠す');
    assert.ok(!r.stdout.includes('"oldText"'), '引数のJSONが素で出ない');
  } finally {
    proc.kill('SIGKILL');
  }
});

test('判定結果が設定へ保存され、2回目は判定し直さない', async () => {
  const cfgBefore = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8')) as {
    endpoints: Array<{ name: string; capabilities: { tools: string; probedModel: string | null } }>;
  };
  const ep = cfgBefore.endpoints.find((e) => e.name === 'notools');
  assert.ok(ep, '前のテストで登録した接続先があること');
  assert.equal(ep!.capabilities.tools, 'prompted', '判定結果が保存されていること');
  assert.equal(ep!.capabilities.probedModel, 'mock-chat-7b');
});

test('--no-tools のとき、ファイルを触れないことを実行前に伝える', async () => {
  const dir = await sandbox({ 'a.txt': 'x\n' });
  await withScriptedServer(11808, [{ text: 'できません' }], async (ep) => {
    const r = await akari(['-e', ep, 'run', '--no-tools', '-C', dir, '-p', 'a.txt を書き換えて']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ツール: なし/);
    assert.match(r.stdout, /ファイルの読み書きとコマンド実行はできません/);
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'x\n');
  });
});

test('モデルはサブコマンドの前でも後ろでも指定できる', async () => {
  const dir = await sandbox({});
  await withScriptedServer(11809, [{ text: 'はい' }], async (ep) => {
    const before = await akari([
      '-e',
      ep,
      '-m',
      'mock-chat-7b',
      'run',
      '--no-tools',
      '-C',
      dir,
      '-p',
      'x',
    ]);
    const after = await akari([
      '-e',
      ep,
      'run',
      '-m',
      'mock-chat-7b',
      '--no-tools',
      '-C',
      dir,
      '-p',
      'x',
    ]);
    assert.equal(before.code, 0);
    assert.equal(after.code, 0);
    for (const r of [before, after]) assert.match(r.stdout, /mock-chat-7b/);
  });
});

test('知らないオプションは終了コード2（使い方の誤り）', async () => {
  const r = await akari(['run', '--no-tool', '-p', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown option/);
});

test('--help と --version は終了コード0', async () => {
  assert.equal((await akari(['--help'])).code, 0);
  assert.equal((await akari(['--version'])).code, 0);
  assert.equal((await akari(['run', '--help'])).code, 0);
});

test('-p - で標準入力からプロンプトを読む', async () => {
  const dir = await sandbox({});
  await withScriptedServer(11810, [{ text: '受け取りました' }], async (ep) => {
    const chat = await akari(['-e', ep, 'chat', '-p', '-', '-q'], '標準入力の文\n');
    assert.equal(chat.code, 0);
    assert.match(chat.stdout, /受け取りました/);

    const run = await akari(
      ['-e', ep, 'run', '-p', '-', '--no-tools', '-C', dir],
      '標準入力の指示\n',
    );
    assert.equal(run.code, 0);
    assert.match(run.stdout, /受け取りました/);
  });
});

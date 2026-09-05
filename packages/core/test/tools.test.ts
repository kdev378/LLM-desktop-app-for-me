import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  Workspace,
  ChangeJournal,
  BUILTIN_TOOLS,
  findTool,
  DEFAULT_LIMITS,
  matchGlob,
  globToRegExp,
  truncateMiddle,
  commandScope,
  matchesDenied,
} from '../dist/index.js';

async function ctx(files: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-tools-')));
  const root = path.join(base, 'work');
  const akari = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(akari, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(root, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  const workspace = await Workspace.open(root, akari);
  const journal = await ChangeJournal.create('01JTESTTESTTESTTESTTESTTES', root, akari);
  return {
    root,
    akari,
    workspace,
    journal,
    tool: (name: string) => findTool(BUILTIN_TOOLS, name)!,
    make: (callId = 'c1') => ({
      workspace,
      journal,
      limits: DEFAULT_LIMITS,
      signal: new AbortController().signal,
      callId,
    }),
  };
}

test('read_file は行番号付きで返す', async () => {
  const c = await ctx({ 'a.txt': 'one\ntwo\nthree\n' });
  const r = await c.tool('read_file').run({ path: 'a.txt' }, c.make());
  assert.equal(r.ok, true);
  assert.match(r.content, /1\| one/);
  assert.match(r.content, /3\| three/);
});

test('read_file は作業フォルダの外を拒否する', async () => {
  const c = await ctx();
  const r = await c.tool('read_file').run({ path: '../secret' }, c.make());
  assert.equal(r.ok, false);
  assert.match(r.content, /作業フォルダの外/);
});

test('read_file はバイナリを拒否し、理由を返す', async () => {
  const c = await ctx();
  await fs.writeFile(path.join(c.root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  const r = await c.tool('read_file').run({ path: 'bin.dat' }, c.make());
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'binary');
});

test('write_file は新規作成し、記録に残る', async () => {
  const c = await ctx();
  const r = await c
    .tool('write_file')
    .run({ path: 'src/new.ts', content: 'export const a = 1;\n' }, c.make());
  assert.equal(r.ok, true);
  assert.equal(await fs.readFile(path.join(c.root, 'src/new.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(r.change?.op, 'create');
  assert.equal(c.journal.changedFiles().length, 1);
});

test('edit_file は oldText が複数一致したら実行しない', async () => {
  const c = await ctx({ 'a.ts': 'x = 1;\nx = 1;\n' });
  const r = await c
    .tool('edit_file')
    .run({ path: 'a.ts', oldText: 'x = 1;', newText: 'x = 2;' }, c.make());
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'ambiguous');
  assert.equal(
    await fs.readFile(path.join(c.root, 'a.ts'), 'utf8'),
    'x = 1;\nx = 1;\n',
    '中身は変わらないこと',
  );
});

test('edit_file は replaceAll なら複数置換する', async () => {
  const c = await ctx({ 'a.ts': 'x = 1;\nx = 1;\n' });
  const r = await c
    .tool('edit_file')
    .run({ path: 'a.ts', oldText: 'x = 1;', newText: 'x = 2;', replaceAll: true }, c.make());
  assert.equal(r.ok, true);
  assert.equal(await fs.readFile(path.join(c.root, 'a.ts'), 'utf8'), 'x = 2;\nx = 2;\n');
});

test('edit_file は一致しなければ実行せず理由を返す', async () => {
  const c = await ctx({ 'a.ts': 'y = 1;\n' });
  const r = await c
    .tool('edit_file')
    .run({ path: 'a.ts', oldText: 'z = 9;', newText: 'q' }, c.make());
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'no-match');
});

test('glob と grep が中身を見つける', async () => {
  const c = await ctx({
    'src/a.ts': 'const found = 1;\n',
    'src/b.js': 'nope\n',
    'node_modules/x/c.ts': 'const found = 2;\n',
  });
  const g = await c.tool('glob').run({ pattern: 'src/**/*.ts' }, c.make());
  assert.match(g.content, /src\/a\.ts/);
  assert.ok(!g.content.includes('node_modules'), 'node_modules は除外されること');
  const gr = await c.tool('grep').run({ pattern: 'found' }, c.make());
  assert.match(gr.content, /src\/a\.ts:1/);
  assert.ok(!gr.content.includes('node_modules'));
});

test('delete_file は記録を残して消す', async () => {
  const c = await ctx({ 'gone.txt': 'bye\n' });
  const r = await c.tool('delete_file').run({ path: 'gone.txt' }, c.make());
  assert.equal(r.ok, true);
  assert.equal(r.change?.op, 'delete');
  await assert.rejects(() => fs.stat(path.join(c.root, 'gone.txt')));
});

test('run_command は終了コードと出力を返す', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX のみ');
  const c = await ctx();
  const r = await c.tool('run_command').run({ command: 'echo こんにちは && exit 0' }, c.make());
  assert.equal(r.ok, true);
  assert.match(r.content, /こんにちは/);
  assert.match(r.content, /終了コード: 0/);
});

test('run_command は失敗の終了コードを ok:false にする', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX のみ');
  const c = await ctx();
  const r = await c.tool('run_command').run({ command: 'exit 3' }, c.make());
  assert.equal(r.ok, false);
  assert.match(r.content, /終了コード: 3/);
});

test('run_command は拒否リストを承認前に弾く', async () => {
  const c = await ctx();
  const base = c.make();
  const r = await c
    .tool('run_command')
    .run(
      { command: 'sudo rm -rf / --no-preserve-root' },
      { ...base, limits: { ...DEFAULT_LIMITS, deniedCommands: ['rm -rf /'] } },
    );
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'denied');
});

test('run_command は子孫ごとタイムアウトで止まる', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX のみ');
  const c = await ctx();
  const base = c.make();
  const started = Date.now();
  const r = await c
    .tool('run_command')
    .run(
      { command: 'sleep 30 & sleep 30' },
      { ...base, limits: { ...DEFAULT_LIMITS, commandTimeoutMs: 1500 } },
    );
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'timeout');
  assert.ok(Date.now() - started < 10000, 'タイムアウトで速やかに戻ること');
});

test('run_command は cwd を作業フォルダの外に取れない', async () => {
  const c = await ctx();
  const r = await c.tool('run_command').run({ command: 'pwd', cwd: '../..' }, c.make());
  assert.equal(r.ok, false);
  assert.match(r.content, /作業フォルダの外/);
});

test('glob のパターン変換', () => {
  assert.equal(matchGlob('src/**/*.ts', 'src/a/b/c.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/c.ts'), true);
  assert.equal(matchGlob('*.ts', 'a/b.ts'), false);
  assert.equal(matchGlob('**/{a,b}.json', 'x/a.json'), true);
  assert.equal(matchGlob('**/{a,b}.json', 'x/c.json'), false);
  assert.equal(matchGlob('a.?s', 'a.ts'), true);
  assert.equal(globToRegExp('a.b').test('axb'), false, '. は文字通り');
});

test('出力の切り詰めは、省いた量を明記する', () => {
  const long = 'あ'.repeat(5000);
  const r = truncateMiddle(long, 1000);
  assert.equal(r.truncated, true);
  assert.match(r.text, /文字を省略/);
  assert.ok(Buffer.byteLength(r.text) < Buffer.byteLength(long));
});

test('コマンドの許可範囲はサブコマンドまで', () => {
  assert.equal(commandScope('npm test'), 'npm test');
  assert.equal(commandScope('npm test -- --watch'), 'npm test');
  assert.equal(commandScope('ls -la'), 'ls');
  assert.equal(commandScope('git push --force'), 'git push');
  assert.notEqual(commandScope('npm test'), commandScope('npm publish'));
});

test('拒否リストは空白の違いを吸収する', () => {
  assert.equal(matchesDenied('rm  -rf  /', ['rm -rf /']), 'rm -rf /');
  assert.equal(matchesDenied('rm -rf ./build', ['rm -rf /']), null);
});

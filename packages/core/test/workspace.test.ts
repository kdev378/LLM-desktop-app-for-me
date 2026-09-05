import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace, isInside, isInsideOrSame } from '../dist/index.js';

/**
 * パス境界のテスト。ここが破れると作業フォルダの外が壊れる。
 * 仕様: docs/spec/05-agent.md「パス境界」
 */

const NUL = String.fromCharCode(0);

async function sandbox() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-ws-')));
  const root = path.join(base, 'work');
  const outside = path.join(base, 'outside');
  const akari = path.join(base, 'akari-home');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(akari, { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'とても大事\n');
  const ws = await Workspace.open(root, akari);
  return { base, root, outside, akari, ws };
}

test('作業フォルダの中の既存ファイルは解決できる', async () => {
  const { ws } = await sandbox();
  const r = await ws.resolve('src/main.ts', 'read');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.relative, path.join('src', 'main.ts'));
    assert.equal(r.exists, true);
  }
});

test('まだ無いファイルも書き込み先として解決できる', async () => {
  const { ws } = await sandbox();
  const r = await ws.resolve('src/new/deep/file.ts', 'write');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.exists, false);
});

test('.. で外へ出られない', async () => {
  const { ws } = await sandbox();
  for (const p of ['../outside/secret.txt', '../../etc/passwd', 'src/../../outside/secret.txt']) {
    const r = await ws.resolve(p, 'read');
    assert.equal(r.ok, false, `${p} は拒否されるはず`);
    if (!r.ok) assert.equal(r.reason, 'outside');
  }
});

test('絶対パスで外へ出られない', async () => {
  const { ws, outside } = await sandbox();
  const r = await ws.resolve(path.join(outside, 'secret.txt'), 'read');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'outside');
});

test('外を指すシンボリックリンク経由で出られない', async () => {
  const { ws, root, outside } = await sandbox();
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const r = await ws.resolve('link.txt', 'read');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'outside');
});

test('外を指すディレクトリのリンクを経由しても出られない', async () => {
  const { ws, root, outside } = await sandbox();
  await fs.symlink(outside, path.join(root, 'escape'));
  const r = await ws.resolve('escape/secret.txt', 'read');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'outside');
});

test('リンク先がまだ無いファイルでも、リンク先が外なら拒否する', async () => {
  const { ws, root, outside } = await sandbox();
  await fs.symlink(outside, path.join(root, 'escape'));
  const r = await ws.resolve('escape/newfile.txt', 'write');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'outside');
});

test('/work と /workspace を取り違えない', () => {
  assert.equal(isInside('/work', '/workspace/a.ts'), false);
  assert.equal(isInside('/work', '/work/a.ts'), true);
  assert.equal(isInside('/work', '/work'), false);
  assert.equal(isInsideOrSame('/work', '/work'), true);
  assert.equal(isInside('/work', '/workspace'), false);
});

test('作業フォルダの中に置かれた Akari のデータは触れない', async () => {
  const { root } = await sandbox();
  const inner = path.join(root, '.akari');
  await fs.mkdir(inner, { recursive: true });
  const ws = await Workspace.open(root, inner);
  const r = await ws.resolve('.akari/credentials.json', 'read');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'denied');
});

test('.git の中は書き換えられない。読むのは許す', async () => {
  const { ws, root } = await sandbox();
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const w = await ws.resolve('.git/HEAD', 'write');
  assert.equal(w.ok, false);
  if (!w.ok) assert.equal(w.reason, 'denied');
  const r = await ws.resolve('.git/HEAD', 'read');
  assert.equal(r.ok, true);
});

test('鍵が入りうるファイルは読めない', async () => {
  const { ws, root } = await sandbox();
  for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'credentials.json', '.npmrc']) {
    await fs.writeFile(path.join(root, name), 'secret\n');
    const r = await ws.resolve(name, 'read');
    assert.equal(r.ok, false, `${name} は読めないはず`);
    if (!r.ok) assert.equal(r.reason, 'denied');
  }
});

test('鍵らしい名前でも書き込みは止めない（作るのは利用者の意図）', async () => {
  const { ws } = await sandbox();
  const r = await ws.resolve('.env.example', 'write');
  assert.equal(r.ok, true);
});

test('空のパスとヌル文字は弾く', async () => {
  const { ws } = await sandbox();
  for (const bad of ['', '   ']) {
    const r = await ws.resolve(bad, 'read');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid');
  }
  const r = await ws.resolve('a' + NUL + 'b', 'read');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid');
});

test('作業フォルダ自身は解決できる', async () => {
  const { ws } = await sandbox();
  const r = await ws.resolve('.', 'read');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.relative, '.');
});

test('広すぎる場所は作業フォルダにできない', async () => {
  await assert.rejects(() => Workspace.open(os.homedir()), /ホームディレクトリ/);
  if (process.platform !== 'win32') {
    await assert.rejects(() => Workspace.open('/'), /ルート|ドライブの根/);
    await assert.rejects(() => Workspace.open('/etc'), /システム設定/);
  }
});

test('Akari のデータディレクトリの中は作業フォルダにできない', async () => {
  const { akari } = await sandbox();
  const inner = path.join(akari, 'projects');
  await fs.mkdir(inner, { recursive: true });
  await assert.rejects(() => Workspace.open(inner, akari), /Akari のデータ/);
});

test('存在しないフォルダは開けない', async () => {
  const { base } = await sandbox();
  await assert.rejects(() => Workspace.open(path.join(base, 'nope')), /ありません/);
});

test('ファイルは作業フォルダにできない', async () => {
  const { root } = await sandbox();
  await assert.rejects(
    () => Workspace.open(path.join(root, 'src', 'main.ts')),
    /ディレクトリではありません/,
  );
});

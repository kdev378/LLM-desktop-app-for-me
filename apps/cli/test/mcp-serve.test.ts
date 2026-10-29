import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMITS,
  McpHub,
  mcpServerSchema,
  withConsent,
  type ToolContext,
} from '@akari/core';

/**
 * akari mcp serve（Akari が MCP サーバになる側）。仕様: docs/spec/13-mcp.md「なる側」
 * 本物の CLI を子プロセスで起こし、Akari 自身の MCP の使う側からつなぐ。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'index.js');
const credentials = { version: 1 as const, keys: {} };
const ctx = {
  limits: DEFAULT_LIMITS,
  signal: new AbortController().signal,
  callId: 'c',
} as unknown as ToolContext;

async function setup() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-mcpserve-')));
  const work = path.join(base, 'work');
  const home = path.join(base, 'home');
  await fs.mkdir(work);
  await fs.mkdir(home);
  await fs.writeFile(path.join(work, 'a.txt'), 'hello\n');
  await fs.writeFile(path.join(work, '.env'), 'TOKEN=secret\n');
  return { base, work, home };
}

async function connect(work: string, home: string, permission?: string) {
  const server = withConsent(
    mcpServerSchema.parse({
      id: 'mcp_akari',
      name: 'akari',
      transport: 'stdio',
      command: process.execPath,
      args: [
        CLI,
        'mcp',
        'serve',
        '--workspace',
        work,
        ...(permission ? ['--permission', permission] : []),
      ],
      env: { AKARI_HOME: home },
    }),
  );
  const hub = await McpHub.connect([server], { credentials });
  assert.equal(hub.statuses[0]?.state, 'connected', hub.statuses[0]?.error);
  const call = async (name: string, args: unknown = {}) => {
    const tool = hub.tools.find((t) => t.name === `mcp__akari__${name}`);
    assert.ok(tool, `${name} が出ていません`);
    return tool.run(args, ctx);
  };
  const names = hub.tools.map((t) => t.name.replace('mcp__akari__', ''));
  return { hub, call, names };
}

function akari(args: string[], home: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, AKARI_HOME: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

test('既定は読み取りだけを出す。作業フォルダの外と秘密のファイルは読めない', async () => {
  const { work, home } = await setup();
  const { hub, call, names } = await connect(work, home);
  try {
    assert.deepEqual(names, ['read_file', 'list_dir', 'glob', 'grep', 'akari_changes']);
    const read = await call('read_file', { path: 'a.txt' });
    assert.equal(read.ok, true);
    assert.match(read.content, /hello/);
    const outside = await call('read_file', { path: '../home/config.json' });
    assert.equal(outside.ok, false);
    assert.match(outside.content, /作業フォルダの外/);
    const secret = await call('read_file', { path: '.env' });
    assert.equal(secret.ok, false);
    assert.doesNotMatch(secret.content, /TOKEN=/);
    assert.match(secret.content, /MCP 経由では読めません/);
    assert.doesNotMatch(secret.content, /request_secret_access/);
  } finally {
    await hub.close();
  }
});

test('auto-edit: 書いた変更は記録され、akari_changes で見え、akari_undo_last で戻る。delete_file は出さない', async () => {
  const { work, home } = await setup();
  const { hub, call, names } = await connect(work, home, 'auto-edit');
  try {
    assert.ok(names.includes('write_file') && names.includes('edit_file'));
    assert.ok(names.includes('akari_undo_last'));
    assert.ok(!names.includes('delete_file'));
    assert.ok(!names.includes('run_command'));

    assert.equal((await call('write_file', { path: 'b.txt', content: 'new\n' })).ok, true);
    assert.equal(
      (await call('edit_file', { path: 'a.txt', oldText: 'hello', newText: 'bye' })).ok,
      true,
    );
    const escape = await call('write_file', { path: '../escape.txt', content: 'x' });
    assert.equal(escape.ok, false);
    await assert.rejects(fs.stat(path.join(work, '..', 'escape.txt')));

    const changes = await call('akari_changes');
    assert.match(changes.content, /変更したファイル 2 件/);
    assert.match(changes.content, /\+bye/);

    const undo = await call('akari_undo_last');
    assert.match(undo.content, /戻しました: 2 件/);
    assert.equal(await fs.readFile(path.join(work, 'a.txt'), 'utf8'), 'hello\n');
    await assert.rejects(fs.stat(path.join(work, 'b.txt')));
    // 戻した後は、次の変更から新しい記録になる
    assert.match((await call('akari_changes')).content, /まだファイルを変更していません/);
  } finally {
    await hub.close();
  }
  // akari runs に MCP経由として並ぶ
  const runs = await akari(['runs', '--json'], home);
  const rows = JSON.parse(runs.stdout) as Array<{ origin?: string }>;
  assert.ok(rows.some((r) => r.origin === 'mcp'));
});

test('full: コマンドを出すが、削除のコマンドは承認の相手がいないので実行しない', async () => {
  const { work, home } = await setup();
  const { hub, call, names } = await connect(work, home, 'full');
  try {
    assert.ok(names.includes('run_command'));
    const rm = await call('run_command', { command: 'rm a.txt' });
    assert.equal(rm.ok, false);
    assert.match(rm.content, /MCP 経由では実行しません/);
    assert.equal(await fs.readFile(path.join(work, 'a.txt'), 'utf8'), 'hello\n');
    const echo = await call('run_command', { command: 'echo ok' });
    assert.match(echo.content, /ok/);
  } finally {
    await hub.close();
  }
});

test('mcp serve --http はまだ無いと言って断る', async () => {
  const { home } = await setup();
  const r = await akari(['mcp', 'serve', '--http'], home);
  assert.equal(r.code, 2);
});

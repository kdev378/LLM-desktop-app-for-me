import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  McpHub,
  Session,
  Workspace,
  ChangeJournal,
  DEFAULT_LIMITS,
  mcpServerSchema,
  mcpToolName,
  mcpFingerprint,
  consentState,
  withConsent,
  describeLaunch,
  type McpServerConfig,
  type RunEvent,
  type ToolContext,
} from '../dist/index.js';
import { fakeProvider, type Scripted } from './fake-provider.ts';

/**
 * MCP の使う側。仕様: docs/spec/13-mcp.md
 * 相手は SDK を使わずに JSON-RPC を手で話す模擬サーバ（tools/mock-mcp-server.mjs）。
 */

const MOCK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/mock-mcp-server.mjs',
);
const credentials = { version: 1 as const, keys: {} };

function server(
  over: Partial<McpServerConfig> & { name: string },
  consent = true,
): McpServerConfig {
  const s = mcpServerSchema.parse({
    id: `mcp_${over.name}`,
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK],
    startupTimeoutMs: 5000,
    ...over,
  });
  return consent ? withConsent(s) : s;
}

async function tmp(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-mcp-')));
}

/** 作業フォルダと、Akari のデータの置き場（別の場所でなければならない）。 */
async function dirs(): Promise<{ root: string; home: string }> {
  const base = await tmp();
  const root = path.join(base, 'work');
  const home = path.join(base, 'home');
  await fs.mkdir(root);
  await fs.mkdir(home);
  return { root, home };
}

async function ctxFor(): Promise<ToolContext> {
  const { root, home } = await dirs();
  const workspace = await Workspace.open(root, home);
  const journal = await ChangeJournal.create('run_mcp', root, home);
  return {
    workspace,
    journal,
    limits: DEFAULT_LIMITS,
    signal: new AbortController().signal,
    callId: 'c1',
  };
}

/** プロセスが終わったか（ゾンビは終わったとみなす）。 */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /\) Z /.test(fss.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test('stdio のサーバへつなぎ、続きのページまで道具を取り、注釈で危険度を決める', async () => {
  const hub = await McpHub.connect([server({ name: 'mock', env: { MOCK_MCP_PAGE_SIZE: '2' } })], {
    credentials,
  });
  try {
    assert.equal(hub.statuses[0]?.state, 'connected');
    const names = hub.tools.map((t) => t.name);
    assert.deepEqual(names, [
      'mcp__mock__echo',
      'mcp__mock__touch',
      'mcp__mock__fail',
      'mcp__mock__sleep',
      'mcp__mock__picture',
      'mcp__mock__env_keys',
    ]);
    const echo = hub.tools.find((t) => t.name === 'mcp__mock__echo')!;
    const touch = hub.tools.find((t) => t.name === 'mcp__mock__touch')!;
    assert.equal(echo.risk, 'read');
    // 注釈が無ければ最も厳しく
    assert.equal(touch.risk, 'execute');
    assert.deepEqual(echo.mcp, { server: 'mock', tool: 'echo', trust: 'ask', readOnlyHint: true });
    assert.match(echo.description, /^\[MCP: mock\]/);
  } finally {
    await hub.close();
  }
});

test('道具を呼ぶ。失敗の結果・画像・時間切れを、モデルへ分かる形で返す', async () => {
  const hub = await McpHub.connect([server({ name: 'mock', toolTimeoutMs: 1000 })], {
    credentials,
  });
  try {
    const ctx = await ctxFor();
    const get = (n: string) => hub.tools.find((t) => t.name === `mcp__mock__${n}`)!;
    const echo = await get('echo').run({ text: 'やあ' }, ctx);
    assert.equal(echo.ok, true);
    assert.equal(echo.content, 'やあ');
    const fail = await get('fail').run({}, ctx);
    assert.equal(fail.ok, false);
    assert.match(fail.summary, /失敗を返しました: わざと失敗しました/);
    const pic = await get('picture').run({}, ctx);
    assert.match(pic.content, /画像（image\/png）が返りました/);
    const slow = await get('sleep').run({ ms: 3000 }, ctx);
    assert.equal(slow.ok, false);
    assert.equal(slow.errorKind, 'timeout');
    // 時間切れの後も接続は使える
    const again = await get('echo').run({ text: 'まだ' }, ctx);
    assert.equal(again.content, 'まだ');
    const preview = await get('touch').preview!({ path: 'x' }, ctx);
    assert.ok(preview?.kind === 'text' && preview.text.includes('この操作は取り消せません'));
  } finally {
    await hub.close();
  }
});

test('子プロセスへ Akari の環境変数をそのまま渡さない（鍵らしいものを漏らさない）', async () => {
  process.env.AKARI_TEST_SECRET_TOKEN = 'should-not-leak';
  process.env.AKARI_TEST_PLAIN = 'plain';
  process.env.MOCK_PASS_ME = 'from-akari';
  const hub = await McpHub.connect(
    [server({ name: 'mock', env: { GIVEN: 'yes', FROM_ENV: 'env:MOCK_PASS_ME' } })],
    { credentials },
  );
  try {
    const ctx = await ctxFor();
    const r = await hub.tools.find((t) => t.name === 'mcp__mock__env_keys')!.run({}, ctx);
    const keys = r.content.split('\n');
    assert.ok(keys.includes('PATH'));
    assert.ok(keys.includes('GIVEN'));
    assert.ok(keys.includes('FROM_ENV'));
    assert.ok(!keys.includes('AKARI_TEST_SECRET_TOKEN'));
    assert.ok(!keys.includes('AKARI_TEST_PLAIN'));
    assert.ok(!keys.includes('MOCK_PASS_ME'));
  } finally {
    await hub.close();
    delete process.env.AKARI_TEST_SECRET_TOKEN;
    delete process.env.AKARI_TEST_PLAIN;
    delete process.env.MOCK_PASS_ME;
  }
});

test('壊れたサーバ・起動が遅いサーバは使わず、理由を出し、ほかは続ける', async () => {
  const dir = await tmp();
  const pidFile = path.join(dir, 'slow.pid');
  const started = Date.now();
  const hub = await McpHub.connect(
    [
      server({ name: 'broken', env: { MOCK_MCP_FAIL: '1' } }),
      server({ name: 'missing', command: '/no/such/command-akari' }),
      server({
        name: 'slow',
        startupTimeoutMs: 1000,
        env: { MOCK_MCP_SLOW_MS: '5000', MOCK_MCP_GRANDCHILD: pidFile },
      }),
      server({ name: 'good' }),
    ],
    { credentials },
  );
  try {
    const state = Object.fromEntries(hub.statuses.map((s) => [s.name, s.state]));
    assert.deepEqual(state, {
      broken: 'failed',
      missing: 'failed',
      slow: 'failed',
      good: 'connected',
    });
    assert.ok(Date.now() - started < 4000, '遅いサーバを上限より長く待たない');
    assert.match(
      hub.notices.map((n) => n.message).join('\n'),
      /「missing」は使いません: コマンドが見つかりません/,
    );
    assert.match(
      hub.notices.map((n) => n.message).join('\n'),
      /「slow」は使いません: .*1秒以内に起動しませんでした/,
    );
    assert.ok(hub.tools.every((t) => t.name.startsWith('mcp__good__')));
    // 起動に失敗したサーバの孫も残さない
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.ok(await waitFor(() => gone(pid)), `孫 ${pid} が残っています`);
  } finally {
    await hub.close();
  }
});

test('閉じると、サーバが起こした孫プロセスまで止まる', async () => {
  const dir = await tmp();
  const pidFile = path.join(dir, 'g.pid');
  const hub = await McpHub.connect(
    [server({ name: 'mock', env: { MOCK_MCP_GRANDCHILD: pidFile } })],
    {
      credentials,
    },
  );
  assert.equal(hub.statuses[0]?.state, 'connected');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.equal(gone(pid), false);
  await hub.close();
  assert.ok(await waitFor(() => gone(pid)), `孫 ${pid} が残っています`);
});

test('同意が無い・同意の後に起動する内容が変わったサーバは起動しない', async () => {
  const dir = await tmp();
  const marker = path.join(dir, 'started.pid');
  const unconsented = server({ name: 'nope', env: { MOCK_MCP_GRANDCHILD: marker } }, false);
  const consented = server({ name: 'changed' });
  // 同意した後に、誰かが引数を書き換えた
  const tampered = { ...consented, args: [...consented.args, '--evil'] };
  assert.equal(consentState(unconsented), 'missing');
  assert.equal(consentState(tampered), 'changed');
  // 名前や承認の扱いを変えても、別のプログラムにはならないので同意は保つ
  assert.equal(consentState({ ...consented, trust: 'full', toolTimeoutMs: 9999 }), 'ok');
  assert.equal(mcpFingerprint(consented), mcpFingerprint({ ...consented, name: 'renamed' }));

  const hub = await McpHub.connect([unconsented, tampered], { credentials });
  try {
    assert.deepEqual(
      hub.statuses.map((s) => s.state),
      ['unconsented', 'changed'],
    );
    assert.match(hub.notices[0]!.message, /akari mcp trust nope/);
    assert.match(hub.notices[1]!.message, /内容が変わっています/);
    assert.equal(fss.existsSync(marker), false, '同意の無いサーバが起動しました');
  } finally {
    await hub.close();
  }
  assert.match(describeLaunch(consented), /次のコマンドがあなたのPCで実行されます/);
  assert.match(describeLaunch(consented), /制限とコマンドの閉じ込めを受けません/);
});

test('HTTP のサーバへ、鍵（Bearer）を付けてつなぐ。鍵が違えば使わない', async () => {
  const child = spawn(process.execPath, [MOCK, '--http', '0'], {
    env: { ...process.env, MOCK_MCP_TOKEN: 'secret-123' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (t: string) => {
        const m = /listening on (\d+)/.exec(t);
        if (m) resolve(Number(m[1]));
      });
      child.on('error', reject);
    });
    process.env.MOCK_HTTP_TOKEN = 'secret-123';
    const url = `http://127.0.0.1:${port}/mcp`;
    const hub = await McpHub.connect(
      [
        server({
          name: 'web',
          transport: 'http',
          url,
          auth: { type: 'bearer', token: 'env:MOCK_HTTP_TOKEN' },
        }),
        server({ name: 'noauth', transport: 'http', url }),
        server({
          name: 'noenv',
          transport: 'http',
          url,
          auth: { type: 'bearer', token: 'env:AKARI_NO_SUCH_VAR' },
        }),
      ],
      { credentials },
    );
    try {
      const state = Object.fromEntries(hub.statuses.map((s) => [s.name, s.state]));
      assert.deepEqual(state, { web: 'connected', noauth: 'failed', noenv: 'failed' });
      assert.match(hub.notices.map((n) => n.message).join('\n'), /環境変数 AKARI_NO_SUCH_VAR/);
      const ctx = await ctxFor();
      const r = await hub.tools
        .find((t) => t.name === 'mcp__web__echo')!
        .run({ text: 'http' }, ctx);
      assert.equal(r.content, 'http');
    } finally {
      await hub.close();
    }
  } finally {
    child.kill();
    delete process.env.MOCK_HTTP_TOKEN;
  }
});

test('道具名は英数字・_・- の64文字に収め、衝突したら _2 を付ける', () => {
  const used = new Set<string>();
  assert.equal(mcpToolName('mcp__a__read.file', used), 'mcp__a__read_file');
  assert.equal(mcpToolName('mcp__a__read/file', used), 'mcp__a__read_file_2');
  const long = mcpToolName(`mcp__srv__${'x'.repeat(80)}`, used);
  assert.equal(long.length, 64);
  assert.match(long, /_[0-9a-f]{8}$/);
  const long2 = mcpToolName(`mcp__srv__${'x'.repeat(80)}`, used);
  assert.equal(long2.length, 64);
  assert.notEqual(long, long2);
});

// ---- 実行ループとの組み合わせ（承認） ----

type Ev = RunEvent;

async function runWith(
  trust: McpServerConfig['trust'],
  mode: 'ask' | 'autoEdit' | 'full',
  steps: Scripted[],
  decide: (ev: Extract<Ev, { type: 'approval-request' }>) => 'allow' | 'deny' = () => 'allow',
) {
  const { root, home } = await dirs();
  const workspace = await Workspace.open(root, home);
  const hub = await McpHub.connect([server({ name: 'mock', trust })], { credentials, cwd: root });
  const session = Session.create({
    provider: fakeProvider(steps),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: mode,
    extraTools: hub.tools,
  });
  const events: Ev[] = [];
  try {
    for await (const ev of session.send('やって')) {
      events.push(ev);
      if (ev.type === 'approval-request') session.approve(ev.callId, { kind: decide(ev) });
    }
  } finally {
    await hub.close();
  }
  const asked = events
    .filter((e): e is Extract<Ev, { type: 'approval-request' }> => e.type === 'approval-request')
    .map((e) => e.name);
  return { events, asked, root };
}

test('trust ask は、権限が full でも毎回聞き、「取り消せません」と示す', async () => {
  const { events, asked } = await runWith('ask', 'full', [
    { tool: 'mcp__mock__echo', args: { text: 'a' } },
    { text: '終わり' },
  ]);
  assert.deepEqual(asked, ['mcp__mock__echo']);
  const req = events.find((e) => e.type === 'approval-request') as Extract<
    Ev,
    { type: 'approval-request' }
  >;
  assert.match(req.prompt, /この操作は取り消せません/);
  assert.ok(
    !req.options.some((o) => o.decision.kind === 'allow-session'),
    '「この実行中は許可」を出さない',
  );
  const start = events.find((e) => e.type === 'run-start') as Extract<Ev, { type: 'run-start' }>;
  assert.ok(start.toolNames.includes('mcp__mock__echo'));
});

test('trust readOnly は、読み取りの注釈がある道具だけ自動。注釈の無い道具は聞く', async () => {
  const { asked } = await runWith('readOnly', 'full', [
    { tool: 'mcp__mock__echo', args: { text: 'a' } },
    { tool: 'mcp__mock__touch', args: { path: path.join(os.tmpdir(), 'akari-mcp-touch-ro') } },
    { text: '終わり' },
  ]);
  assert.deepEqual(asked, ['mcp__mock__touch']);
});

test('trust full でも、権限モードとの厳しいほう（ask なら実行系は聞く）', async () => {
  const ask = await runWith('full', 'ask', [
    { tool: 'mcp__mock__echo', args: { text: 'a' } },
    { tool: 'mcp__mock__touch', args: { path: path.join(os.tmpdir(), 'akari-mcp-touch-a') } },
    { text: '終わり' },
  ]);
  assert.deepEqual(ask.asked, ['mcp__mock__touch']);
  const full = await runWith('full', 'full', [
    { tool: 'mcp__mock__touch', args: { path: path.join(os.tmpdir(), 'akari-mcp-touch-f') } },
    { text: '終わり' },
  ]);
  assert.deepEqual(full.asked, []);
});

test('断った後は、trust full・権限 full でも MCP の実行系を自動で通さない', async () => {
  const { asked, events } = await runWith('full', 'full', [
    // 作業フォルダの外は拒否される（＝この実行で断られた操作がある）
    { tool: 'read_file', args: { path: '../../../etc/hostname' } },
    { tool: 'mcp__mock__touch', args: { path: path.join(os.tmpdir(), 'akari-mcp-touch-r') } },
    { text: '終わり' },
  ]);
  assert.deepEqual(asked, ['mcp__mock__touch']);
  const req = events.find((e) => e.type === 'approval-request') as Extract<
    Ev,
    { type: 'approval-request' }
  >;
  assert.match(req.prompt, /一度断られた操作があったため、MCPの道具は自動では実行しません/);
});

test('道具を渡さない実行には、MCP の道具も渡さない', async () => {
  const { root, home } = await dirs();
  const workspace = await Workspace.open(root, home);
  const hub = await McpHub.connect([server({ name: 'mock' })], { credentials });
  try {
    const provider = fakeProvider([{ text: 'こんにちは' }]);
    const session = Session.create({
      provider,
      model: 'fake-model',
      workspace,
      root: home,
      toolNames: [],
      extraTools: hub.tools,
    });
    for await (const _ of session.send('やあ')) void _;
    assert.equal(provider.calls[0]?.tools, undefined);
  } finally {
    await hub.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  Workspace,
  Session,
  defaultConfig,
  detectSandbox,
  resetSandboxDetection,
  seatbeltProfile,
  bubblewrapArgs,
  type RunEvent,
  type SandboxSettings,
} from '../dist/index.js';
import { fakeProvider, type Scripted } from './fake-provider.ts';

/**
 * コマンドの閉じ込め。仕様: docs/spec/05-agent.md「コマンドの閉じ込め」
 * Linux では本物の bubblewrap で確かめる。入っていなければ「飛ばした」と出す（通ったことにしない）。
 */

const status = await detectSandbox();
const active = status.active;
const skip = active
  ? false
  : `閉じ込められない環境のため飛ばした: ${status.active ? '' : status.reason}`;

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({
  ...defaultConfig().agent.sandbox,
  ...over,
});

/** 偽のホームと作業フォルダ。秘密の場所と、ホームに入った道具を置く。 */
const cleanup: string[] = [];
test.after(async () => {
  for (const d of cleanup) await fs.rm(d, { recursive: true, force: true });
});

/**
 * 一時フォルダの外に作る。一時フォルダは閉じ込めの中でも書けるので、
 * その中に偽のホームを置くと「外へ書けない」を確かめられない。
 */
async function setup(files: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.akari-sbx-test-')));
  cleanup.push(base);
  const home = path.join(base, 'home');
  const root = path.join(home, 'proj');
  const data = path.join(base, 'akari');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  await fs.writeFile(path.join(home, '.ssh', 'id_rsa'), 'ひみつの鍵\n');
  await fs.mkdir(path.join(home, '.cargo', 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.cargo', 'bin', 'mytool'),
    '#!/bin/sh\necho ツールが動いた\n',
    {
      mode: 0o755,
    },
  );
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, 'config.json'), '{"secret":"設定"}');
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  const workspace = await Workspace.open(root, data);
  return { base, home, root, data, workspace };
}

/** HOME を差し替えて走らせる（秘密の場所とキャッシュはホームから決まる）。 */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = before;
  }
}

async function run(
  session: Session,
  input: string,
  decide: (ev: Extract<RunEvent, { type: 'approval-request' }>) => 'allow' | 'deny' = () => 'allow',
) {
  const events: RunEvent[] = [];
  for await (const ev of session.send(input)) {
    events.push(ev);
    if (ev.type === 'approval-request') {
      session.approve(ev.callId, decide(ev) === 'allow' ? { kind: 'allow' } : { kind: 'deny' });
    }
  }
  return events;
}

const cmd = (command: string): Scripted => ({ tool: 'run_command', args: { command } });

/** 道具の結果（モデルへ返した本文）を、呼んだ順に。 */
function toolResults(provider: ReturnType<typeof fakeProvider>): string[] {
  const last = provider.calls.at(-1)!;
  return last.messages.filter((m) => m.role === 'tool').map((m) => m.content);
}

test(
  '閉じ込めの中では、秘密の場所と作業フォルダの .env が読めず、外へ書けない',
  { skip },
  async () => {
    const s = await setup({ '.env': 'API_KEY=本物\n', 'src/a.txt': 'ふつう\n' });
    const provider = fakeProvider([
      cmd('cat .env'),
      cmd('cat "$HOME/.ssh/id_rsa"'),
      cmd(`cat "${s.data}/config.json"`),
      cmd('echo x > ../outside.txt'),
      cmd('touch "$HOME/a"'),
      { text: '終わり' },
    ]);
    await withHome(s.home, () =>
      run(
        Session.create({
          provider,
          model: 'm',
          workspace: s.workspace,
          root: s.data,
          permissionMode: 'full',
          sandbox: settings(),
        }),
        'いろいろ試して',
      ),
    );
    const results = toolResults(provider);
    for (const r of results) {
      assert.ok(!r.includes('本物'), '.env の中身が漏れていない');
      assert.ok(!r.includes('ひみつの鍵'), '~/.ssh の中身が漏れていない');
      assert.ok(!r.includes('"secret"'), 'Akari の設定が漏れていない');
    }
    await assert.rejects(
      () => fs.stat(path.join(s.home, 'outside.txt')),
      '作業フォルダの外へ書けない',
    );
    await assert.rejects(() => fs.stat(path.join(s.home, 'a')), 'ホームへ書けない');
    assert.match(results.at(-1)!, /閉じ込めの中で動いています/, '塞がれたことを添える');
  },
);

test(
  '閉じ込めの中でも、作業フォルダと一時フォルダには書け、ホームに入った道具やふつうのコマンドが動く',
  { skip },
  async () => {
    const s = await setup({ 'src/a.txt': 'ふつう\n' });
    const provider = fakeProvider([
      cmd('echo 書いた > out.txt && cat src/a.txt'),
      cmd('t=$(mktemp) && echo tmp > "$t" && cat "$t"'),
      cmd('"$HOME/.cargo/bin/mytool"'),
      cmd('node -e "console.log(1+1)" && git --version >/dev/null && echo git-ok'),
      cmd(
        'mkdir -p "$HOME/.npm" && echo c > "$HOME/.npm/cache-test" && cat "$HOME/.npm/cache-test"',
      ),
      { text: '終わり' },
    ]);
    await fs.mkdir(path.join(s.home, '.npm'), { recursive: true });
    await withHome(s.home, () =>
      run(
        Session.create({
          provider,
          model: 'm',
          workspace: s.workspace,
          root: s.data,
          permissionMode: 'full',
          sandbox: settings(),
        }),
        '作業して',
      ),
    );
    const results = toolResults(provider);
    assert.equal(await fs.readFile(path.join(s.root, 'out.txt'), 'utf8'), '書いた\n');
    assert.match(results[0]!, /ふつう/);
    assert.match(results[1]!, /tmp/);
    assert.match(results[2]!, /ツールが動いた/);
    assert.match(results[3]!, /2[\s\S]*git-ok/);
    assert.match(results[4]!, /終了コード: 0/, '道具のキャッシュには書ける');
  },
);

test('ネットワークは既定で使え、network: false なら塞がる', { skip }, async () => {
  const server = http.createServer((_, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const probe = cmd(
    `node -e "fetch('http://127.0.0.1:${port}').then(()=>process.exit(0),()=>process.exit(3))"`,
  );
  try {
    for (const [network, expected] of [
      [true, '終了コード: 0'],
      [false, '終了コード: 3'],
    ] as const) {
      const s = await setup();
      const provider = fakeProvider([probe, { text: '終わり' }]);
      await withHome(s.home, () =>
        run(
          Session.create({
            provider,
            model: 'm',
            workspace: s.workspace,
            root: s.data,
            permissionMode: 'full',
            sandbox: settings({ network }),
          }),
          '繋いで',
        ),
      );
      assert.match(toolResults(provider)[0]!, new RegExp(expected), `network: ${network}`);
    }
  } finally {
    server.close();
  }
});

test('実行の最初に閉じ込めの状態を出す。閉じ込められないときは警告し、required ならコマンドを実行しない', async () => {
  const s = await setup();
  const off = fakeProvider([cmd('echo 動いた'), { text: '終わり' }]);
  const events = await withHome(s.home, () =>
    run(
      Session.create({
        provider: off,
        model: 'm',
        workspace: s.workspace,
        root: s.data,
        permissionMode: 'full',
        sandbox: settings({ mode: 'off' }),
      }),
      '動かして',
    ),
  );
  const start = events.find((e) => e.type === 'run-start');
  assert.ok(start && start.type === 'run-start');
  assert.deepEqual(start.sandbox, { active: false, reason: 'agent.sandbox.mode が off' });
  assert.ok(
    events.some((e) => e.type === 'notice' && /閉じ込めずに実行されます/.test(e.message)),
    '閉じ込めていないことを黙らない',
  );
  assert.match(toolResults(off)[0]!, /動いた/);

  // 閉じ込められない環境（bubblewrap が見つからない）で required
  const savedPath = process.env.PATH;
  resetSandboxDetection();
  process.env.PATH = '/nonexistent';
  try {
    const req = fakeProvider([cmd('echo 動いてはいけない'), { text: '終わり' }]);
    const ev2 = await withHome(s.home, () =>
      run(
        Session.create({
          provider: req,
          model: 'm',
          workspace: s.workspace,
          root: s.data,
          permissionMode: 'full',
          sandbox: settings({ mode: 'required' }),
        }),
        '動かして',
      ),
    );
    if (process.platform === 'linux') {
      assert.ok(ev2.some((e) => e.type === 'notice' && /コマンドを実行しません/.test(e.message)));
      assert.match(toolResults(req)[0]!, /閉じ込められないため実行しません/);
      assert.ok(!toolResults(req)[0]!.includes('動いてはいけない\n'));
    }
  } finally {
    process.env.PATH = savedPath;
    resetSandboxDetection();
  }
});

// ---------------- 秘密のファイルの読み取りを求める ----------------

test('モデルが .env の読み取りを求め、許すとその実行の間だけ read_file とコマンドから読める', async () => {
  const s = await setup({ '.env': 'API_KEY=本物\n' });
  const provider = fakeProvider([
    { tool: 'read_file', args: { path: '.env' } },
    { tool: 'request_secret_access', args: { path: '.env', reason: 'テストの設定を確かめたい' } },
    { tool: 'read_file', args: { path: '.env' } },
    ...(active ? [cmd('cat .env')] : []),
    { text: '読めました' },
    { tool: 'read_file', args: { path: '.env' } },
    { text: '次の実行では読めない' },
  ]);
  const session = Session.create({
    provider,
    model: 'm',
    workspace: s.workspace,
    root: s.data,
    permissionMode: 'full',
    sandbox: settings(),
  });
  const prompts: string[] = [];
  await withHome(s.home, () =>
    run(session, '設定を見て', (ev) => {
      prompts.push(ev.prompt);
      return 'allow';
    }),
  );
  // （断られた後なので、コマンドの承認も出る。05-agent.md「断られた後の迂回」）
  const secretPrompts = prompts.filter((p) => p.includes('秘密のファイルの読み取り'));
  assert.equal(secretPrompts.length, 1, 'full でも、求めたときは必ず聞く');
  assert.match(secretPrompts[0]!, /\.env/);
  assert.match(secretPrompts[0]!, /テストの設定を確かめたい/);
  assert.ok(
    provider.calls[0]!.tools?.some((t) => t.name === 'request_secret_access'),
    '秘密のファイルがあるので道具を渡す',
  );
  const first = provider.calls.at(-1)!.messages.filter((m) => m.role === 'tool');
  assert.match(first[0]!.content, /request_secret_access/, '断ったときに、求められることを伝える');
  assert.match(first[2]!.content, /本物/, '許した後は read_file で読める');
  if (active) assert.match(first[3]!.content, /本物/, 'コマンドからも読める');

  // 次の実行では、また塞がる
  await withHome(s.home, () => run(session, 'もう一度'));
  const second = provider.calls
    .at(-1)!
    .messages.filter((m) => m.role === 'tool')
    .at(-1)!;
  assert.ok(!second.content.includes('本物'), '許可はその実行だけ');
});

test('求めても断られたら読めない。秘密でないファイルや外のファイルは承認を出さずに答える', async () => {
  const s = await setup({ '.env': 'API_KEY=本物\n', 'note.txt': 'メモ\n' });
  const provider = fakeProvider([
    { tool: 'request_secret_access', args: { path: 'note.txt', reason: '読みたい' } },
    { tool: 'request_secret_access', args: { path: '../.ssh/id_rsa', reason: '鍵が欲しい' } },
    { tool: 'request_secret_access', args: { path: '.env', reason: '読みたい' } },
    { tool: 'read_file', args: { path: '.env' } },
    { text: '終わり' },
  ]);
  let asked = 0;
  await withHome(s.home, () =>
    run(
      Session.create({
        provider,
        model: 'm',
        workspace: s.workspace,
        root: s.data,
        permissionMode: 'full',
        sandbox: settings(),
      }),
      '読んで',
      () => {
        asked += 1;
        return 'deny';
      },
    ),
  );
  assert.equal(asked, 1, '秘密の .env のときだけ聞く');
  const results = toolResults(provider);
  assert.match(results[0]!, /許可なしで読めます/);
  assert.match(results[1]!, /作業フォルダの外/);
  assert.match(results[2]!, /拒否/);
  assert.ok(!results[3]!.includes('本物'));
});

test('秘密のファイルが無ければ、request_secret_access は渡さない', async () => {
  const s = await setup({ 'a.txt': 'x\n' });
  const provider = fakeProvider([{ text: 'はい' }]);
  await withHome(s.home, () =>
    run(
      Session.create({
        provider,
        model: 'm',
        workspace: s.workspace,
        root: s.data,
        sandbox: settings(),
      }),
      'やあ',
    ),
  );
  assert.ok(!provider.calls[0]!.tools?.some((t) => t.name === 'request_secret_access'));
});

test('allowWorkspaceSecrets なら、許可なしで .env を読める', async () => {
  const s = await setup({ '.env': 'API_KEY=本物\n' });
  const provider = fakeProvider([
    { tool: 'read_file', args: { path: '.env' } },
    ...(active ? [cmd('cat .env')] : []),
    { text: '終わり' },
  ]);
  await withHome(s.home, () =>
    run(
      Session.create({
        provider,
        model: 'm',
        workspace: s.workspace,
        root: s.data,
        permissionMode: 'full',
        sandbox: settings({ allowWorkspaceSecrets: true }),
      }),
      '読んで',
    ),
  );
  for (const r of toolResults(provider)) assert.match(r, /本物/);
});

// ---------------- macOS の規則（この環境では動かせないので、組み立てだけ確かめる） ----------------

test('Seatbelt の規則: 書き込みを全部塞いでから作業フォルダを開け、秘密を塞いでから許されたものを開ける', async () => {
  const s = await setup({ '.env': 'x' });
  const gitDir = path.join(s.base, 'repo.git');
  await fs.mkdir(gitDir);
  const profile = await withHome(s.home, () =>
    seatbeltProfile({
      workspace: s.root,
      akariRoot: s.data,
      settings: settings({ network: false }),
      grantedSecrets: [path.join(s.root, '.env')],
      extraWrite: [gitDir],
    }),
  );
  const lines = profile.split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.equal(lines[0], '(version 1)');
  assert.ok(
    at(/^\(deny file-write\*\)$/) < at(/^\(allow file-write\* .*subpath ".*proj"/),
    '後から開ける',
  );
  assert.ok(profile.includes(`(subpath "${gitDir}")`), 'worktree の元の .git');
  assert.match(profile, new RegExp(`\\(deny file-read\\* .*\\(subpath "${s.home}/\\.ssh"\\)`));
  assert.match(profile, new RegExp(`\\(subpath "${s.data}"\\)`), 'Akari のデータを塞ぐ');
  const secretRule = at(/deny file-read\* \(regex/);
  const grant = at(/allow file-read\* \(literal ".*\.env"\)/);
  assert.ok(secretRule !== -1 && grant > secretRule, '許可は秘密の規則より後');
  assert.ok(profile.includes('(deny network-outbound (remote ip "*:*"))'));
});

test('bubblewrap: 書いてよい場所の中にある秘密の場所は、重ねた後でもう一度隠す', async () => {
  // ホームごと書けるようにした設定でも、~/.ssh は見せない
  const s = await setup();
  const args = await withHome(s.home, () =>
    bubblewrapArgs(
      {
        workspace: s.root,
        akariRoot: s.data,
        settings: settings({ allowWrite: ['~'] }),
        grantedSecrets: [],
        extraWrite: [],
      },
      s.root,
    ),
  );
  const ssh = path.join(s.home, '.ssh');
  const bindHome = args.findIndex((a, i) => a === '--bind' && args[i + 1] === s.home);
  const lastHide = args.lastIndexOf(ssh);
  assert.ok(bindHome !== -1, 'ホームを書けるように重ねている');
  assert.ok(lastHide > bindHome && args[lastHide - 1] === '--tmpfs', '重ねた後で隠し直す');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace, Session, ChangeJournal, type RunEvent } from '../dist/index.js';
import { fakeProvider, type Scripted } from './fake-provider.ts';

/**
 * 実行ループと取り消しの確認。仕様: docs/spec/05-agent.md
 */

async function setup(files: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-agent-')));
  const root = path.join(base, 'work');
  const home = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(root, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  const workspace = await Workspace.open(root, home);
  return { base, root, home, workspace };
}

type RunOutcome = { events: RunEvent[]; end: Extract<RunEvent, { type: 'run-end' }> };

/** 承認は autoApprove の指示に従って自動で返す。 */
async function run(
  session: Session,
  input: string,
  autoApprove: (
    ev: Extract<RunEvent, { type: 'approval-request' }>,
  ) => Parameters<Session['approve']>[1] | null = () => ({ kind: 'allow' }),
): Promise<RunOutcome> {
  const events: RunEvent[] = [];
  for await (const ev of session.send(input)) {
    events.push(ev);
    if (ev.type === 'approval-request') {
      const decision = autoApprove(ev);
      if (decision) session.approve(ev.callId, decision);
    }
  }
  const end = events.find((e) => e.type === 'run-end') as Extract<RunEvent, { type: 'run-end' }>;
  return { events, end };
}

const script = (...steps: Scripted[]) => fakeProvider(steps);

test('ツールを使って完了し、run-end が done になる', async () => {
  const { workspace, home, root } = await setup();
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'hello.txt', content: 'こんにちは\n' } },
      { text: '書きました。' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  const { events, end } = await run(session, 'hello.txt に挨拶を書いて');
  assert.equal(end.reason, 'done');
  assert.deepEqual(end.changedFiles, ['hello.txt']);
  assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'こんにちは\n');
  assert.ok(events.some((e) => e.type === 'run-start'));
  assert.ok(events.some((e) => e.type === 'tool-result' && e.ok));
});

test('ask モードでは書き込み前に承認を求め、拒否すると書かれない', async () => {
  const { workspace, home, root } = await setup();
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'x.txt', content: 'だめ\n' } },
      { text: '拒否されました。' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'ask',
  });
  const { events, end } = await run(session, 'x.txt を作って', () => ({
    kind: 'deny',
    feedback: 'いらない',
  }));
  assert.ok(events.some((e) => e.type === 'approval-request'));
  assert.equal(end.reason, 'done');
  assert.deepEqual(end.changedFiles, []);
  await assert.rejects(() => fs.stat(path.join(root, 'x.txt')), '拒否したファイルは作られないこと');
});

test('承認で中止すると run-end が aborted になる', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script({ tool: 'write_file', args: { path: 'x.txt', content: 'a' } }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'ask',
  });
  const { end } = await run(session, '作って', () => ({ kind: 'abort' }));
  assert.equal(end.reason, 'aborted');
});

test('読み取りだけなら承認を求めない', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'ある\n' });
  const session = Session.create({
    provider: script({ tool: 'read_file', args: { path: 'a.txt' } }, { text: '読みました。' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'ask',
  });
  const { events, end } = await run(session, '読んで');
  assert.equal(
    events.some((e) => e.type === 'approval-request'),
    false,
  );
  assert.equal(end.reason, 'done');
});

test('autoEdit では書き込みは自動、コマンドは承認が要る', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'a.txt', content: 'x' } },
      { tool: 'run_command', args: { command: 'echo hi' } },
      { text: '終わり' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'autoEdit',
  });
  const requests: string[] = [];
  await run(session, 'やって', (ev) => {
    requests.push(ev.name);
    return { kind: 'allow' };
  });
  assert.deepEqual(requests, ['run_command'], 'コマンドだけ承認が要る');
});

test('delete_file は full モードでも承認を求める', async () => {
  const { workspace, home } = await setup({ 'gone.txt': 'bye\n' });
  const session = Session.create({
    provider: script({ tool: 'delete_file', args: { path: 'gone.txt' } }, { text: '消しました' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  const requests: string[] = [];
  await run(session, '消して', (ev) => {
    requests.push(ev.name);
    return { kind: 'allow' };
  });
  assert.deepEqual(requests, ['delete_file']);
});

test('allow-session は同じ範囲を自動化し、違う範囲は再度聞く', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script(
      { tool: 'run_command', args: { command: 'npm test' } },
      { tool: 'run_command', args: { command: 'npm test -- --watch=false' } },
      { tool: 'run_command', args: { command: 'npm publish' } },
      { text: '終わり' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'ask',
  });
  const asked: string[] = [];
  await run(session, 'やって', (ev) => {
    asked.push(ev.prompt);
    const scoped = ev.options.find((o) => o.decision.kind === 'allow-session');
    return scoped ? scoped.decision : { kind: 'allow' };
  });
  assert.equal(asked.length, 2, 'npm test の2回目は聞かれず、npm publish で再度聞く');
  assert.match(asked[1]!, /npm publish/);
});

test('作業フォルダの外への書き込みは、承認を出さずに拒否する', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: '../escape.txt', content: 'x' } },
      { text: '無理でした' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'ask',
  });
  const { events, end } = await run(session, '外に書いて');
  assert.equal(
    events.some((e) => e.type === 'approval-request'),
    false,
    '承認画面すら出さない',
  );
  const result = events.find((e) => e.type === 'tool-result') as Extract<
    RunEvent,
    { type: 'tool-result' }
  >;
  assert.equal(result.ok, false);
  assert.deepEqual(end.changedFiles, []);
});

test('拒否リストのコマンドは full でも承認を出さずに拒否する', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script(
      { tool: 'run_command', args: { command: 'rm -rf / --no-preserve-root' } },
      { text: 'だめでした' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    limits: { deniedCommands: ['rm -rf /'] },
  });
  const { events } = await run(session, '消して');
  assert.equal(
    events.some((e) => e.type === 'approval-request'),
    false,
  );
  const result = events.find((e) => e.type === 'tool-result') as Extract<
    RunEvent,
    { type: 'tool-result' }
  >;
  assert.equal(result.ok, false);
  assert.match(result.summary, /拒否リスト/);
});

test('同じ呼び出しが3回続くとループとみなして停止する', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'x\n' });
  const same = { tool: 'read_file', args: { path: 'a.txt' } } as const;
  const session = Session.create({
    provider: script(same, same, same, same, same, { text: '終わり' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    maxSteps: 10,
  });
  const { end } = await run(session, '読んで');
  assert.equal(end.reason, 'loop');
});

test('ステップ上限に達したら max-steps で終わる', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
  const session = Session.create({
    provider: script(
      { tool: 'read_file', args: { path: 'a.txt' } },
      { tool: 'read_file', args: { path: 'b.txt' } },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    maxSteps: 2,
  });
  const { end } = await run(session, '読んで');
  assert.equal(end.reason, 'max-steps');
});

test('接続先のエラーは run-end に error として残る', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script({ error: 'unreachable' }),
    model: 'fake-model',
    workspace,
    root: home,
  });
  const { end } = await run(session, 'やって');
  assert.equal(end.reason, 'error');
  assert.ok(end.error);
});

test('知らないツールを呼ばれたら、使えるツール名を返して続行する', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script({ tool: 'launch_missiles', args: {} }, { text: 'すみません' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  const { events, end } = await run(session, 'やって');
  const result = events.find((e) => e.type === 'tool-result') as Extract<
    RunEvent,
    { type: 'tool-result' }
  >;
  assert.equal(result.ok, false);
  assert.match(result.summary, /そのツールはありません/);
  assert.equal(end.reason, 'done');
});

test('引数がJSONとして壊れていても落ちない', async () => {
  const { workspace, home } = await setup();
  const provider = script({ text: 'x' });
  const broken = {
    ...provider,
    async *chat(req: never) {
      yield { type: 'start' as const, model: 'fake-model' };
      yield { type: 'tool-call' as const, id: 'c1', name: 'read_file', argumentsRaw: '{ こわれ' };
      yield { type: 'finish' as const, reason: 'tool_calls' as const };
      void req;
    },
  };
  const session = Session.create({
    provider: broken as never,
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    maxSteps: 1,
  });
  const { events } = await run(session, 'やって');
  const result = events.find((e) => e.type === 'tool-result') as Extract<
    RunEvent,
    { type: 'tool-result' }
  >;
  assert.equal(result.ok, false);
  assert.match(result.summary, /JSONとして読めません/);
});

// ---------------- 取り消し ----------------

test('undo は作られたファイルを消し、変更を戻す', async () => {
  const { workspace, home, root } = await setup({ 'existing.txt': '元の中身\n' });
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'created.txt', content: '新規\n' } },
      {
        tool: 'edit_file',
        args: { path: 'existing.txt', oldText: '元の中身', newText: '書き換え後' },
      },
      { text: '終わり' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, 'やって');
  assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), '書き換え後\n');

  const undo = await session.undo();
  assert.deepEqual(undo.skipped, []);
  assert.equal(undo.restored.length, 2);
  assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), '元の中身\n');
  await assert.rejects(() => fs.stat(path.join(root, 'created.txt')), '作られたファイルは消える');
});

test('undo は削除したファイルを戻す', async () => {
  const { workspace, home, root } = await setup({ 'gone.txt': 'たいせつ\n' });
  const session = Session.create({
    provider: script({ tool: 'delete_file', args: { path: 'gone.txt' } }, { text: '消しました' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, '消して', () => ({ kind: 'allow' }));
  await assert.rejects(() => fs.stat(path.join(root, 'gone.txt')));
  const undo = await session.undo();
  assert.deepEqual(undo.restored, ['gone.txt']);
  assert.equal(await fs.readFile(path.join(root, 'gone.txt'), 'utf8'), 'たいせつ\n');
});

test('実行後に手で変更したファイルは、上書きせず飛ばして報告する', async () => {
  const { workspace, home, root } = await setup({ 'a.txt': '元\n' });
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'a.txt', content: 'エージェント\n' } },
      { text: '完了' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, '書いて');
  await fs.writeFile(path.join(root, 'a.txt'), '人が手で直した\n');

  const undo = await session.undo();
  assert.deepEqual(undo.restored, []);
  assert.equal(undo.skipped.length, 1);
  assert.match(undo.skipped[0]!.reason, /手で変更/);
  assert.equal(
    await fs.readFile(path.join(root, 'a.txt'), 'utf8'),
    '人が手で直した\n',
    '上書きしないこと',
  );
});

test('同じファイルを複数回変えても、最初の状態まで戻る', async () => {
  const { workspace, home, root } = await setup({ 'a.txt': 'v1\n' });
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'a.txt', content: 'v2\n' } },
      { tool: 'write_file', args: { path: 'a.txt', content: 'v3\n' } },
      { text: '完了' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, 'やって');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'v3\n');
  const undo = await session.undo();
  assert.deepEqual(undo.restored, ['a.txt']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'v1\n');
});

test('別プロセスからでも記録を読み込んで取り消せる', async () => {
  const { workspace, home, root } = await setup({ 'a.txt': '元\n' });
  const session = Session.create({
    provider: script(
      { tool: 'write_file', args: { path: 'a.txt', content: '新\n' } },
      { text: '完了' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, '書いて');

  const loaded = await ChangeJournal.load(session.runId, home);
  assert.ok(loaded);
  const undo = await loaded!.undo();
  assert.deepEqual(undo.restored, ['a.txt']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '元\n');
});

test('実行の一覧が新しい順に取れる', async () => {
  const { workspace, home } = await setup();
  for (let i = 0; i < 2; i++) {
    const s = Session.create({
      provider: script({ text: 'ok' }),
      model: 'fake-model',
      workspace,
      root: home,
    });
    await run(s, 'なにか');
  }
  const runs = await ChangeJournal.listRuns(home);
  assert.equal(runs.length, 2);
  assert.ok(runs[0]! > runs[1]!, '新しい順');
});

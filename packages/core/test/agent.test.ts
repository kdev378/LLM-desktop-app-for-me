import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  Workspace,
  Session,
  ChangeJournal,
  ConversationStore,
  toApiMessages,
  toTranscript,
  type RunEvent,
  type ChatMessage,
  type ConversationRecorder,
} from '../dist/index.js';
import { assertValidForApi } from './api-shape.ts';
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

// ---------------- 削除と、断られた後の迂回 ----------------

/**
 * 実際に OpenRouter の実モデルで、delete_file を断られたモデルが直後に
 * run_command で rm を実行し、full だったため通ってファイルが消えた。
 * コマンドで消したものは undo で戻せない。
 * 仕様: docs/spec/05-agent.md「削除系のコマンド」「断られた後の迂回」
 */

const denyAll = () => ({ kind: 'deny' as const });

test('full でも、削除系のコマンドは承認を求める。断ればファイルは残る', async () => {
  const { workspace, home, root } = await setup({ 'README.md': '# 残る\n' });
  const session = Session.create({
    provider: script(
      { tool: 'run_command', args: { command: 'rm README.md' } },
      { text: '消せませんでした。' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  const { events } = await run(session, 'README を消して', denyAll);
  const req = events.find((e) => e.type === 'approval-request') as Extract<
    RunEvent,
    { type: 'approval-request' }
  >;
  assert.ok(req, 'full でも聞く');
  assert.match(req.prompt, /削除するコマンド（rm）/, 'なぜ聞くのかを言う');
  assert.ok(
    !req.options.some((o) => o.decision.kind === 'allow-session'),
    '削除は「この実行中は許可」にしない',
  );
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# 残る\n');
});

test('delete_file を断られた後に rm へ切り替えても、消せない（報告された経路）', async () => {
  const { workspace, home, root } = await setup({ 'README.md': '# 残る\n' });
  const session = Session.create({
    provider: script(
      { tool: 'delete_file', args: { path: 'README.md' } },
      { tool: 'run_command', args: { command: 'rm README.md' } },
      { text: 'だめでした。' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, 'README を消して', denyAll);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# 残る\n');
});

test('一度断った後は、削除でないコマンドも自動で通さない', async () => {
  // 名前で見抜けない書き方（python -c など）で消されるのを、断った後は止める
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const session = Session.create({
    provider: script(
      { tool: 'delete_file', args: { path: 'a.txt' } },
      { tool: 'run_command', args: { command: 'echo ok' } },
      { text: '終わり' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  const { events } = await run(session, 'やって', denyAll);
  const requests = events.filter((e) => e.type === 'approval-request') as Array<
    Extract<RunEvent, { type: 'approval-request' }>
  >;
  assert.equal(requests.length, 2, 'delete_file と、その後の echo の両方で聞く');
  assert.match(requests[1]!.prompt, /一度断られた操作があったため/);
  assert.ok(
    events.some((e) => e.type === 'notice' && /自動で実行しません/.test(e.message)),
    '切り替わったことを知らせる',
  );
});

test('断ったときにモデルへ「別の手段で行わない」と伝える', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const provider = script(
    { tool: 'delete_file', args: { path: 'a.txt' } },
    { text: 'わかりました' },
  );
  const session = Session.create({
    provider,
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, 'やって', denyAll);
  const toolMsg = provider.calls[1]!.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg!.content, /別の手段（コマンドなど）で行わないでください/);
  assert.doesNotMatch(toolMsg!.content, /別の方法を検討/, '迂回を促さない');
});

test('断られていなければ、full では普通のコマンドはそのまま通る', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: script({ tool: 'run_command', args: { command: 'echo ok' } }, { text: '終わり' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  const { events, end } = await run(session, 'やって', denyAll);
  assert.ok(!events.some((e) => e.type === 'approval-request'), 'full の意味は保つ');
  assert.equal(end.reason, 'done');
});

test('迂回の制限は、次の実行では元に戻る', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const session = Session.create({
    provider: script(
      { tool: 'delete_file', args: { path: 'a.txt' } },
      { text: 'だめでした' },
      { tool: 'run_command', args: { command: 'echo ok' } },
      { text: '終わり' },
    ),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(session, '1回目', denyAll);
  const second = await run(session, '2回目', denyAll);
  assert.ok(
    !second.events.some((e) => e.type === 'approval-request'),
    '前の実行で断ったことを持ち越さない',
  );
});

// ---------------- 会話の保存とのつなぎ ----------------

/**
 * 仕様: docs/spec/04-chat.md「送信の流れ」、docs/spec/05-agent.md
 * 実際に送ったメッセージを、送った時点の形で控えておく（Session は同じ配列を使い回すため）。
 */
function recordingSent<P extends { chat: (...a: never[]) => unknown }>(provider: P) {
  const sent: ChatMessage[][] = [];
  const orig = provider.chat.bind(provider) as (
    req: { messages: ChatMessage[] },
    s?: AbortSignal,
  ) => unknown;
  (provider as { chat: unknown }).chat = (
    req: { messages: ChatMessage[] },
    signal?: AbortSignal,
  ) => {
    sent.push(structuredClone(req.messages));
    return orig(req, signal);
  };
  return sent;
}

test('実行のやり取りが会話として保存され、実行の終わり方も残る', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const session = Session.create({
    provider: script({ tool: 'read_file', args: { path: 'a.txt' } }, { text: '読みました。' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    recorder: conv.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
    conversationId: conv.id,
  });
  const { events } = await run(session, 'a.txt を読んで');
  const start = events.find((e) => e.type === 'run-start') as Extract<
    RunEvent,
    { type: 'run-start' }
  >;
  assert.equal(start.conversationId, conv.id);

  const saved = await store.open(conv.id);
  const thread = saved.thread();
  assert.deepEqual(
    thread.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(thread[1]!.toolCalls?.[0]?.name, 'read_file');
  assert.equal(thread[2]!.ok, true);
  assert.ok(
    thread.every((m) => m.meta.runId === session.runId),
    'どの実行で作られたかが残る',
  );
  assert.equal(thread[1]!.meta.model, 'fake-model');
  assert.equal(saved.header.runs[0]!.reason, 'done', '成功した実行かどうかが分かる');
  assertValidForApi(toApiMessages(thread));
});

test('保存した会話から続きを始めると、前のやり取りがモデルへ渡る', async () => {
  const { workspace, home } = await setup();
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const first = Session.create({
    provider: script({ text: '合言葉は「さくら」です。' }),
    model: 'fake-model',
    workspace,
    root: home,
    recorder: conv.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
  });
  await run(first, '合言葉を決めて');

  const reopened = await store.open(conv.id);
  const provider = script({ text: 'さくらです。' });
  const sent = recordingSent(provider);
  const second = Session.create({
    provider,
    model: 'fake-model',
    workspace,
    root: home,
    transcript: toTranscript(reopened.thread()),
    recorder: reopened.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
  });
  await run(second, '合言葉は？');
  const contents = sent[0]!.map((m) => m.content).join('\n');
  assert.match(contents, /合言葉を決めて/);
  assert.match(contents, /さくら/);
  assert.equal(sent[0]![0]!.role, 'system', 'システムプロンプトは毎回作り直して先頭に置く');
  assert.equal(sent[0]!.filter((m) => m.role === 'system').length, 1);

  const final = await store.open(conv.id);
  assert.equal(final.thread().length, 4, '続きは同じ会話に足される');
  assert.equal(final.header.runs.length, 2);
});

test('1回に9個以上呼ばれても、次に送るメッセージは API が受け付ける並びになる', async () => {
  // 以前は上限を超えた分の代わりに利用者メッセージを挟んでいて、次のリクエストが 400 になる並びだった
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const nine = Array.from({ length: 9 }, (_, i) => ({
    tool: 'read_file',
    args: { path: 'a.txt', offset: i + 1 },
  }));
  const provider = script({ tools: nine }, { text: '終わり' });
  const sent = recordingSent(provider);
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const session = Session.create({
    provider,
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    recorder: conv.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
  });
  await run(session, 'たくさん読んで');
  assert.equal(sent.length, 2);
  assertValidForApi(sent[1]!);
  const results = sent[1]!.filter((m) => m.role === 'tool');
  assert.equal(results.length, 9, '9個全部に結果がある');
  assert.match(results[8]!.content, /上限（8件）を超えた/);
  assertValidForApi(toApiMessages((await store.open(conv.id)).thread()));
});

test('道具を呼んでいる途中で中断しても、続きを始められる並びが残る', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const session = Session.create({
    provider: script({
      tools: [
        { tool: 'write_file', args: { path: 'a.txt', content: 'b\n' } },
        { tool: 'write_file', args: { path: 'a.txt', content: 'c\n' } },
      ],
    }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'ask',
    recorder: conv.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
  });
  // 1つ目の承認で「実行を中止」を選ぶ
  const { end } = await run(session, '書いて', () => ({ kind: 'abort' }));
  assert.equal(end.reason, 'aborted');

  const saved = await store.open(conv.id);
  const thread = saved.thread();
  const tools = thread.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2, '実行されなかった呼び出しにも結果が付く');
  assert.ok(tools.every((m) => m.meta.synthetic === 'aborted'));
  assertValidForApi(toApiMessages(thread));
  assert.equal(saved.header.runs[0]!.reason, 'aborted');
});

test('生成に失敗した応答も、失敗として残る（送り返しはしない）', async () => {
  const { workspace, home } = await setup();
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const session = Session.create({
    provider: script({ error: 'unreachable' }),
    model: 'fake-model',
    workspace,
    root: home,
    recorder: conv.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
  });
  await run(session, 'やって');
  const thread = (await store.open(conv.id)).thread();
  assert.equal(thread.at(-1)!.role, 'assistant');
  assert.equal(thread.at(-1)!.meta.error?.kind, 'unreachable');
  assert.deepEqual(
    toApiMessages(thread).map((m) => m.role),
    ['user'],
  );
});

test('保存に失敗しても実行は続け、失敗したことを1回だけ知らせる', async () => {
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });
  const broken: ConversationRecorder = {
    runStarted: async () => {},
    runEnded: async () => {},
    inflight: async () => {},
    record: async () => {
      throw new Error('ディスクがいっぱいです');
    },
  };
  const session = Session.create({
    provider: script({ tool: 'read_file', args: { path: 'a.txt' } }, { text: '終わり' }),
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    recorder: broken,
  });
  const { events, end } = await run(session, 'やって');
  assert.equal(end.reason, 'done');
  const notices = events.filter(
    (e) => e.type === 'notice' && /会話の保存に失敗しました/.test(e.message),
  );
  assert.equal(notices.length, 1);
});

test('その場で続けても、保存した会話から続けても、モデルへ送る内容は同じ', async () => {
  // 途中で止まった応答・失敗・道具の結果・本文ブロックの指摘など、食い違いやすいものを混ぜる
  const steps = () => [
    { tool: 'read_file', args: { path: 'a.txt' } },
    { text: '読みました。' },
    { tool: 'list_dir', args: { path: '.' } },
    { text: '一覧も見ました。' },
  ];
  const { workspace, home } = await setup({ 'a.txt': 'a\n' });

  // その場で続ける（同じ Session に2回送る）
  const p1 = script(...(steps() as Scripted[]));
  const sentInline = recordingSent(p1);
  const inline = Session.create({
    provider: p1,
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
  });
  await run(inline, '1回目');
  await run(inline, '2回目');

  // 保存して、開き直して続ける
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const p2 = script(...(steps() as Scripted[]));
  const sentSaved = recordingSent(p2);
  const first = Session.create({
    provider: p2,
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    recorder: conv.recorder({ model: 'fake-model', endpointId: 'ep_fake' }),
  });
  await run(first, '1回目');
  const reopened = await store.open(conv.id);
  const second = Session.create({
    provider: p2,
    model: 'fake-model',
    workspace,
    root: home,
    permissionMode: 'full',
    transcript: toTranscript(reopened.thread()),
  });
  await run(second, '2回目');

  // 道具の呼び出しIDは実行ごとに違うので、比べる前にそろえる
  const normalize = (msgs: ChatMessage[]) =>
    JSON.stringify(msgs.slice(1)).replace(/call_[0-9a-z_]+/g, 'CALL');
  assert.equal(sentInline.length, sentSaved.length);
  for (let i = 0; i < sentInline.length; i++) {
    assert.equal(
      normalize(sentSaved[i]!),
      normalize(sentInline[i]!),
      `${i}回目の呼び出しで食い違う`,
    );
  }
});

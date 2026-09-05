import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  Workspace,
  Session,
  extractPromptedCalls,
  formatPromptedResult,
  buildSystemPrompt,
  BUILTIN_TOOLS,
  type RunEvent,
  type ChatEvent,
  type ChatRequest,
  type Provider,
} from '../dist/index.js';

/**
 * ツール呼び出しに対応していないモデル向けの代替方式（prompted）。
 * Gemma 系のようにツール用テンプレートを持たないモデルでは、こちらが主経路になる。
 * 仕様: docs/spec/02-provider.md「ツール非対応サーバ向けの代替」
 */

const fence = (body: string) => '```akari-tool\n' + body + '\n```';

// ---------------- ブロックの取り出し ----------------

test('ブロックからツール呼び出しを取り出す', () => {
  const r = extractPromptedCalls(
    `まず読みます。\n${fence('{"name":"read_file","arguments":{"path":"a.ts"}}')}`,
  );
  assert.equal(r.errors.length, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'read_file');
  assert.deepEqual(JSON.parse(r.calls[0]!.argumentsRaw), { path: 'a.ts' });
});

test('複数のブロックを上から順に取り出す', () => {
  const r = extractPromptedCalls(
    fence('{"name":"read_file","arguments":{"path":"a.ts"}}') +
      '\n次に\n' +
      fence('{"name":"glob","arguments":{"pattern":"**/*.ts"}}'),
  );
  assert.deepEqual(
    r.calls.map((c) => c.name),
    ['read_file', 'glob'],
  );
});

test('JSONとして読めないブロックは実行せず、エラーとして返す', () => {
  const r = extractPromptedCalls(fence('{name: read_file}'));
  assert.equal(r.calls.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /JSONとして読めません/);
});

test('name が無いブロックは受け付けない', () => {
  const r = extractPromptedCalls(fence('{"arguments":{"path":"a.ts"}}'));
  assert.equal(r.calls.length, 0);
  assert.match(r.errors[0]!, /name がありません/);
});

test('arguments が無ければ空オブジェクトとして扱う', () => {
  const r = extractPromptedCalls(fence('{"name":"list_dir"}'));
  assert.equal(r.calls.length, 1);
  assert.deepEqual(JSON.parse(r.calls[0]!.argumentsRaw), {});
});

test('似ているだけの別のフェンスは拾わない（推測で補正しない）', () => {
  const text = '```json\n{"name":"delete_file","arguments":{"path":"a.ts"}}\n```';
  const r = extractPromptedCalls(text);
  assert.equal(r.calls.length, 0, 'akari-tool 以外のフェンスは実行しない');
  assert.equal(r.errors.length, 0);
});

test('普通の文章だけならツール呼び出しは無い', () => {
  const r = extractPromptedCalls('こんにちは。特に道具は要りません。');
  assert.equal(r.calls.length, 0);
  assert.equal(r.errors.length, 0);
});

test('ツール結果の形式にツール名と成否が入る', () => {
  const s = formatPromptedResult('read_file', true, '中身');
  assert.match(s, /\[akari-tool-result\]/);
  assert.match(s, /"name":"read_file"/);
  assert.match(s, /"ok":true/);
});

// ---------------- システムプロンプト ----------------

test('代替方式のときだけ、ブロックの書き方をシステムプロンプトに入れる', () => {
  const base = {
    workspaceRoot: '/tmp/x',
    tools: BUILTIN_TOOLS,
    instructions: [],
  };
  const withPrompted = buildSystemPrompt({ ...base, promptedTools: true });
  const withNative = buildSystemPrompt({ ...base, promptedTools: false });
  assert.match(withPrompted, /akari-tool/);
  assert.match(withPrompted, /read_file/);
  assert.ok(!withNative.includes('akari-tool'), 'ネイティブ対応時は代替方式の説明を入れない');
});

// ---------------- 実行ループ ----------------

/** 台本の文字列をそのまま本文として返す Provider。ツール定義は受け取らない前提。 */
function textProvider(script: string[]): Provider & { requests: ChatRequest[] } {
  let turn = 0;
  const requests: ChatRequest[] = [];
  return {
    endpointId: 'ep_prompted',
    requests,
    async listModels() {
      return [{ id: 'gemma-like' }];
    },
    async probe() {
      return {
        reachable: true,
        models: [{ id: 'gemma-like' }],
        tools: 'prompted' as const,
        usageReported: false,
        streamsToolCalls: false,
        testedModel: 'gemma-like',
        notes: [],
      };
    },
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
      requests.push(req);
      const text = script[turn++] ?? '終わりです。';
      yield { type: 'start', model: req.model };
      yield { type: 'text-delta', text };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

async function setup(files: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-prompted-')));
  const root = path.join(base, 'work');
  const home = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), content);
  }
  return { root, home, workspace: await Workspace.open(root, home) };
}

async function run(session: Session, input: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of session.send(input)) {
    events.push(ev);
    if (ev.type === 'approval-request') session.approve(ev.callId, { kind: 'allow' });
  }
  return events;
}

test('代替方式でもツールが実行され、ファイルが変わる', async () => {
  const { workspace, home, root } = await setup({ 'a.txt': '元\n' });
  const provider = textProvider([
    `直します。\n${fence('{"name":"write_file","arguments":{"path":"a.txt","content":"新\\n"}}')}`,
    '書き換えました。',
  ]);
  const session = Session.create({
    provider,
    model: 'gemma-like',
    workspace,
    root: home,
    permissionMode: 'full',
    promptedTools: true,
  });
  const events = await run(session, '書き換えて');
  const end = events.find((e) => e.type === 'run-end') as Extract<RunEvent, { type: 'run-end' }>;
  assert.equal(end.reason, 'done');
  assert.deepEqual(end.changedFiles, ['a.txt']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '新\n');
});

test('代替方式ではツール定義をリクエストに載せない', async () => {
  const { workspace, home } = await setup();
  const provider = textProvider(['道具は要りません。']);
  const session = Session.create({
    provider,
    model: 'gemma-like',
    workspace,
    root: home,
    promptedTools: true,
  });
  await run(session, 'こんにちは');
  assert.equal(provider.requests[0]!.tools, undefined, 'tools を送らない');
  assert.match(
    provider.requests[0]!.messages[0]!.content,
    /akari-tool/,
    '代わりにシステムプロンプトへ書く',
  );
});

test('代替方式であることを実行開始時に知らせる（動いているふりをしない）', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: textProvider(['はい。']),
    model: 'gemma-like',
    workspace,
    root: home,
    promptedTools: true,
  });
  const events = await run(session, 'やって');
  const start = events.find((e) => e.type === 'run-start') as Extract<
    RunEvent,
    { type: 'run-start' }
  >;
  assert.equal(start.promptedTools, true);
  assert.ok(
    events.some((e) => e.type === 'notice' && /代替方式/.test(e.message)),
    '代替方式で動いていることを通知する',
  );
});

test('壊れたブロックはやり直させ、次の応答で実行できる', async () => {
  const { workspace, home, root } = await setup();
  const provider = textProvider([
    fence('{"name": read_file}'), // 壊れている
    fence('{"name":"write_file","arguments":{"path":"b.txt","content":"直った\\n"}}'),
    '書きました。',
  ]);
  const session = Session.create({
    provider,
    model: 'gemma-like',
    workspace,
    root: home,
    permissionMode: 'full',
    promptedTools: true,
  });
  const events = await run(session, 'やって');
  assert.ok(events.some((e) => e.type === 'notice' && /JSONとして読めません/.test(e.message)));
  assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), '直った\n');
  // やり直しを促すメッセージがモデルへ渡っていること
  const feedback = provider.requests[1]!.messages.map((m) => m.content).join('\n');
  assert.match(feedback, /\[akari\]/);
});

test('4個以上のブロックは3個までを実行し、残りを黙って捨てない', async () => {
  const { workspace, home, root } = await setup();
  const blocks = ['w', 'x', 'y', 'z']
    .map((n) => fence(`{"name":"write_file","arguments":{"path":"${n}.txt","content":"${n}"}}`))
    .join('\n');
  const session = Session.create({
    provider: textProvider([blocks, '終わり']),
    model: 'gemma-like',
    workspace,
    root: home,
    permissionMode: 'full',
    promptedTools: true,
  });
  const events = await run(session, 'やって');
  assert.ok(
    events.some((e) => e.type === 'notice' && /上限 3 個/.test(e.message)),
    '実行しなかったものを知らせる',
  );
  for (const n of ['w', 'x', 'y']) {
    assert.equal(await fs.readFile(path.join(root, `${n}.txt`), 'utf8'), n);
  }
  await assert.rejects(() => fs.stat(path.join(root, 'z.txt')), '4個目は実行されない');
});

test('代替方式でも作業フォルダの外へは出られない', async () => {
  const { workspace, home } = await setup();
  const session = Session.create({
    provider: textProvider([
      fence('{"name":"write_file","arguments":{"path":"../escape.txt","content":"x"}}'),
      'だめでした',
    ]),
    model: 'gemma-like',
    workspace,
    root: home,
    permissionMode: 'full',
    promptedTools: true,
  });
  const events = await run(session, '外に書いて');
  const result = events.find((e) => e.type === 'tool-result') as Extract<
    RunEvent,
    { type: 'tool-result' }
  >;
  assert.equal(result.ok, false);
  assert.match(result.summary, /作業フォルダの外/);
});

test('代替方式でも承認は効く', async () => {
  const { workspace, home, root } = await setup({ 'a.txt': '元\n' });
  const session = Session.create({
    provider: textProvider([
      fence('{"name":"write_file","arguments":{"path":"a.txt","content":"新\\n"}}'),
      '拒否されました',
    ]),
    model: 'gemma-like',
    workspace,
    root: home,
    permissionMode: 'ask',
    promptedTools: true,
  });
  const events: RunEvent[] = [];
  for await (const ev of session.send('書いて')) {
    events.push(ev);
    if (ev.type === 'approval-request') session.approve(ev.callId, { kind: 'deny' });
  }
  assert.ok(events.some((e) => e.type === 'approval-request'));
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '元\n');
});

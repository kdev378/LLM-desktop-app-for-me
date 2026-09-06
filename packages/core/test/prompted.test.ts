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

// ---------------- モデルごとの判定の記憶 ----------------

test('一度判定したモデルは、次からは判定し直さない', async () => {
  let probeCount = 0;
  const provider = {
    endpointId: 'ep',
    async listModels() {
      return [{ id: 'a' }];
    },
    async probe() {
      probeCount += 1;
      return {
        reachable: true,
        models: [{ id: 'a' }],
        tools: 'prompted' as const,
        usageReported: false,
        streamsToolCalls: false,
        testedModel: 'a',
        notes: [],
      };
    },
    async *chat() {
      /* 使わない */
    },
  } as never;

  const { resolveToolsMode } = await import('../dist/index.js');

  const first = await resolveToolsMode(provider, { tools: 'auto', probedModel: null }, 'a');
  assert.equal(first.probed, true);
  assert.equal(first.mode, 'prompted');
  assert.equal(first.modelCapability?.model, 'a');

  const byModel = { a: first.modelCapability!.value };
  const second = await resolveToolsMode(
    provider,
    { tools: 'prompted', probedModel: 'a', byModel },
    'a',
  );
  assert.equal(second.probed, false, '同じモデルなら判定し直さない');
  assert.equal(second.mode, 'prompted');
  assert.equal(probeCount, 1);
});

test('別のモデルへ切り替えたら判定し直す。前のモデルの記録は残る', async () => {
  const modes: Record<string, 'native' | 'prompted'> = { small: 'prompted', big: 'native' };
  const provider = {
    endpointId: 'ep',
    async listModels() {
      return [{ id: 'small' }, { id: 'big' }];
    },
    async probe(model?: string) {
      return {
        reachable: true,
        models: [],
        tools: modes[model ?? 'small']!,
        usageReported: false,
        streamsToolCalls: false,
        testedModel: model ?? 'small',
        notes: [],
      };
    },
    async *chat() {
      /* 使わない */
    },
  } as never;

  const { resolveToolsMode } = await import('../dist/index.js');

  const a = await resolveToolsMode(provider, { tools: 'auto', probedModel: null }, 'small');
  assert.equal(a.mode, 'prompted');
  const byModel: Record<string, { tools: 'native' | 'prompted' | 'none' }> = {
    small: a.modelCapability!.value,
  };

  const b = await resolveToolsMode(
    provider,
    { tools: 'prompted', probedModel: 'small', byModel },
    'big',
  );
  assert.equal(b.probed, true, '別モデルなら判定し直す');
  assert.equal(b.mode, 'native');
  byModel.big = b.modelCapability!.value;

  // 元のモデルへ戻しても、判定し直さない
  const c = await resolveToolsMode(
    provider,
    { tools: 'native', probedModel: 'big', byModel },
    'small',
  );
  assert.equal(c.probed, false);
  assert.equal(c.mode, 'prompted');
});

test('判定できない接続先では none を返し、実行させない', async () => {
  const provider = {
    endpointId: 'ep',
    async listModels(): Promise<never> {
      throw new Error('繋がりません');
    },
    async probe() {
      return {
        reachable: false,
        models: [],
        tools: 'none' as const,
        usageReported: false,
        streamsToolCalls: false,
        testedModel: null,
        notes: [],
      };
    },
    async *chat() {
      /* 使わない */
    },
  } as never;
  const { resolveToolsMode } = await import('../dist/index.js');
  const r = await resolveToolsMode(provider, { tools: 'auto', probedModel: null }, 'x');
  assert.equal(r.mode, 'none');
  assert.equal(r.capabilities, undefined, '判定できなかった結果を保存しない');
});

// ---------------- モデルの自動選択 ----------------

test('埋め込み専用のモデルをチャット用と見なさない', async () => {
  const { isLikelyChatModel } = await import('../dist/index.js');
  for (const id of [
    'nomic-embed-text-v1.5',
    'text-embedding-3-small',
    'bge-m3',
    'jina-reranker-v2',
    'whisper-large-v3',
    'kokoro-tts',
  ]) {
    assert.equal(isLikelyChatModel(id), false, `${id} はチャット用ではない`);
  }
  for (const id of ['qwen3.5-agents-a1-4b', 'gemma3n:e4b', 'llama3.1:8b', 'mock-coder-14b']) {
    assert.equal(isLikelyChatModel(id), true, `${id} はチャット用`);
  }
});

test('モデル未指定のとき、埋め込みモデルを飛ばして会話用を選ぶ', async () => {
  const { pickChatModel } = await import('../dist/index.js');
  // LM Studio のように埋め込みモデルが先頭に来る一覧
  assert.equal(
    pickChatModel([{ id: 'nomic-embed-text-v1.5' }, { id: 'qwen3.5-agents-a1-4b' }])?.id,
    'qwen3.5-agents-a1-4b',
  );
  // 会話用が無ければ、無理に除外せず先頭を返す（何も選ばないより良い）
  assert.equal(pickChatModel([{ id: 'nomic-embed-text-v1.5' }])?.id, 'nomic-embed-text-v1.5');
  assert.equal(pickChatModel([]), null);
});

test('判定の記録に、どのモデルを使ったかが必ず入る', async () => {
  const provider = {
    endpointId: 'ep',
    async listModels() {
      return [{ id: 'embed-only' }, { id: 'chat-model' }];
    },
    async probe(model?: string) {
      // 実装と同じ選び方をここでは真似しない。probeEndpoint の責務を直接見る
      return {
        reachable: true,
        models: [],
        tools: 'native' as const,
        contextTokens: null,
        usageReported: false,
        streamsToolCalls: true,
        testedModel: model ?? 'chat-model',
        notes: [],
      };
    },
    async *chat() {
      /* 使わない */
    },
  } as never;
  const { probeEndpoint } = await import('../dist/index.js');
  const r = await probeEndpoint(provider, 'ep');
  assert.equal(r.testedModel, 'chat-model', '埋め込みモデルを選ばない');
  assert.ok(
    r.notes.some((n) => n.includes('判定に使ったモデル')),
    'どのモデルで判定したかを必ず出す',
  );
});

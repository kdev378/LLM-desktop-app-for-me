import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, getProviderError } from '../dist/index.js';
import { startFakeServer } from './fake-server.ts';

function endpoint(url: string, over: Record<string, unknown> = {}) {
  return {
    id: 'ep_test',
    name: 'テスト',
    baseUrl: url,
    apiKeyRef: null,
    defaultModel: 'test-model',
    headers: {},
    timeoutMs: 5000,
    externalConsent: false,
    apiKey: null,
    isExternal: false,
    capabilities: {
      tools: 'auto',
      vision: 'auto',
      usageReported: false,
      streamsToolCalls: false,
      probedAt: null,
      probedModel: null,
    },
    ...over,
  } as never;
}

async function collect(gen: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out as Array<Record<string, unknown>>;
}

const req = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hi' }] };

test('モデル一覧を取得できる', async () => {
  const s = await startFakeServer();
  s.setModels(['zeta', 'alpha']);
  const models = await createProvider(endpoint(s.url)).listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].ownedBy, 'fake');
  await s.close();
});

test('本文をトークン単位で流し、finish で終わる', async () => {
  const s = await startFakeServer({ kind: 'text', chunks: ['こん', 'にちは'], usage: true });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  assert.equal(events[0].type, 'start');
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['こん', 'にちは'],
  );
  const finish = events.at(-1)!;
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason, 'stop');
  assert.deepEqual(finish.usage, { prompt: 11, completion: 22, total: 33 });
  await s.close();
});

test('ツール呼び出しの断片を連結して1回で出す', async () => {
  const s = await startFakeServer({
    kind: 'toolCall',
    name: 'read_file',
    argChunks: ['{"path"', ':"a.ts"}'],
  });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  const calls = events.filter((e) => e.type === 'tool-call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].argumentsRaw, '{"path":"a.ts"}');
  assert.equal(events.at(-1)!.reason, 'tool_calls');
  await s.close();
});

test('stream_options を拒否されたら1度だけ外して再送する', async () => {
  const s = await startFakeServer({
    kind: 'rejectStreamOptions',
    then: { kind: 'text', chunks: ['ok'] },
  });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['ok'],
  );
  const chatReqs = s.requests.filter((r) => r.path.endsWith('/chat/completions'));
  assert.equal(chatReqs.length, 2);
  assert.ok((chatReqs[0].body as Record<string, unknown>).stream_options);
  assert.equal((chatReqs[1].body as Record<string, unknown>).stream_options, undefined);
  await s.close();
});

test('401 は unauthorized として分類する', async () => {
  const s = await startFakeServer({
    kind: 'status',
    status: 401,
    body: '{"error":{"message":"bad key"}}',
  });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  const err = events.at(-1)!;
  assert.equal(err.type, 'error');
  assert.equal((err.error as Record<string, unknown>).kind, 'unauthorized');
  await s.close();
});

test('SSEでない200応答は incompatible として分類する', async () => {
  const s = await startFakeServer({ kind: 'notSse', body: '<html>nginx</html>' });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  const err = events.at(-1)!;
  assert.equal(err.type, 'error');
  assert.equal((err.error as Record<string, unknown>).kind, 'incompatible');
  await s.close();
});

test('stream:true を無視して一括JSONを返すサーバでも本文を取り出す', async () => {
  const s = await startFakeServer({ kind: 'jsonCompletion', content: 'まとめて返した' });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['まとめて返した'],
  );
  assert.equal(events.at(-1)!.reason, 'stop');
  await s.close();
});

test('トークンを受け取った後に切断されたら、再試行せず受信済みを残す', async () => {
  const s = await startFakeServer({ kind: 'cutOff', chunks: ['途中', 'まで'] });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['途中', 'まで'],
  );
  // 再送していない = リクエストは1回だけ
  assert.equal(s.requests.filter((r) => r.path.endsWith('/chat/completions')).length, 1);
  await s.close();
});

test('到達できない接続先は unreachable になる', async () => {
  const events = await collect(createProvider(endpoint('http://127.0.0.1:1/v1')).chat(req));
  const err = events.at(-1)!;
  assert.equal(err.type, 'error');
  assert.equal((err.error as Record<string, unknown>).kind, 'unreachable');
});

test('中断すると aborted になり、以降のイベントが出ない', async () => {
  const s = await startFakeServer({ kind: 'hang' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const events = await collect(createProvider(endpoint(s.url)).chat(req, ac.signal));
  const last = events.at(-1)!;
  assert.equal(last.type, 'error');
  assert.equal((last.error as Record<string, unknown>).kind, 'aborted');
  await s.close();
});

test('Authorization ヘッダに鍵が載る', async () => {
  const s = await startFakeServer();
  await createProvider(endpoint(s.url, { apiKey: 'sk-testkey1234567890' })).listModels();
  assert.equal(s.requests[0].headers.authorization, 'Bearer sk-testkey1234567890');
  await s.close();
});

test('listModels の失敗は ProviderError を持った例外になる', async () => {
  try {
    await createProvider(endpoint('http://127.0.0.1:1/v1')).listModels();
    assert.fail('例外になるはず');
  } catch (err) {
    assert.equal(getProviderError(err)?.kind, 'unreachable');
  }
});

test('本文に混ざった <think> は思考として分けて流す', async () => {
  const s = await startFakeServer({
    kind: 'text',
    chunks: ['<thi', 'nk>ここは', '思考</th', 'ink>答えは', '2です。'],
  });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  const text = events
    .filter((e) => e.type === 'text-delta')
    .map((e) => e.text)
    .join('');
  const reasoning = events
    .filter((e) => e.type === 'reasoning-delta')
    .map((e) => e.text)
    .join('');
  assert.equal(text, '答えは2です。');
  assert.equal(reasoning, 'ここは思考');
  await s.close();
});

test('思考タグが無い応答は、チャンクの区切りどおりに流れる', async () => {
  // 思考の切り出しのために出力を溜め込んでいないことの確認
  const s = await startFakeServer({ kind: 'text', chunks: ['一', '二', '三'] });
  const events = await collect(createProvider(endpoint(s.url)).chat(req));
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['一', '二', '三'],
  );
  await s.close();
});

test('モデル一覧はサーバの順序を保つ（並べ替えない）', async () => {
  const s = await startFakeServer();
  s.setModels(['zeta', 'alpha', 'mid']);
  const models = await createProvider(endpoint(s.url)).listModels();
  assert.deepEqual(
    models.map((m) => m.id),
    ['zeta', 'alpha', 'mid'],
    'サーバの順序には意味がある（読み込み中のモデルが先頭など）ので並べ替えない',
  );
  await s.close();
});

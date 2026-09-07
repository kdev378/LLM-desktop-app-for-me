import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { lmStudioModelsUrl, mergeLmStudioInfo, fetchLmStudioModels } from '../dist/index.js';

/**
 * LM Studio 固有の REST API から文脈長を補う処理。
 * OpenAI互換の /v1/models は文脈長を返さないため。
 * 仕様: docs/spec/02-provider.md
 */

test('ベースURLから LM Studio の口のURLを作る', () => {
  assert.equal(
    lmStudioModelsUrl('http://localhost:1234/v1'),
    'http://localhost:1234/api/v0/models',
  );
  assert.equal(
    lmStudioModelsUrl('http://127.0.0.1:1234/v1/'),
    'http://127.0.0.1:1234/api/v0/models',
  );
  assert.equal(lmStudioModelsUrl('http://host/prefix/v1'), 'http://host/prefix/api/v0/models');
  assert.equal(lmStudioModelsUrl('これはURLではない'), null);
});

test('文脈長は、既に分かっているものを上書きしない', () => {
  const merged = mergeLmStudioInfo(
    [{ id: 'a', contextTokens: 4096 }, { id: 'b' }],
    [
      { id: 'a', contextTokens: 99999 },
      { id: 'b', contextTokens: 32768, state: 'loaded' },
    ],
  );
  assert.equal(merged[0]!.contextTokens, 4096, '/models 側の値を優先する');
  assert.equal(merged[1]!.contextTokens, 32768);
  assert.equal(merged[1]!.state, 'loaded');
});

test('補う情報が無ければ、そのまま返す', () => {
  const models = [{ id: 'a' }];
  assert.deepEqual(mergeLmStudioInfo(models, null), models);
});

test('LM Studio でないサーバでは黙って諦める', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  server.unref();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const got = await fetchLmStudioModels(`http://127.0.0.1:${port}/v1`);
  assert.equal(got, null, '取れないのは異常ではない');
  await new Promise<void>((r) => server.close(() => r()));
});

test('LM Studio の応答から文脈長と読み込み状態を取る', async () => {
  const server = http.createServer((req, res) => {
    if (!req.url?.endsWith('/api/v0/models')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'loaded-one',
            state: 'loaded',
            max_context_length: 32768,
            loaded_context_length: 8192,
          },
          { id: 'other', state: 'not-loaded', max_context_length: 16384 },
          { id: 'no-id-field' },
        ],
      }),
    );
  });
  server.unref();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const got = await fetchLmStudioModels(`http://127.0.0.1:${port}/v1`);
  assert.ok(got);
  assert.equal(got!.length, 3);
  // 実際に載っている長さを優先する（max ではなく loaded）
  assert.equal(got![0]!.contextTokens, 8192);
  assert.equal(got![0]!.state, 'loaded');
  assert.equal(got![1]!.contextTokens, 16384);
  assert.equal(got![2]!.contextTokens, undefined, '無い値を作らない');
  await new Promise<void>((r) => server.close(() => r()));
});

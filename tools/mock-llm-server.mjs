#!/usr/bin/env node
/**
 * 開発用の模擬ローカルLLMサーバ（OpenAI互換）。
 * 本物のサーバが手元に無いときに、Akari の動作を確かめるために使う。
 *
 *   node tools/mock-llm-server.mjs [ポート]
 *
 * 本物のモデルは動かない。入力をなぞった応答をトークンごとに返すだけ。
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 11499);
const MODELS = ['mock-chat-7b', 'mock-coder-14b'];

const server = http.createServer((req, res) => {
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
        }),
      );
      return;
    }
    if (!url.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    let payload = {};
    try {
      payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    } catch {
      /* 下で扱う */
    }
    const last = [...(payload.messages ?? [])].reverse().find((m) => m.role === 'user');
    const wantsTool = Array.isArray(payload.tools) && payload.tools.length > 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );

    if (wantsTool) {
      // 機能判定でツール対応と見えるようにする
      const name = payload.tools[0]?.function?.name ?? 'unknown_tool';
      send({
        tool_calls: [
          { index: 0, id: 'call_mock', type: 'function', function: { name, arguments: '' } },
        ],
      });
      send({ tool_calls: [{ index: 0, function: { arguments: '{"label":"probe"}' } }] });
      send({}, 'tool_calls');
      if (payload.stream_options?.include_usage) {
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reply = `（模擬サーバの応答）受け取った文: ${(last?.content ?? '').slice(0, 60)}\nこれはテスト用の固定応答です。本物のモデルは動いていません。`;
    let i = 0;
    const tokens = [...reply];
    const timer = setInterval(() => {
      const piece = tokens.slice(i, i + 3).join('');
      i += 3;
      if (piece) send({ content: piece });
      if (i >= tokens.length) {
        clearInterval(timer);
        send({}, 'stop');
        if (payload.stream_options?.include_usage) {
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: tokens.length, total_tokens: 42 + tokens.length } })}\n\n`,
          );
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 15);
    // res の close を見る。req の 'close' は本文を読み終えた時点で発火するため、
    // ここで使うと送信前に止まってしまう。
    res.on('close', () => clearInterval(timer));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `模擬LLMサーバ: http://127.0.0.1:${port}/v1  (モデル: ${MODELS.join(', ')})\n`,
  );
});

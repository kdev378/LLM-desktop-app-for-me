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
// AKARI_MOCK_MODELS でモデル一覧を差し替えられる（LM Studio のように
// 埋め込みモデルが混ざる状況を再現するため）。
const MODELS = (process.env.AKARI_MOCK_MODELS ?? 'mock-chat-7b,mock-coder-14b,mock-notools-4b')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

// 埋め込み専用モデルは chat を受け付けない。実物と同じように 400 を返す。
const isEmbeddingOnly = (id) => /embed|rerank|whisper|tts|bge-|clip/i.test(id);

// エージェントの動作確認用の台本。
// 「その会話で何ターン目か」で引く。呼び出し回数で数えると、
// probe や chat の分まで消費してしまい、run が台本の途中から始まってしまう。
function readScript() {
  try {
    return JSON.parse(process.env.AKARI_MOCK_SCRIPT ?? '[]');
  } catch {
    return [];
  }
}

function turnIndex(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.filter((m) => m && m.role === 'assistant').length;
}

const server = http.createServer((req, res) => {
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    const rawBody = Buffer.concat(body).toString('utf8');
    let payload0 = {};
    try {
      payload0 = JSON.parse(rawBody || '{}');
    } catch {
      payload0 = {};
    }
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: MODELS.map((id) => ({
            id,
            object: 'model',
            owned_by: 'mock',
            // AKARI_MOCK_CONTEXT を設定すると、vLLM のように文脈長を申告する
            ...(process.env.AKARI_MOCK_CONTEXT
              ? { max_model_len: Number(process.env.AKARI_MOCK_CONTEXT) }
              : {}),
          })),
        }),
      );
      return;
    }
    if (isEmbeddingOnly(String(payload0.model ?? '')) && url.includes('/chat/completions')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `Model ${payload0.model} is an embedding model and does not support chat completions.`,
          },
        }),
      );
      return;
    }

    if (!url.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const payload = payload0;
    const last = [...(payload.messages ?? [])].reverse().find((m) => m.role === 'user');
    // AKARI_MOCK_NO_TOOLS=1 で「ツールを理解しないモデル」を再現する。
    // Gemma 系のようにツール用テンプレートを持たないモデルの挙動にあたる。
    // 名前に notool を含むモデルは「ツールを理解しないモデル」として振る舞う。
    // 1台のサーバで、対応モデルと非対応モデルを並べて比べられるようにするため。
    const ignoreTools =
      process.env.AKARI_MOCK_NO_TOOLS === '1' || /notool/i.test(String(payload.model ?? ''));
    const wantsTool = !ignoreTools && Array.isArray(payload.tools) && payload.tools.length > 0;

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
      // AKARI_MOCK_SCRIPT に台本を書くと、呼ばれるたびに1つ進む。
      // 例: '[{"name":"write_file","arguments":{"path":"a.txt","content":"x"}},{"text":"完了"}]'
      const step = readScript()[turnIndex(payload)] ?? null;
      if (step && step.text) {
        for (const piece of [...step.text]) send({ content: piece });
        send({}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const name = step?.name ?? payload.tools[0]?.function?.name ?? 'unknown_tool';
      const toolArgs = JSON.stringify(step?.arguments ?? { label: 'probe' });
      send({
        tool_calls: [
          {
            index: 0,
            id: `call_${turnIndex(payload)}`,
            type: 'function',
            function: { name, arguments: '' },
          },
        ],
      });
      send({ tool_calls: [{ index: 0, function: { arguments: toolArgs } }] });
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

    // 台本に text があればそれを返す。無ければ入力をなぞった固定文。
    const scriptedStep = readScript()[turnIndex(payload)] ?? null;
    let reply;
    if (typeof scriptedStep?.text === 'string') {
      reply = scriptedStep.text;
    } else if (scriptedStep?.name) {
      // 同じ台本を、ツール非対応モデルでは代替方式のブロックとして出す。
      // 1つの台本で両方の経路を比べられるようにするため。
      const block = JSON.stringify({
        name: scriptedStep.name,
        arguments: scriptedStep.arguments ?? {},
      });
      reply = ['道具を使います。', '```akari-tool', block, '```'].join('\n');
    } else {
      reply = `（模擬サーバの応答）受け取った文: ${(last?.content ?? '').slice(0, 60)}\nこれはテスト用の固定応答です。本物のモデルは動いていません。`;
    }
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

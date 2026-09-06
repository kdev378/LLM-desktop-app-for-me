import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 模擬のOpenAI互換サーバ。SSEの断片、ツール呼び出し、途中切断、非互換応答を再現する。
 * 仕様: docs/spec/11-roadmap.md「テストの方針」
 */

export type FakeBehavior =
  | { kind: 'text'; chunks: string[]; usage?: boolean }
  | { kind: 'toolCall'; name: string; argChunks: string[] }
  | { kind: 'status'; status: number; body: string }
  | { kind: 'rejectStreamOptions'; then: FakeBehavior }
  | { kind: 'notSse'; body: string; contentType?: string }
  | { kind: 'jsonCompletion'; content: string }
  | { kind: 'cutOff'; chunks: string[] }
  | { kind: 'hang' };

export type FakeServer = {
  url: string;
  requests: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }>;
  setBehavior(b: FakeBehavior): void;
  setModels(ids: string[]): void;
  close(): Promise<void>;
};

export async function startFakeServer(
  initial: FakeBehavior = { kind: 'text', chunks: ['こんにちは'] },
): Promise<FakeServer> {
  let behavior = initial;
  let models = ['test-model'];
  const requests: FakeServer['requests'] = [];

  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ path: req.url ?? '', body, headers: req.headers });

      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: models.map((id) => ({ id, object: 'model', owned_by: 'fake' })),
          }),
        );
        return;
      }
      handleChat(res, behavior, body, () => {
        behavior = (behavior as { kind: 'rejectStreamOptions'; then: FakeBehavior }).then;
      });
    });
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // 閉じ忘れてもプロセスを止めない。止まると「テスト失敗」が「ハング」に化けて、
  // 原因を追うのに時間がかかる。
  server.unref();
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setBehavior(b) {
      behavior = b;
    },
    setModels(ids) {
      models = ids;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sse(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function handleChat(
  res: http.ServerResponse,
  behavior: FakeBehavior,
  body: unknown,
  advance: () => void,
): void {
  switch (behavior.kind) {
    case 'status':
      res.writeHead(behavior.status, { 'content-type': 'application/json' });
      res.end(behavior.body);
      return;

    case 'rejectStreamOptions': {
      const hasStreamOptions = !!(body as { stream_options?: unknown })?.stream_options;
      if (hasStreamOptions) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "unknown field 'stream_options'" } }));
        return;
      }
      advance();
      handleChat(res, (behavior as { then: FakeBehavior }).then, body, advance);
      return;
    }

    case 'notSse':
      res.writeHead(200, { 'content-type': behavior.contentType ?? 'text/html' });
      res.end(behavior.body);
      return;

    case 'jsonCompletion':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: behavior.content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        }),
      );
      return;

    case 'text': {
      sse(res);
      for (const c of behavior.chunks) res.write(chunk({ content: c }));
      res.write(chunk({}, 'stop'));
      if (behavior.usage) {
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    case 'toolCall': {
      sse(res);
      res.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_abc',
              type: 'function',
              function: { name: behavior.name, arguments: '' },
            },
          ],
        }),
      );
      for (const a of behavior.argChunks) {
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] }));
      }
      res.write(chunk({}, 'tool_calls'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    case 'cutOff': {
      sse(res);
      for (const c of behavior.chunks) res.write(chunk({ content: c }));
      // 送り出してから切る。書いた直後に destroy するとクライアントへ届かず、
      // 「トークンを受け取った後の切断」の再現にならない。
      setTimeout(() => res.destroy(), 30);
      return;
    }

    case 'hang':
      sse(res);
      return; // 何も書かない
  }
}

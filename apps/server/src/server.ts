import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createProvider,
  loadConfig,
  readJson as readJsonFile,
  resolveEndpoint,
  writeJsonAtomic,
  type Logger,
  type Provider,
  type ResolvedEndpoint,
} from '@akari/core';
import { checkAccess, corsHeaders, type AccessPolicy } from './access.js';
import { ApiError, readJson, sendError, sendJson } from './http.js';
import { RunManager, type CreateRunInput } from './runs.js';
import { chunkText, renderTranscript } from './transcript.js';
import type { RunRecord, StoredEvent } from './run-store.js';

/**
 * ハーネスAPI（akari serve）。仕様: docs/spec/12-harness-api.md
 * 127.0.0.1 にだけ束ね、トークンで守る。ファイル編集とコマンド実行を公開する口だから。
 */

export type ServerOptions = {
  root: string;
  port: number;
  version: string;
  logger: Logger;
  /** 既定の作業フォルダ（--workspace）。 */
  defaultWorkspace?: string | null;
  /** テスト用。 */
  providerFor?: (endpoint: ResolvedEndpoint, logger: Logger) => Provider;
  /** テスト用。1実行あたりのイベントの保持件数。 */
  eventsKeep?: number;
};

export type ServerHandle = {
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
};

const SERVER_SCHEMA_VERSION = 1;
const HEARTBEAT_MS = 15_000;

type ServerFile = {
  schemaVersion: number;
  token: string;
  port: number;
  pid: number;
  startedAt: string;
};

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { config } = await loadConfig(opts.root);
  const token = await loadOrCreateToken(opts.root);
  const policy: AccessPolicy = { port: opts.port, token, allowOrigins: config.server.allowOrigins };
  const runs = new RunManager({
    root: opts.root,
    defaultWorkspace: opts.defaultWorkspace ?? null,
    logger: opts.logger,
    ...(opts.providerFor ? { providerFor: opts.providerFor } : {}),
    ...(opts.eventsKeep ? { eventsKeep: opts.eventsKeep } : {}),
  });
  await runs.init();

  const openStreams = new Set<ServerResponse>();
  const server = http.createServer((req, res) => {
    const started = Date.now();
    let runId: string | undefined;
    res.on('finish', () => {
      opts.logger.info('server.request', {
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        status: res.statusCode,
        ms: Date.now() - started,
        ...(runId ? { runId } : {}),
      });
    });
    void handle(req, res, (id) => (runId = id)).catch((err: unknown) => {
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError(500, 'internal', 'サーバの中で失敗しました。', (err as Error).message);
      if (apiErr.status === 401) {
        opts.logger.warn('server.unauthorized', { remote: req.socket.remoteAddress ?? '' });
      }
      if (apiErr.status >= 500) {
        opts.logger.error('server.error', { message: (err as Error).message });
      }
      if (!res.headersSent) sendError(res, apiErr);
      else res.end();
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    setRunId: (id: string) => void,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    const isHealth = url.pathname === '/v1/health';

    checkAccess(req, policy, !isHealth);
    for (const [k, v] of Object.entries(corsHeaders(req, policy))) res.setHeader(k, v);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (parts[0] !== 'v1') throw notFound();
    const [, a, b, c, d] = parts;

    if (a === 'health' && !b) {
      only(method, 'GET');
      return sendJson(res, 200, { ok: true, version: opts.version, runs: runs.counts });
    }

    if (a === 'endpoints' && !b) {
      only(method, 'GET');
      const { config: cfg } = await loadConfig(opts.root);
      return sendJson(res, 200, {
        activeEndpointId: cfg.activeEndpointId,
        endpoints: cfg.endpoints.map((e) => ({
          id: e.id,
          name: e.name,
          baseUrl: e.baseUrl,
          defaultModel: e.defaultModel ?? null,
          hasKey: e.apiKeyRef !== null && e.apiKeyRef !== undefined,
          capabilities: e.capabilities,
        })),
      });
    }

    if (a === 'models' && !b) {
      only(method, 'GET');
      const { config: cfg } = await loadConfig(opts.root);
      let endpoint: ResolvedEndpoint;
      try {
        endpoint = await resolveEndpoint(cfg, url.searchParams.get('endpoint'), opts.root);
      } catch (err) {
        throw new ApiError(400, 'endpoint_not_found', (err as Error).message);
      }
      const provider = (opts.providerFor ?? ((e, l) => createProvider(e, { logger: l })))(
        endpoint,
        opts.logger,
      );
      try {
        const models = await provider.listModels();
        return sendJson(res, 200, { endpointId: endpoint.id, models });
      } catch (err) {
        throw new ApiError(
          502,
          'endpoint_unreachable',
          '接続先からモデル一覧を取れませんでした。',
          (err as Error).message,
        );
      }
    }

    if (a === 'runs' && !b) {
      if (method === 'POST') {
        const input = parseBody(createRunSchema, await readJson(req)) as CreateRunInput;
        const { record, reused } = await runs.create(input);
        setRunId(record.runId);
        return sendJson(res, reused ? 200 : 201, {
          runId: record.runId,
          conversationId: record.conversationId,
          workspace: record.workspace,
          branch: record.branch,
          status: record.status,
          ...(reused ? { reused: true } : {}),
        });
      }
      only(method, 'GET');
      const labels: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k.startsWith('label.')) labels[k.slice(6)] = v;
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200);
      const status = url.searchParams.get('status') ?? undefined;
      return sendJson(res, 200, {
        runs: runs.list({ labels, ...(status ? { status } : {}), limit }).map(publicRun),
      });
    }

    if (a === 'runs' && b) {
      setRunId(b.toUpperCase());
      if (!c) {
        only(method, 'GET');
        return sendJson(res, 200, publicRun(runs.get(b)));
      }
      if (c === 'events' && !d) {
        only(method, 'GET');
        return streamEvents(req, res, b, url);
      }
      if (c === 'approvals' && d) {
        only(method, 'POST');
        const body = parseBody(approvalSchema, await readJson(req));
        runs.approve(b, d, body);
        return sendJson(res, 200, { ok: true });
      }
      if (c === 'abort' && !d) {
        only(method, 'POST');
        const r = runs.abort(b);
        return sendJson(res, 202, { runId: r.runId, status: r.status });
      }
      if (c === 'messages' && !d) {
        only(method, 'POST');
        const body = parseBody(messageSchema, await readJson(req));
        const { record, injected } = await runs.message(b, body.text);
        return sendJson(res, injected ? 202 : 201, {
          runId: record.runId,
          conversationId: record.conversationId,
          injected,
        });
      }
      if (c === 'transcript' && !d) {
        only(method, 'GET');
        const format = url.searchParams.get('format') ?? 'markdown';
        if (format !== 'markdown' && format !== 'text' && format !== 'json') {
          throw new ApiError(
            400,
            'invalid_format',
            'format は markdown / text / json のどれかです。',
          );
        }
        const data = await runs.transcript(b);
        if (format === 'json') return sendJson(res, 200, data);
        const text = renderTranscript(data, format);
        const chunk = url.searchParams.get('chunk');
        if (chunk === null) return sendJson(res, 200, { format, text });
        return sendJson(res, 200, {
          format,
          chunks: chunkText(text, clampInt(chunk, 2000, 200, 100_000)),
        });
      }
      if (c === 'diff' && !d) {
        only(method, 'GET');
        return sendJson(res, 200, await runs.diff(b, url.searchParams.get('path') ?? undefined));
      }
      if (c === 'undo' && !d) {
        only(method, 'POST');
        return sendJson(res, 200, await runs.undo(b));
      }
      if (c === 'worktree' && !d) {
        only(method, 'DELETE');
        const removed = await runs.deleteWorktree(b);
        return sendJson(res, 200, { removed });
      }
    }

    if (a === 'worktrees' && !b) {
      only(method, 'GET');
      return sendJson(res, 200, { worktrees: await runs.worktrees() });
    }

    if (a === 'conversations') {
      only(method, 'GET');
      if (!b) {
        const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200);
        return sendJson(res, 200, { conversations: await runs.conversationList(limit) });
      }
      if (!c) return sendJson(res, 200, await runs.conversation(b));
    }

    throw notFound();
  }

  /** SSE。連番つきで流し、Last-Event-ID / ?from= で続きから読み直せる。 */
  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    url: URL,
  ): Promise<void> {
    const header = req.headers['last-event-id'];
    const fromRaw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('from');
    const after = fromRaw === null || fromRaw === undefined ? 0 : Number(fromRaw);
    if (!Number.isInteger(after) || after < 0) {
      throw new ApiError(400, 'invalid_from', 'from / Last-Event-ID は 0 以上の整数です。');
    }
    runs.get(runId); // 無ければ 404

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    openStreams.add(res);
    const write = (e: StoredEvent) => {
      const type = typeof e.event.type === 'string' ? e.event.type : 'message';
      res.write(`id: ${e.seq}\nevent: ${type}\ndata: ${JSON.stringify(e.event)}\n\n`);
    };

    // 先に購読してから過去分を読む（その間に来たものを取りこぼさない）。重複は連番で落とす
    let last = after;
    const buffered: StoredEvent[] = [];
    let replaying = true;
    let ended = false;
    let endedDuringReplay = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(beat);
      unsubscribe();
      openStreams.delete(res);
      res.end();
    };
    const unsubscribe = runs.subscribe(runId, (e) => {
      if (e === null) {
        if (replaying) endedDuringReplay = true;
        else finish();
        return;
      }
      if (replaying) buffered.push(e);
      else if (e.seq > last) {
        write(e);
        last = e.seq;
      }
    });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    req.on('close', finish);

    const { events, gap, finished } = await runs.eventsAfter(runId, after);
    if (gap) {
      // 取りこぼした範囲が保持を超えていた。黙って飛ばさない
      res.write(`event: gap\ndata: ${JSON.stringify({ type: 'gap', ...gap })}\n\n`);
    }
    for (const e of [...events, ...buffered].sort((x, y) => x.seq - y.seq)) {
      if (e.seq <= last) continue;
      write(e);
      last = e.seq;
    }
    replaying = false;
    // 終わった実行は、保持している全部を流して閉じる
    if (finished || endedDuringReplay) finish();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new ApiError(
            409,
            'port_in_use',
            `ポート ${opts.port} は既に使われています（別の akari serve が動いているかもしれません）。`,
          ),
        );
      } else reject(err);
    });
    // 127.0.0.1 にだけ束ねる。0.0.0.0 は受け付けない（外からの接続は 12-harness-api.md「将来」）
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  policy.port = port;
  const info: ServerFile = {
    schemaVersion: SERVER_SCHEMA_VERSION,
    token,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(serverFile(opts.root), info, 0o600);

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await runs.close();
      for (const res of openStreams) res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function serverFile(root: string): string {
  return path.join(root, 'server.json');
}

/** トークンは server.json に保つ。再起動しても変わらない（つないでいるツールを切らないため）。 */
async function loadOrCreateToken(root: string): Promise<string> {
  const read = await readJsonFile<Partial<ServerFile>>(serverFile(root));
  if (
    read.status === 'ok' &&
    typeof read.value.token === 'string' &&
    read.value.token.length >= 32
  ) {
    return read.value.token;
  }
  return randomBytes(32).toString('base64url');
}

function only(method: string, allowed: string): void {
  if (method !== allowed) {
    throw new ApiError(405, 'method_not_allowed', `${method} は使えません（${allowed} だけ）。`);
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'そのパスはありません。');
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const detail = r.error.issues
    .map((i) => `${i.path.join('.') || '(本文)'}: ${i.message}`)
    .join(' / ');
  throw new ApiError(400, 'invalid_body', '本文の形が正しくありません。', detail);
}

const createRunSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().min(1).optional(),
  endpoint: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(['ask', 'autoEdit', 'full']).optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
  tools: z.array(z.string()).optional(),
  conversationId: z.string().min(1).optional(),
  labels: z.record(z.string()).optional(),
  git: z
    .object({
      worktree: z.boolean().optional(),
      branch: z.string().min(1).optional(),
      base: z.string().min(1).optional(),
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const approvalSchema = z.object({
  decision: z.enum(['allow', 'allowSession', 'deny', 'abort']),
  scope: z.string().optional(),
  feedback: z.string().optional(),
});

const messageSchema = z.object({ text: z.string().min(1) });

/** 外へ出す形。プロセス番号など中の都合は出さない。 */
function publicRun(r: RunRecord) {
  const { pid: _pid, schemaVersion: _v, ...rest } = r;
  return { ...rest, changedFiles: r.changedFiles.length, changedFileList: r.changedFiles };
}

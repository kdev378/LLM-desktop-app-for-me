import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * HTTP の受け答えの共通部分。仕様: docs/spec/12-harness-api.md「形式」
 * エラーは常に同じ形 { error: { code, message, detail? } }。外部ツールは code で分岐する。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** 本文の上限。これより大きい要求は読まずに断る。 */
const MAX_BODY_BYTES = 1_000_000;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export function sendError(res: ServerResponse, err: ApiError): void {
  sendJson(res, err.status, {
    error: { code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) },
  });
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(
        413,
        'body_too_large',
        `本文が大きすぎます（上限 ${MAX_BODY_BYTES} バイト）。`,
      );
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError(400, 'invalid_json', 'JSON として読めません。', (err as Error).message);
  }
}

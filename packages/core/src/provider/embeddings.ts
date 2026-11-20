import type { ResolvedEndpoint } from '../config/endpoints.js';
import { classifyHttp, classifyNetwork, providerError } from './errors.js';
import type { ProviderError } from './types.js';

/**
 * OpenAI 互換の埋め込み（POST {baseUrl}/embeddings）。仕様: docs/spec/14-memory.md「埋め込み」
 *
 * Provider（会話）とは分けておく。埋め込みは索引の側だけが使い、会話の偽物を作るテストに関わらせないため。
 */

export const EMBED_TIMEOUT_MS = 120_000;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly providerError: ProviderError | null,
    /** この接続先は埋め込みに対応していない（404 など）。 */
    readonly unsupported = false,
  ) {
    super(message);
  }
}

export type EmbedRequest = {
  model: string;
  input: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** 1回分を送る。件数の調整（大きすぎたら半分に）は呼び出し側。 */
export async function fetchEmbeddings(
  ep: ResolvedEndpoint,
  req: EmbedRequest,
): Promise<number[][]> {
  const doFetch = req.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? EMBED_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = () => controller.abort();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...ep.headers,
  };
  if (ep.apiKey) headers['authorization'] = `Bearer ${ep.apiKey}`;
  let res: Response;
  let body: string;
  try {
    res = await doFetch(`${ep.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: req.model, input: req.input }),
      signal: controller.signal,
    });
    body = await res.text();
  } catch (err) {
    const pe = classifyNetwork(err, { endpointId: ep.id, model: req.model, baseUrl: ep.baseUrl });
    throw new EmbeddingError(
      req.signal?.aborted ? '中断しました。' : `埋め込みを取れませんでした: ${pe.message}`,
      pe,
    );
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    const pe = classifyHttp(res.status, body, { endpointId: ep.id, model: req.model });
    const unsupported = res.status === 404 || res.status === 405 || res.status === 501;
    throw new EmbeddingError(
      unsupported
        ? `接続先 "${ep.name}" は埋め込み（/embeddings）に対応していないようです（HTTP ${res.status}）。`
        : `埋め込みが失敗しました（HTTP ${res.status}）: ${pe.message}`,
      pe,
      unsupported,
    );
  }
  let json: { data?: Array<{ embedding?: unknown; index?: number }> };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    throw new EmbeddingError(
      '埋め込みの応答が JSON ではありません。',
      providerError('incompatible', '埋め込みの応答が JSON ではありません。', {
        endpointId: ep.id,
        model: req.model,
      }),
    );
  }
  const data = Array.isArray(json.data) ? [...json.data] : [];
  data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out = data.map((d) => d.embedding);
  if (
    out.length !== req.input.length ||
    !out.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number'))
  ) {
    throw new EmbeddingError(
      `埋め込みの応答の形が違います（${req.input.length} 件送って ${out.length} 件）。`,
      null,
    );
  }
  return out as number[][];
}

/** L2 正規化。検索は内積（= コサイン類似度）で済ませる。 */
export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

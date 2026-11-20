import type { ModelInfo } from './types.js';
import type { Logger } from '../diagnostics/logger.js';

/**
 * LM Studio 固有の REST API から、OpenAI互換のエンドポイントでは分からない情報を補う。
 *
 * OpenAI の /v1/models は文脈長を返さない。LM Studio は独自に
 * {origin}/api/v0/models を持ち、そこに文脈長や読み込み状態が入っている。
 *
 * **これは LM Studio にしか無い口で、応答の形も検証できていない。**
 * 取れなければ黙って諦める。取れない＝不明であって、失敗ではない。
 * 仕様: docs/spec/02-provider.md
 */

export type LmStudioModelInfo = {
  id: string;
  contextTokens?: number;
  /** 'loaded' なら今メモリに載っている。読み込み中でないモデルを指定すると挙動が変わる。 */
  state?: string;
  quantization?: string;
  arch?: string;
};

/** baseUrl（…/v1）から LM Studio の REST API の URL を作る。 */
export function lmStudioModelsUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    // 末尾の /v1 を落として /api/v0/models を付ける
    const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${u.origin}${path}/api/v0/models`;
  } catch {
    return null;
  }
}

export async function fetchLmStudioModels(
  baseUrl: string,
  opts: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    logger?: Logger;
    timeoutMs?: number;
  } = {},
): Promise<LmStudioModelInfo[] | null> {
  const url = lmStudioModelsUrl(baseUrl);
  if (url === null) return null;

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  timer.unref?.();
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await doFetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) return null;

    const out: LmStudioModelInfo[] = [];
    for (const raw of json.data) {
      const rec = raw as Record<string, unknown>;
      if (typeof rec.id !== 'string') continue;
      const ctx =
        pickNumber(rec.loaded_context_length) ?? pickNumber(rec.max_context_length) ?? undefined;
      out.push({
        id: rec.id,
        ...(ctx !== undefined ? { contextTokens: ctx } : {}),
        ...(typeof rec.state === 'string' ? { state: rec.state } : {}),
        ...(typeof rec.quantization === 'string' ? { quantization: rec.quantization } : {}),
        ...(typeof rec.arch === 'string' ? { arch: rec.arch } : {}),
      });
    }
    opts.logger?.debug('provider.lmstudioModels', { count: out.length });
    return out.length > 0 ? out : null;
  } catch {
    // LM Studio でなければここへ来る。異常ではない。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** /v1/models の結果へ、LM Studio 側の情報を重ねる。 */
export function mergeLmStudioInfo(
  models: ModelInfo[],
  extra: LmStudioModelInfo[] | null,
): ModelInfo[] {
  if (!extra) return models;
  const byId = new Map(extra.map((e) => [e.id, e]));
  return models.map((m) => {
    const e = byId.get(m.id);
    if (!e) return m;
    return {
      ...m,
      ...(m.contextTokens === undefined && e.contextTokens !== undefined
        ? { contextTokens: e.contextTokens }
        : {}),
      ...(e.state !== undefined ? { state: e.state } : {}),
    };
  });
}

function pickNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

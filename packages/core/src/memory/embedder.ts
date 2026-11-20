import type { ResolvedEndpoint } from '../config/endpoints.js';
import { EmbeddingError, fetchEmbeddings, normalize } from '../provider/embeddings.js';

/**
 * 埋め込みの口。索引づくり・検索はこの口しか知らない。仕様: docs/spec/14-memory.md「埋め込みの口」
 * 出どころ（内蔵・外部・将来の段階2）は、この裏で差し替える。
 */

export type EmbeddingIdentity = {
  /** 将来 'lan' を足す（段階2）。足しても他の項目と索引の形は変わらない。 */
  source: 'builtin' | 'endpoint';
  model: string;
  revision: string | null;
  fileSha256: string | null;
  /** 使い方の約束（文の前の印・プーリング・正規化）の版。 */
  contract: string;
  /** 分からなければ null（外部の接続先は、最初に埋め込むまで分からない）。 */
  dims: number | null;
  /** 1回に読める長さ（トークン）。分からなければ null。 */
  maxTokens: number | null;
  endpointId?: string;
};

export type EmbedKind = 'query' | 'passage';

export interface Embedder {
  identity(): Promise<EmbeddingIdentity>;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
}

/**
 * 同じ埋め込みか。違えば、その索引では検索しない（別のモデルのベクトルと混ぜない）。
 * dims は片方が分からなければ比べない（外部の接続先。最初の埋め込みで確かめる）。
 */
export function sameIdentity(a: EmbeddingIdentity, b: EmbeddingIdentity): boolean {
  return (
    a.source === b.source &&
    a.model === b.model &&
    a.revision === b.revision &&
    a.fileSha256 === b.fileSha256 &&
    a.contract === b.contract &&
    (a.endpointId ?? null) === (b.endpointId ?? null) &&
    (a.dims === null || b.dims === null || a.dims === b.dims)
  );
}

/** 人に見せる1行。 */
export function describeIdentity(id: EmbeddingIdentity): string {
  if (id.source === 'endpoint') return `外部の接続先 ${id.endpointId ?? '?'} の ${id.model}`;
  return `内蔵の ${id.model}${id.revision ? `@${id.revision}` : ''}`;
}

/** 外部の接続先（OpenAI 互換の /embeddings）。 */
export class EndpointEmbedder implements Embedder {
  private dims: number | null = null;

  constructor(
    private readonly ep: ResolvedEndpoint,
    private readonly model: string,
    private readonly batchSize = 16,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async identity(): Promise<EmbeddingIdentity> {
    return {
      source: 'endpoint',
      model: this.model,
      revision: null,
      fileSha256: null,
      // 外部は文の前の印を付けずに送る。印の要るモデルかどうかを Akari は知らない
      contract: 'openai-embeddings-v1',
      dims: this.dims,
      maxTokens: null,
      endpointId: this.ep.id,
    };
  }

  async embed(texts: string[], _kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      for (const v of await this.send(batch, signal)) out.push(this.check(normalize(v)));
    }
    return out;
  }

  /** 大きすぎると断るサーバがある。413 / 400 なら、半分にして1度だけ送り直す。 */
  private async send(batch: string[], signal?: AbortSignal): Promise<number[][]> {
    const req = {
      model: this.model,
      signal,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    };
    try {
      return await fetchEmbeddings(this.ep, { ...req, input: batch });
    } catch (err) {
      const status = err instanceof EmbeddingError ? err.providerError?.status : undefined;
      if (batch.length > 1 && (status === 413 || status === 400)) {
        const half = Math.ceil(batch.length / 2);
        const a = await fetchEmbeddings(this.ep, { ...req, input: batch.slice(0, half) });
        const b = await fetchEmbeddings(this.ep, { ...req, input: batch.slice(half) });
        return [...a, ...b];
      }
      throw err;
    }
  }

  private check(v: Float32Array): Float32Array {
    if (this.dims === null) this.dims = v.length;
    else if (v.length !== this.dims) {
      throw new EmbeddingError(
        `埋め込みの次元が途中で変わりました（${this.dims} → ${v.length}）。接続先のモデルが入れ替わった可能性があります。`,
        null,
      );
    }
    return v;
  }
}

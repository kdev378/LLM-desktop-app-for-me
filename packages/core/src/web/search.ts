import { loadCredentials, resolveKey } from '../config/credentials.js';
import type { WebSettings } from '../config/schema.js';

/**
 * 検索の提供元。仕様: docs/spec/15-web.md「検索の提供元（差し替え可能）」
 * 今は SearXNG（自前で立てる）と Tavily。足すときは SearchProvider を1つ書いて createSearchProvider に足す。
 *
 * 提供元の宛先は利用者が設定したものなので、SSRF の検査はしない（SearXNG は localhost が普通）。
 * モデルが変えられるのは検索語と件数だけ。
 */

export type SearchResult = { title: string; url: string; snippet: string; publishedAt?: string };

export type SearchProvider = {
  /** 表示用: 「SearXNG（http://localhost:8888）」など。検索語の送り先として見せる。 */
  label: string;
  search(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]>;
};

export class SearchError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;
export const TAVILY_URL = 'https://api.tavily.com';

/** 設定から提供元を作る。使えない（鍵が無いなど）なら理由つきで投げる。 */
export async function createSearchProvider(
  web: WebSettings,
  root?: string,
  opts: { fetchImpl?: typeof fetch; tavilyUrl?: string } = {},
): Promise<SearchProvider> {
  const f = opts.fetchImpl ?? fetch;
  const s = web.search;
  if (s.provider === 'searxng') return searxng(s.url, f);
  const { credentials } = await loadCredentials(root);
  const key = resolveKey(s.apiKeyRef, credentials);
  if (key.kind === 'missing-env') {
    throw new SearchError(
      `Tavily の鍵が環境変数 ${key.varName} から取れませんでした。`,
      `${key.varName} を設定してから実行してください。`,
    );
  }
  if (key.kind === 'none') {
    throw new SearchError(
      'Tavily の鍵が設定されていません。',
      'akari config set web.search.apiKeyRef env:TAVILY_API_KEY（鍵は環境変数 TAVILY_API_KEY に）',
    );
  }
  return tavily(opts.tavilyUrl ?? TAVILY_URL, key.value, f);
}

function searxng(base: string, f: typeof fetch): SearchProvider {
  const root = base.replace(/\/+$/, '');
  return {
    label: `SearXNG（${root}）`,
    async search(query, count, signal) {
      const url = `${root}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
      const res = await call(
        () => f(url, { headers: { accept: 'application/json' }, signal: withTimeout(signal) }),
        'SearXNG',
        root,
      );
      if (res.status === 403) {
        throw new SearchError(
          'SearXNG が JSON での結果を断りました（HTTP 403）。',
          'SearXNG の settings.yml の search.formats に json を足して、SearXNG を再起動してください。',
        );
      }
      if (!res.ok) throw new SearchError(`SearXNG が HTTP ${res.status} を返しました。`);
      const body = (await res.json().catch(() => null)) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          publishedDate?: string | null;
        }>;
      } | null;
      if (!body || !Array.isArray(body.results))
        throw new SearchError('SearXNG の応答が読めませんでした。');
      return body.results
        .filter((r) => typeof r.url === 'string')
        .slice(0, count)
        .map((r) => ({
          title: clean(r.title ?? ''),
          url: r.url!,
          snippet: clean(r.content ?? ''),
          ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
        }));
    },
  };
}

function tavily(base: string, key: string, f: typeof fetch): SearchProvider {
  const root = base.replace(/\/+$/, '');
  return {
    label: `Tavily（${root}）`,
    async search(query, count, signal) {
      const res = await call(
        () =>
          f(`${root}/search`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
            signal: withTimeout(signal),
          }),
        'Tavily',
        root,
      );
      if (res.status === 401 || res.status === 403) {
        throw new SearchError(
          `Tavily が鍵を受け付けませんでした（HTTP ${res.status}）。`,
          '鍵が正しいか確かめてください。',
        );
      }
      if (res.status === 429) {
        throw new SearchError(`Tavily の利用の上限に達しました（HTTP ${res.status}）。`);
      }
      if (!res.ok) throw new SearchError(`Tavily が HTTP ${res.status} を返しました。`);
      const body = (await res.json().catch(() => null)) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          published_date?: string;
        }>;
      } | null;
      if (!body || !Array.isArray(body.results))
        throw new SearchError('Tavily の応答が読めませんでした。');
      return body.results
        .filter((r) => typeof r.url === 'string')
        .slice(0, count)
        .map((r) => ({
          title: clean(r.title ?? ''),
          url: r.url!,
          snippet: clean(r.content ?? ''),
          ...(r.published_date ? { publishedAt: r.published_date } : {}),
        }));
    },
  };
}

async function call(go: () => Promise<Response>, name: string, where: string): Promise<Response> {
  try {
    return await go();
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError')
      throw new SearchError(`${name} が ${TIMEOUT_MS / 1000}秒以内に答えませんでした。`);
    if (e.name === 'AbortError') throw new SearchError('中断しました。');
    throw new SearchError(
      `${name}（${where}）につながりませんでした: ${(e.cause as Error | undefined)?.message ?? e.message}`,
      name === 'SearXNG'
        ? 'SearXNG が動いているか、web.search.url が合っているか確かめてください。'
        : undefined,
    );
  }
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { checkAddress } from './address.js';

/**
 * ページを取りに行く。仕様: docs/spec/15-web.md「SSRF を塞ぐ」
 *
 * - http / https だけ。URL に user:pass@ があれば取らない
 * - 名前解決は1段に1回。結果を全部検査し、選んだ IP へそのまま接続する（lookup の差し替え。DNS の差し替えが効かない）
 * - リダイレクトは自分で追い、行き先も毎回同じ検査をする
 * - プロキシは使わない（使うと IP の検査が効かない）。Cookie・認証のヘッダは送らない
 */

export type FetchSettings = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
  /** 内部のアドレスに解決されても取ってよいホスト名。 */
  privateHosts: string[];
  /** 取らないホスト（その下の名前も）。 */
  deniedHosts: string[];
};

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export type FetchedPage = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  /** 文字に直した中身。 */
  body: string;
  /** maxBytes で切ったか。 */
  truncated: boolean;
  bytes: number;
  /** たどったリダイレクト（最初の URL を除く）。 */
  redirects: string[];
};

export type WebErrorKind =
  | 'bad_url'
  | 'bad_scheme'
  | 'credentials_in_url'
  | 'denied_host'
  | 'private_address'
  | 'too_many_redirects'
  | 'unsupported_type'
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'aborted';

export class WebError extends Error {
  constructor(
    readonly kind: WebErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const systemResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export async function fetchPage(
  url: string,
  settings: FetchSettings,
  opts: { signal?: AbortSignal; resolve?: Resolver } = {},
): Promise<FetchedPage> {
  const resolve = opts.resolve ?? systemResolver;
  const deadline = AbortSignal.timeout(settings.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    const target = parseTarget(current);
    checkHost(target.hostname, settings);
    const address = await pickAddress(target.hostname, settings, resolve);
    let res: Response1;
    try {
      res = await request(target, address, settings, signal);
    } catch (err) {
      throw asWebError(err, signal, opts.signal, settings.timeoutMs);
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      res.drain();
      if (hop >= settings.maxRedirects) {
        throw new WebError(
          'too_many_redirects',
          `リダイレクトが ${settings.maxRedirects} 回を超えました（最後: ${current}）。`,
        );
      }
      let next: string;
      try {
        next = new URL(res.location, target).toString();
      } catch {
        throw new WebError('bad_url', `リダイレクト先の URL が読めません: ${res.location}`);
      }
      redirects.push(next);
      current = next;
      continue;
    }
    if (res.status >= 400) {
      res.drain();
      throw new WebError('http_error', `HTTP ${res.status} が返りました（${current}）。`);
    }
    const contentType = (res.headers['content-type'] ?? '').toString();
    const kind = textKind(contentType);
    if (!kind) {
      res.drain();
      throw new WebError(
        'unsupported_type',
        `この種類（${contentType.split(';')[0] || '不明'}）は読めません。HTML・文字・JSON・XML だけです。`,
      );
    }
    let read: { data: Buffer; truncated: boolean; bytes: number };
    try {
      read = await res.read(settings.maxBytes);
    } catch (err) {
      throw asWebError(err, signal, opts.signal, settings.timeoutMs);
    }
    return {
      url,
      finalUrl: current,
      status: res.status,
      contentType,
      body: decode(read.data, contentType, kind === 'html'),
      truncated: read.truncated,
      bytes: read.bytes,
      redirects,
    };
  }
}

function parseTarget(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError('bad_url', `URL として読めません: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new WebError('bad_scheme', `${u.protocol} は取りません。http と https だけです。`);
  }
  if (u.username || u.password) {
    throw new WebError('credentials_in_url', 'URL に認証情報（user:pass@）があるため取りません。');
  }
  return u;
}

/** URL のホスト名（IPv6 の角括弧を外し、末尾の . を落とした小文字）。数字の IPv4 の書き方は URL が 127.0.0.1 の形に直す。 */
export function hostOf(u: URL | string): string {
  const h = typeof u === 'string' ? u : u.hostname;
  return h
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function matches(host: string, list: string[]): boolean {
  return list.some((h) => {
    const p = h.trim().toLowerCase().replace(/\.$/, '');
    return p !== '' && (host === p || host.endsWith(`.${p}`));
  });
}

function checkHost(hostname: string, settings: FetchSettings): void {
  const host = hostOf(hostname);
  if (matches(host, settings.deniedHosts)) {
    throw new WebError('denied_host', `${host} は取らない設定です（web.fetch.deniedHosts）。`);
  }
}

async function pickAddress(
  hostname: string,
  settings: FetchSettings,
  resolve: Resolver,
): Promise<{ address: string; family: number }> {
  const host = hostOf(hostname);
  let found: Array<{ address: string; family: number }>;
  try {
    const literal = net.isIP(host);
    found = literal ? [{ address: host, family: literal }] : await resolve(host);
  } catch (err) {
    throw new WebError(
      'network_error',
      `${host} の名前解決に失敗しました: ${(err as Error).message}`,
    );
  }
  if (found.length === 0) throw new WebError('network_error', `${host} の名前解決の結果が空です。`);
  const privateOk = matches(host, settings.privateHosts);
  // 1つでも拒否の範囲なら取らない（公開と内部を混ぜて返す名前で、内部へつながせない）
  for (const a of found) {
    const v = checkAddress(a.address);
    if (v.ok) continue;
    if (v.kind === 'internal' && privateOk) continue;
    throw new WebError(
      'private_address',
      `${host} は内部のアドレス（${a.address}、${v.what}）に解決されるため取得しません。` +
        (v.kind === 'internal'
          ? '社内のサーバなどなら、利用者が web.fetch.privateHosts に挙げられます。'
          : ''),
    );
  }
  return found[0]!;
}

type Response1 = {
  status: number;
  location?: string;
  headers: http.IncomingHttpHeaders;
  drain(): void;
  read(max: number): Promise<{ data: Buffer; truncated: boolean; bytes: number }>;
};

function request(
  target: URL,
  address: { address: string; family: number },
  settings: FetchSettings,
  signal: AbortSignal,
): Promise<Response1> {
  // 検査で選んだ IP を返す。TLS の名前（SNI）と Host は元のホスト名のまま
  const lookup: LookupFunction = (_host, options, cb) => {
    if ((options as { all?: boolean }).all) {
      (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        address,
      ]);
    } else cb(null, address.address, address.family);
  };
  const mod = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const req = mod.request(
      target,
      {
        method: 'GET',
        lookup,
        agent: false,
        signal,
        headers: {
          'user-agent': settings.userAgent,
          accept:
            'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
          'accept-language': 'ja,en;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        resolve({
          status,
          ...(location ? { location } : {}),
          headers: res.headers,
          drain: () => res.destroy(),
          read: (max) => readBody(res, max),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 中身を読む。展開した後の大きさで max まで。超えたら切って止める。 */
function readBody(
  res: http.IncomingMessage,
  max: number,
): Promise<{ data: Buffer; truncated: boolean; bytes: number }> {
  const enc = String(res.headers['content-encoding'] ?? '')
    .toLowerCase()
    .trim();
  const stream =
    enc === 'gzip' || enc === 'x-gzip'
      ? res.pipe(zlib.createGunzip())
      : enc === 'deflate'
        ? res.pipe(zlib.createInflate())
        : enc === 'br'
          ? res.pipe(zlib.createBrotliDecompress())
          : res;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      res.destroy();
      const data = Buffer.concat(chunks);
      resolve({ data: data.subarray(0, max), truncated, bytes: Math.min(size, max) });
    };
    stream.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      if (size > max) finish(true);
    });
    stream.on('end', () => finish(false));
    stream.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    res.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function textKind(contentType: string): 'html' | 'text' | null {
  const t = contentType.split(';')[0]!.trim().toLowerCase();
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html';
  if (t === '' || t.startsWith('text/')) return 'text';
  if (
    t === 'application/json' ||
    t === 'application/xml' ||
    t.endsWith('+json') ||
    t.endsWith('+xml')
  )
    return 'text';
  return null;
}

/** 文字コードは ヘッダ → BOM → HTML の meta → UTF-8 の順。 */
function decode(data: Buffer, contentType: string, html: boolean): string {
  const label =
    contentType.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ??
    bomLabel(data) ??
    (html ? metaCharset(data) : null) ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

function bomLabel(data: Buffer): string | null {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return 'utf-8';
  if (data[0] === 0xff && data[1] === 0xfe) return 'utf-16le';
  if (data[0] === 0xfe && data[1] === 0xff) return 'utf-16be';
  return null;
}

function metaCharset(data: Buffer): string | null {
  const head = data.subarray(0, 4096).toString('latin1');
  return head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1] ?? null;
}

function asWebError(
  err: unknown,
  signal: AbortSignal,
  outer: AbortSignal | undefined,
  timeoutMs: number,
): WebError {
  if (err instanceof WebError) return err;
  if (outer?.aborted) return new WebError('aborted', '中断しました。');
  if (signal.aborted)
    return new WebError(
      'timeout',
      `${Math.round(timeoutMs / 1000)}秒以内に取り終わりませんでした。`,
    );
  return new WebError('network_error', `つながりませんでした: ${(err as Error).message}`);
}

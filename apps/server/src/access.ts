import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './http.js';

/**
 * 受け付けの判定。仕様: docs/spec/12-harness-api.md「認証」「宛先（Host）の確認」
 *
 * 接続元・宛先・Origin・トークンの判定をここ1か所にまとめる。
 * 将来、外からの接続（IP の範囲で許す、12-harness-api.md「将来: 外からの接続」）を入れるときは、
 * ここに判定を足すだけで済むようにしておく。
 */

export type AccessPolicy = {
  port: number;
  token: string;
  /** ブラウザからの要求を許すオリジン。空なら全拒否。 */
  allowOrigins: string[];
};

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** トークン不要のもの（状態だけを返す）。それ以外の判定（接続元・宛先・Origin）は同じにかける。 */
export function checkAccess(req: IncomingMessage, policy: AccessPolicy, needsToken: boolean): void {
  // 接続元。今は 127.0.0.1 にしか束ねないので外からは来ないが、念のため確かめる
  const remote = req.socket.remoteAddress ?? '';
  if (!LOOPBACK_ADDRESSES.has(remote)) {
    throw new ApiError(403, 'remote_not_allowed', 'この PC の外からの接続は受け付けていません。');
  }

  // 宛先。DNS リバインディング（悪意のあるページが自分のドメインを 127.0.0.1 へ向け直す）を塞ぐ
  const host = (req.headers.host ?? '').toLowerCase();
  const allowedHosts = LOOPBACK_HOSTS.map((h) => `${h}:${policy.port}`);
  if (!allowedHosts.includes(host)) {
    throw new ApiError(
      403,
      'host_not_allowed',
      `宛先（Host: ${host || 'なし'}）が ${allowedHosts.join(' / ')} のどれでもありません。`,
    );
  }

  // ブラウザからの要求。許したオリジン以外は、トークンが正しくても断る
  const origin = req.headers.origin;
  if (origin !== undefined && !policy.allowOrigins.includes(origin)) {
    throw new ApiError(
      403,
      'origin_not_allowed',
      `ブラウザ（Origin: ${origin}）からの要求は受け付けていません。`,
      '許すには設定の server.allowOrigins にそのオリジンを入れてください。',
    );
  }

  if (!needsToken) return;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !sameToken(match[1]!.trim(), policy.token)) {
    throw new ApiError(
      401,
      'unauthorized',
      'トークンがないか、違います。',
      'Authorization: Bearer <トークン> を付けてください。',
    );
  }
}

/** 長さに依らない定数時間の比較。どちらもハッシュにしてから比べる。 */
export function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** CORS の応答ヘッダ。許したオリジンのときだけ付ける。既定は何も付けない（＝ブラウザは読めない）。 */
export function corsHeaders(req: IncomingMessage, policy: AccessPolicy): Record<string, string> {
  const origin = req.headers.origin;
  if (origin === undefined || !policy.allowOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type, last-event-id',
    'access-control-allow-methods': 'GET, POST, DELETE',
    vary: 'Origin',
  };
}

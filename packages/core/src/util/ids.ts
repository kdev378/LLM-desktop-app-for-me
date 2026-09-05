import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32

/**
 * ULID。時刻順に並び、衝突せず、ファイル名に安全な文字だけを含む。
 * 会話・プロジェクト・実行のIDに使う（docs/spec/07-data.md）。
 */
export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32]!;
  return time + rand;
}

/** ツール呼び出しなど、寿命の短い識別子。 */
export function shortId(prefix = ''): string {
  return prefix + randomBytes(6).toString('hex');
}

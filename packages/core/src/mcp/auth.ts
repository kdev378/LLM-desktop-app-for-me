import type { AuthProvider } from '@modelcontextprotocol/client';
import { resolveKey } from '../config/credentials.js';
import type { Credentials } from '../config/schema.js';
import type { McpServerConfig } from '../config/schema.js';

/**
 * MCP サーバへの認証（認証の担当）。仕様: docs/spec/13-mcp.md「認証（OAuth を後から足す前提）」
 *
 * HTTP の接続には、ここで作ったものだけを差し込む。
 * OAuth を足すときは、auth.type === 'oauth' のときに公式 SDK の OAuthClientProvider を返すだけにする
 * （ログインの戻り先、トークンの置き場はそのときに決める。置き場は下の KeySource と同じ考え方で差し替える）。
 */

/** 鍵の置き場。今は環境変数と credentials.json（endpoints の鍵と同じ規則）。後で OS のキーチェーンを足す。 */
export type KeySource = { credentials: Credentials };

export class McpAuthError extends Error {}

/** 認証の担当。要らなければ undefined。 */
export function createAuthProvider(
  server: McpServerConfig,
  keys: KeySource,
): AuthProvider | undefined {
  const auth = server.auth;
  switch (auth.type) {
    case 'none':
      return undefined;
    case 'bearer': {
      const key = resolveKey(auth.token, keys.credentials);
      if (key.kind === 'missing-env') {
        throw new McpAuthError(`鍵を環境変数 ${key.varName} から取れませんでした。`);
      }
      if (key.kind === 'none') {
        throw new McpAuthError(
          `鍵 "${auth.token}" が見つかりません（env:名前 か、登録した鍵の名前）。`,
        );
      }
      const value = key.value;
      return { token: async () => value };
    }
  }
}

/** ヘッダや環境変数の値。'env:NAME' なら環境変数から読む。無ければ失敗（黙って空にしない）。 */
export function resolveValue(raw: string, what: string): string {
  if (!raw.startsWith('env:')) return raw;
  const name = raw.slice(4);
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new McpAuthError(`${what} の値を環境変数 ${name} から取れませんでした。`);
  }
  return v;
}

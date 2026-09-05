import fs from 'node:fs/promises';
import { paths } from '../util/paths.js';
import { readJson, writeJsonAtomic } from '../util/json.js';
import { credentialsSchema, type Credentials } from './schema.js';
import { registerSecret } from '../diagnostics/redact.js';
import { AkariError } from '../util/errors.js';

/**
 * 鍵の保管。仕様: docs/spec/03-config.md
 *
 * 値は平文で保存される。OSのファイル権限に依存した保護であり、暗号化ではない。
 * 外部APIの鍵は 'env:NAME' 参照を推奨する。
 */

export type CredentialsFile = { credentials: Credentials; permissionWarning: string | null };

export async function loadCredentials(root?: string): Promise<CredentialsFile> {
  const file = paths.credentials(root);
  const res = await readJson(file);
  if (res.status === 'missing') {
    return { credentials: credentialsSchema.parse({}), permissionWarning: null };
  }
  if (res.status === 'unreadable') {
    throw new AkariError(
      'credentials.unreadable',
      'credentials.json が読めません。手で確認するまで、鍵を使う操作は行いません。',
      { detail: `${file}: ${res.error.message}` },
    );
  }
  const parsed = credentialsSchema.safeParse(res.value);
  if (!parsed.success) {
    throw new AkariError('credentials.invalid', 'credentials.json の形式が想定と違います。', {
      detail: file,
    });
  }
  for (const v of Object.values(parsed.data.keys)) registerSecret(v);

  let permissionWarning: string | null = null;
  if (process.platform !== 'win32') {
    try {
      const st = await fs.stat(file);
      const mode = st.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        permissionWarning = `credentials.json のパーミッションが ${mode.toString(8)} です。他の利用者から読めます（chmod 600 で直せます）。`;
      }
    } catch {
      /* 権限が読めないこと自体は致命ではない */
    }
  }
  return { credentials: parsed.data, permissionWarning };
}

export async function saveCredentials(creds: Credentials, root?: string): Promise<void> {
  await writeJsonAtomic(paths.credentials(root), creds, 0o600);
  for (const v of Object.values(creds.keys)) registerSecret(v);
}

export async function setKey(ref: string, value: string, root?: string): Promise<void> {
  const { credentials } = await loadCredentials(root);
  credentials.keys[ref] = value;
  await saveCredentials(credentials, root);
}

export async function removeKey(ref: string, root?: string): Promise<void> {
  const { credentials } = await loadCredentials(root);
  delete credentials.keys[ref];
  await saveCredentials(credentials, root);
}

export type ResolvedKey =
  | { kind: 'none' }
  | { kind: 'value'; value: string; source: 'file' | 'env'; ref: string }
  | { kind: 'missing-env'; ref: string; varName: string };

/**
 * apiKeyRef を実際の値へ解決する。
 * - null / 空       → 鍵なし（ローカルLLMの通常）
 * - 'env:NAME'      → 環境変数から。無ければ missing-env を返す（黙って鍵なしにしない）
 * - それ以外        → credentials.json のキー名
 */
export function resolveKey(ref: string | null | undefined, creds: Credentials): ResolvedKey {
  if (!ref || ref.trim() === '') return { kind: 'none' };
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const varName = trimmed.slice(4);
    const value = process.env[varName];
    if (value === undefined || value === '') return { kind: 'missing-env', ref: trimmed, varName };
    registerSecret(value);
    return { kind: 'value', value, source: 'env', ref: trimmed };
  }
  const value = creds.keys[trimmed];
  if (value === undefined || value === '') return { kind: 'none' };
  registerSecret(value);
  return { kind: 'value', value, source: 'file', ref: trimmed };
}

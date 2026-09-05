import { AkariError } from '../util/errors.js';
import { shortId } from '../util/ids.js';
import { endpointSchema, describeIssues, type Config, type Endpoint } from './schema.js';
import { loadCredentials, resolveKey } from './credentials.js';

/**
 * 接続先の操作と、実行用の形への解決。仕様: docs/spec/02-provider.md
 */

/** Provider が実際に使う形。鍵が解決済み。 */
export type ResolvedEndpoint = Endpoint & {
  apiKey: string | null;
  /** localhost 以外を指しているか。UIの「外部」表示と同意確認に使う。 */
  isExternal: boolean;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isExternalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (LOCAL_HOSTS.has(host)) return false;
    if (host.endsWith('.local')) return false;
    return true;
  } catch {
    return true; // 判定できないものは外部として扱う（安全側）
  }
}

export function findEndpoint(config: Config, nameOrId?: string | null): Endpoint | null {
  if (nameOrId && nameOrId.trim() !== '') {
    const key = nameOrId.trim();
    return (
      config.endpoints.find((e) => e.id === key) ??
      config.endpoints.find((e) => e.name === key) ??
      config.endpoints.find((e) => e.name.toLowerCase() === key.toLowerCase()) ??
      null
    );
  }
  if (config.activeEndpointId) {
    return config.endpoints.find((e) => e.id === config.activeEndpointId) ?? null;
  }
  return config.endpoints[0] ?? null;
}

/**
 * 接続先を実行用へ解決する。
 * 鍵の参照が env: で環境変数が無い場合は、鍵なしへ黙って落とさずエラーにする。
 */
export async function resolveEndpoint(
  config: Config,
  nameOrId?: string | null,
  root?: string,
): Promise<ResolvedEndpoint> {
  const endpoint = findEndpoint(config, nameOrId);
  if (!endpoint) {
    throw new AkariError(
      'endpoint.notFound',
      nameOrId ? `接続先 "${nameOrId}" が見つかりません。` : '接続先が登録されていません。',
      { hint: 'akari config endpoints add --name <名前> --url <ベースURL> で登録してください。' },
    );
  }

  const { credentials } = await loadCredentials(root);
  const key = resolveKey(endpoint.apiKeyRef, credentials);
  if (key.kind === 'missing-env') {
    throw new AkariError(
      'endpoint.keyMissing',
      `接続先 "${endpoint.name}" の鍵が環境変数 ${key.varName} から取れませんでした。`,
      { hint: `${key.varName} を設定してから実行してください。` },
    );
  }

  return {
    ...endpoint,
    apiKey: key.kind === 'value' ? key.value : null,
    isExternal: isExternalUrl(endpoint.baseUrl),
  };
}

export type AddEndpointInput = {
  name: string;
  baseUrl: string;
  apiKeyRef?: string | null;
  defaultModel?: string | null;
  timeoutMs?: number;
};

/** 接続先を足した新しい Config を返す。呼び出し側が saveConfig する。 */
export function addEndpoint(
  config: Config,
  input: AddEndpointInput,
): { config: Config; endpoint: Endpoint } {
  const parsed = endpointSchema.safeParse({
    id: `ep_${shortId()}`,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKeyRef ?? null,
    defaultModel: input.defaultModel ?? null,
    timeoutMs: input.timeoutMs ?? 120000,
  });
  if (!parsed.success) {
    throw new AkariError('endpoint.invalid', '接続先の内容が不正です。', {
      detail: describeIssues(parsed.error).join('\n'),
    });
  }
  const endpoint = parsed.data;
  if (config.endpoints.some((e) => e.name === endpoint.name)) {
    throw new AkariError(
      'endpoint.duplicateName',
      `同じ名前の接続先 "${endpoint.name}" が既にあります。`,
    );
  }
  const next: Config = {
    ...config,
    endpoints: [...config.endpoints, endpoint],
    activeEndpointId: config.activeEndpointId ?? endpoint.id,
  };
  return { config: next, endpoint };
}

export function removeEndpoint(config: Config, nameOrId: string): Config {
  const target = findEndpoint(config, nameOrId);
  if (!target) throw new AkariError('endpoint.notFound', `接続先 "${nameOrId}" が見つかりません。`);
  const endpoints = config.endpoints.filter((e) => e.id !== target.id);
  return {
    ...config,
    endpoints,
    activeEndpointId:
      config.activeEndpointId === target.id ? (endpoints[0]?.id ?? null) : config.activeEndpointId,
  };
}

export function updateEndpoint(config: Config, id: string, patch: Partial<Endpoint>): Config {
  return {
    ...config,
    endpoints: config.endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  };
}

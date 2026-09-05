import { redact } from '../diagnostics/redact.js';
import type { ProviderError, ProviderErrorKind } from './types.js';

const EXCERPT_LIMIT = 2048;

export function excerpt(body: string): string {
  const cut =
    body.length > EXCERPT_LIMIT ? body.slice(0, EXCERPT_LIMIT) + `…(全${body.length}文字)` : body;
  return redact(cut);
}

/** HTTP 応答をエラー種別へ分類する。仕様: docs/spec/02-provider.md の表 */
export function classifyHttp(
  status: number,
  body: string,
  ctx: { endpointId: string; model?: string; retryAfter?: string | null },
): ProviderError {
  const base = { endpointId: ctx.endpointId, model: ctx.model, bodyExcerpt: excerpt(body), status };

  if (status === 401 || status === 403) {
    return {
      ...base,
      kind: 'unauthorized',
      message: 'APIキーが拒否されました。設定の鍵を確認してください。',
    };
  }
  if (status === 404) {
    const m = ctx.model ? `モデル "${ctx.model}" ` : '';
    return {
      ...base,
      kind: 'model_not_found',
      message: `${m}が見つかりません（404）。モデル一覧を取り直してください。`,
    };
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(ctx.retryAfter);
    return {
      ...base,
      kind: 'rate_limited',
      message: retryAfterMs
        ? `混雑しています。${Math.ceil(retryAfterMs / 1000)}秒後に再試行してください。`
        : '混雑しています。しばらく待ってから再試行してください。',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  if (status >= 500) {
    return {
      ...base,
      kind: 'server_error',
      message: `サーバ側でエラーが発生しました（${status}）。`,
    };
  }
  if (status === 400 || status === 422) {
    return {
      ...base,
      kind: 'bad_request',
      message: `リクエストが拒否されました（${status}）。詳細を確認してください。`,
    };
  }
  // モデル名が本文に無いのに 404 以外で見つからないと言われる場合がある
  if (/model .*not found|no such model|unknown model/i.test(body)) {
    return {
      ...base,
      kind: 'model_not_found',
      message: 'サーバがモデルを見つけられませんでした。',
    };
  }
  return { ...base, kind: 'server_error', message: `想定外の応答です（HTTP ${status}）。` };
}

/** fetch が投げた例外を分類する。接続すらできていない場合。 */
export function classifyNetwork(
  err: unknown,
  ctx: { endpointId: string; model?: string; baseUrl: string },
): ProviderError {
  const e = err as { name?: string; code?: string; cause?: { code?: string }; message?: string };
  if (e?.name === 'AbortError') {
    return {
      kind: 'aborted',
      message: '中断しました。',
      endpointId: ctx.endpointId,
      model: ctx.model,
    };
  }
  const code = e?.code ?? e?.cause?.code ?? '';
  const detail = redact(String(e?.message ?? err));
  const hint = `${ctx.baseUrl} へ接続できません。サーバが起動しているか、URLが正しいか確認してください。`;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return {
      kind: 'unreachable',
      message: hint,
      endpointId: ctx.endpointId,
      model: ctx.model,
      bodyExcerpt: `${code}: ${detail}`,
    };
  }
  return {
    kind: 'unreachable',
    message: hint,
    endpointId: ctx.endpointId,
    model: ctx.model,
    bodyExcerpt: detail,
  };
}

export function providerError(
  kind: ProviderErrorKind,
  message: string,
  ctx: { endpointId: string; model?: string; bodyExcerpt?: string },
): ProviderError {
  return {
    kind,
    message,
    endpointId: ctx.endpointId,
    model: ctx.model,
    bodyExcerpt: ctx.bodyExcerpt,
  };
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** 接続確立前の失敗だけを自動再試行の対象にする（docs/spec/02-provider.md）。 */
export function isRetriableBeforeFirstByte(e: ProviderError): boolean {
  if (e.kind === 'server_error') return true;
  if (e.kind === 'unreachable') {
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/.test(e.bodyExcerpt ?? '');
  }
  return false;
}

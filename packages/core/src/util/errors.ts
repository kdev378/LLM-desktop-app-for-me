/**
 * Akari が意図的に投げるエラー。予期しない例外と区別できるようにする。
 * message は利用者に見せる前提で日本語。detail は診断向け。
 */
export class AkariError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly hint?: string;

  constructor(
    code: string,
    message: string,
    opts: { detail?: string; hint?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AkariError';
    this.code = code;
    this.detail = opts.detail;
    this.hint = opts.hint;
  }
}

export function isAkariError(e: unknown): e is AkariError {
  return e instanceof AkariError;
}

/** 何を投げられても、表示できる1行にする。 */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

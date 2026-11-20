/**
 * 出力の直前に通す伏字化。ログ・診断・エラー表示・--json のすべてが通る。
 * 仕様: docs/spec/09-security.md
 */

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI 形式
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // Authorization ヘッダの中身
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

/** 既知の秘密値。設定を読んだ時点で登録し、以後すべての出力から消す。 */
const known = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.trim().length >= 8) known.add(value);
}

export function forgetSecrets(): void {
  known.clear();
}

export function redact(input: string): string {
  let out = input;
  for (const secret of known) {
    if (secret && out.includes(secret)) out = out.split(secret).join('***');
  }
  for (const re of PATTERNS) out = out.replace(re, '***');
  return out;
}

/** オブジェクトの中の文字列をすべて伏字化する。ログの構造化フィールド用。 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 鍵らしい名前の項目は、値を見ずに落とす
      if (/^(authorization|api[-_]?key|apikey|token|password|secret)$/i.test(k)) {
        out[k] = '***';
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

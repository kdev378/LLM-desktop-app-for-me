/**
 * 対話画面の色（暫定）。仕様: docs/spec/17-interactive.md「色」
 *
 * 差し色は緑寄りの黄緑1色。端末の背景が白でも黒でも読めるよう、中くらいの明るさにする。
 * 色だけで意味を示さない（✓ / ✗ / ! を必ず付ける）。
 */

export type Tone =
  'normal' | 'dim' | 'bold' | 'accent' | 'info' | 'ok' | 'warn' | 'error' | 'add' | 'del' | 'hunk';

export const ACCENT = '#6BAF5A';

type Style = { color?: string; dimColor?: boolean; bold?: boolean };

const STYLES: Record<Tone, Style> = {
  normal: {},
  dim: { dimColor: true },
  bold: { bold: true },
  accent: { color: ACCENT },
  info: { color: '#5F9EB5' },
  ok: { color: ACCENT },
  warn: { color: '#C9952E' },
  error: { color: '#C4604F' },
  add: { color: ACCENT },
  del: { color: '#C4604F' },
  hunk: { color: '#5F9EB5' },
};

let colorEnabled = true;

export function setThemeColor(enabled: boolean): void {
  colorEnabled = enabled;
}

/** Ink の <Text> に渡す属性。色を切っているときも、太字と淡色は残す（意味は記号でも示す）。 */
export function styleOf(tone: Tone | undefined): Style {
  const s = STYLES[tone ?? 'normal'];
  if (colorEnabled) return s;
  const { color: _drop, ...rest } = s;
  return rest;
}

export function accentColor(): string | undefined {
  return colorEnabled ? ACCENT : undefined;
}

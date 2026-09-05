/**
 * 端末への出力。色は NO_COLOR と --no-color を尊重する。
 * 依存を足さずに済む範囲なので自前にしている。
 */

const ESC = String.fromCharCode(27);

let colorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColor(on: boolean): void {
  colorEnabled = on;
}

const wrap = (open: number, close: number) => (s: string) =>
  colorEnabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const isInteractive = (): boolean =>
  process.stdin.isTTY === true && process.stdout.isTTY === true;

export function out(line = ''): void {
  process.stdout.write(line + '\n');
}

export function write(text: string): void {
  process.stdout.write(text);
}

let notesEnabled = true;

/** --json / --quiet のときは人向けの補助情報を出さない。 */
export function setNotes(on: boolean): void {
  notesEnabled = on;
}

/** 人向けの補助情報。標準エラーへ出す。 */
export function note(line: string): void {
  if (!notesEnabled) return;
  process.stderr.write(c.gray(line) + '\n');
}

export function errorLine(message: string, detail?: string): void {
  process.stderr.write(c.red('エラー: ') + message + '\n');
  if (detail) process.stderr.write(c.gray(indent(detail)) + '\n');
}

export function hintLine(hint: string): void {
  process.stderr.write(c.gray('  → ' + hint) + '\n');
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** 全角を2桁として数える。日本語のモデル名や接続先名で桁がずれないように。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 表を桁揃えして出す。件数の多い一覧向け。 */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    });
  }
  const line = (row: string[]) =>
    row
      .map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(cell))))
      .join('  ')
      .trimEnd();
  const body = rows.map((r) => line(r));
  if (!headers) return body.join('\n');
  return [c.dim(line(headers)), ...body].join('\n');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}秒`;
}

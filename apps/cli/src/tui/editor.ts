import stringWidth from 'string-width';

/**
 * 入力欄の編集。画面から切り離して、キーごとの動きを試せるようにする。
 * 仕様: docs/spec/17-interactive.md「操作」
 *
 * cursor は text の中の位置（UTF-16 の添字）。サロゲートペア（絵文字など）の途中には置かない。
 */

export type EditorState = { text: string; cursor: number };

export const emptyEditor: EditorState = { text: '', cursor: 0 };

export function insert(s: EditorState, chunk: string): EditorState {
  // 貼り付けの CRLF / CR は改行1つにそろえる
  const clean = chunk.replace(/\r\n?/g, '\n');
  return {
    text: s.text.slice(0, s.cursor) + clean + s.text.slice(s.cursor),
    cursor: s.cursor + clean.length,
  };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const start = prevBoundary(s.text, s.cursor);
  return { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start };
}

export function del(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  const end = nextBoundary(s.text, s.cursor);
  return { text: s.text.slice(0, s.cursor) + s.text.slice(end), cursor: s.cursor };
}

export function left(s: EditorState): EditorState {
  return { ...s, cursor: prevBoundary(s.text, s.cursor) };
}

export function right(s: EditorState): EditorState {
  return { ...s, cursor: nextBoundary(s.text, s.cursor) };
}

/**
 * カーソルの直前が「\」なら、それを改行に置き換える（「\」+ Enter で改行）。
 * Shift+Enter を区別できない端末（macOS 標準のターミナル）でも、手を Enter から離さずに改行するため。
 * 直前が「\」でなければ null。
 */
export function backslashNewline(s: EditorState): EditorState | null {
  if (s.cursor === 0 || s.text[s.cursor - 1] !== '\\') return null;
  return { text: s.text.slice(0, s.cursor - 1) + '\n' + s.text.slice(s.cursor), cursor: s.cursor };
}

/** 今の行の先頭へ。 */
export function lineStart(s: EditorState): EditorState {
  return { ...s, cursor: s.text.lastIndexOf('\n', s.cursor - 1) + 1 };
}

/** 今の行の末尾へ。 */
export function lineEnd(s: EditorState): EditorState {
  const i = s.text.indexOf('\n', s.cursor);
  return { ...s, cursor: i === -1 ? s.text.length : i };
}

/** 行頭からカーソルまでを消す（Ctrl+U）。 */
export function killToLineStart(s: EditorState): EditorState {
  const start = s.text.lastIndexOf('\n', s.cursor - 1) + 1;
  return { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start };
}

export function isOnFirstLine(s: EditorState): boolean {
  return s.text.lastIndexOf('\n', s.cursor - 1) === -1;
}

export function isOnLastLine(s: EditorState): boolean {
  return s.text.indexOf('\n', s.cursor) === -1;
}

/** 上の行へ。表示の幅で同じくらいの位置へ。先頭行なら null（履歴へ回す）。 */
export function up(s: EditorState): EditorState | null {
  if (isOnFirstLine(s)) return null;
  const curStart = s.text.lastIndexOf('\n', s.cursor - 1) + 1;
  const prevStart = s.text.lastIndexOf('\n', curStart - 2) + 1;
  const col = stringWidth(s.text.slice(curStart, s.cursor));
  return { ...s, cursor: atColumn(s.text, prevStart, curStart - 1, col) };
}

/** 下の行へ。最終行なら null（履歴へ回す）。 */
export function down(s: EditorState): EditorState | null {
  if (isOnLastLine(s)) return null;
  const curStart = s.text.lastIndexOf('\n', s.cursor - 1) + 1;
  const nextStart = s.text.indexOf('\n', s.cursor) + 1;
  const nextEnd = s.text.indexOf('\n', nextStart);
  const col = stringWidth(s.text.slice(curStart, s.cursor));
  return {
    ...s,
    cursor: atColumn(s.text, nextStart, nextEnd === -1 ? s.text.length : nextEnd, col),
  };
}

function atColumn(text: string, start: number, end: number, col: number): number {
  let i = start;
  let w = 0;
  while (i < end) {
    const n = nextBoundary(text, i);
    const cw = stringWidth(text.slice(i, n));
    if (w + cw > col) break;
    w += cw;
    i = n;
  }
  return i;
}

function prevBoundary(text: string, i: number): number {
  if (i <= 0) return 0;
  const code = text.charCodeAt(i - 1);
  return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

function nextBoundary(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const code = text.charCodeAt(i);
  return code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? i + 2 : i + 1;
}

/**
 * 表示のための折り返し。各行を幅 width で折り、カーソルが何行目の何桁目かを返す。
 * 端末へカーソル位置を伝えるのに使う（日本語の変換中の文字をそこに出させるため）。
 * 全角は幅2で数える。
 */
export function layout(
  s: EditorState,
  width: number,
): { rows: string[]; cursorRow: number; cursorCol: number } {
  const w = Math.max(4, width);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = 0;
  let offset = 0;
  for (const line of s.text.split('\n')) {
    let row = '';
    let rowWidth = 0;
    let i = 0;
    const placeCursor = (at: number) => {
      if (s.cursor === at) {
        cursorRow = rows.length;
        cursorCol = rowWidth;
      }
    };
    while (i < line.length) {
      placeCursor(offset + i);
      const n = nextBoundary(line, i);
      const ch = line.slice(i, n);
      const cw = stringWidth(ch);
      if (rowWidth + cw > w) {
        rows.push(row);
        row = '';
        rowWidth = 0;
        placeCursor(offset + i);
      }
      row += ch;
      rowWidth += cw;
      i = n;
    }
    placeCursor(offset + line.length);
    // 行末ちょうどで幅いっぱいなら、カーソルは次の行の先頭に出す
    if (s.cursor === offset + line.length && rowWidth >= w) {
      rows.push(row);
      row = '';
      rowWidth = 0;
      cursorRow = rows.length;
      cursorCol = 0;
    }
    rows.push(row);
    offset += line.length + 1;
  }
  return { rows, cursorRow, cursorCol };
}

/** 送信の履歴。↑↓ でたどる。たどる前の書きかけは残しておき、戻ってきたら返す。 */
export class InputHistory {
  private items: string[] = [];
  private index: number | null = null;
  private draft = '';

  push(text: string): void {
    if (text.trim() === '') return;
    if (this.items.at(-1) !== text) this.items.push(text);
    if (this.items.length > 200) this.items.shift();
    this.index = null;
  }

  prev(current: string): string | null {
    if (this.items.length === 0) return null;
    if (this.index === null) {
      this.draft = current;
      this.index = this.items.length - 1;
    } else if (this.index > 0) {
      this.index -= 1;
    } else {
      return null;
    }
    return this.items[this.index]!;
  }

  next(): string | null {
    if (this.index === null) return null;
    if (this.index < this.items.length - 1) {
      this.index += 1;
      return this.items[this.index]!;
    }
    this.index = null;
    return this.draft;
  }

  reset(): void {
    this.index = null;
  }
}

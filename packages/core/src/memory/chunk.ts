/**
 * チャンクの切り方 lines-v1。仕様: docs/spec/14-memory.md「チャンクの切り方」
 * 行単位で切る。言語ごとの構文解析はしない。
 */

export const CHUNK_STRATEGY = 'lines-v1';

export type Chunk = { path: string; startLine: number; endLine: number; text: string };

export function chunkText(
  relative: string,
  content: string,
  opts: { maxChars: number; overlapChars: number },
): Chunk[] {
  const maxChars = Math.max(50, opts.maxChars);
  const overlap = Math.min(opts.overlapChars, Math.floor(maxChars / 2));
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.every((l) => l.trim() === '')) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    // 1行だけで上限を超える（圧縮された JS など）は、例外として行の中で切る
    if (lines[start]!.length > maxChars) {
      const line = lines[start]!;
      for (let i = 0; i < line.length; i += maxChars - overlap) {
        chunks.push({
          path: relative,
          startLine: start + 1,
          endLine: start + 1,
          text: line.slice(i, i + maxChars),
        });
        if (i + maxChars >= line.length) break;
      }
      start++;
      continue;
    }
    // 最初の1行は必ず入れる（上限ちょうどの行でも前へ進むため）
    let end = start + 1;
    let size = lines[start]!.length + 1;
    while (
      end < lines.length &&
      lines[end]!.length <= maxChars &&
      size + lines[end]!.length + 1 <= maxChars
    ) {
      size += lines[end]!.length + 1;
      end++;
    }
    const text = lines.slice(start, end).join('\n');
    if (text.trim() !== '')
      chunks.push({ path: relative, startLine: start + 1, endLine: end, text });
    if (end >= lines.length) break;
    // 次が上限を超える1行なら、重ねずにそこから（重ねると小さな重複のチャンクができる）
    if (lines[end]!.length > maxChars) {
      start = end;
      continue;
    }
    // 重なり: 末尾から overlap 文字ぶんの行を、次のチャンクの頭に含める（必ず前へ進む）
    let back = end;
    let kept = 0;
    while (back - 1 > start && kept + lines[back - 1]!.length + 1 <= overlap) {
      back--;
      kept += lines[back]!.length + 1;
    }
    start = back;
  }
  return chunks;
}

/** 埋め込むときの本文。ファイル名と行番号を先頭に付ける（ファイル名自体が手がかりになる）。 */
export function embedText(c: Chunk): string {
  return `// ${c.path}:${c.startLine}-${c.endLine}\n${c.text}`;
}

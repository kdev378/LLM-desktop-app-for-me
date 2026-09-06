/**
 * 本文に混ざる思考ブロックを切り分ける。
 *
 * Qwen3 系などの推論モデルは、思考を `reasoning_content` という別項目で返すことも、
 * `<think>…</think>` として本文にそのまま混ぜることもある。
 * 後者を素通しすると、
 *   - 回答にタグごと表示される
 *   - 代替方式（docs/spec/02-provider.md）で、思考の中の記述までツール呼び出しとして拾う
 * ので、受け取った時点で分けておく。
 *
 * ストリームなのでタグがチャンクの途中で割れる。状態を持って解釈する。
 */

const TAGS = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
] as const;

/**
 * 末尾のうち、タグの途中かもしれない分の長さ。ここだけを次のチャンクまで保留する。
 *
 * 常に固定長を保留すると、タグが無い普通の応答でも出力が遅れて塊になる。
 * ストリームの手応えが落ちるので、本当にタグの前半に見えるときだけ待つ。
 */
function pendingLen(buf: string, candidates: readonly string[]): number {
  const longest = Math.max(...candidates.map((c) => c.length));
  const max = Math.min(buf.length, longest - 1);
  for (let k = max; k >= 1; k--) {
    const tail = buf.slice(buf.length - k);
    for (const c of candidates) {
      if (c.length > k && c.startsWith(tail)) return k;
    }
  }
  return 0;
}

export type SplitResult = { text: string; reasoning: string };

export class ThinkSplitter {
  private buf = '';
  private closeTag: string | null = null;

  /** チャンクを渡し、確定した分だけを本文と思考に分けて返す。 */
  push(chunk: string): SplitResult {
    this.buf += chunk;
    let text = '';
    let reasoning = '';

    for (;;) {
      if (this.closeTag === null) {
        const hit = firstIndexOfAny(
          this.buf,
          TAGS.map((t) => t.open),
        );
        if (hit === null) {
          // 開始タグの前半に見える末尾だけ残す。それ以外はすぐ流す。
          const keep = pendingLen(
            this.buf,
            TAGS.map((t) => t.open),
          );
          text += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return { text, reasoning };
        }
        text += this.buf.slice(0, hit.index);
        this.buf = this.buf.slice(hit.index + hit.value.length);
        this.closeTag = TAGS.find((t) => t.open === hit.value)!.close;
      } else {
        const at = this.buf.indexOf(this.closeTag);
        if (at === -1) {
          const keep = pendingLen(this.buf, [this.closeTag]);
          reasoning += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return { text, reasoning };
        }
        reasoning += this.buf.slice(0, at);
        this.buf = this.buf.slice(at + this.closeTag.length);
        this.closeTag = null;
      }
    }
  }

  /**
   * ストリーム終了時に、バッファに残った分を取り出す。
   * 閉じタグが来ないまま終わった場合、その分は思考として扱う（本文へ混ぜない）。
   */
  flush(): SplitResult {
    const rest = this.buf;
    this.buf = '';
    if (this.closeTag !== null) return { text: '', reasoning: rest };
    return { text: rest, reasoning: '' };
  }

  /** 閉じタグ待ちのまま終わったか。診断に使う。 */
  get unterminated(): boolean {
    return this.closeTag !== null;
  }
}

function firstIndexOfAny(
  haystack: string,
  needles: readonly string[],
): { index: number; value: string } | null {
  let best: { index: number; value: string } | null = null;
  for (const n of needles) {
    const i = haystack.indexOf(n);
    if (i !== -1 && (best === null || i < best.index)) best = { index: i, value: n };
  }
  return best;
}

/**
 * Server-Sent Events の逐次解釈。仕様: docs/spec/02-provider.md
 *
 * サーバによって改行が \n / \r\n で揺れる。data が複数行に分かれることもある。
 * チャンク境界がイベントの途中に来ても壊れないよう、状態を持って解釈する。
 */

export type SseEvent = { data: string; event?: string };

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** 受け取ったチャンクから、完成したイベントだけを返す。 */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];

    // 行単位に切り出す。最後の不完全な行はバッファに残す。
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        const ev = this.complete();
        if (ev) out.push(ev);
        continue;
      }
      if (line.startsWith(':')) continue; // コメント行

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') this.dataLines.push(value);
      else if (field === 'event') this.eventName = value;
      // id / retry は使わない
    }
    return out;
  }

  /** ストリーム終了時に、末尾の改行が無いまま残ったイベントを取り出す。 */
  flush(): SseEvent[] {
    if (this.buffer.length > 0) {
      const rest = this.buffer;
      this.buffer = '';
      // 末尾の1行を通常の行として処理してから完成させる
      for (const ev of this.push(rest + '\n')) return [ev];
    }
    const ev = this.complete();
    return ev ? [ev] : [];
  }

  private complete(): SseEvent | null {
    if (this.dataLines.length === 0 && this.eventName === undefined) return null;
    const ev: SseEvent = { data: this.dataLines.join('\n') };
    if (this.eventName !== undefined) ev.event = this.eventName;
    this.dataLines = [];
    this.eventName = undefined;
    return ev;
  }
}

/**
 * ツール呼び出しの断片を index ごとに連結する。
 * arguments は断片で届くため、完了するまで JSON として解釈しない。
 */
export type ToolCallAccumulator = {
  index: number;
  id: string;
  name: string;
  argumentsRaw: string;
};

export class ToolCallBuffer {
  private byIndex = new Map<number, ToolCallAccumulator>();

  add(delta: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): void {
    const index = delta.index ?? 0;
    const cur = this.byIndex.get(index) ?? { index, id: '', name: '', argumentsRaw: '' };
    if (delta.id) cur.id = delta.id;
    if (delta.function?.name) cur.name += delta.function.name;
    if (delta.function?.arguments) cur.argumentsRaw += delta.function.arguments;
    this.byIndex.set(index, cur);
  }

  /** index の順で確定した呼び出しを返す。id が無いサーバのために連番で補う。 */
  finish(): ToolCallAccumulator[] {
    const list = [...this.byIndex.values()].sort((a, b) => a.index - b.index);
    return list.map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  }

  get size(): number {
    return this.byIndex.size;
  }
}

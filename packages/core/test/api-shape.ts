import assert from 'node:assert/strict';
import type { ChatMessage } from '../dist/index.js';

/** OpenAI互換APIが受け付ける並びか。呼び出しの直後に、その結果が全部並んでいること。 */
export function assertValidForApi(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') assert.fail(`${i}番目: 呼び出しの無い結果がある`);
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const want = new Set(m.toolCalls.map((c) => c.id));
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      assert.ok(want.delete(messages[j]!.toolCallId!), `${j}番目: 知らない呼び出しへの結果`);
      j++;
    }
    assert.equal(want.size, 0, `${i}番目の呼び出しに結果が無い: ${[...want].join(', ')}`);
    i = j - 1;
  }
}

import { formatPromptedResult } from '../agent/prompt.js';
import type { ChatMessage } from '../provider/types.js';
import { textOf, type StoredMessage } from './conversations.js';

/**
 * 保存した道筋から、モデルへ送るメッセージを組み立てる。仕様: docs/spec/04-chat.md「送信の流れ」
 *
 * - 思考出力は送らない
 * - 道具の結果は、呼ばれたときの形で再現する（本文ブロックなら利用者メッセージ、
 *   関数呼び出しなら role:"tool"）。今の接続先の方式とは関係ない
 * - 失敗した応答は送らない
 * - 結果の無い関数呼び出しには「実行されませんでした」を補う。
 *   無いまま送ると OpenAI互換APIは 400 を返す
 *
 * システムプロンプトは含めない（呼び出し側が毎回作る）。
 *
 * `dropFailedTurns`: 失敗した応答の直前の利用者メッセージも外す（chat 用）。
 * chat は失敗した往復を文脈から外す。利用者とモデルが交互でないと断るモデル（Gemma 系など）があるため。
 * エージェントの実行では外さない。外すと「何を頼んだか」ごと消え、続きを頼めなくなる。
 */
export function toApiMessages(
  thread: StoredMessage[],
  opts: { dropFailedTurns?: boolean } = {},
): ChatMessage[] {
  const out: ChatMessage[] = [];
  // 直前の応答が出した関数呼び出しのうち、まだ結果が来ていないもの（呼ばれた順）
  let pending: Array<{ id: string; name: string }> = [];

  const flush = () => {
    for (const c of pending) {
      out.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: '実行されませんでした（実行が途中で終わったため）。',
      });
    }
    pending = [];
  };

  for (const m of thread) {
    if (m.role === 'tool') {
      if (m.origin === 'prompted') {
        out.push({
          role: 'user',
          content: formatPromptedResult(m.toolName ?? '', m.ok === true, textOf(m.content)),
        });
        continue;
      }
      // 対応する呼び出しが無い結果は送らない（送ると 400 になる）
      const i = pending.findIndex((c) => c.id === m.toolCallId);
      if (i < 0) continue;
      pending.splice(i, 1);
      out.push({
        role: 'tool',
        toolCallId: m.toolCallId ?? '',
        name: m.toolName ?? '',
        content: textOf(m.content),
      });
      continue;
    }

    flush();
    if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m.content) });
      continue;
    }
    // assistant
    if (m.meta.error) {
      const prev = out.at(-1);
      if (opts.dropFailedTurns && prev?.role === 'user') out.pop();
      continue;
    }
    const native = (m.toolCalls ?? []).filter((c) => c.origin === 'native');
    const text = textOf(m.content);
    if (text === '' && native.length === 0) continue;
    out.push({
      role: 'assistant',
      content: text,
      ...(native.length > 0
        ? {
            toolCalls: native.map((c) => ({
              id: c.id,
              name: c.name,
              argumentsRaw: c.argumentsRaw,
            })),
          }
        : {}),
    });
    pending = native.map((c) => ({ id: c.id, name: c.name }));
  }
  flush();
  return out;
}

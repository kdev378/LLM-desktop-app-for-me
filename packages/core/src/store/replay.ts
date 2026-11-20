import { buildApiMessages, type TranscriptEntry } from '../agent/transcript.js';
import type { ChatMessage } from '../provider/types.js';
import { textOf, type StoredMessage } from './conversations.js';

/**
 * 保存したメッセージを、実行エンジンが持つ生の記録の形へ移す。
 * 組み立ての規則は buildApiMessages（agent/transcript.ts）に一本化してある。
 */
export function toTranscript(thread: StoredMessage[]): TranscriptEntry[] {
  return thread.map((m) => ({
    id: m.id,
    role: m.role,
    text: textOf(m.content),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
    ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
    ...(m.ok !== undefined ? { ok: m.ok } : {}),
    ...(m.origin !== undefined ? { origin: m.origin } : {}),
    ...(m.meta.source ? { source: m.meta.source } : {}),
    ...(m.meta.error ? { failed: true } : {}),
  }));
}

/** 保存した道筋から、モデルへ送るメッセージを組み立てる（システムプロンプトは含めない）。 */
export function toApiMessages(
  thread: StoredMessage[],
  opts: { dropFailedTurns?: boolean } = {},
): ChatMessage[] {
  return buildApiMessages(toTranscript(thread), opts);
}

import type { FinishReason, ProviderError, ToolCallRequest, Usage } from '../provider/types.js';
import type { RunEndReason } from './events.js';
import type { Compaction } from '../context/digest.js';

/**
 * 実行エンジンが、やり取りを記録係へ渡すための口。仕様: docs/spec/04-chat.md
 *
 * Session はファイルのことを知らない。メッセージが1件できるたびにここへ渡すだけ。
 * CLI・ハーネスAPI・デスクトップは同じ記録係（store）を差し込む。
 * どこかで保存し忘れる、ということを起こさないため。
 */

export type RecordedToolCall = ToolCallRequest & { origin: 'native' | 'prompted' };

/**
 * 記録する1件。`id` は実行エンジンが振る（ULID）。保存しない場合も同じ ID で
 * 生の記録を持つので、圧縮の根拠（sources）を指せる。
 */
export type RecordedMessage = { id: string } & (
  | {
      role: 'user';
      text: string;
      /** Akari がモデルへ伝えた文（形式の誤りの指摘など）。利用者の発言ではない。 */
      source?: 'akari';
    }
  | {
      role: 'assistant';
      text: string;
      reasoning?: string;
      toolCalls?: RecordedToolCall[];
      finishReason?: FinishReason;
      usage?: Usage;
      error?: ProviderError;
      durationMs?: number;
      step: number;
    }
  | {
      role: 'tool';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      content: string;
      origin: 'native' | 'prompted';
      /** 実行されなかった呼び出しに Akari が付けた結果。 */
      synthetic?: 'aborted' | 'dropped';
      step: number;
    }
);

export type InflightPartial = { text: string; reasoning: string; step: number };

export interface ConversationRecorder {
  runStarted(runId: string): Promise<void>;
  record(runId: string, message: RecordedMessage): Promise<void>;
  /** 生成中の途中経過。null で消す。 */
  inflight(runId: string, partial: InflightPartial | null): Promise<void>;
  runEnded(runId: string, reason: RunEndReason): Promise<void>;
  /** 文脈を圧縮した。会話の見出しに残す（生のメッセージは消さない）。 */
  compacted(compaction: Compaction): Promise<void>;
}

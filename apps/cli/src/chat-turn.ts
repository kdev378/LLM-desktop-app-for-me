import {
  ulid,
  type ChatEvent,
  type ChatMessage,
  type ConversationRecorder,
  type FinishReason,
  type Provider,
  type ProviderError,
  type ReasoningLevel,
  type Usage,
} from '@akari/core';

/**
 * 道具なしの1往復。ヘッドレス（akari chat）と、対話画面の道具なしの会話
 * （docs/spec/17-interactive.md「作業フォルダにできない場所で起動したとき」）で共有する。
 * 画面には何も出さず、起きたことを順に返す。表示は呼び出し側が決める。
 *
 * messages には送る文脈を渡す。最後は利用者の発言であること。
 * 終わると応答を messages に足す（失敗して何も届かなければ足さない）。
 */

export type ChatParams = {
  temperature: number;
  maxTokens: number | null;
  reasoning?: ReasoningLevel;
};

export type ChatRecord = {
  recorder: ConversationRecorder;
  save: (task: () => Promise<unknown>) => Promise<void>;
};

export type ChatTurnEvent =
  /** サーバから届いたそのままの出来事。--json はこれを出す（形を変えない）。 */
  | { type: 'provider'; event: ChatEvent }
  /** 送ったものが通らなかったなど、黙らずに伝えること。 */
  | { type: 'notice'; message: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'done';
      reason: FinishReason;
      usage?: Usage;
      text: string;
      reasoning: string;
      durationMs: number;
      firstTokenMs: number | null;
    }
  | {
      type: 'error';
      error: ProviderError;
      text: string;
      reasoning: string;
      durationMs: number;
    };

export async function* chatTurn(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  params: ChatParams,
  signal?: AbortSignal,
  record?: ChatRecord,
): AsyncGenerator<ChatTurnEvent, void, void> {
  const started = Date.now();
  let text = '';
  let reasoning = '';
  let firstTokenAt: number | null = null;
  // 1往復を1つの実行として記録する。終わり方を run と同じ形で残すため
  const turnId = ulid();
  const userText = messages.at(-1)?.content ?? '';
  let lastInflightAt = Date.now();
  const saveInflight = async () => {
    if (!record || Date.now() - lastInflightAt < 1000) return;
    lastInflightAt = Date.now();
    await record.save(() => record.recorder.inflight(turnId, { text, reasoning, step: 1 }));
  };
  if (record) {
    await record.save(() => record.recorder.runStarted(turnId));
    await record.save(() =>
      record.recorder.record(turnId, { id: ulid(), role: 'user', text: userText }),
    );
  }

  for await (const ev of provider.chat(
    {
      model,
      messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    },
    signal,
  )) {
    yield { type: 'provider', event: ev };
    switch (ev.type) {
      case 'notice':
        yield { type: 'notice', message: ev.message };
        break;
      case 'text-delta':
        firstTokenAt ??= Date.now();
        text += ev.text;
        yield { type: 'text', text: ev.text };
        await saveInflight();
        break;
      case 'reasoning-delta':
        firstTokenAt ??= Date.now();
        reasoning += ev.text;
        yield { type: 'reasoning', text: ev.text };
        await saveInflight();
        break;
      case 'finish': {
        messages.push({ role: 'assistant', content: text });
        if (record) {
          await record.save(() =>
            record.recorder.record(turnId, {
              id: ulid(),
              role: 'assistant',
              text,
              ...(reasoning ? { reasoning } : {}),
              finishReason: ev.reason,
              ...(ev.usage ? { usage: ev.usage } : {}),
              durationMs: Date.now() - started,
              step: 1,
            }),
          );
          await record.save(() => record.recorder.inflight(turnId, null));
          await record.save(() =>
            record.recorder.runEnded(turnId, ev.reason === 'aborted' ? 'aborted' : 'done'),
          );
        }
        yield {
          type: 'done',
          reason: ev.reason,
          ...(ev.usage ? { usage: ev.usage } : {}),
          text,
          reasoning,
          durationMs: Date.now() - started,
          firstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
        };
        return;
      }
      case 'error': {
        if (text !== '') messages.push({ role: 'assistant', content: text });
        if (record) {
          const aborted = ev.error.kind === 'aborted';
          await record.save(() =>
            record.recorder.record(turnId, {
              id: ulid(),
              role: 'assistant',
              text,
              ...(reasoning ? { reasoning } : {}),
              ...(aborted ? { finishReason: 'aborted' as const } : { error: ev.error }),
              durationMs: Date.now() - started,
              step: 1,
            }),
          );
          await record.save(() => record.recorder.inflight(turnId, null));
          await record.save(() => record.recorder.runEnded(turnId, aborted ? 'aborted' : 'error'));
        }
        yield { type: 'error', error: ev.error, text, reasoning, durationMs: Date.now() - started };
        return;
      }
      default:
        break;
    }
  }
}

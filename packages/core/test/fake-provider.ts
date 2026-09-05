import type { ChatEvent, ChatRequest, ModelInfo, Provider } from '../dist/index.js';

/**
 * 台本どおりに応答する Provider。エージェントの実行ループを、
 * ネットワークもモデルも無しで確かめるために使う。
 */

export type Scripted =
  | { text: string }
  | { tool: string; args: unknown; id?: string }
  | { tools: Array<{ tool: string; args: unknown; id?: string }> }
  | { error: 'unreachable' | 'bad_request' };

export function fakeProvider(script: Scripted[]): Provider & { calls: ChatRequest[] } {
  let turn = 0;
  const calls: ChatRequest[] = [];

  return {
    endpointId: 'ep_fake',
    calls,
    async listModels(): Promise<ModelInfo[]> {
      return [{ id: 'fake-model' }];
    },
    async probe() {
      return {
        reachable: true,
        models: [{ id: 'fake-model' }],
        tools: 'native' as const,
        usageReported: false,
        streamsToolCalls: true,
        testedModel: 'fake-model',
        notes: [],
      };
    },
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
      calls.push(req);
      const step = script[turn++] ?? { text: '（台本の終わり）' };
      yield { type: 'start', model: req.model };

      if ('error' in step) {
        yield {
          type: 'error',
          error: { kind: step.error, message: `擬似エラー: ${step.error}`, endpointId: 'ep_fake' },
        };
        return;
      }
      if ('text' in step) {
        for (const piece of chunk(step.text)) yield { type: 'text-delta', text: piece };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      const list = 'tools' in step ? step.tools : [step];
      for (const [i, t] of list.entries()) {
        yield {
          type: 'tool-call',
          id: t.id ?? `call_${turn}_${i}`,
          name: t.tool,
          argumentsRaw: JSON.stringify(t.args),
        };
      }
      yield { type: 'finish', reason: 'tool_calls' };
    },
  };
}

function chunk(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 5) out.push(s.slice(i, i + 5));
  return out.length > 0 ? out : [''];
}

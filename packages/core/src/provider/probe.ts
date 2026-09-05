import { getProviderError } from './openai.js';
import type { EndpointProbeResult, Provider, ProviderError, ToolDefinition } from './types.js';

/**
 * 接続先の実力を調べる。仕様: docs/spec/02-provider.md
 *
 * 判定は「その時点のモデルに対する結果」であることを notes に必ず書く。
 * 判定できなかったものを、できたことにしない。
 */

const PROBE_TOOL: ToolDefinition = {
  name: 'akari_probe_number',
  description: 'テスト用。呼び出すと固定の数値を返す。',
  parameters: {
    type: 'object',
    properties: { label: { type: 'string', description: '任意のラベル' } },
    required: [],
  },
};

export async function probeEndpoint(
  provider: Provider,
  endpointId: string,
  model?: string,
  signal?: AbortSignal,
): Promise<EndpointProbeResult> {
  const notes: string[] = [];

  // 1. /models
  let models;
  try {
    models = await provider.listModels(signal);
  } catch (err) {
    const pe = getProviderError(err);
    return {
      reachable: false,
      models: [],
      tools: 'none',
      usageReported: false,
      streamsToolCalls: false,
      testedModel: null,
      notes: ['/models を取得できませんでした。これ以降の判定は行っていません。'],
      error: pe ?? ({ kind: 'unreachable', message: String(err), endpointId } as ProviderError),
    };
  }
  notes.push(`/models: ${models.length}件`);

  const testedModel = model ?? models[0]?.id ?? null;
  if (!testedModel) {
    return {
      reachable: true,
      models,
      tools: 'none',
      usageReported: false,
      streamsToolCalls: false,
      testedModel: null,
      notes: [...notes, 'モデルが1件も無いため、生成とツールの判定はできていません。'],
    };
  }

  // 2. ツール呼び出しを1つだけ渡して、呼ばれるかを見る
  let sawToolCall = false;
  let sawText = false;
  let usageReported = false;
  let error: ProviderError | undefined;
  let rejectedTools = false;

  try {
    for await (const ev of provider.chat(
      {
        model: testedModel,
        messages: [
          {
            role: 'system',
            content: 'あなたはツールを使う助手です。必要なら必ずツールを呼びます。',
          },
          { role: 'user', content: 'akari_probe_number を呼んで、その結果を教えてください。' },
        ],
        tools: [PROBE_TOOL],
        maxTokens: 64,
        temperature: 0,
      },
      signal,
    )) {
      if (ev.type === 'tool-call') sawToolCall = true;
      else if (ev.type === 'text-delta') sawText = true;
      else if (ev.type === 'finish' && ev.usage) usageReported = true;
      else if (ev.type === 'error') {
        error = ev.error;
        if (ev.error.kind === 'bad_request' && /tool|function/i.test(ev.error.bodyExcerpt ?? '')) {
          rejectedTools = true;
        }
        break;
      }
    }
  } catch (err) {
    error = getProviderError(err) ?? undefined;
  }

  let tools: EndpointProbeResult['tools'];
  if (sawToolCall) {
    tools = 'native';
    notes.push(`ツール呼び出し: 対応（${testedModel} で確認）`);
  } else if (rejectedTools) {
    tools = 'prompted';
    notes.push('ツール呼び出し: サーバが tools 引数を拒否。代替方式（prompted）になります。');
  } else if (error) {
    tools = 'none';
    notes.push(`ツール判定: 生成でエラーが出たため判定できていません（${error.message}）`);
  } else if (sawText) {
    tools = 'prompted';
    notes.push('ツール呼び出し: 呼ばれず本文だけが返りました。代替方式（prompted）になります。');
  } else {
    tools = 'none';
    notes.push('ツール判定: 応答が空でした。判定できていません。');
  }

  notes.push(
    usageReported
      ? 'トークン数: サーバが報告します'
      : 'トークン数: サーバが報告しないため概算になります',
  );
  notes.push('この判定は上のモデルに対する結果です。別のモデルでは変わることがあります。');

  return {
    reachable: true,
    models,
    tools,
    usageReported,
    streamsToolCalls: sawToolCall,
    testedModel,
    notes,
    ...(error ? { error } : {}),
  };
}

/**
 * 使うモデルに対して、ツール呼び出しの方式を確定させる。
 *
 * `capabilities.tools` が `auto` のまま実行すると、ツール非対応のモデルへ
 * ネイティブのツール定義を渡し、モデルが何も呼ばずに終わる（＝何も起きない）。
 * それを避けるため、未判定なら実行前に1度だけ判定する。
 *
 * 判定はモデルごとに変わる（docs/spec/02-provider.md）ので、
 * 前に判定したモデルと違うときも判定し直す。
 */
export type ToolsModeResolution = {
  mode: 'native' | 'prompted' | 'none';
  /** 今回あらためて判定したか。false なら保存済みの値をそのまま使った。 */
  probed: boolean;
  notes: string[];
  /** 判定した場合、保存すべき新しい capabilities。 */
  capabilities?: {
    tools: 'native' | 'prompted' | 'none';
    usageReported: boolean;
    streamsToolCalls: boolean;
    probedAt: string;
    probedModel: string;
  };
};

export async function resolveToolsMode(
  provider: Provider,
  current: { tools: 'auto' | 'native' | 'prompted' | 'none'; probedModel: string | null },
  model: string,
  signal?: AbortSignal,
): Promise<ToolsModeResolution> {
  const needsProbe = current.tools === 'auto' || current.probedModel !== model;
  if (!needsProbe) {
    return { mode: current.tools as 'native' | 'prompted' | 'none', probed: false, notes: [] };
  }

  const why =
    current.tools === 'auto'
      ? 'ツール呼び出しへの対応が未判定のため'
      : `前回の判定は ${current.probedModel} に対するものだったため`;

  const result = await probeEndpoint(provider, provider.endpointId, model, signal);
  if (!result.reachable) {
    // 判定できなかった。動くふりをせず、そのまま伝える。
    return {
      mode: 'none',
      probed: false,
      notes: [`${why}判定を試みましたが、接続先に到達できませんでした。`],
    };
  }

  return {
    mode: result.tools,
    probed: true,
    notes: [`${why}、${model} で判定しました: ${describeMode(result.tools)}`, ...result.notes],
    capabilities: {
      tools: result.tools,
      usageReported: result.usageReported,
      streamsToolCalls: result.streamsToolCalls,
      probedAt: new Date().toISOString(),
      probedModel: model,
    },
  };
}

function describeMode(mode: 'native' | 'prompted' | 'none'): string {
  if (mode === 'native') return 'ツール呼び出しに対応';
  if (mode === 'prompted') return '非対応のため代替方式（prompted）を使います';
  return '判定できませんでした';
}

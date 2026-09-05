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
  /** 判定した場合、保存すべき新しい capabilities（最後に判定したモデルの写し）。 */
  capabilities?: {
    tools: 'native' | 'prompted' | 'none';
    usageReported: boolean;
    streamsToolCalls: boolean;
    probedAt: string;
    probedModel: string;
  };
  /** 判定した場合、byModel へ足すべき1件。 */
  modelCapability?: {
    model: string;
    value: {
      tools: 'native' | 'prompted' | 'none';
      usageReported: boolean;
      streamsToolCalls: boolean;
      probedAt: string;
    };
  };
};

export async function resolveToolsMode(
  provider: Provider,
  current: {
    tools: 'auto' | 'native' | 'prompted' | 'none';
    probedModel: string | null;
    byModel?: Record<string, { tools: 'native' | 'prompted' | 'none' }>;
  },
  model: string,
  signal?: AbortSignal,
): Promise<ToolsModeResolution> {
  // このモデルを前に判定していれば、それを使う。行き来しても判定し直さない。
  const remembered = current.byModel?.[model];
  if (remembered) {
    return { mode: remembered.tools, probed: false, notes: [] };
  }
  // 記録が無くても、最後の判定が同じモデルに対するものならそれで足りる（古い設定との互換）
  if (current.tools !== 'auto' && current.probedModel === model) {
    return { mode: current.tools, probed: false, notes: [] };
  }

  const why =
    current.tools === 'auto' && current.probedModel === null
      ? 'ツール呼び出しへの対応が未判定のため'
      : `${model} はまだ判定していないため`;

  // Provider の口を通す。中身は probeEndpoint と同じだが、
  // インターフェース越しにしておくと差し替えと検証がしやすい。
  const result = await provider.probe(model, signal);
  if (!result.reachable) {
    // 判定できなかった。動くふりをせず、そのまま伝える。
    return {
      mode: 'none',
      probed: false,
      notes: [`${why}判定を試みましたが、接続先に到達できませんでした。`],
    };
  }

  const probedAt = new Date().toISOString();
  return {
    mode: result.tools,
    probed: true,
    notes: [`${why}、${model} で判定しました: ${describeMode(result.tools)}`, ...result.notes],
    capabilities: {
      tools: result.tools,
      usageReported: result.usageReported,
      streamsToolCalls: result.streamsToolCalls,
      probedAt,
      probedModel: model,
    },
    modelCapability: {
      model,
      value: {
        tools: result.tools,
        usageReported: result.usageReported,
        streamsToolCalls: result.streamsToolCalls,
        probedAt,
      },
    },
  };
}

function describeMode(mode: 'native' | 'prompted' | 'none'): string {
  if (mode === 'native') return 'ツール呼び出しに対応';
  if (mode === 'prompted') return '非対応のため代替方式（prompted）を使います';
  return '判定できませんでした';
}

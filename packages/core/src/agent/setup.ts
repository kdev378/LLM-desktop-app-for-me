import { resolveToolsMode } from '../provider/probe.js';
import { updateEndpoint } from '../config/endpoints.js';
import type { Config } from '../config/schema.js';
import type { ResolvedEndpoint } from '../config/endpoints.js';
import type { Provider } from '../provider/types.js';
import { ALL_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import type { PermissionMode, ToolsMode } from './events.js';

/**
 * 実行の下ごしらえ。CLI（run・対話画面）とハーネスAPI（docs/spec/12-harness-api.md）で共有する。
 * 使い口によって、同じモデルへ違う道具の渡し方をしないため。
 */

/** 渡す道具の範囲。 */
export type ToolScope = 'all' | 'read-only' | 'off';

export function toolNamesFor(scope: ToolScope): string[] {
  return scope === 'off' ? [] : scope === 'read-only' ? READ_ONLY_TOOL_NAMES : ALL_TOOL_NAMES;
}

/**
 * MCP の道具のうち、その範囲で渡すもの（docs/spec/13-mcp.md）。
 * 読み取りのみの実行には、読み取りの注釈がある道具だけを渡す（注釈はサーバの自己申告）。
 */
export function mcpToolsFor(tools: ToolSpec[], scope: ToolScope): ToolSpec[] {
  return scope === 'off'
    ? []
    : scope === 'read-only'
      ? tools.filter((t) => t.risk === 'read')
      : tools;
}

/** 権限の表記ゆれを受ける（ask / auto-edit / autoEdit / full）。読めなければ null。 */
export function parsePermission(raw: string): PermissionMode | null {
  const map: Record<string, PermissionMode> = {
    ask: 'ask',
    'auto-edit': 'autoEdit',
    autoedit: 'autoEdit',
    autoEdit: 'autoEdit',
    full: 'full',
  };
  return map[raw] ?? null;
}

export type ToolsModeDecision = {
  /** 判定の結果そのもの（none もありうる）。表示に使う。 */
  mode: ToolsMode | 'none';
  /** 実際に使う渡し方。none は「測れなかった」なので両対応で試す。 */
  effective: ToolsMode;
  /** 判定の経過として人へ見せること。 */
  notes: string[];
  /** 判定結果を保存できなかったなど、黙らずに伝えること。 */
  warnings: string[];
};

/**
 * 道具の渡し方を確定させる。未判定なら判定し、結果を接続先に保存する（save）。
 * 未判定のまま非対応モデルへネイティブのツール定義を渡すと、
 * モデルが何も呼ばず「何も起きずに終わった」ように見えてしまう。
 * 明示されていれば判定そのものを省く（無駄な呼び出しを1回減らす）。
 */
export async function decideToolsMode(opts: {
  config: Config;
  endpoint: ResolvedEndpoint;
  provider: Provider;
  model: string;
  toolNames: string[];
  forced: ToolsMode | null;
  /** 判定結果を入れた設定を保存する。失敗しても実行は続ける（warnings に出す）。 */
  save: (next: Config) => Promise<void>;
  signal?: AbortSignal;
}): Promise<ToolsModeDecision> {
  const { endpoint, model } = opts;
  const warnings: string[] = [];
  const decided =
    opts.toolNames.length === 0 || opts.forced !== null
      ? { mode: (opts.forced ?? 'both') as ToolsMode, probed: false, notes: [] as string[] }
      : await resolveToolsMode(
          opts.provider,
          {
            tools: endpoint.capabilities.tools,
            probedModel: endpoint.capabilities.probedModel,
            byModel: endpoint.capabilities.byModel,
          },
          model,
          opts.signal,
        );
  if ('capabilities' in decided && decided.capabilities) {
    // 判定結果は保存する。毎回判定し直さないため。
    await opts
      .save(
        updateEndpoint(opts.config, endpoint.id, {
          capabilities: {
            ...endpoint.capabilities,
            ...decided.capabilities,
            byModel: {
              ...endpoint.capabilities.byModel,
              ...('modelCapability' in decided && decided.modelCapability
                ? { [decided.modelCapability.model]: decided.modelCapability.value }
                : {}),
            },
          },
        }),
      )
      .catch((err: unknown) => {
        // 保存に失敗しても実行は続けるが、黙らない。
        // 黙ると「判定したのに次回も判定される」理由が分からなくなる。
        warnings.push(`判定結果を保存できませんでした: ${(err as Error).message}`);
      });
  }
  return {
    mode: decided.mode,
    effective: decided.mode === 'none' ? 'both' : decided.mode,
    notes: decided.notes,
    warnings,
  };
}

/** そのモデルの文脈長（判定や --context で分かっていれば）。圧縮の閾値が変わる。 */
export function windowTokensFor(config: Config, endpointId: string, model: string): number | null {
  const ep = config.endpoints.find((e) => e.id === endpointId);
  return ep?.capabilities.byModel?.[model]?.contextTokens ?? null;
}

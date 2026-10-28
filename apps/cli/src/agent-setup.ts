import {
  resolveToolsMode,
  updateEndpoint,
  ALL_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  type PermissionMode,
  type Provider,
  type ResolvedEndpoint,
  type ToolsMode,
} from '@akari/core';
import { persist, type CliContext } from './context.js';
import { ExitError, EXIT } from './exit.js';

/**
 * エージェント実行の下ごしらえ。ヘッドレス（akari run）と対話画面（docs/spec/17-interactive.md）で共有する。
 * 使い口によって、同じモデルへ違う道具の渡し方をしないため。
 */

/** 渡す道具の範囲。 */
export type ToolScope = 'all' | 'read-only' | 'off';

export function toolNamesFor(scope: ToolScope): string[] {
  return scope === 'off' ? [] : scope === 'read-only' ? READ_ONLY_TOOL_NAMES : ALL_TOOL_NAMES;
}

export function toolScopeOf(opts: { noTools?: boolean; readOnly?: boolean }): ToolScope {
  return opts.noTools ? 'off' : opts.readOnly ? 'read-only' : 'all';
}

/** --permission / -y / AKARI_PERMISSION_MODE を解決する。 */
export function resolvePermission(
  opts: { permission?: string; yes?: boolean },
  fallback: PermissionMode,
): PermissionMode {
  const raw =
    opts.permission ?? (opts.yes ? 'auto-edit' : undefined) ?? process.env.AKARI_PERMISSION_MODE;
  if (raw === undefined) return fallback;
  const mode = parsePermission(raw);
  if (!mode) {
    throw new ExitError(
      EXIT.usage,
      `--permission は ask / auto-edit / full のいずれかです（受け取った値: ${raw}）。`,
    );
  }
  return mode;
}

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

/** --tools-mode / 設定を、強制する渡し方へ解決する。auto なら null（判定に従う）。 */
export function resolveToolsModeOption(
  opts: { toolsMode?: string },
  fromConfig: 'auto' | ToolsMode,
): ToolsMode | null {
  const raw = opts.toolsMode ?? process.env.AKARI_TOOLS_MODE ?? fromConfig;
  if (raw === 'auto' || raw === undefined) return null;
  if (raw === 'native' || raw === 'prompted' || raw === 'both') return raw;
  throw new ExitError(
    EXIT.usage,
    `--tools-mode は auto / native / prompted / both のいずれかです（受け取った値: ${raw}）。`,
  );
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
 * 道具の渡し方を確定させる。未判定なら判定し、結果を接続先に保存する。
 * 未判定のまま非対応モデルへネイティブのツール定義を渡すと、
 * モデルが何も呼ばず「何も起きずに終わった」ように見えてしまう。
 * 明示されていれば判定そのものを省く（無駄な呼び出しを1回減らす）。
 */
export async function decideToolsMode(
  ctx: CliContext,
  endpoint: ResolvedEndpoint,
  provider: Provider,
  model: string,
  toolNames: string[],
  forced: ToolsMode | null,
): Promise<ToolsModeDecision> {
  const warnings: string[] = [];
  const decided =
    toolNames.length === 0 || forced !== null
      ? { mode: (forced ?? 'both') as ToolsMode, probed: false, notes: [] as string[] }
      : await resolveToolsMode(
          provider,
          {
            tools: endpoint.capabilities.tools,
            probedModel: endpoint.capabilities.probedModel,
            byModel: endpoint.capabilities.byModel,
          },
          model,
        );
  if ('capabilities' in decided && decided.capabilities) {
    // 判定結果は保存する。毎回判定し直さないため。
    await persist(
      ctx,
      updateEndpoint(ctx.config, endpoint.id, {
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
    ).catch((err: unknown) => {
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
export function windowTokensFor(ctx: CliContext, endpointId: string, model: string): number | null {
  const ep = ctx.config.endpoints.find((e) => e.id === endpointId);
  return ep?.capabilities.byModel?.[model]?.contextTokens ?? null;
}

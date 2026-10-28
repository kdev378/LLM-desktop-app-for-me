import {
  decideToolsMode as decide,
  parsePermission,
  windowTokensFor as windowFor,
  type PermissionMode,
  type Provider,
  type ResolvedEndpoint,
  type ToolScope,
  type ToolsMode,
  type ToolsModeDecision,
} from '@akari/core';
import { persist, type CliContext } from './context.js';
import { ExitError, EXIT } from './exit.js';

/**
 * CLI 側の下ごしらえ。判断そのものは core（agent/setup.ts）にあり、ハーネスAPIと共有する。
 * ここには、オプションの読み方と、CLI の設定の保存のしかただけを置く。
 */

export { toolNamesFor, type ToolScope, type ToolsModeDecision } from '@akari/core';

export function toolScopeOf(opts: { noTools?: boolean; readOnly?: boolean }): ToolScope {
  return opts.noTools ? 'off' : opts.readOnly ? 'read-only' : 'all';
}

export { parsePermission };

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

/** 道具の渡し方を確定させる。判定結果は CLI の設定として保存する。 */
export function decideToolsMode(
  ctx: CliContext,
  endpoint: ResolvedEndpoint,
  provider: Provider,
  model: string,
  toolNames: string[],
  forced: ToolsMode | null,
): Promise<ToolsModeDecision> {
  return decide({
    config: ctx.config,
    endpoint,
    provider,
    model,
    toolNames,
    forced,
    save: (next) => persist(ctx, next),
  });
}

/** そのモデルの文脈長（判定や --context で分かっていれば）。 */
export function windowTokensFor(ctx: CliContext, endpointId: string, model: string): number | null {
  return windowFor(ctx.config, endpointId, model);
}

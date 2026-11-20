import {
  McpHub,
  loadCredentials,
  prepareMemory,
  type PreparedMemory,
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
import { c } from './term.js';

/**
 * CLI 側の下ごしらえ。判断そのものは core（agent/setup.ts）にあり、ハーネスAPIと共有する。
 * ここには、オプションの読み方と、CLI の設定の保存のしかただけを置く。
 */

export { toolNamesFor, mcpToolsFor, type ToolScope, type ToolsModeDecision } from '@akari/core';

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

/**
 * 登録した MCP サーバへつなぐ（docs/spec/13-mcp.md）。道具を渡さない実行ではつながない。
 * つなげなかったサーバは hub.notices に理由が入る。閉じるのは呼び出し側。
 */
export async function connectMcp(ctx: CliContext, scope: ToolScope, cwd: string): Promise<McpHub> {
  if (scope === 'off' || !ctx.config.mcpServers.some((s) => s.enabled)) return McpHub.empty();
  const { credentials } = await loadCredentials(ctx.root);
  return McpHub.connect(ctx.config.mcpServers, { credentials, logger: ctx.logger, cwd });
}

/** MCP の知らせを標準エラーへ出す（--json でも出す。使えないサーバを黙って飛ばさない）。 */
export function printMcpNotices(hub: McpHub): void {
  for (const n of hub.notices) {
    process.stderr.write(
      (n.level === 'warn' ? c.yellow(`! ${n.message}`) : c.dim(n.message)) + '\n',
    );
  }
}

/**
 * 作業フォルダの索引（14-memory.md）。あれば、変わったファイルだけ更新して memory_search を作る。
 * 道具を渡さない実行では見ない。知らせは呼び出し側が出す。
 */
export async function prepareCliMemory(
  ctx: CliContext,
  scope: ToolScope,
  workspaceRoot: string,
): Promise<PreparedMemory> {
  if (scope === 'off') return { tool: null, notices: [], index: null };
  return prepareMemory({
    dataRoot: ctx.root,
    indexRoot: workspaceRoot,
    config: ctx.config,
    autoUpdate: true,
    logger: ctx.logger,
  });
}

export function printMemoryNotices(m: PreparedMemory): void {
  for (const n of m.notices) {
    process.stderr.write(
      (n.level === 'warn' ? c.yellow(`! ${n.message}`) : c.dim(n.message)) + '\n',
    );
  }
}

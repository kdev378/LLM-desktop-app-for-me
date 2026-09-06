import { createProvider, getProviderError } from '@akari/core';
import { createContext, pickEndpoint, type GlobalOptions } from '../context.js';
import { out, table, c } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/** akari models — 接続先のモデル一覧。 */
export async function modelsCommand(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const endpoint = await pickEndpoint(ctx, opts.endpoint);
  const provider = createProvider(endpoint, { logger: ctx.logger });

  let models;
  try {
    models = await provider.listModels();
  } catch (err) {
    const pe = getProviderError(err);
    throw new ExitError(
      pe?.kind === 'unreachable' ? EXIT.unreachable : EXIT.runtime,
      pe?.message ?? (err as Error).message,
      { detail: pe?.bodyExcerpt },
    );
  }

  // 表示は名前順。選択に使う順序（サーバの順序）とは別（docs/spec/02-provider.md）。
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));

  if (ctx.json) {
    out(JSON.stringify({ endpoint: endpoint.name, baseUrl: endpoint.baseUrl, models }));
    return;
  }

  if (models.length === 0) {
    out('モデルがありません。');
    return;
  }
  out(c.dim(`${endpoint.name}  ${endpoint.baseUrl}`));
  out(
    table(
      sorted.map((m) => [
        m.id === endpoint.defaultModel ? c.green('*') : ' ',
        m.id,
        m.contextTokens ? `${m.contextTokens.toLocaleString()}` : '',
        m.ownedBy ?? '',
      ]),
      [' ', 'モデル', '文脈長', '提供'],
    ),
  );
  out(c.dim(`\n${models.length}件  * = この接続先の既定`));
}

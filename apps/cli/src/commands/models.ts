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
      models.map((m) => [
        m.id === endpoint.defaultModel ? c.green('*') : ' ',
        m.id,
        m.ownedBy ?? '',
      ]),
      [' ', 'モデル', '提供'],
    ),
  );
  out(c.dim(`\n${models.length}件  * = この接続先の既定`));
}

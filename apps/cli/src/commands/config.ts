import {
  addEndpoint,
  removeEndpoint,
  findEndpoint,
  updateEndpoint,
  resolveEndpoint,
  createProvider,
  setKey,
  configSchema,
  describeIssues,
  isExternalUrl,
  type Config,
} from '@akari/core';
import { createContext, persist, type GlobalOptions } from '../context.js';
import { out, c, table } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/** akari config … — 設定の確認と変更。仕様: docs/spec/10-cli.md */

export async function configList(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const view = redactedView(ctx.config);
  if (ctx.json) {
    out(JSON.stringify(view, null, 2));
    return;
  }
  out(JSON.stringify(view, null, 2));
  out('');
  out(c.dim(`設定の場所: ${ctx.root}/config.json`));
  out(c.dim('鍵の値はここには出ません（credentials.json に平文で保存されます）。'));
}

export async function configGet(pathExpr: string, opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const value = getPath(redactedView(ctx.config), pathExpr);
  if (value === undefined) {
    throw new ExitError(EXIT.usage, `設定項目 "${pathExpr}" はありません。`, {
      hint: 'akari config list で一覧を確認できます。',
    });
  }
  out(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export async function configSet(pathExpr: string, raw: string, opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  if (pathExpr.startsWith('endpoints')) {
    throw new ExitError(EXIT.usage, '接続先は akari config endpoints … で操作してください。');
  }
  const next = structuredClone(ctx.config) as Config;
  const current = getPath(next, pathExpr);
  if (current === undefined) {
    throw new ExitError(EXIT.usage, `設定項目 "${pathExpr}" はありません。`, {
      hint: 'akari config list で一覧を確認できます。',
    });
  }
  setPath(next, pathExpr, coerce(raw, current));

  // 検証してから保存する。不正なら何も変えずに、有効な範囲を示して終わる。
  const parsed = configSchema.safeParse(next);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error).filter((i) => i.startsWith(pathExpr));
    throw new ExitError(
      EXIT.usage,
      `"${pathExpr}" に ${raw} は設定できません。設定は変更していません。`,
      {
        detail: (issues.length > 0 ? issues : describeIssues(parsed.error)).join('\n'),
      },
    );
  }
  await persist(ctx, parsed.data);
  out(`${pathExpr} = ${JSON.stringify(getPath(parsed.data, pathExpr))}`);
}

export async function endpointsList(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  if (ctx.config.endpoints.length === 0) {
    out('接続先が登録されていません。');
    out(c.dim('  → akari config endpoints add --name "ローカル" --url http://localhost:11434/v1'));
    return;
  }
  if (ctx.json) {
    out(
      JSON.stringify(
        ctx.config.endpoints.map((e) => ({ ...e, apiKeyRef: e.apiKeyRef ? '(設定あり)' : null })),
      ),
    );
    return;
  }
  out(
    table(
      ctx.config.endpoints.map((e) => [
        e.id === ctx.config.activeEndpointId ? c.green('*') : ' ',
        e.name,
        e.baseUrl + (isExternalUrl(e.baseUrl) ? c.yellow(' [外部]') : ''),
        e.defaultModel ?? c.dim('-'),
        e.capabilities.tools,
      ]),
      [' ', '名前', 'URL', '既定モデル', 'ツール'],
    ),
  );
  out(c.dim('\n* = 選択中'));
}

export async function endpointsAdd(
  opts: GlobalOptions & {
    name: string;
    url: string;
    model?: string;
    key?: string;
    keyEnv?: string;
    timeout?: string;
  },
): Promise<void> {
  const ctx = await createContext(opts);
  if (opts.key && opts.keyEnv) {
    throw new ExitError(EXIT.usage, '--key と --key-env は同時に使えません。');
  }
  const timeoutMs = opts.timeout !== undefined ? Number(opts.timeout) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs < 1000)) {
    throw new ExitError(EXIT.usage, '--timeout は 1 以上の秒数で指定してください。');
  }

  const { config, endpoint } = addEndpoint(ctx.config, {
    name: opts.name,
    baseUrl: opts.url,
    defaultModel: opts.model ?? null,
    apiKeyRef: opts.keyEnv ? `env:${opts.keyEnv}` : opts.key ? endpointKeyRef(opts.name) : null,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  if (opts.key) {
    await setKey(endpointKeyRef(opts.name), opts.key, ctx.root);
  }
  await persist(ctx, config);

  out(`接続先 "${endpoint.name}" を追加しました。`);
  if (isExternalUrl(endpoint.baseUrl)) {
    out('');
    out(c.yellow('この接続先はインターネット上にあります。'));
    out(c.yellow('会話の内容と、エージェントが読んだファイルの中身が送信されます。'));
  }
  if (opts.key) {
    out('');
    out(
      c.yellow(
        '鍵は credentials.json に平文で保存されます（ファイル権限600）。暗号化ではありません。',
      ),
    );
    out(c.gray('  外部APIの鍵は --key-env で環境変数参照にするほうが安全です。'));
  }
  out('');
  out(c.dim('接続を確認するには: akari doctor'));
}

export async function endpointsRemove(nameOrId: string, opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const target = findEndpoint(ctx.config, nameOrId);
  if (!target) throw new ExitError(EXIT.usage, `接続先 "${nameOrId}" が見つかりません。`);
  await persist(ctx, removeEndpoint(ctx.config, nameOrId));
  out(`接続先 "${target.name}" を削除しました。`);
  out(
    c.dim(
      '鍵は credentials.json に残っています。消すには akari config keys rm ' +
        (target.apiKeyRef ?? '(なし)'),
    ),
  );
}

export async function endpointsUse(nameOrId: string, opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const target = findEndpoint(ctx.config, nameOrId);
  if (!target) throw new ExitError(EXIT.usage, `接続先 "${nameOrId}" が見つかりません。`);
  await persist(ctx, { ...ctx.config, activeEndpointId: target.id });
  out(`接続先を "${target.name}" にしました。`);
}

export async function endpointsProbe(
  nameOrId: string | undefined,
  opts: GlobalOptions,
): Promise<void> {
  const ctx = await createContext(opts);
  const target = findEndpoint(ctx.config, nameOrId ?? null);
  if (!target) throw new ExitError(EXIT.usage, '判定する接続先がありません。');

  const resolved = await resolveEndpoint(ctx.config, target.id, ctx.root);
  const model = opts.model ?? process.env.AKARI_MODEL ?? target.defaultModel ?? undefined;
  out(c.dim(`${target.name}${model ? ` / ${model}` : ''} を判定しています…`));
  const result = await createProvider(resolved, { logger: ctx.logger }).probe(model);

  if (ctx.json) {
    out(JSON.stringify(result, null, 2));
  } else {
    out('');
    out(result.reachable ? c.green('到達: はい') : c.red('到達: いいえ'));
    for (const n of result.notes) out('  - ' + n);
    if (result.error) out(c.red(`  ! ${result.error.message}`));
  }

  if (!result.reachable) throw new ExitError(EXIT.unreachable, '接続先に到達できませんでした。');

  const probedAt = new Date().toISOString();
  await persist(
    ctx,
    updateEndpoint(ctx.config, target.id, {
      capabilities: {
        ...target.capabilities,
        tools: result.tools,
        usageReported: result.usageReported,
        streamsToolCalls: result.streamsToolCalls,
        probedAt,
        probedModel: result.testedModel,
        byModel: {
          ...target.capabilities.byModel,
          ...(result.testedModel
            ? {
                [result.testedModel]: {
                  tools: result.tools,
                  usageReported: result.usageReported,
                  streamsToolCalls: result.streamsToolCalls,
                  probedAt,
                },
              }
            : {}),
        },
      },
    }),
  );
  out('');
  out(c.dim('判定結果を設定へ保存しました。'));
}

// ---- 補助 ----

function endpointKeyRef(name: string): string {
  return `key_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function redactedView(config: Config): unknown {
  return {
    ...config,
    endpoints: config.endpoints.map((e) => ({
      ...e,
      apiKeyRef:
        e.apiKeyRef && !e.apiKeyRef.startsWith('env:')
          ? '(credentials.json に保存済み)'
          : e.apiKeyRef,
    })),
  };
}

function getPath(obj: unknown, expr: string): unknown {
  return expr.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, expr: string, value: unknown): void {
  const keys = expr.split('.');
  const last = keys.pop()!;
  let cur: Record<string, unknown> = obj;
  for (const k of keys) cur = cur[k] as Record<string, unknown>;
  cur[last] = value;
}

/** 現在値の型に合わせて文字列を変換する。型が変わる変更は受け付けない。 */
function coerce(raw: string, current: unknown): unknown {
  if (typeof current === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new ExitError(EXIT.usage, `"${raw}" は数値ではありません。`);
    return n;
  }
  if (typeof current === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new ExitError(EXIT.usage, `"${raw}" は true か false で指定してください。`);
  }
  if (Array.isArray(current)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 下でエラーにする */
    }
    throw new ExitError(
      EXIT.usage,
      `"${raw}" は配列（JSON形式）で指定してください。例: '["a","b"]'`,
    );
  }
  if (current === null) {
    if (raw === 'null') return null;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

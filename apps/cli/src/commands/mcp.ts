import readlinePromises from 'node:readline/promises';
import path from 'node:path';
import type { McpServePermission } from '@akari/server';
import {
  McpHub,
  Workspace,
  consentState,
  describeSandbox,
  tildify,
  describeLaunch,
  loadCredentials,
  mcpServerSchema,
  shortId,
  withConsent,
  describeIssues,
  type McpServerConfig,
  type McpServerStatus,
} from '@akari/core';
import { createContext, persist, type CliContext, type GlobalOptions } from '../context.js';
import { c, out, isInteractive } from '../term.js';
import { ExitError, EXIT } from '../exit.js';
import { VERSION } from '../version.js';

/**
 * akari mcp — MCP サーバの登録（使う側）。仕様: docs/spec/13-mcp.md
 *
 * 登録することは、そのプログラムを自分のPCで動かすことと同じ。だから追加と同意し直しでは、
 * 何が動くかを見せて同意を取る。パイプの中では -y が無ければ断る。
 */

export type McpAddOptions = GlobalOptions & {
  name: string;
  command?: string;
  arg?: string[];
  env?: string[];
  cwd?: string;
  url?: string;
  header?: string[];
  bearerEnv?: string;
  trust?: string;
  yes?: boolean;
};

export async function mcpAdd(opts: McpAddOptions): Promise<void> {
  const ctx = await createContext(opts);
  if (!!opts.command === !!opts.url) {
    throw new ExitError(
      EXIT.usage,
      '--command（子プロセス）か --url（HTTP）の、どちらか一方を指定してください。',
    );
  }
  if (findServer(ctx, opts.name)) {
    throw new ExitError(EXIT.usage, `MCPサーバ "${opts.name}" はもう登録されています。`, {
      hint: `作り直すなら akari mcp rm ${opts.name} の後で追加してください。`,
    });
  }
  if (opts.url && (opts.arg?.length || opts.env?.length || opts.cwd)) {
    throw new ExitError(EXIT.usage, '--arg / --env / --cwd は --command のときだけ使えます。');
  }
  if (opts.command && (opts.header?.length || opts.bearerEnv)) {
    throw new ExitError(EXIT.usage, '--header / --bearer-env は --url のときだけ使えます。');
  }
  const parsed = mcpServerSchema.safeParse({
    id: shortId('mcp_'),
    name: opts.name,
    transport: opts.command ? 'stdio' : 'http',
    ...(opts.command ? { command: opts.command } : {}),
    args: opts.arg ?? [],
    env: pairs(opts.env ?? [], '=', '--env'),
    cwd: opts.cwd ? path.resolve(opts.cwd) : null,
    ...(opts.url ? { url: opts.url } : {}),
    headers: pairs(opts.header ?? [], ':', '--header'),
    auth: opts.bearerEnv ? { type: 'bearer', token: `env:${opts.bearerEnv}` } : { type: 'none' },
    trust: parseTrust(opts.trust),
  });
  if (!parsed.success) {
    throw new ExitError(
      EXIT.usage,
      `登録内容が正しくありません: ${describeIssues(parsed.error).join(' / ')}`,
    );
  }
  const server = parsed.data;
  if (!(await agree(ctx, server, opts.yes))) return;
  await persist(ctx, {
    ...ctx.config,
    mcpServers: [...ctx.config.mcpServers, withConsent(server)],
  });
  out(`MCPサーバ "${server.name}" を追加しました。`);
  out(c.dim(describeTrust(server.trust)));
  out(c.dim(`道具の一覧を見るには: akari mcp tools ${server.name}`));
}

export async function mcpList(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const servers = ctx.config.mcpServers;
  if (ctx.json) {
    out(
      JSON.stringify(
        servers.map((s) => ({ ...redactServer(s), consentState: consentState(s) })),
        null,
        2,
      ),
    );
    return;
  }
  if (servers.length === 0) {
    out('MCPサーバは登録されていません。');
    out(c.dim('追加するには: akari mcp add --name <名前> --command <コマンド> [--arg …]'));
    return;
  }
  for (const s of servers) {
    const consent = consentState(s);
    const flags = [
      s.enabled ? null : c.yellow('無効'),
      consent === 'missing'
        ? c.yellow('同意なし')
        : consent === 'changed'
          ? c.red('内容が変わった')
          : null,
    ].filter(Boolean);
    out(
      `${c.bold(s.name)}  ${c.dim(s.transport)}  承認: ${trustLabel(s.trust)}${flags.length ? '  ' + flags.join(' ') : ''}`,
    );
    out(c.dim(`  ${launchLine(s)}`));
  }
  out('');
  out(c.dim('つながるか・道具が何件かは: akari mcp doctor'));
}

export async function mcpTools(name: string, opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const server = requireServer(ctx, name);
  const hub = await connect(ctx, [server.name]);
  try {
    const status = hub.statuses[0];
    if (!status || status.state !== 'connected') {
      throw new ExitError(
        EXIT.runtime,
        `"${name}" につなげませんでした: ${status?.error ?? '不明'}`,
      );
    }
    if (ctx.json) {
      out(
        JSON.stringify(
          hub.tools.map((t) => ({
            name: t.name,
            tool: t.mcp?.tool,
            risk: t.risk,
            readOnlyHint: t.mcp?.readOnlyHint ?? false,
            description: t.description,
          })),
          null,
          2,
        ),
      );
      return;
    }
    out(`${server.name}: 道具 ${hub.tools.length} 件（${status.ms}ms でつながりました）`);
    for (const t of hub.tools) {
      const mark = t.mcp?.readOnlyHint ? c.green('読み取り') : c.yellow('実行');
      out(`  ${c.cyan(t.name)}  ${mark}`);
      const desc = t.description.replace(/^\[MCP: [^\]]*\]\s*/, '');
      if (desc) out(c.dim(`    ${desc.split('\n')[0]}`));
    }
    out('');
    out(c.dim('「読み取り」はサーバの自己申告です。Akari には確かめられません。'));
    out(c.dim(describeTrust(server.trust)));
  } finally {
    await hub.close();
  }
}

export async function mcpTrust(
  name: string,
  opts: GlobalOptions & { yes?: boolean },
): Promise<void> {
  const ctx = await createContext(opts);
  const server = requireServer(ctx, name);
  const state = consentState(server);
  if (state === 'ok' && !ctx.json) out(c.dim('この内容には同意済みです。もう一度確かめます。'));
  if (state === 'changed') out(c.yellow('同意した後に、起動する内容が変わっています。'));
  if (!(await agree(ctx, server, opts.yes))) return;
  await persist(ctx, {
    ...ctx.config,
    mcpServers: ctx.config.mcpServers.map((s) => (s.id === server.id ? withConsent(s) : s)),
  });
  out(`MCPサーバ "${server.name}" の起動に同意しました。`);
}

export async function mcpRemove(name: string, opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const server = requireServer(ctx, name);
  await persist(ctx, {
    ...ctx.config,
    mcpServers: ctx.config.mcpServers.filter((s) => s.id !== server.id),
  });
  out(`MCPサーバ "${server.name}" を削除しました。`);
}

export async function mcpDoctor(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const enabled = ctx.config.mcpServers.filter((s) => s.enabled);
  if (enabled.length === 0) {
    out('有効なMCPサーバはありません。');
    return;
  }
  if (!ctx.json) out(c.dim(`${enabled.length} 件へつないでいます…`));
  const hub = await connect(ctx);
  try {
    if (ctx.json) {
      out(JSON.stringify(hub.statuses.map(statusJson), null, 2));
    } else {
      for (const s of hub.statuses) {
        if (s.state === 'connected') {
          out(`${c.green('✓')} ${s.name}  ${s.ms}ms  道具 ${s.tools?.length ?? 0} 件`);
        } else {
          out(`${c.red('✗')} ${s.name}  ${s.error ?? s.state}`);
        }
      }
    }
    if (hub.statuses.some((s) => s.state !== 'connected')) process.exitCode = EXIT.runtime;
  } finally {
    await hub.close();
  }
}

// ---- 下請け ----

async function connect(ctx: CliContext, only?: string[]): Promise<McpHub> {
  const { credentials } = await loadCredentials(ctx.root);
  return McpHub.connect(ctx.config.mcpServers, {
    credentials,
    logger: ctx.logger,
    cwd: process.cwd(),
    ...(only ? { only } : {}),
  });
}

/** 何が動くかを見せて同意を取る。同意しなければ false。 */
async function agree(ctx: CliContext, server: McpServerConfig, yes?: boolean): Promise<boolean> {
  // 同意の文は --json でも標準エラーへ出す（何に同意したかを残す）
  process.stderr.write(describeLaunch(server) + '\n');
  if (yes) return true;
  if (!isInteractive()) {
    throw new ExitError(
      EXIT.denied,
      '確認できない環境です。内容を確かめたうえで -y を付けてください。',
    );
  }
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question('同意しますか？ [y/N] ')).trim().toLowerCase();
    if (ans === 'y' || ans === 'yes') return true;
    out('やめました。');
    return false;
  } finally {
    rl.close();
  }
}

function findServer(ctx: CliContext, name: string): McpServerConfig | undefined {
  return ctx.config.mcpServers.find((s) => s.name === name || s.id === name);
}

function requireServer(ctx: CliContext, name: string): McpServerConfig {
  const s = findServer(ctx, name);
  if (!s) {
    throw new ExitError(EXIT.usage, `MCPサーバ "${name}" は登録されていません。`, {
      hint: '登録済みの一覧は akari mcp list',
    });
  }
  return s;
}

function parseTrust(raw: string | undefined): McpServerConfig['trust'] {
  if (raw === undefined) return 'ask';
  const map: Record<string, McpServerConfig['trust']> = {
    ask: 'ask',
    readonly: 'readOnly',
    'read-only': 'readOnly',
    readOnly: 'readOnly',
    full: 'full',
  };
  const t = map[raw];
  if (!t)
    throw new ExitError(
      EXIT.usage,
      `--trust は ask / read-only / full のいずれかです（受け取った値: ${raw}）。`,
    );
  return t;
}

function trustLabel(t: McpServerConfig['trust']): string {
  return t === 'ask' ? '毎回聞く' : t === 'readOnly' ? '読み取りは自動' : '権限モードに従う';
}

function describeTrust(t: McpServerConfig['trust']): string {
  switch (t) {
    case 'ask':
      return '承認: 道具を使うたびに聞きます（--trust で変えられます）。';
    case 'readOnly':
      return '承認: サーバが「読み取りだけ」と申告した道具は聞かずに使います。申告を信じる設定です。';
    case 'full':
      return '承認: 権限モード（ask / auto-edit / full）に従います。full なら聞かずに使います。';
  }
}

function launchLine(s: McpServerConfig): string {
  return s.transport === 'stdio' ? [s.command ?? '', ...s.args].join(' ') : (s.url ?? '');
}

/** 一覧に出すとき、ヘッダの値は出さない（鍵が入りうる）。 */
function redactServer(s: McpServerConfig): Record<string, unknown> {
  return {
    ...s,
    headers: Object.fromEntries(Object.keys(s.headers).map((k) => [k, '…'])),
    env: Object.fromEntries(Object.keys(s.env).map((k) => [k, '…'])),
  };
}

function statusJson(s: McpServerStatus): Record<string, unknown> {
  return {
    name: s.name,
    state: s.state,
    ...(s.ms !== undefined ? { ms: s.ms } : {}),
    ...(s.tools ? { tools: s.tools.length } : {}),
    ...(s.error ? { error: s.error } : {}),
  };
}

function pairs(list: string[], sep: string, flag: string): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf(sep);
    if (i <= 0)
      throw new ExitError(
        EXIT.usage,
        `${flag} は 名前${sep}値 の形で書いてください（受け取った値: ${item}）。`,
      );
    outMap[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return outMap;
}

// ---- なる側（akari mcp serve） ----

export type McpServeCliOptions = GlobalOptions & {
  workspace?: string;
  permission?: string;
  http?: boolean;
  port?: string;
};

/**
 * Akari の道具を MCP（stdio）で出す。標準出力は MCP の通り道なので、人向けの案内は全部標準エラーへ。
 * 仕様: docs/spec/13-mcp.md「なる側」
 */
export async function mcpServe(opts: McpServeCliOptions): Promise<void> {
  if (opts.http) {
    throw new ExitError(EXIT.usage, 'HTTP での公開はまだ実装していません。今は stdio だけです。', {
      hint: 'Claude Code などからは stdio で登録してください（docs/commands.md）。',
    });
  }
  const ctx = await createContext({ ...opts, quiet: true });
  const permission = parseServePermission(opts.permission);
  let workspace: Workspace;
  try {
    workspace = await Workspace.open(path.resolve(opts.workspace ?? process.cwd()));
  } catch (err) {
    throw new ExitError(EXIT.usage, (err as Error).message, {
      hint: '--workspace で作業フォルダを指定してください。',
    });
  }
  const { serveMcp } = await import('@akari/server');
  const handle = await serveMcp({
    root: ctx.root,
    workspace,
    permission,
    config: ctx.config,
    logger: ctx.logger,
    version: VERSION,
  });
  const info = (s: string) => process.stderr.write(`${s}\n`);
  info(c.bold(`Akari MCP サーバ ${VERSION}（stdio）`));
  info(c.dim(`  作業フォルダ: ${tildify(workspace.root)}（この外は読み書きしません）`));
  info(c.dim(`  権限: ${serveLabel(permission)}`));
  info(c.dim(`  承認なしで実行されるもの: ${handle.tools.join(', ')}`));
  if (handle.sandbox) info(c.dim(`  コマンド: ${describeSandbox(handle.sandbox)}`));
  for (const n of handle.notices)
    info(n.level === 'warn' ? c.yellow(`  ! ${n.message}`) : c.dim(`  ${n.message}`));
  if (permission !== 'readOnly') {
    info(
      c.dim(
        '  ファイルの変更は記録されます。戻すには akari_undo_last、または akari runs / akari undo --run <ID>',
      ),
    );
  }
  const stop = () => void handle.close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await handle.closed;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}

function parseServePermission(raw: string | undefined): McpServePermission {
  if (raw === undefined) return 'readOnly';
  const map: Record<string, McpServePermission> = {
    readOnly: 'readOnly',
    readonly: 'readOnly',
    'read-only': 'readOnly',
    autoEdit: 'autoEdit',
    autoedit: 'autoEdit',
    'auto-edit': 'autoEdit',
    full: 'full',
  };
  const p = map[raw];
  if (!p) {
    throw new ExitError(
      EXIT.usage,
      `--permission は read-only / auto-edit / full のいずれかです（受け取った値: ${raw}）。`,
    );
  }
  return p;
}

function serveLabel(p: McpServePermission): string {
  return p === 'readOnly'
    ? '読み取りのみ（既定）'
    : p === 'autoEdit'
      ? c.yellow('読み取りとファイルの編集（auto-edit）')
      : c.yellow('読み取り・編集・コマンドの実行（full）');
}

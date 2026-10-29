import {
  BUILTIN_TOOLS,
  ChangeJournal,
  DEFAULT_LIMITS,
  detectSandbox,
  diffJournal,
  findDeleteCommand,
  matchesDenied,
  ulid,
  type Config,
  type Logger,
  type SandboxStatus,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type Workspace,
} from '@akari/core';
import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type ToolAnnotations,
  type Transport,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * akari mcp serve — Akari の道具を MCP で外へ出す。仕様: docs/spec/13-mcp.md「なる側」
 *
 * MCP の相手には Akari の承認画面が無い。だから出す道具を権限で絞り、
 * パス境界と変更の記録（取り消し）はどの権限でも外さない。
 * 1つの接続を1つの「実行」として記録し、akari runs に MCP経由として並ぶ。
 */

export type McpServePermission = 'readOnly' | 'autoEdit' | 'full';

export type McpServeOptions = {
  /** Akari のデータの置き場。 */
  root: string;
  workspace: Workspace;
  permission: McpServePermission;
  config: Config;
  logger: Logger;
  version: string;
  /** 既定は標準入出力。テストで差し替える。 */
  transport?: Transport;
};

export type McpServeHandle = {
  /** 出した道具の名前。 */
  tools: string[];
  sandbox: SandboxStatus | null;
  /** 相手が切ったら解決する。 */
  closed: Promise<void>;
  close: () => Promise<void>;
};

const READ_TOOLS = ['read_file', 'list_dir', 'glob', 'grep'];
const EDIT_TOOLS = ['write_file', 'edit_file'];
const EXEC_TOOLS = ['run_command'];

/** その権限で出す Akari の道具。delete_file はどの権限でも出さない（承認の相手が分からないため）。 */
export function exposedToolNames(permission: McpServePermission): string[] {
  return [
    ...READ_TOOLS,
    ...(permission !== 'readOnly' ? EDIT_TOOLS : []),
    ...(permission === 'full' ? EXEC_TOOLS : []),
  ];
}

export async function serveMcp(opts: McpServeOptions): Promise<McpServeHandle> {
  const { workspace, config, logger } = opts;
  const sandboxSettings = config.agent.sandbox;
  workspace.setSecretsAllowed(sandboxSettings.allowWorkspaceSecrets);
  const sandbox: SandboxStatus | null =
    opts.permission !== 'full'
      ? null
      : sandboxSettings.mode === 'off'
        ? { active: false, reason: 'agent.sandbox.mode が off' }
        : await detectSandbox();

  const limits = {
    ...DEFAULT_LIMITS,
    commandTimeoutMs: config.agent.commandTimeoutMs,
    toolOutputLimitBytes: config.agent.toolOutputLimitBytes,
    deniedCommands: config.agent.deniedCommands,
  };

  // 変更の記録は、最初に書く道具が呼ばれたときに作る（読むだけの接続で空の記録を増やさない）。
  // akari_undo_last で戻したら、次の変更は新しい記録に書く
  let journal: ChangeJournal | null = null;
  const journalFor = async (): Promise<ChangeJournal> => {
    journal ??= await ChangeJournal.create(ulid(), workspace.root, opts.root, 'mcp');
    return journal;
  };

  const server = new McpServer(
    { name: 'akari', version: opts.version },
    {
      instructions:
        `Akari の道具。作業フォルダ ${workspace.root} の中だけを扱う。` +
        'ファイルの変更は記録され、akari_undo_last でまとめて戻せる。',
    },
  );

  const names = exposedToolNames(opts.permission);
  const exposed: string[] = [];
  for (const name of names) {
    const tool = BUILTIN_TOOLS.find((t) => t.name === name);
    if (!tool) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.parameters as never),
        annotations: annotationsFor(tool),
      },
      async (args: unknown, ctx) => {
        const result = await callTool(tool, args, ctx.mcpReq.signal);
        logger.info('mcp.serve.call', { tool: tool.name, ok: result.ok });
        return toCallResult(result);
      },
    );
    exposed.push(tool.name);
  }

  server.registerTool(
    'akari_changes',
    {
      description:
        'この接続で Akari の道具が変更したファイルと、その差分を返す（akari_undo_last で戻した分は含まない）。',
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!journal || journal.changes.length === 0)
        return text('この接続ではまだファイルを変更していません。');
      const diffs = await diffJournal(journal);
      const body = diffs
        .map((d) => `## ${d.path}${d.note ? `（${d.note}）` : ''}\n${d.diff}`)
        .join('\n\n');
      return text(`変更したファイル ${diffs.length} 件（記録 ${journal.runId}）\n\n${body}`);
    },
  );
  exposed.push('akari_changes');

  if (opts.permission !== 'readOnly') {
    server.registerTool(
      'akari_undo_last',
      {
        description:
          'この接続で Akari の道具が変更したファイルを、まとめて元に戻す（前回 akari_undo_last した後の分）。' +
          '戻した後に手で変えられたファイルは上書きせずに知らせる。run_command で変えたものは対象外。',
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async () => {
        if (!journal || journal.changes.length === 0) return text('戻す変更はありません。');
        const undone = journal;
        const result = await undone.undo();
        journal = null;
        logger.info('mcp.serve.undo', {
          runId: undone.runId,
          restored: result.restored.length,
          skipped: result.skipped.length,
        });
        const lines = [
          `戻しました: ${result.restored.length} 件${result.restored.length ? `（${result.restored.join(', ')}）` : ''}`,
          ...result.skipped.map((s) => `戻さなかった: ${s.path} — ${s.reason}`),
        ];
        return {
          ...text(lines.join('\n')),
          isError: result.skipped.length > 0 && result.restored.length === 0,
        };
      },
    );
    exposed.push('akari_undo_last');
  }

  /** Akari 自身の実行ループと同じ順の検査をして、道具を動かす（承認の代わりに、権限で道具を絞ってある）。 */
  async function callTool(tool: ToolSpec, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    const ctx: ToolContext = {
      workspace,
      // 読み取りの道具は記録を使わない。書く道具のときだけ作る
      journal: tool.risk === 'read' ? (journal ?? (null as never)) : await journalFor(),
      limits,
      signal,
      callId: ulid(),
      logger,
      canRequestSecrets: false,
      ...(sandbox
        ? { sandbox: { status: sandbox, settings: sandboxSettings, extraWrite: [] } }
        : {}),
    };
    // パス境界はどの権限でも外さない
    for (const use of tool.pathsOf?.(args) ?? []) {
      const r = await workspace.resolve(use.value, use.mode);
      if (!r.ok) {
        // MCP 経由では許可を求める道具を出していない。その案内はしない
        return fail(
          r.secret
            ? `${use.value} は鍵や資格情報が入りうるため、MCP 経由では読めません（Akari の設定 agent.sandbox.allowWorkspaceSecrets で許せます）。`
            : r.message,
          'denied',
        );
      }
    }
    const checked = await tool.check?.(args, ctx);
    if (checked) return checked;
    if (tool.name === 'run_command') {
      const command = (args as { command?: unknown }).command;
      if (typeof command === 'string') {
        const hit = matchesDenied(command, limits.deniedCommands);
        if (hit !== null)
          return fail(`このコマンドは実行できません（拒否リストの "${hit}" に一致）。`, 'denied');
        // 消したものは記録の外で戻せない。承認を取る相手もいないので、MCP 経由では実行しない
        const deletes = findDeleteCommand(command);
        if (deletes !== null) {
          return fail(
            `ファイルを削除するコマンド（${deletes}）は、MCP 経由では実行しません。取り消せず、承認を取る相手もいないためです。`,
            'denied',
          );
        }
      }
    }
    try {
      return await tool.run(args, ctx);
    } catch (err) {
      return fail(`道具の実行が失敗しました: ${(err as Error).message}`, 'failed');
    }
  }

  const transport = opts.transport ?? new StdioServerTransport();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  await server.connect(transport);
  server.server.onclose = () => {
    if (journal)
      logger.info('mcp.serve.closed', { runId: journal.runId, changes: journal.changes.length });
    resolveClosed();
  };

  return {
    tools: exposed,
    sandbox,
    closed,
    close: async () => {
      await server.close();
    },
  };
}

function annotationsFor(tool: ToolSpec): ToolAnnotations {
  return tool.risk === 'read'
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: true };
}

function toCallResult(r: ToolResult): CallToolResult {
  return { content: [{ type: 'text', text: r.content }], ...(r.ok ? {} : { isError: true }) };
}

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function fail(message: string, kind: ToolResult['errorKind']): ToolResult {
  return { ok: false, summary: message, content: message, errorKind: kind };
}

import { createHash } from 'node:crypto';
import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import type { Credentials, McpServerConfig } from '../config/schema.js';
import type { Logger } from '../diagnostics/logger.js';
import { truncateMiddle } from '../tools/walk.js';
import type { ToolResult, ToolSpec } from '../tools/types.js';
import { createAuthProvider, resolveValue } from './auth.js';
import { consentState } from './consent.js';
import { GroupStdioTransport } from './stdio.js';

/**
 * 登録した MCP サーバへつなぎ、その道具を Akari の道具として並べる。
 * 仕様: docs/spec/13-mcp.md「使う側」
 *
 * - 会話の間は接続を保つ。閉じるのは呼び出し側（close）
 * - つなげなかったサーバは使わず、理由を notices に残して他を続ける
 * - 同意していない・内容が変わったサーバは起動しない
 */

export type McpServerState = 'connected' | 'failed' | 'unconsented' | 'changed' | 'disabled';

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  /** 接続にかかった時間（ミリ秒）。つないだときだけ。 */
  ms?: number;
  /** サーバが出した道具（そのまま）。つないだときだけ。 */
  tools?: Tool[];
  error?: string;
};

export type McpNotice = { level: 'info' | 'warn'; message: string };

export type McpConnectOptions = {
  credentials: Credentials;
  logger?: Logger;
  /** stdio の子プロセスの作業ディレクトリ（サーバの cwd が無いとき）。 */
  cwd?: string;
  signal?: AbortSignal;
  /** 名前で絞る（akari mcp tools など）。省略で有効なもの全部。 */
  only?: string[];
};

type Connection = { server: McpServerConfig; client: Client; tools: Tool[] };

/** stdio の子へ渡す、Akari の環境変数のうち動くのに要るもの。鍵らしいものは渡さない。 */
const PASS_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  // npx などが取りに行くのに要る
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // Windows
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'ComSpec',
];

const MAX_NAME = 64;
const ARGS_PREVIEW_CHARS = 2000;

export class McpHub {
  private constructor(
    private readonly connections: Connection[],
    readonly statuses: McpServerStatus[],
    readonly tools: ToolSpec[],
    readonly notices: McpNotice[],
  ) {}

  /** 有効なサーバへ並行してつなぐ。1つが失敗しても他は続ける。 */
  static async connect(servers: McpServerConfig[], opts: McpConnectOptions): Promise<McpHub> {
    const targets = opts.only
      ? servers.filter((s) => opts.only!.includes(s.name))
      : servers.filter((s) => s.enabled);
    const statuses: McpServerStatus[] = [];
    const notices: McpNotice[] = [];
    const connections: Connection[] = [];

    const results = await Promise.all(
      targets.map(async (server): Promise<{ status: McpServerStatus; conn?: Connection }> => {
        const consent = consentState(server);
        if (consent !== 'ok') {
          return {
            status: {
              name: server.name,
              state: consent === 'missing' ? 'unconsented' : 'changed',
              error:
                consent === 'missing'
                  ? `起動の同意がありません。akari mcp trust ${server.name} で同意してください。`
                  : `同意した後に起動する内容が変わっています。akari mcp trust ${server.name} で確かめて同意し直してください。`,
            },
          };
        }
        const started = Date.now();
        try {
          const conn = await connectOne(server, opts);
          const ms = Date.now() - started;
          opts.logger?.info('mcp.connected', { server: server.name, ms, tools: conn.tools.length });
          return { status: { name: server.name, state: 'connected', ms, tools: conn.tools }, conn };
        } catch (err) {
          const message = describeError(err);
          opts.logger?.warn('mcp.connect_failed', { server: server.name, error: message });
          return { status: { name: server.name, state: 'failed', error: message } };
        }
      }),
    );

    for (const r of results) {
      statuses.push(r.status);
      if (r.conn) connections.push(r.conn);
      else if (r.status.error) {
        notices.push({
          level: 'warn',
          message: `MCPサーバ「${r.status.name}」は使いません: ${r.status.error}`,
        });
      }
    }

    const used = new Set<string>();
    const tools: ToolSpec[] = [];
    for (const conn of connections) {
      for (const t of conn.tools) tools.push(toToolSpec(conn, t, used));
    }
    return new McpHub(connections, statuses, tools, notices);
  }

  /** 空のハブ（MCP サーバが無いとき）。 */
  static empty(): McpHub {
    return new McpHub([], [], [], []);
  }

  /** 全部の接続を閉じる。stdio の子はプロセスグループごと止まる。 */
  async close(): Promise<void> {
    await Promise.all(
      this.connections.map((c) =>
        c.client.close().catch(() => {
          /* 閉じるときの失敗は無視（すでに切れている） */
        }),
      ),
    );
    this.connections.length = 0;
  }
}

async function connectOne(server: McpServerConfig, opts: McpConnectOptions): Promise<Connection> {
  const transport = makeTransport(server, opts);
  const client = new Client({ name: 'akari', version: '0.1.0' }, { capabilities: {} });
  const timeout = server.startupTimeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    // SDK の上限に加え、起動そのもの（npx の取得など）が戻らない場合にも上限をかける
    const work = (async () => {
      await client.connect(transport, { timeout, ...(opts.signal ? { signal: opts.signal } : {}) });
      const listed = await client.listTools(undefined, {
        timeout,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return listed.tools;
    })();
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${Math.round(timeout / 1000)}秒以内に起動しませんでした`)),
        timeout,
      );
    });
    // 時間切れで見捨てた側が後から失敗しても、拾われない失敗にしない
    work.catch(() => undefined);
    const tools = await Promise.race([work, limit]);
    return { server, client, tools };
  } catch (err) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeTransport(server: McpServerConfig, opts: McpConnectOptions): Transport {
  if (server.transport === 'stdio') {
    const env: Record<string, string> = {};
    for (const k of PASS_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    for (const [k, v] of Object.entries(server.env)) env[k] = resolveValue(v, `環境変数 ${k}`);
    const cwd = server.cwd ?? opts.cwd;
    return new GroupStdioTransport({
      command: server.command!,
      args: server.args,
      env,
      ...(cwd ? { cwd } : {}),
      onStderr: (text) =>
        opts.logger?.debug('mcp.stderr', { server: server.name, text: text.slice(0, 2000) }),
    });
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.headers)) headers[k] = resolveValue(v, `ヘッダ ${k}`);
  const authProvider = createAuthProvider(server, { credentials: opts.credentials });
  return new StreamableHTTPClientTransport(new URL(server.url!), {
    requestInit: { headers },
    ...(authProvider ? { authProvider } : {}),
  });
}

/** MCP の道具を、Akari の道具の形にする。 */
function toToolSpec(conn: Connection, tool: Tool, used: Set<string>): ToolSpec {
  const { server, client } = conn;
  const name = uniqueName(`mcp__${server.name}__${tool.name}`, used);
  const readOnlyHint = tool.annotations?.readOnlyHint === true;
  const head = `[MCP: ${server.name}${name.endsWith(tool.name) ? '' : ` / 元の名前: ${tool.name}`}]`;
  const description = tool.description ? `${head} ${tool.description}` : head;
  return {
    name,
    description,
    parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
    },
    // サーバの自己申告。読み取りの注釈が無ければ最も厳しく扱う
    risk: readOnlyHint ? 'read' : 'execute',
    mcp: { server: server.name, tool: tool.name, trust: server.trust, readOnlyHint },
    async preview(args) {
      let shown = JSON.stringify(args ?? {}, null, 2);
      if (shown.length > ARGS_PREVIEW_CHARS)
        shown = `${shown.slice(0, ARGS_PREVIEW_CHARS)}\n…（省略）`;
      return {
        kind: 'text',
        text:
          `MCPサーバ「${server.name}」の道具 ${tool.name} を実行します。\n引数:\n${shown}\n` +
          'この操作は取り消せません（Akari の変更記録に残らず、akari undo の対象外です）。' +
          (readOnlyHint
            ? '\n（サーバは「読み取りだけ」と申告しています。Akari には確かめられません）'
            : ''),
      };
    },
    async run(args, ctx): Promise<ToolResult> {
      const label = `${server.name}: ${tool.name}`;
      try {
        const res = (await client.callTool(
          { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
          { timeout: server.toolTimeoutMs, signal: ctx.signal },
        )) as CallToolResult;
        const { text } = truncateMiddle(resultText(res), ctx.limits.toolOutputLimitBytes);
        if (res.isError) {
          return {
            ok: false,
            summary: `${label} が失敗を返しました: ${firstLine(text)}`,
            content: text,
            errorKind: 'failed',
          };
        }
        return { ok: true, summary: `${label} を実行しました`, content: text };
      } catch (err) {
        const timedOut = err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout;
        const msg = timedOut
          ? `${label} が ${Math.round(server.toolTimeoutMs / 1000)}秒以内に終わらなかったため、中断しました。`
          : `${label} を呼べませんでした: ${describeError(err)}`;
        return {
          ok: false,
          summary: msg,
          content: msg,
          errorKind: timedOut ? 'timeout' : 'failed',
        };
      }
    },
  };
}

/** モデルへ渡せる名前にする（英数字・_・- の64文字まで）。衝突したら _2, _3…。 */
export function uniqueName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (base.length > MAX_NAME) {
    const tag = createHash('sha256').update(raw).digest('hex').slice(0, 8);
    base = `${base.slice(0, MAX_NAME - 9)}_${tag}`;
  }
  let name = base;
  for (let i = 2; used.has(name); i++) {
    const suffix = `_${i}`;
    name = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

/** 道具の結果を文字にする。画像・音声はまだモデルへ渡せないので、あったことだけ伝える。 */
export function resultText(res: CallToolResult): string {
  const parts: string[] = [];
  for (const block of res.content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
      case 'audio':
        parts.push(
          `[${block.type === 'image' ? '画像' : '音声'}（${block.mimeType}）が返りました。Akari はまだこれをモデルへ渡せません]`,
        );
        break;
      case 'resource_link':
        parts.push(`[リソース: ${block.uri}${block.name ? `（${block.name}）` : ''}]`);
        break;
      case 'resource': {
        const r = block.resource as { uri: string; text?: string };
        parts.push(typeof r.text === 'string' ? r.text : `[バイナリのリソース: ${r.uri}]`);
        break;
      }
      default:
        parts.push(`[扱えない種類の結果: ${(block as { type: string }).type}]`);
    }
  }
  if (parts.length === 0 && res.structuredContent !== undefined) {
    parts.push(JSON.stringify(res.structuredContent, null, 2));
  }
  return parts.length > 0 ? parts.join('\n') : '（結果は空です）';
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return `コマンドが見つかりません（${(err as NodeJS.ErrnoException).path ?? ''}）`;
    return err.message;
  }
  return String(err);
}

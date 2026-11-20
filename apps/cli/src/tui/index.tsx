import path from 'node:path';
import { render } from 'ink';
import { Workspace, createProvider } from '@akari/core';
import {
  createContext,
  pickEndpoint,
  pickModel,
  pickReasoning,
  type GlobalOptions,
} from '../context.js';
import { chooseConversation } from '../conversation.js';
import {
  connectMcp,
  decideToolsMode,
  resolvePermission,
  resolveToolsModeOption,
  toolNamesFor,
  toolScopeOf,
} from '../agent-setup.js';
import { ExitError, EXIT } from '../exit.js';
import { note, setNotes } from '../term.js';
import { VERSION } from '../version.js';
import { App } from './App.js';
import { Controller, type AgentSetup, type ChatSetup } from './controller.js';
import { setThemeColor } from './theme.js';

/**
 * akari（引数なし）— 対話画面。仕様: docs/spec/17-interactive.md
 *
 * 画面を出す前に、接続先・モデル・道具の渡し方・会話を決める。
 * ここまでの失敗は、ヘッドレスの run と同じ文言と終了コードで終わる。
 */

export type InteractiveOptions = GlobalOptions & {
  cwd?: string;
  permission?: string;
  yes?: boolean;
  maxSteps?: string;
  noTools?: boolean;
  readOnly?: boolean;
  toolsMode?: string;
  timeout?: string;
  think?: string;
  continue?: boolean;
  conversation?: string;
  save?: boolean;
};

export async function interactiveCommand(opts: InteractiveOptions): Promise<void> {
  const ctx = await createContext(opts);
  const startupNotes: string[] = [];

  const endpoint = await pickEndpoint(ctx, opts.endpoint, opts.timeout);
  const provider = createProvider(endpoint, { logger: ctx.logger });
  const model = await pickModel(endpoint, opts.model, async () =>
    (await provider.listModels()).map((m) => m.id),
  );
  const reasoning = pickReasoning(opts.think, ctx.config.generation.reasoning);

  // 作業フォルダにできない場所なら、道具なしの会話で始める（17-interactive.md）
  const dir = path.resolve(opts.cwd ?? process.cwd());
  let workspace: Workspace | null = null;
  let refusal = '';
  try {
    workspace = await Workspace.open(dir);
  } catch (err) {
    if (opts.cwd) {
      // 明示されたフォルダが使えないなら、黙って道具なしにしない
      throw new ExitError(EXIT.usage, (err as Error).message, {
        hint: '-C で別のフォルダを指定できます。',
      });
    }
    refusal = (err as Error).message;
  }

  let setup: AgentSetup | ChatSetup;
  if (workspace) {
    const permission = resolvePermission(opts, ctx.config.agent.permissionMode);
    const scope = toolScopeOf(opts);
    const forced = resolveToolsModeOption(opts, ctx.config.agent.toolsMode);
    const decision = await decideToolsMode(
      ctx,
      endpoint,
      provider,
      model,
      toolNamesFor(scope),
      forced,
    );
    startupNotes.push(...decision.notes, ...decision.warnings);
    const maxSteps =
      opts.maxSteps !== undefined ? Number(opts.maxSteps) : ctx.config.agent.maxSteps;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
      throw new ExitError(EXIT.usage, '--max-steps は 1〜200 の整数で指定してください。');
    }
    // MCP サーバは画面を閉じるまでつないでおく（13-mcp.md「起動と生存」）
    if (scope !== 'off' && ctx.config.mcpServers.some((s) => s.enabled)) {
      note('MCP サーバへつないでいます…');
    }
    const mcp = await connectMcp(ctx, scope, workspace.root);
    startupNotes.push(...mcp.notices.map((n) => `! ${n.message}`));
    setup = {
      kind: 'agent',
      workspace,
      permission,
      scope,
      forced,
      toolsMode: decision.effective,
      maxSteps,
      mcp,
    };
  } else {
    setup = {
      kind: 'chat',
      reason: refusal,
      params: {
        temperature: ctx.config.generation.temperature,
        maxTokens: ctx.config.generation.maxTokens,
      },
    };
  }

  const conversation = await chooseConversation(ctx, opts, {
    kind: setup.kind === 'agent' ? 'agent' : 'chat',
    workspace: setup.kind === 'agent' ? setup.workspace.root : null,
    settings: { endpointId: endpoint.id, model },
  });

  const controller = new Controller({
    ctx,
    endpoint,
    provider,
    model,
    ...(reasoning ? { reasoning } : {}),
    conversation,
    save: opts.save !== false,
    setup,
    version: VERSION,
    startupNotes,
  });

  // 画面を出している間は、端末へ直接書く補助行を止める（画面が崩れるため）。伝えることは画面に出す
  setNotes(false);
  setThemeColor(opts.color !== false && !process.env.NO_COLOR);
  const app = render(<App controller={controller} />, {
    exitOnCtrlC: false,
    // 'auto' は端末への問い合わせ中（200ms）に届いた入力を2回流す（先打ちした文字が二重になった）。
    // 対応しない端末は有効化の指示を無視するだけなので、問い合わせずに有効にする
    kittyKeyboard: { mode: 'enabled' },
  });
  await app.waitUntilExit();
  controller.abort();
  if (setup.kind === 'agent') await setup.mcp.close();
  process.stdout.write(`${controller.farewell()}\n`);
}

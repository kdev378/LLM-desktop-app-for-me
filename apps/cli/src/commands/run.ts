import readlinePromises from 'node:readline/promises';
import path from 'node:path';
import {
  Workspace,
  Session,
  describeSandbox,
  createProvider,
  type ApprovalDecision,
  type RunEvent,
  type PermissionMode,
  type ToolsMode,
} from '@akari/core';
import {
  createContext,
  pickEndpoint,
  pickModel,
  pickReasoning,
  type GlobalOptions,
} from '../context.js';
import { c, out, write, note, isInteractive, formatDuration } from '../term.js';
import { ExitError, EXIT } from '../exit.js';
import { chooseConversation } from '../conversation.js';
import {
  connectMcp,
  decideToolsMode,
  mcpToolsFor,
  printMcpNotices,
  resolvePermission,
  resolveToolsModeOption,
  toolNamesFor,
  toolScopeOf,
  windowTokensFor,
} from '../agent-setup.js';
import {
  createBlockFilter,
  describeContext,
  describeEnd,
  describeMode,
  describeToolsMode,
  summarizeArgs,
} from '../describe.js';

/**
 * akari run — エージェント実行。仕様: docs/spec/10-cli.md
 *
 * 非対話（パイプの中）で承認が要る操作は自動で拒否する。
 * 勝手にファイルを書かないため。
 */

export type RunOptions = GlobalOptions & {
  cwd?: string;
  prompt?: string;
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

export async function runCommand(promptArgs: string[], opts: RunOptions): Promise<void> {
  const ctx = await createContext(opts);

  const permissionMode = resolvePermission(opts, ctx.config.agent.permissionMode);
  const workspaceDir = path.resolve(opts.cwd ?? process.cwd());

  let workspace: Workspace;
  try {
    workspace = await Workspace.open(workspaceDir);
  } catch (err) {
    throw new ExitError(EXIT.usage, (err as Error).message, {
      hint: '-C で別のフォルダを指定できます。',
    });
  }

  // -p - は「標準入力から読む」（docs/spec/10-cli.md）
  const fromArgs = opts.prompt === '-' ? '' : (opts.prompt ?? promptArgs.join(' ')).trim();
  const prompt = fromArgs || (await readStdin());
  if (!prompt) {
    throw new ExitError(EXIT.usage, '何をするかを渡してください。', {
      hint: 'akari run "テストを通して"  /  akari run -p - で標準入力から',
    });
  }

  const endpoint = await pickEndpoint(ctx, opts.endpoint, opts.timeout);
  const provider = createProvider(endpoint, { logger: ctx.logger });
  const model = await pickModel(endpoint, opts.model, async () =>
    (await provider.listModels()).map((m) => m.id),
  );

  const scope = toolScopeOf(opts);
  const toolNames = toolNamesFor(scope);
  const forced = resolveToolsModeOption(opts, ctx.config.agent.toolsMode);
  const toolsMode = await decideToolsMode(ctx, endpoint, provider, model, toolNames, forced);
  if (!ctx.json && !ctx.quiet) {
    for (const n of toolsMode.notes) note(n);
  }
  for (const w of toolsMode.warnings) note(w);
  const effectiveMode = toolsMode.effective;

  const reasoning = pickReasoning(opts.think, ctx.config.generation.reasoning);

  const maxSteps = opts.maxSteps !== undefined ? Number(opts.maxSteps) : ctx.config.agent.maxSteps;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
    throw new ExitError(EXIT.usage, '--max-steps は 1〜200 の整数で指定してください。');
  }

  // そのモデルの文脈長（判定や --context で分かっていれば）。圧縮の閾値が変わる
  const windowTokens = windowTokensFor(ctx, endpoint.id, model);

  // どの会話に書くか。続きなら、これまでのやり取りを読む（docs/spec/10-cli.md）
  const conversation = await chooseConversation(ctx, opts, {
    kind: 'agent',
    workspace: workspace.root,
    settings: { endpointId: endpoint.id, model },
  });

  // MCP サーバは、この実行の間だけつなぐ（docs/spec/13-mcp.md「起動と生存」）
  const mcp = await connectMcp(ctx, scope, workspace.root);
  printMcpNotices(mcp);
  try {
    await runSession();
  } finally {
    await mcp.close();
  }

  async function runSession(): Promise<void> {
    const session = Session.create({
      provider,
      model,
      workspace,
      transcript: conversation.transcript,
      // 文脈の管理（docs/spec/16-context.md）。文脈長はモデルごとの判定結果から
      context: {
        settings: ctx.config.context,
        windowTokens,
        endpointId: endpoint.id,
      },
      ...(conversation.source?.latestCompaction()
        ? { compaction: conversation.source.latestCompaction()! }
        : {}),
      ...(conversation.target
        ? {
            recorder: conversation.target.recorder({ model, endpointId: endpoint.id }),
            conversationId: conversation.target.id,
          }
        : {}),
      permissionMode,
      toolNames,
      extraTools: mcpToolsFor(mcp.tools, scope),
      maxSteps,
      toolsMode: effectiveMode,
      sandbox: ctx.config.agent.sandbox,
      ...(reasoning ? { reasoning } : {}),
      limits: {
        commandTimeoutMs: ctx.config.agent.commandTimeoutMs,
        toolOutputLimitBytes: ctx.config.agent.toolOutputLimitBytes,
        deniedCommands: ctx.config.agent.deniedCommands,
      },
      logger: ctx.logger,
    });

    const interactive = isInteractive();
    let interrupted = false;
    const onSigint = () => {
      if (interrupted) process.exit(EXIT.interrupted);
      interrupted = true;
      if (!ctx.json) out(c.yellow('\n中断しています…（もう一度 Ctrl+C で即座に終了）'));
      session.abort();
    };
    process.on('SIGINT', onSigint);

    // 代替方式では、本文に混ざるブロックを画面から隠す（内容は tool-call 行に出る）
    const blockFilter = toolsMode.mode === 'prompted' && !ctx.json ? createBlockFilter() : null;

    const started = Date.now();
    let deniedForNonInteractive = false;
    let endReason: string = 'done';
    let lastWasText = false;

    try {
      for await (const ev of session.send(prompt)) {
        if (ctx.json) {
          out(JSON.stringify({ ts: new Date().toISOString(), ...ev }));
        }
        switch (ev.type) {
          case 'run-start':
            if (!ctx.json && !ctx.quiet) {
              out(
                c.dim(
                  `${endpoint.name} / ${model}  ${ev.workspace}  権限: ${describeMode(permissionMode)}  ツール: ${describeTools(opts, ev.toolNames)}${ev.toolNames.length > 0 ? ` / ${describeToolsMode(ev.toolsMode)}` : ''}`,
                ),
              );
              if (ev.toolNames.length === 0) {
                out(
                  c.yellow(
                    'ツールを渡していないため、ファイルの読み書きとコマンド実行はできません。',
                  ),
                );
                out(c.dim('ファイルを触らせるには --no-tools を外してください。'));
              }
              if (ev.sandbox) out(c.dim(`コマンド: ${describeSandbox(ev.sandbox)}`));
              if (ev.instructionFiles.length > 0)
                out(c.dim(`指示ファイル: ${ev.instructionFiles.join(', ')}`));
              out(c.dim(describeConversation(conversation)));
              if (ev.toolNames.length > 0)
                out(c.dim(describeContext(ctx.config.context, windowTokens)));
              out('');
            }
            break;
          case 'text-delta': {
            if (ctx.json) break;
            const shown = blockFilter ? blockFilter.feed(ev.text) : ev.text;
            if (shown !== '') {
              write(shown);
              lastWasText = true;
            }
            break;
          }
          case 'tool-call':
            if (!ctx.json) {
              if (blockFilter) {
                const rest = blockFilter.flush();
                if (rest.trim() !== '') write(rest);
              }
              if (lastWasText) {
                out('');
                lastWasText = false;
              }
              out(c.cyan(`  ${ev.name}`) + c.dim(` ${summarizeArgs(ev.args)}`));
            }
            break;
          case 'tool-output':
            if (!ctx.json && !ctx.quiet) write(c.dim(indentBlock(ev.text)));
            break;
          case 'tool-result':
            if (!ctx.json) {
              out(ev.ok ? c.green(`    ✓ ${ev.summary}`) : c.red(`    ✗ ${ev.summary}`));
            }
            break;
          case 'approval-request': {
            if (!interactive) {
              // パイプの中で勝手にファイルを書かない
              deniedForNonInteractive = true;
              session.approve(ev.callId, {
                kind: 'deny',
                feedback: '対話できない環境のため自動で拒否しました',
              });
              if (!ctx.json)
                out(c.yellow(`    ! 承認が必要ですが対話できないため拒否しました（${ev.name}）`));
              break;
            }
            const decision = await askApproval(ev);
            session.approve(ev.callId, decision);
            break;
          }
          case 'compaction-start':
            if (!ctx.json) {
              if (lastWasText) {
                out('');
                lastWasText = false;
              }
              out(
                c.magenta(
                  `  ⧉ 文脈が約${ev.beforeTokens.toLocaleString()}トークン${ev.estimated ? '（概算）' : ''}になったため、古い ${ev.turns} 手を圧縮しています…`,
                ),
              );
            }
            break;
          case 'compaction-end':
            if (!ctx.json) {
              out(
                c.magenta(
                  `  ⧉ 圧縮しました: 約${ev.afterTokens.toLocaleString()}トークン${ev.estimated ? '（概算）' : ''}。中身は akari digest で見られます`,
                ),
              );
              if (ev.fallback)
                out(
                  c.yellow(
                    '    ! モデルが圧縮版を書けなかった分は、機械的な要約で残しています（劣った圧縮です）。',
                  ),
                );
            }
            break;
          case 'notice':
            if (!ctx.json)
              out(ev.level === 'warn' ? c.yellow(`  ! ${ev.message}`) : c.dim(`  ${ev.message}`));
            break;
          case 'run-end': {
            endReason = ev.reason;
            if (!ctx.json) {
              if (blockFilter) {
                const rest = blockFilter.flush();
                if (rest.trim() !== '') write(rest);
              }
              if (lastWasText) out('');
              out('');
              out(c.dim(`${describeEnd(ev.reason)}  ${formatDuration(Date.now() - started)}`));
              if (ev.changedFiles.length > 0) {
                out(c.dim(`変更したファイル (${ev.changedFiles.length}):`));
                for (const f of ev.changedFiles) out(c.dim(`  ${f}`));
                out(c.dim(`元に戻すには: akari undo --run ${session.runId}`));
              }
              if (ev.error)
                out(c.red(`エラー: ${typeof ev.error === 'string' ? ev.error : ev.error.message}`));
              if (conversation.target && !ctx.quiet)
                out(c.dim(`続けるには: akari run -c "…"  （会話 ${conversation.target.id}）`));
            }
            break;
          }
          default:
            break;
        }
      }
    } finally {
      process.off('SIGINT', onSigint);
    }

    if (deniedForNonInteractive) {
      throw new ExitError(EXIT.denied, '承認が得られなかったため、一部の操作を行いませんでした。', {
        // full でも聞く操作（削除、断られた後のコマンド）がある。そこで「full にして」と言わない
        hint:
          permissionMode === 'full'
            ? '削除・秘密のファイルの読み取り・断られた後のコマンド・trust が ask の MCP の道具は、full でも確認が要ります。対話できる端末で実行してください。'
            : '自動で進めるには --permission auto-edit などを明示してください。',
        silent: ctx.json,
      });
    }
    if (endReason === 'aborted')
      throw new ExitError(EXIT.interrupted, '中断しました。', { silent: true });
    if (endReason === 'max-steps') {
      throw new ExitError(EXIT.maxSteps, `ステップ上限（${maxSteps}）に達しました。`, {
        hint: '--max-steps を増やすか、目的を分けてください。',
        silent: ctx.json,
      });
    }
    // 作業は終わっていない。スクリプトから成功に見えないよう、ステップ上限と同じ「途中で止まった」扱い
    if (endReason === 'loop') {
      throw new ExitError(EXIT.maxSteps, '同じ操作を繰り返したため、途中で止めました。', {
        hint: '指示を具体的にするか、別のモデルで試してください。',
        silent: ctx.json,
      });
    }
    if (endReason === 'error' || endReason === 'context-full')
      throw new ExitError(EXIT.runtime, '実行が失敗しました。', { silent: true });
  }
}

function describeTools(opts: RunOptions, names: string[]): string {
  if (opts.noTools) return 'なし（--no-tools）';
  const mcp = names.filter((n) => n.startsWith('mcp__')).length;
  const own = names.length - mcp;
  const tail = mcp > 0 ? ` + MCP ${mcp}種` : '';
  if (opts.readOnly) return `読み取りのみ ${own}種${tail}（--read-only）`;
  return `${own}種${tail}`;
}

function describeConversation(conv: Awaited<ReturnType<typeof chooseConversation>>): string {
  if (!conv.target) {
    return conv.continued
      ? `会話: ${conv.source?.id} の続き（--no-save のため保存しない）`
      : '会話: 保存しない（--no-save）';
  }
  return conv.continued
    ? `会話: ${conv.target.id} の続き（これまで ${conv.transcript.length} 件）`
    : `会話: ${conv.target.id}（新規）`;
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? '' : '    ' + l))
    .join('\n');
}

async function askApproval(
  ev: Extract<RunEvent, { type: 'approval-request' }>,
): Promise<ApprovalDecision> {
  out('');
  out(c.yellow('  承認が必要です'));
  for (const line of ev.prompt.split('\n')) out(c.bold('    ' + line));
  if (ev.preview?.kind === 'diff') {
    const { formatUnifiedDiff } = await import('@akari/core');
    const text = formatUnifiedDiff(ev.preview.path, ev.preview.before, ev.preview.after, 2);
    for (const line of text.split('\n').slice(0, 60)) {
      out(
        '    ' +
          (line.startsWith('+') ? c.green(line) : line.startsWith('-') ? c.red(line) : c.dim(line)),
      );
    }
  }
  const labels = ev.options.map((o) => `[${o.key}] ${o.label}`).join('   ');
  out(c.dim('    ' + labels));

  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('    > ')).trim().toLowerCase();
      const chosen = ev.options.find((o) => o.key === answer);
      if (!chosen) {
        out(c.dim(`    ${ev.options.map((o) => o.key).join(' / ')} のどれかを入力してください。`));
        continue;
      }
      if (chosen.decision.kind === 'deny') {
        const reason = (await rl.question('    理由（空でも可）: ')).trim();
        return reason ? { kind: 'deny', feedback: reason } : { kind: 'deny' };
      }
      return chosen.decision;
    }
  } finally {
    rl.close();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

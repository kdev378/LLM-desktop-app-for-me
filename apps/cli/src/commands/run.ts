import readlinePromises from 'node:readline/promises';
import path from 'node:path';
import {
  Workspace,
  Session,
  createProvider,
  resolveToolsMode,
  updateEndpoint,
  ALL_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  type ApprovalDecision,
  type RunEvent,
  type PermissionMode,
} from '@akari/core';
import { createContext, pickEndpoint, pickModel, persist, type GlobalOptions } from '../context.js';
import { c, out, write, note, isInteractive, formatDuration } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

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

  const prompt = (opts.prompt ?? promptArgs.join(' ')).trim() || (await readStdin());
  if (!prompt) {
    throw new ExitError(EXIT.usage, '何をするかを渡してください。', {
      hint: 'akari run "テストを通して"  /  akari run -p - で標準入力から',
    });
  }

  const endpoint = await pickEndpoint(ctx, opts.endpoint);
  const provider = createProvider(endpoint, { logger: ctx.logger });
  const model = await pickModel(endpoint, opts.model, async () =>
    (await provider.listModels()).map((m) => m.id),
  );

  // ツール呼び出しの方式を確定させてから実行する。
  // 未判定のまま非対応モデルへネイティブのツール定義を渡すと、
  // モデルが何も呼ばず「何も起きずに終わった」ように見えてしまう。
  const toolsMode = await resolveToolsMode(
    provider,
    {
      tools: endpoint.capabilities.tools,
      probedModel: endpoint.capabilities.probedModel,
      byModel: endpoint.capabilities.byModel,
    },
    model,
  );
  if (!ctx.json && !ctx.quiet) {
    for (const n of toolsMode.notes) note(n);
  }
  if (toolsMode.capabilities) {
    // 判定結果は保存する。毎回判定し直さないため。
    await persist(
      ctx,
      updateEndpoint(ctx.config, endpoint.id, {
        capabilities: {
          ...endpoint.capabilities,
          ...toolsMode.capabilities,
          byModel: {
            ...endpoint.capabilities.byModel,
            ...(toolsMode.modelCapability
              ? { [toolsMode.modelCapability.model]: toolsMode.modelCapability.value }
              : {}),
          },
        },
      }),
    ).catch(() => undefined);
  }
  if (toolsMode.mode === 'none' && !opts.noTools) {
    throw new ExitError(EXIT.runtime, `${model} がツールを使えるか判定できませんでした。`, {
      hint: 'akari config endpoints probe で判定し直すか、--no-tools で生成だけ行ってください。',
    });
  }

  const maxSteps = opts.maxSteps !== undefined ? Number(opts.maxSteps) : ctx.config.agent.maxSteps;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
    throw new ExitError(EXIT.usage, '--max-steps は 1〜200 の整数で指定してください。');
  }

  const toolNames = opts.noTools ? [] : opts.readOnly ? READ_ONLY_TOOL_NAMES : ALL_TOOL_NAMES;

  const session = Session.create({
    provider,
    model,
    workspace,
    permissionMode,
    toolNames,
    maxSteps,
    promptedTools: toolsMode.mode === 'prompted',
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
                `${endpoint.name} / ${model}  ${ev.workspace}  権限: ${describeMode(permissionMode)}`,
              ),
            );
            if (ev.instructionFiles.length > 0)
              out(c.dim(`指示ファイル: ${ev.instructionFiles.join(', ')}`));
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
      hint: '自動で進めるには --permission auto-edit などを明示してください。',
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
  if (endReason === 'error')
    throw new ExitError(EXIT.runtime, '実行が失敗しました。', { silent: true });
}

function resolvePermission(opts: RunOptions, fallback: PermissionMode): PermissionMode {
  const raw =
    opts.permission ?? (opts.yes ? 'auto-edit' : undefined) ?? process.env.AKARI_PERMISSION_MODE;
  if (raw === undefined) return fallback;
  const map: Record<string, PermissionMode> = {
    ask: 'ask',
    'auto-edit': 'autoEdit',
    autoedit: 'autoEdit',
    autoEdit: 'autoEdit',
    full: 'full',
  };
  const mode = map[raw];
  if (!mode) {
    throw new ExitError(
      EXIT.usage,
      `--permission は ask / auto-edit / full のいずれかです（受け取った値: ${raw}）。`,
    );
  }
  return mode;
}

function describeMode(m: PermissionMode): string {
  return m === 'ask' ? '承認する' : m === 'autoEdit' ? '編集は自動・コマンドは承認' : 'すべて自動';
}

function describeEnd(reason: string): string {
  const map: Record<string, string> = {
    done: '完了',
    aborted: '中断',
    'max-steps': 'ステップ上限で停止',
    error: 'エラーで停止',
    denied: '拒否により停止',
    loop: '同じ操作の繰り返しを検出して停止',
  };
  return map[reason] ?? reason;
}

function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  const rec = args as Record<string, unknown>;
  if (typeof rec.command === 'string') return rec.command.slice(0, 120);
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.pattern === 'string') return rec.pattern;
  return '';
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

/**
 * 代替方式のとき、本文に混ざる akari-tool ブロックを画面から隠す。
 * 呼び出しの内容は直後の tool-call 行に出るので、情報は失われない。
 * チャンクの途中でフェンスが割れても壊れないよう、末尾を持ち越す。
 */
function createBlockFilter(): { feed: (chunk: string) => string; flush: () => string } {
  const OPEN = '```akari-tool';
  const CLOSE = '```';
  let buf = '';
  let hidden = false;

  const feed = (chunk: string): string => {
    buf += chunk;
    let out = '';
    for (;;) {
      if (!hidden) {
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          // フェンスの先頭が末尾に掛かっているかもしれない分だけ残す
          const keep = Math.min(buf.length, OPEN.length - 1);
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          return out;
        }
        out += buf.slice(0, i);
        buf = buf.slice(i + OPEN.length);
        hidden = true;
      } else {
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          const keep = Math.min(buf.length, CLOSE.length - 1);
          buf = buf.slice(buf.length - keep);
          return out;
        }
        buf = buf.slice(j + CLOSE.length);
        hidden = false;
      }
    }
  };

  const flush = (): string => {
    const rest = hidden ? '' : buf;
    buf = '';
    return rest;
  };

  return { feed, flush };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid, shortId } from '../util/ids.js';
import { ChangeJournal, type UndoResult } from './journal.js';
import { Workspace } from '../tools/workspace.js';
import { selectTools, toolDefinitions, findTool } from '../tools/registry.js';
import { commandScope, matchesDenied } from '../tools/command.js';
import {
  DEFAULT_LIMITS,
  type ToolContext,
  type ToolLimits,
  type ToolSpec,
  type ToolPreview,
  type Risk,
} from '../tools/types.js';
import {
  buildSystemPrompt,
  loadInstructionFiles,
  extractPromptedCalls,
  formatPromptedResult,
} from './prompt.js';
import {
  approvalOptions,
  type ApprovalDecision,
  type PermissionMode,
  type RunEndReason,
  type RunEvent,
} from './events.js';
import type {
  Provider,
  ChatMessage,
  ProviderError,
  ToolCallRequest,
  Usage,
} from '../provider/types.js';
import type { Logger } from '../diagnostics/logger.js';

/**
 * エージェントの実行ループ。仕様: docs/spec/05-agent.md
 *
 * 呼び出し側は for await でイベントを受け取り、approval-request が来たら
 * approve() を呼んでから次のイベントを取りに来る。
 */

export type SessionOptions = {
  provider: Provider;
  model: string;
  workspace: Workspace;
  permissionMode?: PermissionMode;
  /** 使うツール名。省略で標準一式。 */
  toolNames?: string[];
  maxSteps?: number;
  limits?: Partial<ToolLimits>;
  /** ネイティブのツール呼び出しに対応していない接続先向け。 */
  promptedTools?: boolean;
  projectInstructions?: string;
  conversationInstructions?: string;
  /** 続きから始める場合の既存メッセージ。 */
  history?: ChatMessage[];
  logger?: Logger;
  root?: string;
  runId?: string;
};

/** 1回の応答で受け付けるツール呼び出しの上限。 */
const MAX_CALLS_PER_STEP = 8;
/** 同じツール・同じ引数がこの回数続いたらループとみなす。 */
const LOOP_THRESHOLD = 3;

export class Session {
  readonly runId: string;
  readonly workspace: Workspace;
  private readonly opts: Required<Pick<SessionOptions, 'permissionMode' | 'maxSteps'>> &
    SessionOptions;
  private readonly limits: ToolLimits;
  private readonly tools: ToolSpec[];
  private readonly unknownTools: string[];
  private messages: ChatMessage[] = [];
  private journal: ChangeJournal | null = null;
  private controller = new AbortController();
  private pending = new Map<string, (d: ApprovalDecision) => void>();
  private sessionAllows = new Set<string>();
  private running = false;
  private aborted = false;

  private constructor(
    opts: SessionOptions,
    tools: ToolSpec[],
    unknown: string[],
    limits: ToolLimits,
  ) {
    this.runId = opts.runId ?? ulid();
    this.workspace = opts.workspace;
    this.opts = { permissionMode: 'ask', maxSteps: 25, ...opts };
    this.tools = tools;
    this.unknownTools = unknown;
    this.limits = limits;
    this.messages = [...(opts.history ?? [])];
  }

  static create(opts: SessionOptions): Session {
    const { tools, unknown } = selectTools(opts.toolNames);
    const limits: ToolLimits = { ...DEFAULT_LIMITS, ...opts.limits };
    return new Session(opts, tools, unknown, limits);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 承認の返答。approval-request を受け取った側が呼ぶ。 */
  approve(callId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(callId);
    if (!resolve) return false;
    this.pending.delete(callId);
    resolve(decision);
    return true;
  }

  /** 実行を止める。モデルのストリームと実行中のコマンドの両方へ伝わる。 */
  abort(): void {
    this.aborted = true;
    this.controller.abort();
    for (const [, resolve] of this.pending)
      resolve({ kind: 'deny', feedback: '実行が中断されました' });
    this.pending.clear();
  }

  /** この実行が行ったファイル変更を戻す。 */
  async undo(): Promise<UndoResult> {
    const journal = this.journal ?? (await ChangeJournal.load(this.runId, this.opts.root));
    if (!journal) return { runId: this.runId, restored: [], skipped: [] };
    return journal.undo();
  }

  async *send(input: string): AsyncGenerator<RunEvent, void, void> {
    if (this.running) throw new Error('この会話では既に実行中です。');
    this.running = true;
    this.aborted = false;
    this.controller = new AbortController();

    try {
      yield* this.runLoop(input);
    } finally {
      this.running = false;
      this.pending.clear();
    }
  }

  private async *runLoop(input: string): AsyncGenerator<RunEvent, void, void> {
    const journal = await ChangeJournal.create(this.runId, this.workspace.root, this.opts.root);
    this.journal = journal;

    const instructions = await loadInstructionFiles(this.workspace.root);
    const git = await detectGit(this.workspace.root);
    const promptedTools = this.opts.promptedTools === true;

    const system = buildSystemPrompt({
      workspaceRoot: this.workspace.root,
      tools: this.tools,
      promptedTools,
      instructions,
      projectInstructions: this.opts.projectInstructions,
      conversationInstructions: this.opts.conversationInstructions,
      git,
    });

    if (this.messages.length === 0 || this.messages[0]?.role !== 'system') {
      this.messages.unshift({ role: 'system', content: system });
    } else {
      this.messages[0] = { role: 'system', content: system };
    }
    this.messages.push({ role: 'user', content: input });

    yield {
      type: 'run-start',
      runId: this.runId,
      workspace: this.workspace.root,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      instructionFiles: instructions.map((i) => i.name),
      toolNames: this.tools.map((t) => t.name),
      promptedTools,
    };

    if (this.unknownTools.length > 0) {
      yield {
        type: 'notice',
        level: 'warn',
        message: `知らないツール名を指定されました: ${this.unknownTools.join(', ')}`,
      };
    }
    if (promptedTools) {
      yield {
        type: 'notice',
        level: 'warn',
        message:
          '代替方式（prompted）で動作中です。ネイティブのツール呼び出しより失敗しやすくなります。',
      };
    }

    const recent: string[] = [];
    let endReason: RunEndReason = 'done';
    let endError: ProviderError | string | undefined;

    for (let step = 1; step <= this.opts.maxSteps; step++) {
      if (this.aborted) {
        endReason = 'aborted';
        break;
      }
      yield { type: 'step-start', step };

      let text = '';
      let usage: Usage | undefined;
      const nativeCalls: ToolCallRequest[] = [];
      let failed = false;

      for await (const ev of this.opts.provider.chat(
        {
          model: this.opts.model,
          messages: this.messages,
          ...(promptedTools ? {} : { tools: toolDefinitions(this.tools) }),
        },
        this.controller.signal,
      )) {
        if (ev.type === 'text-delta') {
          text += ev.text;
          yield { type: 'text-delta', text: ev.text };
        } else if (ev.type === 'reasoning-delta') {
          yield { type: 'reasoning-delta', text: ev.text };
        } else if (ev.type === 'tool-call') {
          nativeCalls.push({ id: ev.id, name: ev.name, argumentsRaw: ev.argumentsRaw });
        } else if (ev.type === 'finish') {
          usage = ev.usage;
        } else if (ev.type === 'error') {
          if (ev.error.kind === 'aborted') {
            endReason = 'aborted';
          } else {
            endReason = 'error';
            endError = ev.error;
          }
          failed = true;
          break;
        }
      }

      if (failed) break;
      if (this.aborted) {
        endReason = 'aborted';
        break;
      }

      // 代替方式では本文からツール呼び出しを取り出す
      let calls: ToolCallRequest[] = nativeCalls;
      let promptedErrors: string[] = [];
      if (promptedTools) {
        const extracted = extractPromptedCalls(text);
        promptedErrors = extracted.errors;
        calls = extracted.calls
          .slice(0, 3)
          .map((c) => ({ id: shortId('call_'), name: c.name, argumentsRaw: c.argumentsRaw }));
      }

      this.messages.push({
        role: 'assistant',
        content: text,
        ...(nativeCalls.length > 0 ? { toolCalls: nativeCalls } : {}),
      });

      if (promptedErrors.length > 0) {
        for (const e of promptedErrors) yield { type: 'notice', level: 'warn', message: e };
        this.messages.push({
          role: 'user',
          content: `[akari] 次の形式エラーがありました。その形式では受け取れません。\n${promptedErrors.join('\n')}`,
        });
        yield { type: 'step-end', step, ...(usage ? { usage } : {}) };
        continue;
      }

      if (calls.length === 0) {
        yield { type: 'step-end', step, ...(usage ? { usage } : {}) };
        endReason = 'done';
        break;
      }

      if (calls.length > MAX_CALLS_PER_STEP) {
        yield {
          type: 'notice',
          level: 'warn',
          message: `1回の応答でツールが ${calls.length} 件呼ばれました。上限 ${MAX_CALLS_PER_STEP} 件までを実行します。`,
        };
        const dropped = calls
          .slice(MAX_CALLS_PER_STEP)
          .map((c) => c.name)
          .join(', ');
        calls = calls.slice(0, MAX_CALLS_PER_STEP);
        this.messages.push({
          role: 'user',
          content: `[akari] 上限のため次のツールは実行しませんでした: ${dropped}`,
        });
      }

      let abortRequested = false;
      for (const call of calls) {
        if (this.aborted) {
          abortRequested = true;
          break;
        }

        const fingerprint = `${call.name}:${call.argumentsRaw}`;
        recent.push(fingerprint);
        if (recent.length > LOOP_THRESHOLD) recent.shift();
        if (recent.length === LOOP_THRESHOLD && recent.every((f) => f === fingerprint)) {
          yield {
            type: 'notice',
            level: 'warn',
            message: `同じ呼び出しが ${LOOP_THRESHOLD} 回続いたため停止しました: ${call.name}`,
          };
          endReason = 'loop';
          abortRequested = true;
          break;
        }

        const outcome = yield* this.executeCall(call, journal, promptedTools);
        if (outcome === 'abort') {
          abortRequested = true;
          endReason = 'aborted';
          break;
        }
      }

      yield { type: 'step-end', step, ...(usage ? { usage } : {}) };
      if (abortRequested) break;
      if (step === this.opts.maxSteps) endReason = 'max-steps';
    }

    yield {
      type: 'run-end',
      reason: this.aborted && endReason !== 'loop' ? 'aborted' : endReason,
      changedFiles: journal.changedFiles(),
      ...(endError !== undefined ? { error: endError } : {}),
    };
  }

  /** 1つのツール呼び出しを、承認を挟んで実行する。 */
  private async *executeCall(
    call: ToolCallRequest,
    journal: ChangeJournal,
    promptedTools: boolean,
  ): AsyncGenerator<RunEvent, 'ok' | 'abort', void> {
    const tool = findTool(this.tools, call.name);
    if (!tool) {
      const msg = `そのツールはありません: ${call.name}。使えるのは ${this.tools.map((t) => t.name).join(', ')} です。`;
      yield { type: 'tool-result', callId: call.id, name: call.name, ok: false, summary: msg };
      this.pushToolResult(call, false, msg, promptedTools);
      return 'ok';
    }

    let args: unknown;
    try {
      args = call.argumentsRaw.trim() === '' ? {} : JSON.parse(call.argumentsRaw);
    } catch {
      const msg = `引数がJSONとして読めません: ${call.argumentsRaw.slice(0, 200)}`;
      yield { type: 'tool-result', callId: call.id, name: call.name, ok: false, summary: msg };
      this.pushToolResult(call, false, msg, promptedTools);
      return 'ok';
    }

    const ctx: ToolContext = {
      workspace: this.workspace,
      journal,
      limits: this.limits,
      signal: this.controller.signal,
      callId: call.id,
      logger: this.opts.logger,
    };

    let preview: ToolPreview | undefined;
    try {
      preview = await tool.preview?.(args, ctx);
    } catch {
      preview = undefined;
    }

    yield {
      type: 'tool-call',
      callId: call.id,
      name: tool.name,
      args,
      risk: tool.risk,
      ...(preview ? { preview } : {}),
    };

    // パス境界は承認より前に見る。外なら承認画面を出さずに拒否する（docs/spec/05-agent.md）。
    // 何を試みたかは上の tool-call で見えているので、利用者には経緯が残る。
    for (const use of tool.pathsOf?.(args) ?? []) {
      const check = await this.workspace.resolve(use.value, use.mode);
      if (!check.ok) {
        yield {
          type: 'tool-result',
          callId: call.id,
          name: tool.name,
          ok: false,
          summary: check.message,
        };
        this.pushToolResult(call, false, check.message, promptedTools);
        return 'ok';
      }
    }

    // 拒否リストは承認より前。承認画面すら出さない。
    if (tool.name === 'run_command') {
      const command = (args as { command?: unknown }).command;
      if (typeof command === 'string') {
        const hit = matchesDenied(command, this.limits.deniedCommands);
        if (hit !== null) {
          const msg = `このコマンドは実行できません（拒否リストの "${hit}" に一致）。`;
          yield { type: 'tool-result', callId: call.id, name: tool.name, ok: false, summary: msg };
          this.pushToolResult(call, false, msg, promptedTools);
          return 'ok';
        }
      }
    }

    const need = this.needsApproval(tool.risk, tool.name, args);
    if (need.required) {
      const decision = yield* this.askApproval(call, tool, preview, need.scope);
      yield { type: 'approval-resolved', callId: call.id, decision };
      if (decision.kind === 'abort') return 'abort';
      if (decision.kind === 'deny') {
        const msg = decision.feedback
          ? `利用者が拒否しました: ${decision.feedback}`
          : '利用者が拒否しました。別の方法を検討してください。';
        yield {
          type: 'tool-result',
          callId: call.id,
          name: tool.name,
          ok: false,
          summary: '拒否されました',
        };
        this.pushToolResult(call, false, msg, promptedTools);
        return 'ok';
      }
      if (decision.kind === 'allow-session') this.sessionAllows.add(decision.scope);
    }

    yield { type: 'tool-start', callId: call.id, name: tool.name };

    const outputs: RunEvent[] = [];
    const runCtx: ToolContext = {
      ...ctx,
      onOutput: (stream, text) => {
        outputs.push({ type: 'tool-output', callId: call.id, stream, text });
      },
    };

    const resultPromise = tool.run(args, runCtx);
    // 逐次出力を流しながら待つ
    let done = false;
    void resultPromise.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    while (!done) {
      if (outputs.length > 0) {
        const batch = outputs.splice(0, outputs.length);
        for (const ev of batch) yield ev;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    for (const ev of outputs.splice(0, outputs.length)) yield ev;

    let result;
    try {
      result = await resultPromise;
    } catch (err) {
      const msg = `ツールの実行が失敗しました: ${(err as Error).message}`;
      yield { type: 'tool-result', callId: call.id, name: tool.name, ok: false, summary: msg };
      this.pushToolResult(call, false, msg, promptedTools);
      return 'ok';
    }

    yield {
      type: 'tool-result',
      callId: call.id,
      name: tool.name,
      ok: result.ok,
      summary: result.summary,
      ...(result.change ? { change: result.change } : {}),
    };
    this.pushToolResult(call, result.ok, result.content, promptedTools);
    return 'ok';
  }

  private async *askApproval(
    call: ToolCallRequest,
    tool: ToolSpec,
    preview: ToolPreview | undefined,
    scope: string | null,
  ): AsyncGenerator<RunEvent, ApprovalDecision, void> {
    const promise = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(call.id, resolve);
    });
    yield {
      type: 'approval-request',
      callId: call.id,
      name: tool.name,
      risk: tool.risk,
      prompt: describeApproval(tool, preview),
      options: approvalOptions(scope),
      ...(preview ? { preview } : {}),
    };
    return promise;
  }

  /**
   * 承認が要るか。仕様: docs/spec/05-agent.md「承認モデル」の表。
   * delete_file は full でも必ず聞く。
   */
  private needsApproval(
    risk: Risk,
    name: string,
    args: unknown,
  ): { required: boolean; scope: string | null } {
    const mode = this.opts.permissionMode;
    const scope = this.scopeFor(name, args);
    if (scope && this.sessionAllows.has(scope)) return { required: false, scope };

    if (name === 'delete_file') return { required: true, scope: null };
    if (risk === 'read') return { required: false, scope };
    if (risk === 'write') return { required: mode === 'ask', scope };
    // execute
    return { required: mode !== 'full', scope };
  }

  private scopeFor(name: string, args: unknown): string | null {
    if (name === 'run_command') {
      const command = (args as { command?: unknown }).command;
      return typeof command === 'string' ? `command:${commandScope(command)}` : null;
    }
    const p = (args as { path?: unknown }).path;
    return typeof p === 'string' ? `${name}:${p}` : null;
  }

  private pushToolResult(
    call: ToolCallRequest,
    ok: boolean,
    content: string,
    promptedTools: boolean,
  ): void {
    if (promptedTools) {
      this.messages.push({ role: 'user', content: formatPromptedResult(call.name, ok, content) });
    } else {
      this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
    }
  }
}

function describeApproval(tool: ToolSpec, preview: ToolPreview | undefined): string {
  if (preview?.kind === 'command')
    return `コマンドを実行します: ${preview.command}\n作業ディレクトリ: ${preview.cwd}`;
  if (preview?.kind === 'diff') return `${preview.path} を書き換えます。`;
  if (preview?.kind === 'delete')
    return `${preview.path} を削除します（${preview.bytes} バイト）。`;
  return `${tool.name} を実行します。`;
}

async function detectGit(root: string): Promise<{ isRepo: boolean; branch?: string }> {
  try {
    const head = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8');
    const m = /ref:\s*refs\/heads\/(.+)/.exec(head.trim());
    return { isRepo: true, ...(m ? { branch: m[1] } : {}) };
  } catch {
    return { isRepo: false };
  }
}

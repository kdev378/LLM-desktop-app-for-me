import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid, shortId } from '../util/ids.js';
import { ChangeJournal, type UndoResult } from './journal.js';
import { Workspace } from '../tools/workspace.js';
import { selectTools, toolDefinitions, findTool } from '../tools/registry.js';
import { commandScope, matchesDenied, findDeleteCommand } from '../tools/command.js';
import {
  DEFAULT_LIMITS,
  type ToolContext,
  type ToolLimits,
  type ToolSpec,
  type ToolPreview,
  type Risk,
} from '../tools/types.js';
import { buildSystemPrompt, loadInstructionFiles, extractPromptedCalls } from './prompt.js';
import {
  approvalOptions,
  type ApprovalDecision,
  type PermissionMode,
  type RunEndReason,
  type RunEvent,
  type ToolsMode,
} from './events.js';
import type {
  Provider,
  ReasoningLevel,
  ProviderError,
  ToolCallRequest,
  Usage,
  FinishReason,
} from '../provider/types.js';
import type { ConversationRecorder, RecordedMessage } from './recorder.js';
import { buildApiMessages, type TranscriptEntry } from './transcript.js';
import { RECALL_TOOLS } from '../tools/recall.js';
import { SECRET_ACCESS_TOOL_NAME, requestSecretAccessTool } from '../tools/secrets.js';
import { detectSandbox, hasWorkspaceSecrets, type SandboxStatus } from '../tools/sandbox.js';
import {
  compactThreshold,
  estimateTokens,
  selectForCompaction,
  truncateMiddle,
  type Unit,
} from '../context/budget.js';
import { compact } from '../context/compactor.js';
import { renderDigest, type Compaction } from '../context/digest.js';
import type { ContextSettings, SandboxSettings } from '../config/schema.js';
import type { ChatMessage, ToolDefinition } from '../provider/types.js';
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
  /**
   * 道具の渡し方。既定は 'both'（対応が分からないときの安全側）。
   * docs/spec/02-provider.md
   */
  toolsMode?: ToolsMode;
  /** 思考（reasoning）の量。docs/spec/02-provider.md */
  reasoning?: ReasoningLevel;
  /**
   * やり取りの記録係（docs/spec/04-chat.md）。省略すると保存しない。
   * Session はファイルのことを知らず、メッセージができるたびにここへ渡すだけ。
   */
  recorder?: ConversationRecorder;
  /** 記録先の会話。run-start に載せて、呼び出し側が続きを指定できるようにする。 */
  conversationId?: string;
  /**
   * 文脈の管理（docs/spec/16-context.md）。省略すると量を見ない（圧縮しない）。
   * windowTokens はそのモデルの文脈長。分からなければ null。
   */
  context?: { settings: ContextSettings; windowTokens: number | null; endpointId: string };
  /** 続きから始めるときの、いちばん新しい圧縮の記録。 */
  compaction?: Compaction;
  /**
   * コマンドの閉じ込め（05-agent.md）。設定の agent.sandbox をそのまま渡す。
   * 省略すると閉じ込めない（テストや、閉じ込めを持たない呼び出し。そのことは run-start に出る）。
   */
  sandbox?: SandboxSettings;
  /** 閉じ込めの中で、既定の場所に加えて書き込みを許す場所（worktree の元の .git など）。 */
  sandboxExtraWrite?: string[];
  projectInstructions?: string;
  conversationInstructions?: string;
  /**
   * 続きから始める場合の、これまでの生の記録（保存した会話から toTranscript で作る）。
   * システムプロンプトは含めない。毎回作り直す。
   */
  transcript?: TranscriptEntry[];
  logger?: Logger;
  root?: string;
  runId?: string;
};

/** 1回の応答で受け付けるツール呼び出しの上限。 */
const MAX_CALLS_PER_STEP = 8;
/** 同じツール・同じ引数がこの回数続いたらループとみなす。 */
const LOOP_THRESHOLD = 3;
/** 生成中の途中経過を保存する間隔（docs/spec/07-data.md）。 */
const INFLIGHT_INTERVAL_MS = 1000;
/**
 * 入りきらないときに、道具の出力を送るときだけ切り詰める長さ（文字）。段階的に短くする。
 * 1段で諦めると、1手で何ファイルもまとめて読んだときに止まってしまう（2026-10-27 実測）。
 */
const TRUNCATE_STEPS = [4000, 2000, 1000];
/** 実測と概算の比として信じる範囲。 */
const CALIBRATION_MIN = 0.5;
const CALIBRATION_MAX = 2;
/** 文脈長のこの割合を超えたら、応答の余地が無いので送らない。 */
const HARD_LIMIT_RATIO = 0.95;

/** 切り詰めたときにモデルへ添える一文。recall が渡っていないのに recall を案内しない。 */
function truncateHint(tools: ToolSpec[]): string {
  return tools.some((t) => t.name === 'recall_read')
    ? '原文は recall_read で読めます。'
    : '必要なら read_file の offset と limit で、分けて読み直してください。';
}

type PromptBase = {
  instructions: Awaited<ReturnType<typeof loadInstructionFiles>>;
  git: { isRepo: boolean; branch?: string };
  toolsMode: ToolsMode;
};

type BuiltRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** 文字数からの概算。実測との比を取るのに使う。 */
  rawEstimate: number;
  /** 判断に使う量（実測で補正したもの。無ければ概算）。 */
  tokens: number;
  estimatedOnly: boolean;
};

/** 代替方式で1回の応答から受け付けるブロック数（docs/spec/02-provider.md）。 */
const MAX_PROMPTED_CALLS_PER_STEP = 3;

/**
 * 断ったときにモデルへ必ず添える一文。
 * 「別の方法を検討して」と返していたら、delete_file を断られたモデルが rm で消した。
 * 仕様: docs/spec/05-agent.md「断られた後の迂回」
 */
const NO_WORKAROUND =
  '同じことを別の手段（コマンドなど）で行わないでください。必要なら、何をしたいかを利用者に説明して終えてください。';

/** ツール呼び出しと、それがどう来たか。 */
type PendingCall = ToolCallRequest & { origin: 'native' | 'prompted' };

/**
 * 送る合間に変えてよい設定（docs/spec/17-interactive.md「1回の送信と、記録」）。
 * 記録は「何を呼び、何が返ったか」で持つので、途中で変えても続きは壊れない。
 */
export type SessionReconfig = {
  model?: string;
  permissionMode?: PermissionMode;
  toolNames?: string[];
  toolsMode?: ToolsMode;
  /** null で既定（送らない）に戻す。 */
  reasoning?: ReasoningLevel | null;
  /** モデルを変えたときの、そのモデルの文脈長。 */
  windowTokens?: number | null;
  /** 記録係。モデルを変えたら、記録に残すモデル名も変わるので差し替える。 */
  recorder?: ConversationRecorder;
};

/** 文脈の量。最後に送ったリクエストのもの。 */
export type ContextUsage = {
  tokens: number;
  /** 圧縮を始める量。 */
  threshold: number;
  windowTokens: number | null;
  /** 実測で補正していない概算か。 */
  estimated: boolean;
};

export class Session {
  private currentRunId: string;
  /** 1度でも送ったか。2回目からは送るたびに新しい実行 ID を振る。 */
  private sentOnce = false;
  readonly workspace: Workspace;
  private readonly opts: Required<Pick<SessionOptions, 'permissionMode' | 'maxSteps'>> &
    SessionOptions;
  private readonly limits: ToolLimits;
  private tools: ToolSpec[];
  private unknownTools: string[];
  private lastUsage: ContextUsage | null = null;
  /** 実行中に差し込まれた利用者の追記。次の手の前にモデルへ渡す（12-harness-api.md「messages」）。 */
  private injected: string[] = [];
  /** この実行の閉じ込めの状態。 */
  private sandboxStatus: SandboxStatus | null = null;
  /** 作業フォルダに秘密のファイルがあり、request_secret_access を渡すか。 */
  private offerSecretAccess = false;
  /**
   * 生の記録（正本）。モデルへ送るメッセージは、呼ぶたびにここから組み立てる。
   * その場で続けても、保存した会話から続けても、同じ組み立て方になるようにするため。
   */
  private entries: TranscriptEntry[] = [];
  private journal: ChangeJournal | null = null;
  private controller = new AbortController();
  private pending = new Map<string, (d: ApprovalDecision) => void>();
  private sessionAllows = new Set<string>();
  /** この実行の中で一度でも断ったか。断った後はコマンドを自動で通さない。 */
  private refusedInRun = false;
  /** このステップで結果を返した呼び出し。結果の無い呼び出しを残さないため。 */
  private answered = new Set<string>();
  private currentStep = 0;
  /** 保存の失敗を一度知らせたか。 */
  private saveFailed = false;
  /** いちばん新しい圧縮。古いやり取りの代わりに、その圧縮版を送る。 */
  private compaction: Compaction | null = null;
  /** 圧縮した生の記録の ID。送らないが、消さない。 */
  private covered = new Set<string>();
  /** 送るときだけ先頭と末尾に切り詰める道具の出力と、その長さ（文字）。それでも入りきらないとき。 */
  private truncated = new Map<string, number>();
  /** 実測（usage.prompt）と概算の比。分かれば概算をこれで補正する。 */
  private calibration: number | null = null;
  private thresholdWarned = false;
  private running = false;
  private aborted = false;

  private constructor(
    opts: SessionOptions,
    tools: ToolSpec[],
    unknown: string[],
    limits: ToolLimits,
  ) {
    this.currentRunId = opts.runId ?? ulid();
    this.workspace = opts.workspace;
    this.opts = { permissionMode: 'ask', maxSteps: 25, ...opts };
    this.tools = tools;
    this.unknownTools = unknown;
    this.limits = limits;
    this.entries = [...(opts.transcript ?? [])];
    if (opts.compaction) {
      this.compaction = opts.compaction;
      this.covered = new Set(opts.compaction.coveredMessageIds);
    }
  }

  static create(opts: SessionOptions): Session {
    const { tools, unknown } = selectTools(opts.toolNames);
    const limits: ToolLimits = { ...DEFAULT_LIMITS, ...opts.limits };
    return new Session(opts, tools, unknown, limits);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** いま（または直前）の実行の ID。送るたびに変わる。 */
  get runId(): string {
    return this.currentRunId;
  }

  get permissionMode(): PermissionMode {
    return this.opts.permissionMode;
  }

  get model(): string {
    return this.opts.model;
  }

  /** 渡す道具の名前（圧縮後にだけ渡す recall は含まない）。 */
  get toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  /** いちばん新しい圧縮。まだ無ければ null。保存しない会話でも見られるように持っておく。 */
  get latestCompaction(): Compaction | null {
    return this.compaction;
  }

  /** 最後に送ったリクエストの文脈の量。まだ送っていなければ null。 */
  get contextUsage(): ContextUsage | null {
    return this.lastUsage;
  }

  /** 送る合間に設定を変える。実行中は変えない（その実行の判断が途中で変わるため）。 */
  reconfigure(patch: SessionReconfig): void {
    if (this.running) throw new Error('実行中は設定を変えられません。');
    if (patch.model !== undefined && patch.model !== this.opts.model) {
      this.opts.model = patch.model;
      // 実測との比はモデルの数え方に依る。別のモデルへ持ち越さない
      this.calibration = null;
      this.lastUsage = null;
    }
    if (patch.permissionMode !== undefined) this.opts.permissionMode = patch.permissionMode;
    if (patch.toolNames !== undefined) {
      const { tools, unknown } = selectTools(patch.toolNames);
      this.tools = tools;
      this.unknownTools = unknown;
      this.opts.toolNames = patch.toolNames;
    }
    if (patch.toolsMode !== undefined) this.opts.toolsMode = patch.toolsMode;
    if (patch.reasoning !== undefined) {
      if (patch.reasoning === null) delete this.opts.reasoning;
      else this.opts.reasoning = patch.reasoning;
    }
    if (patch.recorder !== undefined) this.opts.recorder = patch.recorder;
    if (patch.windowTokens !== undefined && this.opts.context) {
      this.opts.context = { ...this.opts.context, windowTokens: patch.windowTokens };
    }
  }

  /** 承認の返答。approval-request を受け取った側が呼ぶ。 */
  approve(callId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(callId);
    if (!resolve) return false;
    this.pending.delete(callId);
    resolve(decision);
    return true;
  }

  /**
   * 実行中に利用者の追記を差し込む。次の手の前にモデルへ渡る（今の生成は止めない）。
   * 実行中でなければ false（呼び出し側は、続きとして新しく送る）。
   */
  inject(text: string): boolean {
    if (!this.running || this.aborted) return false;
    this.injected.push(text);
    return true;
  }

  /** 差し込まれたが、実行が先に終わってモデルへ渡らなかった追記を取り出す。 */
  takeInjected(): string[] {
    const rest = this.injected;
    this.injected = [];
    return rest;
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
    // 1回の送信を1つの実行にする。変更の記録と取り消しも1回ごと（17-interactive.md）
    if (this.sentOnce) this.currentRunId = ulid();
    this.sentOnce = true;
    this.injected = [];
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
    this.refusedInRun = false;
    // 「この実行中は許可」は文字どおりこの実行だけ。続けて送る使い方（対話画面）で持ち越さない
    this.sessionAllows.clear();
    // 秘密のファイルの読み取りの許可も、この実行だけ
    this.workspace.clearGrants();
    const sandboxSettings = this.opts.sandbox;
    this.workspace.setSecretsAllowed(sandboxSettings?.allowWorkspaceSecrets ?? false);
    const usesCommands = this.tools.some((t) => t.name === 'run_command');
    this.sandboxStatus = !sandboxSettings
      ? null
      : sandboxSettings.mode === 'off'
        ? { active: false, reason: 'agent.sandbox.mode が off' }
        : await detectSandbox();
    this.offerSecretAccess =
      this.tools.length > 0 &&
      !(sandboxSettings?.allowWorkspaceSecrets ?? false) &&
      (await hasWorkspaceSecrets(this.workspace.root));
    const journal = await ChangeJournal.create(this.runId, this.workspace.root, this.opts.root);
    this.journal = journal;

    const instructions = await loadInstructionFiles(this.workspace.root);
    const git = await detectGit(this.workspace.root);
    const toolsMode = this.opts.toolsMode ?? 'both';

    const promptBase = { instructions, git, toolsMode };

    yield {
      type: 'run-start',
      runId: this.runId,
      workspace: this.workspace.root,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      instructionFiles: instructions.map((i) => i.name),
      toolNames: this.tools.map((t) => t.name),
      toolsMode,
      ...(this.opts.conversationId ? { conversationId: this.opts.conversationId } : {}),
      ...(usesCommands && this.sandboxStatus ? { sandbox: this.sandboxStatus } : {}),
    };
    if (usesCommands && this.sandboxStatus && !this.sandboxStatus.active) {
      yield {
        type: 'notice',
        level: 'warn',
        message:
          sandboxSettings?.mode === 'required'
            ? `コマンドを閉じ込められないため、この実行ではコマンドを実行しません（${this.sandboxStatus.reason}）。`
            : `コマンドは閉じ込めずに実行されます（${this.sandboxStatus.reason}）。作業フォルダの外の書き込みや秘密の読み取りを、コマンドからは塞げません。`,
      };
    }
    yield* this.persist((r) => r.runStarted(this.runId));
    yield* this.addUser(input);

    if (this.unknownTools.length > 0) {
      yield {
        type: 'notice',
        level: 'warn',
        message: `知らないツール名を指定されました: ${this.unknownTools.join(', ')}`,
      };
    }
    if (toolsMode === 'prompted') {
      yield {
        type: 'notice',
        level: 'warn',
        message:
          '代替方式（prompted）で動作中です。ネイティブのツール呼び出しより失敗しやすくなります。',
      };
    } else if (toolsMode === 'both') {
      yield {
        type: 'notice',
        level: 'warn',
        message:
          'ツール呼び出しへの対応が確認できていないため、両対応（関数呼び出しと本文ブロックの両方）で試します。',
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
      this.currentStep = step;
      this.answered = new Set();
      // 差し込まれた追記は、手と手の間に入れる（呼び出しと結果の並びを崩さない位置）
      while (this.injected.length > 0) {
        const text = this.injected.shift()!;
        yield* this.addUser(text);
        yield { type: 'user-message', text };
      }

      let text = '';
      let reasoning = '';
      let usage: Usage | undefined;
      let finishReason: FinishReason | undefined;
      let stepError: ProviderError | undefined;
      const nativeCalls: ToolCallRequest[] = [];
      let failed = false;

      // 送る前に量を見る。超えそうなら古い手を圧縮する（16-context.md「いつ圧縮するか」）
      const prepared = yield* this.prepareRequest(promptBase);
      if (prepared && this.opts.context) {
        const ctx = this.opts.context;
        this.lastUsage = {
          tokens: prepared.tokens,
          threshold: compactThreshold(ctx.settings, ctx.windowTokens, prepared.estimatedOnly),
          windowTokens: ctx.windowTokens,
          estimated: prepared.estimatedOnly,
        };
      }
      if (this.aborted) {
        endReason = 'aborted';
        break;
      }
      if (prepared === null) {
        endReason = 'context-full';
        endError =
          '圧縮して道具の出力を切り詰めても、文脈に入りきりませんでした。目的を分けるか、文脈長の大きいモデルで実行してください。';
        break;
      }
      const stepStartedAt = Date.now();
      let lastInflightAt = Date.now();

      for await (const ev of this.opts.provider.chat(
        {
          model: this.opts.model,
          messages: prepared.messages,
          ...(prepared.tools ? { tools: prepared.tools } : {}),
          ...(this.opts.reasoning ? { reasoning: this.opts.reasoning } : {}),
        },
        this.controller.signal,
      )) {
        if (ev.type === 'text-delta' || ev.type === 'reasoning-delta') {
          if (ev.type === 'text-delta') text += ev.text;
          else reasoning += ev.text;
          yield { type: ev.type, text: ev.text };
          // 落ちてもここまでの応答が残るように、途中経過を一定間隔で保存する
          if (Date.now() - lastInflightAt >= INFLIGHT_INTERVAL_MS) {
            lastInflightAt = Date.now();
            yield* this.persist((r) => r.inflight(this.runId, { text, reasoning, step }));
          }
        } else if (ev.type === 'tool-call') {
          nativeCalls.push({ id: ev.id, name: ev.name, argumentsRaw: ev.argumentsRaw });
        } else if (ev.type === 'notice') {
          // 送ったものが通らなかったことを隠さない。設定が効いているふりをしない。
          yield { type: 'notice', level: 'warn', message: ev.message };
        } else if (ev.type === 'finish') {
          usage = ev.usage;
          finishReason = ev.reason;
          // 実測が来たら、以後の概算をこれで補正する（実測を最優先する。16-context.md）。
          // ただし概算の半分〜2倍の外は信じない。文字数からの概算がそこまで外れることはまず無く、
          // 外れた報告を信じると、溢れるまで圧縮しなくなる
          if (ev.usage && ev.usage.prompt > 0 && prepared.rawEstimate > 0) {
            this.calibration = Math.min(
              CALIBRATION_MAX,
              Math.max(CALIBRATION_MIN, ev.usage.prompt / prepared.rawEstimate),
            );
          }
        } else if (ev.type === 'error') {
          if (ev.error.kind === 'aborted') {
            endReason = 'aborted';
          } else {
            endReason = 'error';
            endError = ev.error;
            stepError = ev.error;
          }
          failed = true;
          break;
        }
      }

      if (failed || this.aborted) {
        // 失敗・停止した応答も消さずに残す（04-chat.md）。
        // 停止した途中の本文は、続きを始めたときにも前提になるので会話にも入れる。
        if (text !== '' || reasoning !== '' || stepError) {
          yield* this.addAssistant({
            text,
            ...(reasoning !== '' ? { reasoning } : {}),
            step,
            durationMs: Date.now() - stepStartedAt,
            ...(stepError ? { error: stepError } : { finishReason: 'aborted' as const }),
          });
        }
        yield* this.persist((r) => r.inflight(this.runId, null));
        if (!failed) endReason = 'aborted';
        break;
      }

      // 関数呼び出しが来ていればそれを使う。来ていなければ本文のブロックを見る。
      let calls: PendingCall[] = nativeCalls.map((c) => ({ ...c, origin: 'native' as const }));
      let promptedErrors: string[] = [];
      if (toolsMode !== 'native' && calls.length === 0) {
        const extracted = extractPromptedCalls(text);
        promptedErrors = extracted.errors;
        if (extracted.calls.length > MAX_PROMPTED_CALLS_PER_STEP) {
          // 黙って捨てない。何を実行しなかったかをモデルにも利用者にも伝える。
          const dropped = extracted.calls
            .slice(MAX_PROMPTED_CALLS_PER_STEP)
            .map((c) => c.name)
            .join(', ');
          promptedErrors.push(
            `1回の応答に ${extracted.calls.length} 個のブロックがありました。上限 ${MAX_PROMPTED_CALLS_PER_STEP} 個までを実行し、残りは実行していません: ${dropped}`,
          );
        }
        calls = extracted.calls.slice(0, MAX_PROMPTED_CALLS_PER_STEP).map((c) => ({
          id: shortId('call_'),
          name: c.name,
          argumentsRaw: c.argumentsRaw,
          origin: 'prompted' as const,
        }));
      }

      {
        const recordedCalls = calls.map(({ id, name, argumentsRaw, origin }) => ({
          id,
          name,
          argumentsRaw,
          origin,
        }));
        yield* this.addAssistant({
          text,
          ...(reasoning !== '' ? { reasoning } : {}),
          ...(recordedCalls.length > 0 ? { toolCalls: recordedCalls } : {}),
          ...(finishReason ? { finishReason } : {}),
          ...(usage ? { usage } : {}),
          durationMs: Date.now() - stepStartedAt,
          step,
        });
        yield* this.persist((r) => r.inflight(this.runId, null));
      }

      if (promptedErrors.length > 0) {
        for (const e of promptedErrors) yield { type: 'notice', level: 'warn', message: e };
        const feedback = `[akari] 次の問題がありました。\n${promptedErrors.join('\n')}`;
        yield* this.addUser(feedback, 'akari');
        // 読めたブロックが1つも無いときだけ、やり直させる。
        // 読めたものがあるなら、それは実行してから続ける。
        if (calls.length === 0) {
          yield { type: 'step-end', step, ...(usage ? { usage } : {}) };
          continue;
        }
      }

      if (calls.length === 0) {
        yield { type: 'step-end', step, ...(usage ? { usage } : {}) };
        // 答え終わる前に追記が届いていれば、それを渡して続ける
        if (this.injected.length > 0 && !this.aborted && step < this.opts.maxSteps) continue;
        endReason = 'done';
        break;
      }

      let dropped: PendingCall[] = [];
      if (calls.length > MAX_CALLS_PER_STEP) {
        yield {
          type: 'notice',
          level: 'warn',
          message: `1回の応答でツールが ${calls.length} 件呼ばれました。上限 ${MAX_CALLS_PER_STEP} 件までを実行します。`,
        };
        // 上限を超えた分は、下で「実行しませんでした」という結果を付ける。
        // 利用者メッセージを挟むと、呼び出しの直後に結果が並ばず、次のリクエストが 400 になる。
        dropped = calls.slice(MAX_CALLS_PER_STEP);
        calls = calls.slice(0, MAX_CALLS_PER_STEP);
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
            // 止めた呼び出しは画面に出ないので、ここで中身を見せる（出ないと回数が合わなく見える）
            message:
              `同じ呼び出しが ${LOOP_THRESHOLD} 回続いたため、${LOOP_THRESHOLD} 回目は実行せずに停止しました: ` +
              `${call.name} ${call.argumentsRaw.length > 200 ? `${call.argumentsRaw.slice(0, 200)}…` : call.argumentsRaw}`,
          };
          endReason = 'loop';
          abortRequested = true;
          break;
        }

        const outcome = yield* this.executeCall(call, journal);
        if (outcome === 'abort') {
          abortRequested = true;
          endReason = 'aborted';
          break;
        }
      }

      // 結果の無い呼び出しを残さない。残すと、続きを始めたときにサーバが 400 を返す。
      for (const call of calls) {
        if (this.answered.has(call.id)) continue;
        yield* this.pushToolResult(call, false, '中断のため実行されませんでした。', 'aborted');
      }
      for (const call of dropped) {
        yield* this.pushToolResult(
          call,
          false,
          `1回の応答で呼べる上限（${MAX_CALLS_PER_STEP}件）を超えたため、実行しませんでした。`,
          'dropped',
        );
      }

      yield { type: 'step-end', step, ...(usage ? { usage } : {}) };
      if (abortRequested) break;
      if (step === this.opts.maxSteps) endReason = 'max-steps';
    }

    const finalReason: RunEndReason = this.aborted && endReason !== 'loop' ? 'aborted' : endReason;
    yield* this.persist((r) => r.runEnded(this.runId, finalReason));
    yield {
      type: 'run-end',
      reason: finalReason,
      changedFiles: journal.changedFiles(),
      ...(endError !== undefined ? { error: endError } : {}),
    };
  }

  /** 1つのツール呼び出しを、承認を挟んで実行する。 */
  private async *executeCall(
    call: PendingCall,
    journal: ChangeJournal,
  ): AsyncGenerator<RunEvent, 'ok' | 'abort', void> {
    const tool = findTool(this.activeTools(), call.name);
    if (!tool) {
      const msg = `そのツールはありません: ${call.name}。使えるのは ${this.activeTools()
        .map((t) => t.name)
        .join(', ')} です。`;
      yield { type: 'tool-result', callId: call.id, name: call.name, ok: false, summary: msg };
      yield* this.pushToolResult(call, false, msg);
      return 'ok';
    }

    let args: unknown;
    try {
      args = call.argumentsRaw.trim() === '' ? {} : JSON.parse(call.argumentsRaw);
    } catch {
      const msg = `引数がJSONとして読めません: ${call.argumentsRaw.slice(0, 200)}`;
      yield { type: 'tool-result', callId: call.id, name: call.name, ok: false, summary: msg };
      yield* this.pushToolResult(call, false, msg);
      return 'ok';
    }

    const ctx: ToolContext = {
      workspace: this.workspace,
      journal,
      limits: this.limits,
      signal: this.controller.signal,
      callId: call.id,
      logger: this.opts.logger,
      transcript: () => this.entries,
      ...(this.opts.sandbox && this.sandboxStatus
        ? {
            sandbox: {
              status: this.sandboxStatus,
              settings: this.opts.sandbox,
              extraWrite: this.opts.sandboxExtraWrite ?? [],
            },
          }
        : {}),
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
        // 秘密のファイルは、利用者に許可を求める道を示す（迂回はさせない）
        const tail =
          check.secret && this.offerSecretAccess
            ? '別の手段（コマンドなど）で読もうとしないでください。'
            : NO_WORKAROUND;
        yield* this.pushToolResult(call, false, `${check.message}\n${tail}`);
        // 秘密のファイルを断っただけで、閉じ込めが効いていれば、コマンドからも読めない。
        // 迂回のしようがないので、残りのコマンドまでは止めない（ヘッドレスで全滅させない）
        if (!(check.secret && this.sandboxStatus?.active)) yield* this.markRefused();
        return 'ok';
      }
    }

    // 道具ごとの事前の検査。求めても意味のない承認を出さない
    const checked = await tool.check?.(args, ctx);
    if (checked) {
      yield {
        type: 'tool-result',
        callId: call.id,
        name: tool.name,
        ok: checked.ok,
        summary: checked.summary,
      };
      yield* this.pushToolResult(call, checked.ok, checked.content);
      return 'ok';
    }

    // 拒否リストは承認より前。承認画面すら出さない。
    if (tool.name === 'run_command') {
      const command = (args as { command?: unknown }).command;
      if (typeof command === 'string') {
        const hit = matchesDenied(command, this.limits.deniedCommands);
        if (hit !== null) {
          const msg = `このコマンドは実行できません（拒否リストの "${hit}" に一致）。`;
          yield { type: 'tool-result', callId: call.id, name: tool.name, ok: false, summary: msg };
          yield* this.pushToolResult(call, false, `${msg}\n${NO_WORKAROUND}`);
          yield* this.markRefused();
          return 'ok';
        }
      }
    }

    const need = this.needsApproval(tool.risk, tool.name, args);
    if (need.required) {
      const decision = yield* this.askApproval(call, tool, preview, need.scope, need.reason);
      yield { type: 'approval-resolved', callId: call.id, decision };
      if (decision.kind === 'abort') return 'abort';
      if (decision.kind === 'deny') {
        const msg = decision.feedback
          ? `利用者が拒否しました: ${decision.feedback}\n${NO_WORKAROUND}`
          : `利用者が拒否しました。${NO_WORKAROUND}`;
        yield {
          type: 'tool-result',
          callId: call.id,
          name: tool.name,
          ok: false,
          summary: '拒否されました',
        };
        yield* this.pushToolResult(call, false, msg);
        // 秘密のファイルの許可を断った場合も同じ（閉じ込めが効いていれば、コマンドからは読めない）
        if (!(tool.name === SECRET_ACCESS_TOOL_NAME && this.sandboxStatus?.active)) {
          yield* this.markRefused();
        }
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
      yield* this.pushToolResult(call, false, msg);
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
    yield* this.pushToolResult(call, result.ok, result.content);
    return 'ok';
  }

  private async *askApproval(
    call: ToolCallRequest,
    tool: ToolSpec,
    preview: ToolPreview | undefined,
    scope: string | null,
    reason?: string,
  ): AsyncGenerator<RunEvent, ApprovalDecision, void> {
    const promise = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(call.id, resolve);
    });
    yield {
      type: 'approval-request',
      callId: call.id,
      name: tool.name,
      risk: tool.risk,
      prompt: reason
        ? `${reason}\n${describeApproval(tool, preview)}`
        : describeApproval(tool, preview),
      options: approvalOptions(scope),
      ...(preview ? { preview } : {}),
    };
    return promise;
  }

  /** 断ったことを覚える。初回だけ、以後コマンドを自動で通さないことを知らせる。 */
  private *markRefused(): Generator<RunEvent, void, void> {
    if (this.refusedInRun) return;
    this.refusedInRun = true;
    yield {
      type: 'notice',
      level: 'warn',
      message:
        '断られた操作があったため、この実行の残りではコマンドを自動で実行しません（承認を求めます）。',
    };
  }

  /**
   * 承認が要るか。仕様: docs/spec/05-agent.md「承認モデル」の表。
   * delete_file は full でも必ず聞く。
   */
  private needsApproval(
    risk: Risk,
    name: string,
    args: unknown,
  ): { required: boolean; scope: string | null; reason?: string } {
    const mode = this.opts.permissionMode;
    const scope = this.scopeFor(name, args);

    // 削除系のコマンドは、どのモードでも毎回聞く（allow-session にもしない）。
    // コマンドで消したものは記録の外で、undo で戻せないため。
    const command = name === 'run_command' ? (args as { command?: unknown }).command : undefined;
    const deletes = typeof command === 'string' ? findDeleteCommand(command) : null;
    if (deletes !== null) {
      return {
        required: true,
        scope: null,
        reason: `ファイルを削除するコマンド（${deletes}）です。コマンドで消したファイルは akari undo で戻せないため、確認します。`,
      };
    }

    // 秘密のファイルの読み取りは、どの権限でも毎回聞く（「この実行中は許可」も出さない）
    if (name === SECRET_ACCESS_TOOL_NAME) return { required: true, scope: null };

    if (scope && this.sessionAllows.has(scope)) return { required: false, scope };

    // 一度断った後は、コマンドを自動で通さない（断られた後の迂回を止める）
    if (name === 'run_command' && this.refusedInRun) {
      return {
        required: true,
        scope,
        reason: 'この実行で一度断られた操作があったため、コマンドは自動では実行しません。',
      };
    }

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

  /**
   * 今使える道具。圧縮が起きた会話でだけ recall_* を足す（使う意味が無い道具を渡さない）。
   * 道具を渡さない実行（--no-tools）には足さない。
   */
  private activeTools(): ToolSpec[] {
    if (this.tools.length === 0) return this.tools;
    return [
      ...this.tools,
      ...(this.compaction !== null ? RECALL_TOOLS : []),
      ...(this.offerSecretAccess ? [requestSecretAccessTool] : []),
    ];
  }

  /** 送るものを組み立てる。圧縮していれば圧縮版を足し、圧縮した生の記録は送らない。 */
  private buildRequest(base: PromptBase): BuiltRequest {
    const tools = this.activeTools();
    const system = buildSystemPrompt({
      workspaceRoot: this.workspace.root,
      tools,
      toolsMode: base.toolsMode,
      instructions: base.instructions,
      projectInstructions: this.opts.projectInstructions,
      conversationInstructions: this.opts.conversationInstructions,
      git: base.git,
      ...(this.compaction ? { digest: renderDigest(this.compaction.digest) } : {}),
    });
    const visible = this.entries
      .filter((e) => !this.covered.has(e.id))
      .map((e) =>
        this.truncated.has(e.id)
          ? { ...e, text: truncateMiddle(e.text, this.truncated.get(e.id)!, truncateHint(tools)) }
          : e,
      );
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...buildApiMessages(visible),
    ];
    const defs =
      base.toolsMode === 'prompted' || tools.length === 0 ? undefined : toolDefinitions(tools);
    const rawEstimate = estimateTokens(messages, defs);
    return {
      messages,
      ...(defs ? { tools: defs } : {}),
      rawEstimate,
      tokens: this.calibration ? Math.ceil(rawEstimate * this.calibration) : rawEstimate,
      estimatedOnly: this.calibration === null,
    };
  }

  /**
   * 量を見て、必要なら圧縮する。仕様: docs/spec/16-context.md
   * 入りきらないと分かったときだけ null を返す（実行を止める）。黙って古いものを落とさない。
   */
  private async *prepareRequest(
    base: PromptBase,
  ): AsyncGenerator<RunEvent, BuiltRequest | null, void> {
    let req = this.buildRequest(base);
    const ctx = this.opts.context;
    if (!ctx) return req;
    const window = ctx.windowTokens;
    const over = (r: BuiltRequest) =>
      r.tokens > compactThreshold(ctx.settings, window, r.estimatedOnly);
    const doesNotFit = (r: BuiltRequest) => window !== null && r.tokens > window * HARD_LIMIT_RATIO;
    if (!over(req)) return req;

    if (ctx.settings.mode === 'auto') {
      const units = this.chooseUnits(
        ctx.settings.keepRecentTurns,
        compactThreshold(ctx.settings, window, req.estimatedOnly),
      );
      if (units.length > 0) {
        const turns = units.filter((u) => u.kind === 'assistant').length;
        const before = req;
        yield {
          type: 'compaction-start',
          turns,
          beforeTokens: before.tokens,
          estimated: before.estimatedOnly,
        };
        const digestModel = ctx.settings.digestModel ?? this.opts.model;
        const result = await compact({
          provider: this.opts.provider,
          model: digestModel,
          units,
          previous: this.compaction?.digest ?? null,
          knownIds: new Set(this.entries.map((e) => e.id)),
          // 1回の圧縮に使う量。文脈長の半分（分からなければ判断の閾値の8割）
          budgetTokens:
            window !== null
              ? Math.floor(window * 0.5)
              : Math.floor(ctx.settings.compactAtTokens * 0.8),
          ...(this.opts.reasoning ? { reasoning: this.opts.reasoning } : {}),
          signal: this.controller.signal,
        });
        const coveredIds = [...this.covered, ...units.flatMap((u) => u.entries.map((e) => e.id))];
        const record: Compaction = {
          id: ulid(),
          createdAt: new Date().toISOString(),
          coveredMessageIds: coveredIds,
          coveredTurns: turns,
          model: digestModel,
          endpointId: ctx.endpointId,
          digest: result.digest,
          beforeTokens: before.tokens,
          afterTokens: 0,
          estimated: before.estimatedOnly,
          ...(result.fallback ? { fallback: result.fallback } : {}),
        };
        this.compaction = record;
        this.covered = new Set(coveredIds);
        req = this.buildRequest(base);
        record.afterTokens = req.tokens;
        for (const n of result.notes) yield { type: 'notice', level: 'warn', message: n };
        yield* this.persist((r) => r.compacted(record));
        yield {
          type: 'compaction-end',
          compactionId: record.id,
          afterTokens: record.afterTokens,
          estimated: req.estimatedOnly,
          ...(record.fallback ? { fallback: record.fallback } : {}),
        };
        if (this.aborted || !over(req)) return req;
      }

      // それでも多いなら、送るときだけ大きい道具の出力から切り詰める（生の記録は変えない）。
      // 段階的に短くし、閾値を下回ったところで止める
      const cut = new Set<string>();
      let shortest = 0;
      outer: for (const limit of TRUNCATE_STEPS) {
        const big = this.entries
          .filter((e) => e.role === 'tool' && !this.covered.has(e.id))
          .filter((e) => e.text.length > limit && (this.truncated.get(e.id) ?? Infinity) > limit)
          .sort((a, b) => b.text.length - a.text.length);
        for (const e of big) {
          this.truncated.set(e.id, limit);
          cut.add(e.id);
          shortest = limit;
          req = this.buildRequest(base);
          if (!over(req)) break outer;
        }
      }
      if (cut.size > 0) {
        yield {
          type: 'notice',
          level: 'warn',
          message: `文脈に入りきらないため、道具の出力 ${cut.size} 件を、送るときだけ先頭と末尾を残して切り詰めました（短いもので ${shortest} 字。生の記録はそのまま）。`,
        };
      }
      if (!over(req)) return req;
    }

    if (doesNotFit(req)) return null;
    // 閾値は超えているが、文脈長には収まっている（または文脈長が分からない）。送るが、黙らない
    if (!this.thresholdWarned) {
      this.thresholdWarned = true;
      yield {
        type: 'notice',
        level: 'warn',
        message:
          ctx.settings.mode === 'off'
            ? '文脈が圧縮の目安を超えていますが、context.mode が off のため圧縮しません。'
            : '圧縮しても、文脈が圧縮の目安を超えています。このまま続けます。',
      };
    }
    return req;
  }

  /**
   * 圧縮する単位を選ぶ。直近に残す手だけで閾値の半分を超えるなら、残す手数を減らす（最低1手）。
   * そうしないと、残した手だけで閾値の近くまで埋まり、1手ごとに圧縮（＝モデルの呼び出し1回）が起きる。
   */
  private chooseUnits(keepRecent: number, threshold: number): Unit[] {
    for (let keep = keepRecent; keep >= 1; keep--) {
      const units = selectForCompaction(this.entries, this.covered, keep);
      if (keep === 1) return units;
      const taking = new Set(units.flatMap((u) => u.entries.map((e) => e.id)));
      const rest = this.entries.filter((e) => !this.covered.has(e.id) && !taking.has(e.id));
      const raw = estimateTokens(buildApiMessages(rest));
      const tokens = this.calibration ? raw * this.calibration : raw;
      if (tokens <= threshold * 0.5) return units;
    }
    return [];
  }

  private async *pushToolResult(
    call: PendingCall,
    ok: boolean,
    content: string,
    synthetic?: 'aborted' | 'dropped',
  ): AsyncGenerator<RunEvent, void, void> {
    // 送るときの形（関数呼び出しには tool メッセージ、本文ブロックには利用者メッセージ）は
    // buildApiMessages が origin を見て決める。
    const id = ulid();
    this.entries.push({
      id,
      role: 'tool',
      text: content,
      toolCallId: call.id,
      toolName: call.name,
      ok,
      origin: call.origin,
    });
    this.answered.add(call.id);
    const step = this.currentStep;
    yield* this.persist((r) =>
      r.record(this.runId, {
        id,
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        ok,
        content,
        origin: call.origin,
        step,
        ...(synthetic ? { synthetic } : {}),
      }),
    );
  }

  /** 利用者（または Akari）の発言を、生の記録と記録係の両方へ足す。 */
  private async *addUser(text: string, source?: 'akari'): AsyncGenerator<RunEvent, void, void> {
    const id = ulid();
    this.entries.push({ id, role: 'user', text, ...(source ? { source } : {}) });
    yield* this.persist((r) =>
      r.record(this.runId, { id, role: 'user', text, ...(source ? { source } : {}) }),
    );
  }

  /** モデルの応答を、生の記録と記録係の両方へ足す。失敗した応答は送らない印を付ける。 */
  private async *addAssistant(
    m: Omit<Extract<RecordedMessage, { role: 'assistant' }>, 'id' | 'role'>,
  ): AsyncGenerator<RunEvent, void, void> {
    const id = ulid();
    this.entries.push({
      id,
      role: 'assistant',
      text: m.text,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
      ...(m.error ? { failed: true } : {}),
    });
    yield* this.persist((r) => r.record(this.runId, { id, role: 'assistant', ...m }));
  }

  /** 記録係へ渡す。失敗しても実行は止めないが、黙らない（最初の1回を知らせる）。 */
  private async *persist(
    task: (r: ConversationRecorder) => Promise<void>,
  ): AsyncGenerator<RunEvent, void, void> {
    const recorder = this.opts.recorder;
    if (!recorder) return;
    try {
      await task(recorder);
    } catch (err) {
      if (this.saveFailed) return;
      this.saveFailed = true;
      yield {
        type: 'notice',
        level: 'warn',
        message: `会話の保存に失敗しました。実行は続けますが、記録が欠けます: ${(err as Error).message}`,
      };
    }
  }
}

function describeApproval(tool: ToolSpec, preview: ToolPreview | undefined): string {
  if (preview?.kind === 'command')
    return `コマンドを実行します: ${preview.command}\n作業ディレクトリ: ${preview.cwd}`;
  if (preview?.kind === 'diff') return `${preview.path} を書き換えます。`;
  if (preview?.kind === 'delete')
    return `${preview.path} を削除します（${preview.bytes} バイト）。`;
  if (preview?.kind === 'text') return preview.text;
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

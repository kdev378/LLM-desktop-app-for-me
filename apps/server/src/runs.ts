import {
  ALL_TOOL_NAMES,
  ChangeJournal,
  ConversationStore,
  Session,
  Workspace,
  createProvider,
  decideToolsMode,
  detectSandbox,
  diffJournal,
  getProviderError,
  isAkariError,
  isLikelyChatModel,
  loadConfig,
  resolveEndpoint,
  saveConfig,
  toTranscript,
  ulid,
  updateEndpoint,
  windowTokensFor,
  type ApprovalDecision,
  type Config,
  type Conversation,
  type Logger,
  type PermissionMode,
  type Provider,
  type ResolvedEndpoint,
  type RunEvent,
  type SandboxStatus,
} from '@akari/core';
import { ApiError } from './http.js';
import {
  FINISHED,
  RUN_SCHEMA_VERSION,
  RunStore,
  type RunRecord,
  type RunStatus,
  type StoredEvent,
} from './run-store.js';
import { createWorktree, gitCommonDirs, listWorktrees, removeWorktree } from './worktree.js';
import { buildTranscript, type TranscriptData } from './transcript.js';

/**
 * 実行の管理。仕様: docs/spec/12-harness-api.md
 *
 * - 同時に走らせる数は concurrency.maxParallelRuns。超えた分は待機列
 * - イベントには連番を振り、ファイルにも書く（再起動しても保持の範囲なら読み直せる）
 * - 承認は HTTP から返す。期限（agent.approvalTimeoutMs）を過ぎたら拒否
 * - 記録は再起動しても API から取れる。落ちたときに走っていた実行は interrupted にする
 */

/** 1実行あたりのイベントの保持（件数）。 */
const EVENTS_KEEP = 10_000;
/** 実行が終わってからイベントを保持する時間。 */
const EVENTS_TTL_MS = 60 * 60 * 1000;
/** idempotencyKey を覚えておく時間。 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type CreateRunInput = {
  prompt: string;
  workspace?: string;
  endpoint?: string;
  model?: string;
  permissionMode?: PermissionMode;
  maxSteps?: number;
  tools?: string[];
  conversationId?: string;
  labels?: Record<string, string>;
  git?: { worktree?: boolean; branch?: string; base?: string };
  idempotencyKey?: string;
};

export type RunManagerOptions = {
  root: string;
  /** --workspace で決めた既定の作業フォルダ。 */
  defaultWorkspace: string | null;
  logger: Logger;
  /** テスト用。接続先から Provider を作る方法を差し替える。 */
  providerFor?: (endpoint: ResolvedEndpoint, logger: Logger) => Provider;
  /** テスト用。1実行あたりのイベントの保持件数（既定 10,000）。 */
  eventsKeep?: number;
};

type Live = {
  session: Session | null;
  abortRequested: boolean;
  /** 待機中に届いた追記。始まったら差し込む。 */
  pendingMessages: string[];
  approvalTimers: Map<string, NodeJS.Timeout>;
};

type Subscriber = (ev: StoredEvent | null) => void;

export class RunManager {
  private readonly store: RunStore;
  private readonly conversations: ConversationStore;
  private readonly records = new Map<string, RunRecord>();
  private readonly live = new Map<string, Live>();
  /** メモリに持っているイベント（保持の範囲）。無ければファイルから読む。 */
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly nextSeq = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly queue: string[] = [];
  private running = 0;
  private configWrites: Promise<void> = Promise.resolve();
  private dropTimers = new Set<NodeJS.Timeout>();
  private closing = false;

  private get keep(): number {
    return this.opts.eventsKeep ?? EVENTS_KEEP;
  }

  constructor(private readonly opts: RunManagerOptions) {
    this.store = new RunStore(opts.root);
    this.conversations = new ConversationStore(opts.root);
  }

  /** 保存した記録を読み、落ちたときに走っていたものを interrupted にする。 */
  async init(): Promise<void> {
    await this.store.init();
    const now = Date.now();
    for (const r of await this.store.loadAll()) {
      if (!FINISHED.has(r.status) && r.pid !== process.pid && !isAlive(r.pid)) {
        r.status = 'interrupted';
        r.endedAt ??= new Date().toISOString();
        r.pendingApproval = null;
        await this.store.save(r).catch((err) => this.warnSave(r.runId, err));
      }
      this.records.set(r.runId, r);
      // 保持の時間を過ぎたイベントは消す（記録そのものは残す）
      if (FINISHED.has(r.status) && r.endedAt && now - Date.parse(r.endedAt) > EVENTS_TTL_MS) {
        await this.store.dropEvents(r.runId).catch(() => undefined);
      }
    }
  }

  /** コマンドの閉じ込めが効くか（設定の mode も見る）。 */
  async sandboxStatus(config?: Config): Promise<SandboxStatus> {
    const cfg = config ?? (await loadConfig(this.opts.root)).config;
    if (cfg.agent.sandbox.mode === 'off')
      return { active: false, reason: 'agent.sandbox.mode が off' };
    return detectSandbox();
  }

  get counts(): { active: number; queued: number } {
    return { active: this.running, queued: this.queue.length };
  }

  // ---------------- 作る ----------------

  async create(input: CreateRunInput): Promise<{ record: RunRecord; reused: boolean }> {
    if (input.idempotencyKey) {
      const prior = [...this.records.values()].find(
        (r) =>
          r.idempotencyKey === input.idempotencyKey &&
          Date.now() - Date.parse(r.createdAt) < IDEMPOTENCY_TTL_MS,
      );
      if (prior) return { record: prior, reused: true };
    }
    const { config } = await loadConfig(this.opts.root);

    const permissionMode = input.permissionMode ?? config.agent.permissionMode;
    if (permissionMode === 'full' && !config.server.allowFullPermission) {
      throw new ApiError(
        403,
        'full_permission_disabled',
        'HTTP からは permissionMode "full" で頼めない設定です。',
        '許すなら akari config set server.allowFullPermission true',
      );
    }
    if (permissionMode === 'full') {
      // 閉じ込められない環境では、許していても断る（外部のツールが人の目を通さずに、
      // 閉じ込めなしでコマンドを実行する状態を作らない。12-harness-api.md「権限」）
      const sandbox = await this.sandboxStatus(config);
      if (!sandbox.active) {
        throw new ApiError(
          403,
          'full_without_sandbox',
          'コマンドを閉じ込められない環境なので、HTTP からは full で頼めません。',
          sandbox.reason,
        );
      }
    }
    const tools = input.tools ?? null;
    if (tools) {
      const git = tools.filter((t) => t.startsWith('git_'));
      if (git.length > 0) {
        throw new ApiError(
          400,
          'git_tools_disabled',
          `git の道具（${git.join(', ')}）は有効になっていません。`,
          'API から権限を広げることはできません（設定の agent.gitTools）。',
        );
      }
      const unknown = tools.filter((t) => !ALL_TOOL_NAMES.includes(t));
      if (unknown.length > 0) {
        throw new ApiError(
          400,
          'unknown_tool',
          `知らない道具です: ${unknown.join(', ')}`,
          `使える道具: ${ALL_TOOL_NAMES.join(', ')}`,
        );
      }
    }

    // 続きの会話なら、作業フォルダはその会話のもの
    let conversation: Conversation | null = null;
    if (input.conversationId) {
      conversation = await this.openConversation(input.conversationId);
      if (conversation.header.kind !== 'agent') {
        throw new ApiError(
          400,
          'conversation_kind',
          `会話 ${conversation.id} は道具なしの会話（chat）です。`,
        );
      }
      const busy = [...this.records.values()].find(
        (r) => r.conversationId === conversation!.id && !FINISHED.has(r.status),
      );
      if (busy) {
        throw new ApiError(
          409,
          'conversation_busy',
          `会話 ${conversation.id} では実行 ${busy.runId} がまだ終わっていません。`,
          '実行中に追記するなら POST /v1/runs/{runId}/messages を使ってください。',
        );
      }
      if (input.git?.worktree) {
        throw new ApiError(
          400,
          'worktree_with_conversation',
          '続きの会話では worktree を新しく作れません（会話は元の作業フォルダを前提にしています）。',
        );
      }
    }
    const requested =
      conversation?.header.workspace ?? input.workspace ?? this.opts.defaultWorkspace;
    if (!requested) {
      throw new ApiError(
        400,
        'workspace_required',
        '作業フォルダ（workspace）を指定してください。',
        'serve の --workspace で既定を決めることもできます。',
      );
    }
    if (conversation && input.workspace && conversation.header.workspace !== input.workspace) {
      throw new ApiError(
        400,
        'conversation_workspace_mismatch',
        `会話 ${conversation.id} の作業フォルダは ${conversation.header.workspace} です。`,
      );
    }
    // 作業フォルダとして開けるかを、ここで確かめる（広すぎる場所などは断る）
    let source: Workspace;
    try {
      source = await Workspace.open(requested, this.opts.root);
    } catch (err) {
      throw new ApiError(400, 'workspace_invalid', (err as Error).message);
    }

    let endpoint: ResolvedEndpoint;
    try {
      endpoint = await resolveEndpoint(config, input.endpoint ?? null, this.opts.root);
    } catch (err) {
      throw new ApiError(400, 'endpoint_not_found', (err as Error).message);
    }

    const runId = ulid();
    let workspace = source.root;
    let branch: string | null = null;
    if (input.git?.worktree) {
      const wt = await createWorktree({
        root: this.opts.root,
        repo: source.root,
        runId,
        ...(input.git.branch ? { branch: input.git.branch } : {}),
        ...(input.git.base ? { base: input.git.base } : {}),
      });
      workspace = wt.path;
      branch = wt.branch;
    }

    conversation ??= await this.conversations.create({
      kind: 'agent',
      workspace,
      settings: { endpointId: endpoint.id, ...(input.model ? { model: input.model } : {}) },
    });

    const record: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      prompt: input.prompt,
      conversationId: conversation.id,
      workspace,
      sourceWorkspace: source.root,
      worktree: input.git?.worktree === true,
      branch,
      endpointId: endpoint.id,
      model: input.model ?? null,
      permissionMode,
      maxSteps: input.maxSteps ?? config.agent.maxSteps,
      tools,
      labels: input.labels ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      status: 'queued',
      step: 0,
      pendingApproval: null,
      changedFiles: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      endReason: null,
      error: null,
      usage: { prompt: 0, completion: 0 },
      continuedFrom: null,
      pid: process.pid,
    };
    await this.register(record);
    return { record, reused: false };
  }

  private async register(record: RunRecord): Promise<void> {
    this.records.set(record.runId, record);
    this.live.set(record.runId, {
      session: null,
      abortRequested: false,
      pendingMessages: [],
      approvalTimers: new Map(),
    });
    this.events.set(record.runId, []);
    this.nextSeq.set(record.runId, 1);
    await this.store.save(record);
    this.emit(record.runId, { type: 'status', status: 'queued' });
    this.queue.push(record.runId);
    this.pump();
  }

  /** 空きがあれば待機列から始める。 */
  private pump(): void {
    if (this.closing) return;
    void loadConfig(this.opts.root).then(({ config }) => {
      while (this.running < config.concurrency.maxParallelRuns && this.queue.length > 0) {
        const runId = this.queue.shift()!;
        this.running += 1;
        void this.execute(runId).finally(() => {
          this.running -= 1;
          this.pump();
        });
      }
    });
  }

  // ---------------- 走らせる ----------------

  private async execute(runId: string): Promise<void> {
    const record = this.records.get(runId)!;
    const live = this.live.get(runId)!;
    if (live.abortRequested) {
      await this.finish(record, 'aborted', 'aborted', null);
      return;
    }
    record.startedAt = new Date().toISOString();
    this.setStatus(record, 'running');

    let session: Session;
    try {
      const { config } = await loadConfig(this.opts.root);
      const endpoint = await resolveEndpoint(config, record.endpointId, this.opts.root);
      const provider = (this.opts.providerFor ?? defaultProvider)(endpoint, this.opts.logger);
      const model = record.model ?? (await pickModel(endpoint, provider));
      record.model = model;
      const toolNames = record.tools ?? ALL_TOOL_NAMES;
      const forced = config.agent.toolsMode === 'auto' ? null : config.agent.toolsMode;
      const decision = await decideToolsMode({
        config,
        endpoint,
        provider,
        model,
        toolNames,
        forced,
        save: (next) => this.saveCapabilities(endpoint.id, next),
      });
      for (const n of decision.notes)
        this.emit(runId, { type: 'notice', level: 'info', message: n });
      for (const w of decision.warnings)
        this.emit(runId, { type: 'notice', level: 'warn', message: w });

      const conversation = await this.openConversation(record.conversationId!);
      const workspace = await Workspace.open(record.workspace, this.opts.root);
      const fresh = (await loadConfig(this.opts.root)).config;
      const compaction = conversation.latestCompaction();
      session = Session.create({
        provider,
        model,
        workspace,
        root: this.opts.root,
        runId,
        transcript: toTranscript(conversation.thread()),
        ...(compaction ? { compaction } : {}),
        recorder: conversation.recorder({ model, endpointId: endpoint.id }),
        conversationId: conversation.id,
        context: {
          settings: fresh.context,
          windowTokens: windowTokensFor(fresh, endpoint.id, model),
          endpointId: endpoint.id,
        },
        permissionMode: record.permissionMode,
        toolNames,
        maxSteps: record.maxSteps,
        toolsMode: decision.effective,
        sandbox: fresh.agent.sandbox,
        // worktree では git commit が元のリポジトリの .git に書く。そこだけ書き込みを許す
        ...(record.worktree ? { sandboxExtraWrite: await gitCommonDirs(record.workspace) } : {}),
        limits: {
          commandTimeoutMs: fresh.agent.commandTimeoutMs,
          toolOutputLimitBytes: fresh.agent.toolOutputLimitBytes,
          deniedCommands: fresh.agent.deniedCommands,
        },
        logger: this.opts.logger,
      });
    } catch (err) {
      const message = describeError(err);
      this.emit(runId, { type: 'notice', level: 'warn', message });
      if (live.pendingMessages.length > 0) {
        this.emit(runId, {
          type: 'notice',
          level: 'warn',
          message: `実行が始まる前に失敗したため、届いていた追記 ${live.pendingMessages.length} 件はモデルへ渡していません。`,
        });
      }
      await this.finish(record, 'failed', 'error', message);
      return;
    }

    live.session = session;
    const approvalTimeout = (await loadConfig(this.opts.root)).config.agent.approvalTimeoutMs;
    try {
      for await (const ev of session.send(record.prompt)) {
        this.onEvent(record, live, ev, approvalTimeout);
        if (ev.type === 'run-start') {
          // 待機中に届いた追記を、最初の手の前に入れる
          for (const text of live.pendingMessages.splice(0)) session.inject(text);
          if (live.abortRequested) session.abort();
        }
      }
    } catch (err) {
      const message = describeError(err);
      this.emit(runId, { type: 'notice', level: 'warn', message });
      if (!FINISHED.has(record.status)) await this.finish(record, 'failed', 'error', message);
    } finally {
      for (const t of live.approvalTimers.values()) clearTimeout(t);
      live.approvalTimers.clear();
      live.session = null;
    }

    // 実行が先に終わって渡らなかった追記は、続きとして新しく送る（黙って落とさない）
    const leftover = [...session.takeInjected(), ...live.pendingMessages.splice(0)];
    if (leftover.length > 0 && !this.closing) {
      const next = await this.continueWith(record, leftover.join('\n\n')).catch(() => null);
      this.emit(runId, {
        type: 'notice',
        level: 'info',
        message: next
          ? `実行が終わった後に届いた追記を、続きの実行 ${next.runId} として送りました。`
          : '実行が終わった後に届いた追記を、続きとして送れませんでした。',
      });
    }
  }

  private onEvent(
    record: RunRecord,
    live: Live,
    ev: RunEvent,
    approvalTimeout: number | null,
  ): void {
    switch (ev.type) {
      case 'step-start':
        record.step = ev.step;
        break;
      case 'step-end':
        if (ev.usage) {
          record.usage.prompt += ev.usage.prompt;
          record.usage.completion += ev.usage.completion;
        }
        break;
      case 'approval-request': {
        const scope = ev.options.find((o) => o.decision.kind === 'allow-session')?.decision ?? null;
        record.pendingApproval = {
          callId: ev.callId,
          name: ev.name,
          risk: ev.risk,
          prompt: ev.prompt,
          decisions: ev.options.map((o) => decisionName(o.decision)),
          scope: scope && scope.kind === 'allow-session' ? scope.scope : null,
          since: new Date().toISOString(),
        };
        this.emit(record.runId, ev);
        this.setStatus(record, 'waiting-approval');
        if (approvalTimeout !== null) {
          live.approvalTimers.set(
            ev.callId,
            setTimeout(() => {
              const ok = live.session?.approve(ev.callId, {
                kind: 'deny',
                feedback: '承認の期限が切れました。',
              });
              if (ok) {
                this.emit(record.runId, {
                  type: 'notice',
                  level: 'warn',
                  message: `承認を ${Math.round(approvalTimeout / 1000)} 秒待ったため、拒否として扱いました（agent.approvalTimeoutMs）。`,
                });
              }
            }, approvalTimeout),
          );
        }
        return;
      }
      case 'approval-resolved': {
        const t = live.approvalTimers.get(ev.callId);
        if (t) clearTimeout(t);
        live.approvalTimers.delete(ev.callId);
        record.pendingApproval = null;
        this.emit(record.runId, ev);
        this.setStatus(record, 'running');
        return;
      }
      case 'run-end': {
        this.emit(record.runId, ev);
        record.changedFiles = ev.changedFiles;
        const status: RunStatus =
          ev.reason === 'done'
            ? 'done'
            : ev.reason === 'aborted'
              ? 'aborted'
              : ev.reason === 'max-steps'
                ? 'max-steps'
                : 'failed';
        const error =
          ev.error === undefined
            ? null
            : typeof ev.error === 'string'
              ? ev.error
              : ev.error.message;
        void this.finish(record, status, ev.reason, error, false);
        return;
      }
      default:
        break;
    }
    this.emit(record.runId, ev);
  }

  private async finish(
    record: RunRecord,
    status: RunStatus,
    reason: string,
    error: string | null,
    emitEnd = true,
  ): Promise<void> {
    record.endReason = reason;
    record.error = error;
    record.pendingApproval = null;
    record.endedAt = new Date().toISOString();
    if (emitEnd) {
      // 始まる前に失敗・中断したとき。RunEvent と同じ形の終わりを流す
      const end: Record<string, unknown> = {
        type: 'run-end',
        reason,
        changedFiles: record.changedFiles,
        ...(error ? { error } : {}),
      };
      this.emit(record.runId, end);
    }
    this.setStatus(record, status);
    // 保持: 件数を超えた分と、時間を過ぎた分を消す
    await this.store.trimEvents(record.runId, this.keep).catch(() => undefined);
    const timer = setTimeout(() => {
      this.dropTimers.delete(timer);
      this.events.delete(record.runId);
      void this.store.dropEvents(record.runId).catch(() => undefined);
    }, EVENTS_TTL_MS);
    timer.unref();
    this.dropTimers.add(timer);
    this.closeSubscribers(record.runId);
  }

  private setStatus(record: RunRecord, status: RunStatus): void {
    if (record.status === status) {
      void this.store.save(record).catch((err) => this.warnSave(record.runId, err));
      return;
    }
    record.status = status;
    void this.store.save(record).catch((err) => this.warnSave(record.runId, err));
    this.emit(record.runId, { type: 'status', status });
  }

  /** 判定結果を接続先に保存する。同時に走る実行どうしで上書きし合わないよう、読み直してから足す。 */
  private saveCapabilities(endpointId: string, next: Config): Promise<void> {
    const task = async () => {
      const capabilities = next.endpoints.find((e) => e.id === endpointId)?.capabilities;
      if (!capabilities) return;
      const { config } = await loadConfig(this.opts.root);
      const current = config.endpoints.find((e) => e.id === endpointId);
      if (!current) return;
      await saveConfig(
        updateEndpoint(config, endpointId, {
          capabilities: {
            ...capabilities,
            byModel: { ...current.capabilities.byModel, ...capabilities.byModel },
          },
        }),
        this.opts.root,
      );
    };
    const run = this.configWrites.then(task);
    this.configWrites = run.catch(() => undefined);
    return run;
  }

  // ---------------- イベント ----------------

  private emit(runId: string, event: RunEvent | Record<string, unknown>): void {
    const seq = this.nextSeq.get(runId) ?? 1;
    this.nextSeq.set(runId, seq + 1);
    const stored: StoredEvent = {
      seq,
      ts: new Date().toISOString(),
      event: event as Record<string, unknown>,
    };
    const list = this.events.get(runId) ?? [];
    list.push(stored);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    this.events.set(runId, list);
    void this.store.appendEvent(runId, stored).catch((err) => this.warnSave(runId, err));
    for (const fn of this.subscribers.get(runId) ?? []) fn(stored);
  }

  /**
   * after より後のイベント。保持を超えて取りこぼしていれば gap を付ける。
   * メモリに無ければ（再起動後など）ファイルから読む。
   */
  async eventsAfter(
    runId: string,
    after: number,
  ): Promise<{
    events: StoredEvent[];
    gap: { from: number; firstAvailable: number | null } | null;
    finished: boolean;
  }> {
    const record = this.get(runId);
    let list = this.events.get(runId);
    if (!list) {
      list = await this.store.readEvents(runId);
      if (!this.live.has(runId)) this.events.set(runId, list);
    }
    const first = list[0]?.seq ?? null;
    const gap =
      first !== null && after + 1 < first
        ? { from: after + 1, firstAvailable: first }
        : first === null && FINISHED.has(record.status)
          ? { from: after + 1, firstAvailable: null } // 保持の時間を過ぎて、全部消えている
          : null;
    return {
      events: list.filter((e) => e.seq > after),
      gap,
      finished: FINISHED.has(record.status),
    };
  }

  /** 新しいイベントを受け取る。null は実行の終わり。 */
  subscribe(runId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private closeSubscribers(runId: string): void {
    for (const fn of this.subscribers.get(runId) ?? []) fn(null);
    this.subscribers.delete(runId);
  }

  // ---------------- 操作 ----------------

  get(runId: string): RunRecord {
    const r = this.records.get(runId.toUpperCase());
    if (!r) throw new ApiError(404, 'run_not_found', `実行 ${runId} はありません。`);
    return r;
  }

  list(filter: { labels: Record<string, string>; status?: string; limit: number }): RunRecord[] {
    return [...this.records.values()]
      .filter((r) => !filter.status || r.status === filter.status)
      .filter((r) => Object.entries(filter.labels).every(([k, v]) => r.labels[k] === v))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit);
  }

  approve(
    runId: string,
    callId: string,
    body: { decision: string; scope?: string; feedback?: string },
  ): void {
    const record = this.get(runId);
    const live = this.live.get(record.runId);
    const pending = record.pendingApproval;
    if (!live?.session || !pending || pending.callId !== callId) {
      throw new ApiError(
        409,
        'approval_not_pending',
        `呼び出し ${callId} は承認待ちではありません。`,
      );
    }
    if (!pending.decisions.includes(body.decision)) {
      throw new ApiError(
        400,
        'decision_not_available',
        `この承認では ${body.decision} を選べません（選べるもの: ${pending.decisions.join(', ')}）。`,
      );
    }
    const decision: ApprovalDecision =
      body.decision === 'allow'
        ? { kind: 'allow' }
        : body.decision === 'allowSession'
          ? { kind: 'allow-session', scope: pending.scope ?? body.scope ?? '' }
          : body.decision === 'abort'
            ? { kind: 'abort' }
            : { kind: 'deny', ...(body.feedback ? { feedback: body.feedback } : {}) };
    if (!live.session.approve(callId, decision)) {
      throw new ApiError(
        409,
        'approval_not_pending',
        `呼び出し ${callId} は既に答えが出ています。`,
      );
    }
  }

  abort(runId: string): RunRecord {
    const record = this.get(runId);
    if (FINISHED.has(record.status)) {
      throw new ApiError(409, 'run_finished', `実行 ${record.runId} は既に終わっています。`);
    }
    const live = this.live.get(record.runId)!;
    live.abortRequested = true;
    const i = this.queue.indexOf(record.runId);
    if (i !== -1) {
      this.queue.splice(i, 1);
      void this.finish(record, 'aborted', 'aborted', null);
    } else {
      live.session?.abort();
    }
    return record;
  }

  /** 追記。実行中なら差し込み、終わっていれば続きとして新しい実行を作る。 */
  async message(runId: string, text: string): Promise<{ record: RunRecord; injected: boolean }> {
    const record = this.get(runId);
    const live = this.live.get(record.runId);
    if (!FINISHED.has(record.status) && live) {
      if (live.session?.isRunning && live.session.inject(text)) return { record, injected: true };
      // 待機中や、始まる準備の途中（判定など）。始まったら最初の手の前に入れる
      live.pendingMessages.push(text);
      return { record, injected: true };
    }
    return { record: await this.continueWith(record, text), injected: false };
  }

  /** 同じ会話・同じ設定で、続きの実行を作る。 */
  private async continueWith(prev: RunRecord, text: string): Promise<RunRecord> {
    const record: RunRecord = {
      ...prev,
      runId: ulid(),
      prompt: text,
      idempotencyKey: null,
      status: 'queued',
      step: 0,
      pendingApproval: null,
      changedFiles: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      endReason: null,
      error: null,
      usage: { prompt: 0, completion: 0 },
      continuedFrom: prev.runId,
      pid: process.pid,
      labels: { ...prev.labels },
    };
    await this.register(record);
    return record;
  }

  async transcript(runId: string): Promise<TranscriptData> {
    const record = this.get(runId);
    if (!record.conversationId) return buildTranscript(record, []);
    const conversation = await this.openConversation(record.conversationId);
    const messages = conversation.thread().filter((m) => m.meta.runId === record.runId);
    return buildTranscript(record, toTranscript(messages));
  }

  async diff(runId: string, onlyPath?: string) {
    const record = this.get(runId);
    const journal = await ChangeJournal.load(record.runId, this.opts.root);
    return {
      runId: record.runId,
      workspace: record.workspace,
      files: journal ? await diffJournal(journal, onlyPath) : [],
    };
  }

  async undo(runId: string) {
    const record = this.get(runId);
    if (!FINISHED.has(record.status)) {
      throw new ApiError(
        409,
        'run_running',
        `実行 ${record.runId} はまだ終わっていません。止めてから戻してください。`,
      );
    }
    const journal = await ChangeJournal.load(record.runId, this.opts.root);
    if (!journal) return { runId: record.runId, restored: [], skipped: [] };
    return journal.undo();
  }

  async worktrees() {
    const list = await listWorktrees(this.opts.root);
    return list.map((w) => {
      const r = this.records.get(w.runId);
      return {
        ...w,
        branch: r?.branch ?? null,
        status: r?.status ?? null,
        sourceWorkspace: r?.sourceWorkspace ?? null,
      };
    });
  }

  async deleteWorktree(runId: string): Promise<boolean> {
    const record = this.get(runId);
    if (!record.worktree)
      throw new ApiError(400, 'no_worktree', `実行 ${record.runId} は worktree を使っていません。`);
    if (!FINISHED.has(record.status)) {
      throw new ApiError(409, 'run_running', `実行 ${record.runId} はまだ終わっていません。`);
    }
    return removeWorktree(this.opts.root, record.runId, record.sourceWorkspace);
  }

  async conversationList(limit: number) {
    const { items } = await this.conversations.list({ limit });
    return items;
  }

  async conversation(id: string) {
    const c = await this.openConversation(id);
    return { header: c.header, messages: c.thread() };
  }

  private async openConversation(id: string): Promise<Conversation> {
    try {
      return await this.conversations.open(id);
    } catch (err) {
      if (isAkariError(err) && err.code.startsWith('conversation.')) {
        throw new ApiError(404, 'conversation_not_found', err.message);
      }
      throw err;
    }
  }

  /** 閉じる。走っている実行は止める（変更の記録は残る）。 */
  async close(): Promise<void> {
    this.closing = true;
    for (const id of this.queue.splice(0)) {
      const r = this.records.get(id);
      if (r) await this.finish(r, 'aborted', 'aborted', 'サーバを止めたため実行しませんでした。');
    }
    for (const live of this.live.values()) live.session?.abort();
    const deadline = Date.now() + 5000;
    while (this.running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    for (const t of this.dropTimers) clearTimeout(t);
    await this.store.flush();
  }

  private warnSave(runId: string, err: unknown): void {
    this.opts.logger.warn('server.saveFailed', { runId, message: (err as Error).message });
  }
}

function defaultProvider(endpoint: ResolvedEndpoint, logger: Logger): Provider {
  return createProvider(endpoint, { logger });
}

async function pickModel(endpoint: ResolvedEndpoint, provider: Provider): Promise<string> {
  if (endpoint.defaultModel) return endpoint.defaultModel;
  const models = (await provider.listModels()).map((m) => m.id);
  const first = models.find((m) => isLikelyChatModel(m)) ?? models[0];
  if (!first) throw new Error(`接続先 "${endpoint.name}" にモデルが1件もありません。`);
  return first;
}

function decisionName(d: ApprovalDecision): string {
  return d.kind === 'allow-session' ? 'allowSession' : d.kind;
}

function describeError(err: unknown): string {
  const pe = getProviderError(err);
  if (pe) return pe.message;
  return (err as Error).message ?? String(err);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

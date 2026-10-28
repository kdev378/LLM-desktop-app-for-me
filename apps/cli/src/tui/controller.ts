import {
  ChangeJournal,
  Session,
  formatUnifiedDiff,
  tildify,
  type ApprovalDecision,
  type ChatMessage,
  type PermissionMode,
  type Provider,
  type ReasoningLevel,
  type ResolvedEndpoint,
  type RunEvent,
  type ToolsMode,
} from '@akari/core';
import type { CliContext } from '../context.js';
import { ExitError } from '../exit.js';
import { chooseConversation, safeSaver, type ConversationChoice } from '../conversation.js';
import {
  decideToolsMode,
  parsePermission,
  toolNamesFor,
  windowTokensFor,
  type ToolScope,
} from '../agent-setup.js';
import { chatTurn, type ChatParams } from '../chat-turn.js';
import {
  createBlockFilter,
  describeContext,
  describeEnd,
  describeMode,
  describeToolsMode,
  summarizeArgs,
} from '../describe.js';
import { formatDuration } from '../term.js';
import { collectDiffs } from '../commands/runs.js';
import { diffLine, digestLines, helpLines, line, seg, trimEnd, type Line } from './lines.js';

export type { Line, Seg } from './lines.js';

/**
 * 対話画面の中身。仕様: docs/spec/17-interactive.md
 *
 * 画面（Ink）から切り離してある。画面はここの状態を写すだけで、
 * 何を送るか・どう記録するか・承認をどう返すかはここで決める。
 * そのため、画面なしでキー操作の結果を試せる。
 */

/** 流れていく（書き換えない）表示の1件。 */
export type Item =
  | { id: number; kind: 'header'; title: string; lines: Line[] }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'lines'; lines: Line[] };

export type DialogOption = { key: string; label: string };

type NewItem = Item extends infer T ? (T extends Item ? Omit<T, 'id'> : never) : never;

/** 選んで答える枠（承認、取り消しの確認）。 */
export type Dialog = {
  title: string;
  body: Line[];
  options: DialogOption[];
  selected: number;
};

export type Status = {
  model: string;
  /** 道具なしの会話のときは null（権限は使わない）。 */
  permission: PermissionMode | null;
  tools: string;
  context: string | null;
};

export type Snapshot = {
  items: Item[];
  /** 実行中なら何をしているか。 */
  busy: { label: string; since: number } | null;
  /** 届いている途中の応答（まだ行が閉じていない分）。 */
  streaming: string;
  /** 実行中の道具の出力の末尾（数行だけ）。 */
  toolTail: string[];
  dialog: Dialog | null;
  /** 入力欄の上に出す案内（拒否の理由を入れるときなど）。 */
  inputHint: string | null;
  status: Status;
  /** Ctrl+C を1度押して、もう1度で終わる状態。 */
  exitPending: boolean;
};

export type AgentSetup = {
  kind: 'agent';
  workspace: import('@akari/core').Workspace;
  permission: PermissionMode;
  scope: ToolScope;
  /** --tools-mode などで強制した渡し方。判定に従うなら null。 */
  forced: ToolsMode | null;
  toolsMode: ToolsMode;
  maxSteps: number;
};

export type ChatSetup = {
  kind: 'chat';
  /** 道具なしにした理由（作業フォルダにできない場所など）。 */
  reason: string;
  params: Omit<ChatParams, 'reasoning'>;
};

export type ControllerOptions = {
  ctx: CliContext;
  endpoint: ResolvedEndpoint;
  provider: Provider;
  model: string;
  reasoning?: ReasoningLevel;
  conversation: ConversationChoice;
  /** --no-save なら false。 */
  save: boolean;
  setup: AgentSetup | ChatSetup;
  version: string;
  /** 起動までに出た注意（判定の経過など）。画面の最初に出す。 */
  startupNotes?: string[];
};

/** 流す前に止める行数。これより長い道具の出力は、末尾だけを残す。 */
const TOOL_OUTPUT_KEEP = 8;
const DIFF_PREVIEW_LINES = 40;

export class Controller {
  private readonly ctx: CliContext;
  private endpoint: ResolvedEndpoint;
  private readonly provider: Provider;
  private model: string;
  private readonly reasoning: ReasoningLevel | undefined;
  private conversation: ConversationChoice;
  private readonly save: boolean;
  private readonly saver = safeSaver();
  private readonly setup: AgentSetup | ChatSetup;
  private session: Session | null = null;
  /** 道具なしの会話の文脈。 */
  private messages: ChatMessage[] = [];
  private chatAbort: AbortController | null = null;
  private lastRun: { runId: string; changedFiles: string[] } | null = null;
  private instructionsShown = false;
  private shownNotices = new Set<string>();

  private nextId = 1;
  private state: Snapshot;
  private listeners = new Set<() => void>();
  /** 選択肢を選んだときの続き。 */
  private onPick: ((key: string) => void) | null = null;
  /** 入力欄で受けている、送信ではない答え（拒否の理由）。 */
  private onAnswer: ((text: string | null) => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private exitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ControllerOptions) {
    this.ctx = opts.ctx;
    this.endpoint = opts.endpoint;
    this.provider = opts.provider;
    this.model = opts.model;
    this.reasoning = opts.reasoning;
    this.conversation = opts.conversation;
    this.save = opts.save;
    this.setup = opts.setup;
    if (opts.setup.kind === 'agent') this.session = this.createSession(opts.conversation);
    else this.messages = [...opts.conversation.history];

    this.state = {
      items: [],
      busy: null,
      streaming: '',
      toolTail: [],
      dialog: null,
      inputHint: null,
      status: this.computeStatus(),
      exitPending: false,
    };
    this.pushItem({ kind: 'header', title: `Akari ${opts.version}`, lines: this.headerLines() });
    for (const n of opts.startupNotes ?? []) this.pushLines([line(n, 'dim')]);
    if (opts.setup.kind === 'chat') {
      this.pushLines([
        [seg('! ', 'warn'), seg(opts.setup.reason)],
        line(
          '  道具なしの会話で始めます。ファイルを触らせるには、プロジェクトのフォルダで起動し直してください。',
          'dim',
        ),
      ]);
    }
  }

  // ---------------- 画面とのつなぎ ----------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.state;

  /** 画面を閉じる手段（Ink の exit）。 */
  setExitHandler(fn: () => void): void {
    this.exitHandler = fn;
  }

  /** 閉じるときに出す、続きの始め方。 */
  farewell(): string {
    const target = this.conversation.target;
    if (!target) return '会話は保存していません（--no-save）。';
    const cmd = this.setup.kind === 'agent' ? 'akari -c' : 'akari chat -c';
    return `続けるには: ${cmd}  （会話 ${target.id}）`;
  }

  get isBusy(): boolean {
    return this.state.busy !== null;
  }

  private update(patch: Partial<Snapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private pushItem(item: NewItem): void {
    const withId = { ...item, id: this.nextId++ } as Item;
    this.state = { ...this.state, items: [...this.state.items, withId] };
    for (const fn of this.listeners) fn();
  }

  private pushLines(lines: Line[]): void {
    if (lines.length === 0) return;
    this.pushItem({ kind: 'lines', lines });
  }

  // ---------------- 入力 ----------------

  /** 入力欄で Enter。送信か、/ コマンドか、待っている答えか。 */
  async submit(raw: string): Promise<void> {
    if (this.onAnswer) {
      const answer = this.onAnswer;
      this.onAnswer = null;
      this.update({ inputHint: null });
      answer(raw.trim());
      return;
    }
    if (this.isBusy) return;
    const text = raw.trim();
    if (text === '') return;
    this.clearExitPending();
    // 画面の中で起きた失敗で画面ごと落とさない。その操作を失敗として出し、入力欄に戻る（17-interactive.md）
    try {
      if (text.startsWith('/')) await this.command(text);
      else if (this.setup.kind === 'agent') await this.runAgent(text);
      else await this.runChat(text);
    } catch (err) {
      this.state = { ...this.state, streaming: '' };
      this.pushLines([[seg('✗ ', 'error'), seg(messageOf(err), 'error')]]);
      this.update({ busy: null, toolTail: [], dialog: null });
    }
  }

  /** Esc。選択肢があれば拒否、実行中なら止める。 */
  escape(): void {
    if (this.state.dialog) {
      this.pickByKey(this.state.dialog.options.find((o) => o.key === 'n')?.key ?? 'n', true);
      return;
    }
    if (this.onAnswer) {
      const answer = this.onAnswer;
      this.onAnswer = null;
      this.update({ inputHint: null });
      answer(null);
      return;
    }
    this.abort();
  }

  /** Ctrl+C。入力が空でなければ画面側で消す。ここでは止める・終わるだけ。 */
  interrupt(): void {
    if (this.state.dialog || this.onAnswer) {
      // 承認の途中なら拒否してから、実行ごと止める
      this.escape();
      this.abort();
      return;
    }
    if (this.isBusy) {
      this.abort();
      return;
    }
    if (this.state.exitPending) {
      this.exit();
      return;
    }
    this.update({ exitPending: true });
    this.exitTimer = setTimeout(() => this.clearExitPending(), 3000);
    this.exitTimer.unref?.();
  }

  exit(): void {
    this.abort();
    this.clearExitPending();
    this.exitHandler?.();
  }

  private clearExitPending(): void {
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.exitTimer = null;
    if (this.state.exitPending) this.update({ exitPending: false });
  }

  abort(): void {
    this.session?.abort();
    this.chatAbort?.abort();
  }

  /** Shift+Tab。権限を 承認する → 編集は自動 → すべて自動 → と回す。 */
  cyclePermission(): void {
    if (this.setup.kind !== 'agent' || this.isBusy) return;
    const order: PermissionMode[] = ['ask', 'autoEdit', 'full'];
    const next = order[(order.indexOf(this.setup.permission) + 1) % order.length]!;
    this.setPermission(next);
  }

  // ---------------- 選択肢 ----------------

  moveSelection(delta: number): void {
    const d = this.state.dialog;
    if (!d) return;
    const n = d.options.length;
    this.update({ dialog: { ...d, selected: (d.selected + delta + n) % n } });
  }

  chooseSelected(): void {
    const d = this.state.dialog;
    if (!d) return;
    this.pickByKey(d.options[d.selected]!.key);
  }

  /** 括弧の中のキーで選ぶ。そのキーの選択肢が無ければ false。 */
  pickByKey(key: string, viaEscape = false): boolean {
    const d = this.state.dialog;
    if (!d || !d.options.some((o) => o.key === key)) return false;
    const pick = this.onPick;
    this.onPick = null;
    this.update({ dialog: null });
    pick?.(viaEscape ? `${key}!` : key);
    return true;
  }

  private ask(dialog: Omit<Dialog, 'selected'>): Promise<string> {
    return new Promise((resolve) => {
      this.onPick = resolve;
      this.update({ dialog: { ...dialog, selected: 0 } });
    });
  }

  private askText(hint: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.onAnswer = resolve;
      this.update({ inputHint: hint });
    });
  }

  // ---------------- エージェント ----------------

  private createSession(conversation: ConversationChoice): Session {
    const setup = this.setup as AgentSetup;
    const compaction = conversation.source?.latestCompaction();
    return Session.create({
      provider: this.provider,
      model: this.model,
      workspace: setup.workspace,
      transcript: conversation.transcript,
      context: {
        settings: this.ctx.config.context,
        windowTokens: windowTokensFor(this.ctx, this.endpoint.id, this.model),
        endpointId: this.endpoint.id,
      },
      ...(compaction ? { compaction } : {}),
      ...(conversation.target
        ? {
            recorder: conversation.target.recorder({
              model: this.model,
              endpointId: this.endpoint.id,
            }),
            conversationId: conversation.target.id,
          }
        : {}),
      permissionMode: setup.permission,
      toolNames: toolNamesFor(setup.scope),
      maxSteps: setup.maxSteps,
      toolsMode: setup.toolsMode,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      limits: {
        commandTimeoutMs: this.ctx.config.agent.commandTimeoutMs,
        toolOutputLimitBytes: this.ctx.config.agent.toolOutputLimitBytes,
        deniedCommands: this.ctx.config.agent.deniedCommands,
      },
      logger: this.ctx.logger,
    });
  }

  private async runAgent(text: string): Promise<void> {
    const session = this.session!;
    const setup = this.setup as AgentSetup;
    this.pushItem({ kind: 'user', text });
    const started = Date.now();
    this.update({ busy: { label: '待機中', since: started }, streaming: '', toolTail: [] });
    const filter = setup.toolsMode === 'prompted' ? createBlockFilter() : null;
    let tail: string[] = [];
    let outputLines = 0;

    try {
      for await (const ev of session.send(text)) {
        this.onAgentEvent(ev, session, filter, started, {
          get: () => tail,
          set: (t) => (tail = t),
          count: () => outputLines,
          add: (n) => (outputLines += n),
          reset: () => {
            tail = [];
            outputLines = 0;
          },
        });
      }
    } catch (err) {
      this.flushStreaming(filter);
      this.pushLines([
        [seg('✗ ', 'error'), seg(`実行が失敗しました: ${(err as Error).message}`, 'error')],
      ]);
    } finally {
      this.update({ busy: null, toolTail: [], status: this.computeStatus() });
    }
  }

  private onAgentEvent(
    ev: RunEvent,
    session: Session,
    filter: ReturnType<typeof createBlockFilter> | null,
    started: number,
    out: {
      get: () => string[];
      set: (t: string[]) => void;
      count: () => number;
      add: (n: number) => void;
      reset: () => void;
    },
  ): void {
    switch (ev.type) {
      case 'run-start':
        if (!this.instructionsShown && ev.instructionFiles.length > 0) {
          this.pushLines([line(`指示ファイル: ${ev.instructionFiles.join(', ')}`, 'dim')]);
        }
        this.instructionsShown = true;
        break;
      case 'text-delta': {
        const shown = filter ? filter.feed(ev.text) : ev.text;
        if (shown !== '') this.appendStreaming(shown);
        this.setBusyLabel('生成中');
        break;
      }
      case 'reasoning-delta':
        this.setBusyLabel('考え中');
        break;
      case 'tool-call':
        this.flushStreaming(filter);
        out.reset();
        this.pushLines([[seg(`  ${ev.name}`, 'accent'), seg(` ${summarizeArgs(ev.args)}`, 'dim')]]);
        this.setBusyLabel(`${ev.name} を実行中`);
        break;
      case 'tool-output': {
        const lines = ev.text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
        out.add(lines.length);
        const tail = [...out.get(), ...lines].slice(-TOOL_OUTPUT_KEEP);
        out.set(tail);
        this.update({ toolTail: tail.slice(-4) });
        break;
      }
      case 'tool-result': {
        const tail = out.get();
        const lines: Line[] = [];
        if (tail.length > 0) {
          if (out.count() > tail.length) {
            lines.push(
              line(
                `    …（${out.count() - tail.length} 行省略。全部は akari conversations show --full）`,
                'dim',
              ),
            );
          }
          for (const l of tail) lines.push(line(`    ${l}`, 'dim'));
        }
        lines.push(
          ev.ok
            ? [seg('    ✓ ', 'ok'), seg(ev.summary, 'ok')]
            : [seg('    ✗ ', 'error'), seg(ev.summary, 'error')],
        );
        this.pushLines(lines);
        out.reset();
        this.update({ toolTail: [] });
        break;
      }
      case 'approval-request':
        this.flushStreaming(filter);
        this.setBusyLabel('承認待ち');
        void this.askApproval(ev, session);
        break;
      case 'compaction-start':
        this.flushStreaming(filter);
        this.pushLines([
          line(
            `  ⧉ 文脈が約${ev.beforeTokens.toLocaleString()}トークン${ev.estimated ? '（概算）' : ''}になったため、古い ${ev.turns} 手を圧縮しています…`,
            'info',
          ),
        ]);
        this.setBusyLabel('圧縮中');
        break;
      case 'compaction-end': {
        const lines: Line[] = [
          line(
            `  ⧉ 圧縮しました: 約${ev.afterTokens.toLocaleString()}トークン${ev.estimated ? '（概算）' : ''}。中身は /digest で見られます`,
            'info',
          ),
        ];
        if (ev.fallback) {
          lines.push([
            seg('    ! ', 'warn'),
            seg(
              'モデルが圧縮版を書けなかった分は、機械的な要約で残しています（劣った圧縮です）。',
              'warn',
            ),
          ]);
        }
        this.pushLines(lines);
        break;
      }
      case 'notice':
        // 送るたびに同じ注意（代替方式で動作中、など）が出ると埋もれる。同じ文は1度だけ
        if (this.shownNotices.has(ev.message)) break;
        this.shownNotices.add(ev.message);
        this.flushStreaming(filter);
        this.pushLines([
          ev.level === 'warn'
            ? [seg('  ! ', 'warn'), seg(ev.message, 'warn')]
            : line(`  ${ev.message}`, 'dim'),
        ]);
        break;
      case 'run-end': {
        this.flushStreaming(filter);
        const lines: Line[] = [
          line(`${describeEnd(ev.reason)}  ${formatDuration(Date.now() - started)}`, 'dim'),
        ];
        if (ev.changedFiles.length > 0) {
          lines.push(line(`変更したファイル (${ev.changedFiles.length}):`, 'dim'));
          for (const f of ev.changedFiles) lines.push(line(`  ${f}`, 'dim'));
          lines.push(line('戻すには /undo、差分は /diff', 'dim'));
        }
        if (ev.error) {
          lines.push([
            seg('✗ ', 'error'),
            seg(`エラー: ${typeof ev.error === 'string' ? ev.error : ev.error.message}`, 'error'),
          ]);
        }
        this.pushLines(lines);
        this.lastRun = { runId: session.runId, changedFiles: ev.changedFiles };
        break;
      }
      default:
        break;
    }
  }

  private async askApproval(
    ev: Extract<RunEvent, { type: 'approval-request' }>,
    session: Session,
  ): Promise<void> {
    const body: Line[] = ev.prompt.split('\n').map((l) => line(l, 'bold'));
    if (ev.preview?.kind === 'diff') {
      const diff = trimEnd(
        formatUnifiedDiff(ev.preview.path, ev.preview.before, ev.preview.after, 2).split('\n'),
      );
      for (const l of diff.slice(0, DIFF_PREVIEW_LINES)) body.push(diffLine(l));
      if (diff.length > DIFF_PREVIEW_LINES) {
        body.push(line(`…（ほか ${diff.length - DIFF_PREVIEW_LINES} 行）`, 'dim'));
      }
    }
    const picked = await this.ask({
      title: '承認が必要です',
      body,
      options: ev.options.map((o) => ({ key: o.key, label: o.label })),
    });
    const viaEscape = picked.endsWith('!');
    const key = viaEscape ? picked.slice(0, -1) : picked;
    const option = ev.options.find((o) => o.key === key);
    let decision: ApprovalDecision = option?.decision ?? { kind: 'deny' };
    if (decision.kind === 'deny' && !viaEscape) {
      const reason = await this.askText('拒否の理由を入れて Enter（空でよい。Esc で理由なし）');
      decision = reason ? { kind: 'deny', feedback: reason } : { kind: 'deny' };
    }
    this.pushLines([
      line(
        `    → ${option?.label ?? '拒否'}${decision.kind === 'deny' && decision.feedback ? `（理由: ${decision.feedback}）` : ''}`,
        'dim',
      ),
    ]);
    this.setBusyLabel('実行中');
    session.approve(ev.callId, decision);
  }

  // ---------------- 道具なしの会話 ----------------

  private async runChat(text: string): Promise<void> {
    const setup = this.setup as ChatSetup;
    this.pushItem({ kind: 'user', text });
    this.messages.push({ role: 'user', content: text });
    const started = Date.now();
    this.chatAbort = new AbortController();
    this.update({ busy: { label: '待機中', since: started }, streaming: '' });
    const target = this.conversation.target;
    const record = target
      ? {
          recorder: target.recorder({ model: this.model, endpointId: this.endpoint.id }),
          save: this.saver,
        }
      : undefined;
    const params: ChatParams = {
      ...setup.params,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    };
    try {
      for await (const ev of chatTurn(
        this.provider,
        this.model,
        this.messages,
        params,
        this.chatAbort.signal,
        record,
      )) {
        switch (ev.type) {
          case 'notice':
            this.pushLines([[seg('  ! ', 'warn'), seg(ev.message, 'warn')]]);
            break;
          case 'text':
            this.appendStreaming(ev.text);
            this.setBusyLabel('生成中');
            break;
          case 'reasoning':
            this.setBusyLabel('考え中');
            break;
          case 'done': {
            this.flushStreaming(null);
            const parts = [formatDuration(ev.durationMs)];
            if (ev.usage) parts.push(`${ev.usage.prompt}+${ev.usage.completion} トークン`);
            if (ev.reasoning) parts.push(`思考出力 ${ev.reasoning.length}文字（非表示）`);
            const lines: Line[] = [];
            if (ev.reason === 'length')
              lines.push(line('（上限に達して途中で止まりました）', 'warn'));
            if (ev.reason === 'aborted') lines.push(line('（停止しました）', 'warn'));
            lines.push(line(parts.join('  '), 'dim'));
            this.pushLines(lines);
            break;
          }
          case 'error': {
            this.flushStreaming(null);
            if (ev.error.kind === 'aborted') {
              this.pushLines([line('（停止しました）', 'warn')]);
            } else {
              // 失敗した往復は文脈から外す。壊れた履歴のまま続けない
              if (ev.text === '') this.messages.pop();
              this.pushLines([[seg('✗ ', 'error'), seg(`エラー: ${ev.error.message}`, 'error')]]);
            }
            break;
          }
          default:
            break;
        }
      }
    } finally {
      this.chatAbort = null;
      this.update({ busy: null, status: this.computeStatus() });
    }
  }

  // ---------------- 応答の流し方 ----------------

  /** 届いた文字を足す。閉じた行は流れる側へ移し、書き換わる部分を小さく保つ。 */
  private appendStreaming(text: string): void {
    const all = this.state.streaming + text;
    const cut = all.lastIndexOf('\n');
    if (cut === -1) {
      this.update({ streaming: all });
      return;
    }
    const done = all.slice(0, cut);
    this.state = { ...this.state, streaming: all.slice(cut + 1) };
    this.pushItem({ kind: 'assistant', text: done });
  }

  private flushStreaming(filter: ReturnType<typeof createBlockFilter> | null): void {
    const rest = filter ? filter.flush() : '';
    const text = this.state.streaming + rest;
    this.state = { ...this.state, streaming: '' };
    if (text.trim() !== '') this.pushItem({ kind: 'assistant', text: text.replace(/\n+$/, '') });
    else this.update({});
  }

  private setBusyLabel(label: string): void {
    const busy = this.state.busy;
    if (busy && busy.label !== label) this.update({ busy: { ...busy, label } });
  }

  // ---------------- 表示の材料 ----------------

  private headerLines(): Line[] {
    const lines: Line[] = [];
    lines.push([
      seg(this.endpoint.name),
      ...(this.endpoint.isExternal ? [seg(' [外部]', 'warn')] : []),
      seg(` / ${this.model}`),
      ...(this.setup.kind === 'agent'
        ? [seg(`   ${tildify(this.setup.workspace.root)}`, 'dim')]
        : []),
    ]);
    if (this.setup.kind === 'agent') {
      const names = toolNamesFor(this.setup.scope);
      lines.push(
        line(
          `権限: ${describeMode(this.setup.permission)}   道具: ${this.describeScope()}${names.length > 0 ? ` / ${describeToolsMode(this.setup.toolsMode)}` : ''}`,
          'dim',
        ),
      );
    } else {
      lines.push(line('道具なしの会話', 'dim'));
    }
    lines.push(line(this.describeConversation(), 'dim'));
    if (this.setup.kind === 'agent') {
      lines.push(
        line(
          describeContext(
            this.ctx.config.context,
            windowTokensFor(this.ctx, this.endpoint.id, this.model),
          ),
          'dim',
        ),
      );
    }
    lines.push(line('/help で操作一覧。Enter で送信、Shift+Enter（または Ctrl+J）で改行。', 'dim'));
    return lines;
  }

  private describeConversation(): string {
    const conv = this.conversation;
    if (!conv.target) {
      return conv.continued
        ? `会話: ${conv.source?.id} の続き（--no-save のため保存しない）`
        : '会話: 保存しない（--no-save）';
    }
    const count = this.setup.kind === 'agent' ? conv.transcript.length : conv.history.length;
    return conv.continued
      ? `会話: ${conv.target.id} の続き（これまで ${count} 件）`
      : `会話: ${conv.target.id}（新規）`;
  }

  private describeScope(): string {
    if (this.setup.kind !== 'agent') return 'なし';
    const n = toolNamesFor(this.setup.scope).length;
    return this.setup.scope === 'off'
      ? 'なし'
      : this.setup.scope === 'read-only'
        ? `読み取りのみ ${n}種`
        : `${n}種`;
  }

  private computeStatus(): Status {
    let context: string | null = null;
    const usage = this.session?.contextUsage;
    if (usage) {
      const pct = Math.min(999, Math.round((usage.tokens / Math.max(1, usage.threshold)) * 100));
      context = `文脈 ${usage.estimated ? '~' : ''}${pct}%`;
    }
    return {
      model: this.model,
      permission: this.setup.kind === 'agent' ? this.setup.permission : null,
      tools: this.setup.kind === 'agent' ? `道具 ${this.describeScope()}` : '道具なし',
      context,
    };
  }

  // ---------------- / コマンド ----------------

  private async command(text: string): Promise<void> {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    this.pushLines([[seg('› ', 'accent'), seg(text, 'dim')]]);
    switch (name) {
      case 'help':
        this.pushLines(helpLines());
        return;
      case 'exit':
      case 'quit':
        this.exit();
        return;
      case 'new':
        await this.newConversation();
        return;
      case 'model':
        await this.switchModel(arg);
        return;
      case 'permission':
        this.permissionCommand(arg);
        return;
      case 'tools':
        await this.toolsCommand(arg);
        return;
      case 'context':
        this.contextCommand();
        return;
      case 'digest':
        this.digestCommand();
        return;
      case 'diff':
        await this.diffCommand();
        return;
      case 'undo':
        await this.undoCommand();
        return;
      default:
        this.pushLines([
          [seg('! ', 'warn'), seg(`知らないコマンドです: /${name ?? ''}`, 'warn')],
          line('  /help で一覧を出せます。モデルへは送っていません。', 'dim'),
        ]);
    }
  }

  private requireAgent(what: string): boolean {
    if (this.setup.kind === 'agent') return true;
    this.pushLines([
      line(
        `道具なしの会話では${what}は使えません。プロジェクトのフォルダで akari を起動してください。`,
        'dim',
      ),
    ]);
    return false;
  }

  private async newConversation(): Promise<void> {
    const kind = this.setup.kind === 'agent' ? 'agent' : 'chat';
    this.conversation = await chooseConversation(
      this.ctx,
      { save: this.save },
      {
        kind,
        workspace: this.setup.kind === 'agent' ? this.setup.workspace.root : null,
        settings: { endpointId: this.endpoint.id, model: this.model },
      },
    );
    if (this.setup.kind === 'agent') {
      this.session = this.createSession(this.conversation);
      this.lastRun = null;
    } else {
      this.messages = [];
    }
    this.update({ status: this.computeStatus() });
    this.pushLines([
      line(
        this.conversation.target
          ? `新しい会話 ${this.conversation.target.id} を始めます（前の会話は残っています）。`
          : '新しい会話を始めます（保存しません）。',
        'dim',
      ),
    ]);
  }

  private async switchModel(id: string): Promise<void> {
    let models: string[];
    try {
      models = (await this.provider.listModels()).map((m) => m.id);
    } catch (err) {
      this.pushLines([
        [
          seg('✗ ', 'error'),
          seg(`モデル一覧を取れませんでした: ${(err as Error).message}`, 'error'),
        ],
      ]);
      return;
    }
    if (id === '') {
      this.pushLines([
        line(`接続先 ${this.endpoint.name} のモデル:`, 'dim'),
        ...models.map((m) =>
          m === this.model ? [seg('  › ', 'accent'), seg(m, 'accent')] : line(`    ${m}`),
        ),
        line('切り替えるには /model <ID>', 'dim'),
      ]);
      return;
    }
    if (!models.includes(id)) {
      this.pushLines([
        [seg('! ', 'warn'), seg(`接続先 ${this.endpoint.name} に ${id} はありません。`, 'warn')],
        line('  /model で一覧を出せます。', 'dim'),
      ]);
      return;
    }
    if (this.setup.kind === 'agent') {
      const setup = this.setup;
      this.update({ busy: { label: '道具の渡し方を判定中', since: Date.now() } });
      try {
        const decision = await decideToolsMode(
          this.ctx,
          this.freshEndpoint(),
          this.provider,
          id,
          toolNamesFor(setup.scope),
          setup.forced,
        );
        setup.toolsMode = decision.effective;
        this.model = id;
        this.session!.reconfigure({
          model: id,
          toolsMode: decision.effective,
          windowTokens: windowTokensFor(this.ctx, this.endpoint.id, id),
          ...(this.conversation.target
            ? {
                recorder: this.conversation.target.recorder({
                  model: id,
                  endpointId: this.endpoint.id,
                }),
              }
            : {}),
        });
        this.pushLines([
          ...decision.notes.map((n) => line(`  ${n}`, 'dim')),
          ...decision.warnings.map((w) => [seg('  ! ', 'warn'), seg(w, 'warn')]),
        ]);
      } finally {
        this.update({ busy: null });
      }
    } else {
      this.model = id;
    }
    await this.saver(async () => this.conversation.target?.updateSettings({ model: id }));
    this.update({ status: this.computeStatus() });
    this.pushLines([line(`モデルを ${id} にしました。`, 'dim')]);
  }

  /** 判定の結果を保存したあとの接続先（判定し直さないため）。 */
  private freshEndpoint(): ResolvedEndpoint {
    const saved = this.ctx.config.endpoints.find((e) => e.id === this.endpoint.id);
    if (saved) this.endpoint = { ...this.endpoint, capabilities: saved.capabilities };
    return this.endpoint;
  }

  private permissionCommand(arg: string): void {
    if (!this.requireAgent('権限')) return;
    const setup = this.setup as AgentSetup;
    if (arg === '') {
      this.pushLines([
        line(
          `権限: ${describeMode(setup.permission)}（ask / auto-edit / full。Shift+Tab でも切り替え）`,
          'dim',
        ),
      ]);
      return;
    }
    const mode = parsePermission(arg);
    if (!mode) {
      this.pushLines([
        [
          seg('! ', 'warn'),
          seg(`権限は ask / auto-edit / full のどれかです（受け取った値: ${arg}）。`, 'warn'),
        ],
      ]);
      return;
    }
    this.setPermission(mode);
  }

  private setPermission(mode: PermissionMode): void {
    const setup = this.setup as AgentSetup;
    setup.permission = mode;
    this.session!.reconfigure({ permissionMode: mode });
    this.update({ status: this.computeStatus() });
    this.pushLines([line(`権限を「${describeMode(mode)}」にしました。`, 'dim')]);
  }

  private async toolsCommand(arg: string): Promise<void> {
    if (!this.requireAgent('道具の切り替え')) return;
    const setup = this.setup as AgentSetup;
    if (arg === '') {
      this.pushLines([line(`道具: ${this.describeScope()}（all / read-only / off）`, 'dim')]);
      return;
    }
    if (arg !== 'all' && arg !== 'read-only' && arg !== 'off') {
      this.pushLines([
        [
          seg('! ', 'warn'),
          seg(`道具は all / read-only / off のどれかです（受け取った値: ${arg}）。`, 'warn'),
        ],
      ]);
      return;
    }
    const names = toolNamesFor(arg);
    // 道具なしから渡すようにしたときは、渡し方がまだ決まっていないことがある
    if (names.length > 0 && setup.scope === 'off' && setup.forced === null) {
      this.update({ busy: { label: '道具の渡し方を判定中', since: Date.now() } });
      try {
        const decision = await decideToolsMode(
          this.ctx,
          this.freshEndpoint(),
          this.provider,
          this.model,
          names,
          null,
        );
        setup.toolsMode = decision.effective;
        this.pushLines(decision.notes.map((n) => line(`  ${n}`, 'dim')));
      } finally {
        this.update({ busy: null });
      }
    }
    setup.scope = arg;
    this.session!.reconfigure({ toolNames: names, toolsMode: setup.toolsMode });
    this.update({ status: this.computeStatus() });
    this.pushLines([line(`道具を「${this.describeScope()}」にしました。`, 'dim')]);
  }

  private contextCommand(): void {
    if (this.setup.kind !== 'agent') {
      const chars = this.messages.reduce((n, m) => n + m.content.length, 0);
      this.pushLines([
        line(
          `メッセージ ${this.messages.length}件 / 概算 ${Math.ceil(chars / 2.2)} トークン（概算です）`,
          'dim',
        ),
      ]);
      return;
    }
    const windowTokens = windowTokensFor(this.ctx, this.endpoint.id, this.model);
    const usage = this.session!.contextUsage;
    this.pushLines([
      line(
        usage
          ? `最後に送った量: 約${usage.tokens.toLocaleString()}トークン${usage.estimated ? '（概算）' : ''} / 圧縮を始める量: 約${usage.threshold.toLocaleString()}`
          : 'まだ送っていないので、量は分かりません。',
        'dim',
      ),
      line(describeContext(this.ctx.config.context, windowTokens), 'dim'),
    ]);
  }

  private digestCommand(): void {
    const compaction = this.session?.latestCompaction ?? null;
    if (!compaction) {
      this.pushLines([
        line(
          'この会話ではまだ圧縮が起きていません。モデルには生のやり取りがそのまま渡っています。',
          'dim',
        ),
      ]);
      return;
    }
    this.pushLines(digestLines(compaction));
  }

  private async diffCommand(): Promise<void> {
    if (!this.requireAgent('/diff')) return;
    const journal = this.lastRun
      ? await ChangeJournal.load(this.lastRun.runId, this.ctx.root)
      : null;
    if (!journal || journal.changes.length === 0) {
      this.pushLines([line('直前の実行はファイルを変えていません。', 'dim')]);
      return;
    }
    const lines: Line[] = [];
    for (const r of await collectDiffs(journal)) {
      if (r.note) {
        lines.push(line(`${r.path}: ${r.note}`, 'dim'));
        continue;
      }
      for (const l of trimEnd(r.diff.split('\n'))) lines.push(diffLine(l));
    }
    this.pushLines(lines);
  }

  private async undoCommand(): Promise<void> {
    if (!this.requireAgent('/undo')) return;
    const last = this.lastRun;
    if (!last || last.changedFiles.length === 0) {
      this.pushLines([line('直前の実行はファイルを変えていません。', 'dim')]);
      return;
    }
    const picked = await this.ask({
      title: '直前の実行の変更を戻します',
      body: last.changedFiles.map((f) => line(f)),
      options: [
        { key: 'y', label: '戻す' },
        { key: 'n', label: 'やめる' },
      ],
    });
    if (picked !== 'y') {
      this.pushLines([line('戻しませんでした。', 'dim')]);
      return;
    }
    const result = await this.session!.undo();
    const lines: Line[] = [];
    for (const f of result.restored) lines.push([seg('  ✓ ', 'ok'), seg(`${f} を戻しました`)]);
    for (const s of result.skipped)
      lines.push([seg('  ! ', 'warn'), seg(`${s.path}: ${s.reason}`, 'warn')]);
    if (lines.length === 0) lines.push(line('戻すものはありませんでした。', 'dim'));
    this.pushLines(lines);
    this.lastRun = { ...last, changedFiles: [] };
  }
}

function messageOf(err: unknown): string {
  if (err instanceof ExitError) return err.hint ? `${err.message}（${err.hint}）` : err.message;
  return (err as Error).message ?? String(err);
}

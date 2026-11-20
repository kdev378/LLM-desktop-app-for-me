import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid } from '../util/ids.js';
import { akariHome, paths } from '../util/paths.js';
import { readJson, writeJsonAtomic, withFileQueue } from '../util/json.js';
import { AkariError } from '../util/errors.js';
import type { FinishReason, ProviderError, Usage } from '../provider/types.js';
import type { RunEndReason } from '../agent/events.js';
import type { Compaction } from '../context/digest.js';
import type { ConversationRecorder, InflightPartial, RecordedMessage } from '../agent/recorder.js';

/**
 * 会話の保存。仕様: docs/spec/04-chat.md / docs/spec/07-data.md
 *
 *   conversations/<id>.json            見出し（小さい。原子的に書き直す）
 *   conversations/<id>.messages.jsonl  メッセージ（1行1件、追記のみ）
 *   conversations/<id>.inflight.json   生成中の途中経過（終わったら消す）
 *
 * メッセージを追記だけにするのは、エージェントの会話が道具の出力で大きくなり、
 * 生の記録を消さない約束のため大きくなる一方だから。書き直す方式では
 * 保存の時間が大きさに比例する。
 */

export const CONVERSATION_SCHEMA_VERSION = 1;
const TITLE_LENGTH = 40;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 会話のファイルの権限。エージェントが読んだファイルの中身やコマンドの出力が入るので、
 * 鍵（credentials.json）と同じく本人だけが読めるようにする（POSIX のみ。Windows では効かない）。
 */
const FILE_MODE = 0o600;

export type ContentPart =
  | { type: 'text'; text: string }
  /** 添付（04-chat.md）。CLI ではまだ作らないが、読んだものは消さずに残す。 */
  | { type: 'image' | 'file'; [key: string]: unknown };

export type StoredToolCall = {
  id: string;
  name: string;
  argumentsRaw: string;
  origin: 'native' | 'prompted';
};

export type MessageMeta = {
  createdAt: string;
  runId?: string;
  step?: number;
  model?: string;
  endpointId?: string;
  usage?: Usage;
  finishReason?: FinishReason;
  error?: ProviderError;
  durationMs?: number;
  source?: 'akari';
  synthetic?: 'aborted' | 'dropped';
  interrupted?: 'process-exit';
};

export type StoredMessage = {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  reasoning?: string;
  toolCalls?: StoredToolCall[];
  toolCallId?: string;
  toolName?: string;
  ok?: boolean;
  origin?: 'native' | 'prompted';
  meta: MessageMeta;
};

export type RunSummary = {
  runId: string;
  startedAt: string;
  endedAt?: string;
  /** 終わり方。成功した実行だけを数えたい用途（将来のスキル化など）のために残す。 */
  reason?: RunEndReason | 'interrupted';
  model: string;
  endpointId: string;
  /** 実行していたプロセス。落ちた実行を見分けるため。 */
  pid: number;
};

export type ConversationKind = 'chat' | 'agent';

export type ConversationSettings = {
  endpointId?: string;
  model?: string;
  systemPrompt?: string;
};

export type ConversationHeader = {
  schemaVersion: number;
  id: string;
  kind: ConversationKind;
  title: string;
  titleSource: 'auto' | 'manual';
  workspace: string | null;
  projectId: string | null;
  activeLeafId: string | null;
  messageCount: number;
  settings: ConversationSettings;
  runs: RunSummary[];
  /** 文脈の圧縮の記録（16-context.md）。読めない形のものも消さずに残す。 */
  compactions: unknown[];
  createdAt: string;
  updatedAt: string;
};

/** 読んだときに見つかった問題。黙って飛ばさず、呼び出し側が表示する。 */
export type LoadProblem = { conversationId: string; message: string };

type InflightFile = {
  schemaVersion: number;
  pid: number;
  runId: string;
  step: number;
  model?: string;
  endpointId?: string;
  startedAt: string;
  text: string;
  reasoning: string;
};

export type NewMessage = Omit<StoredMessage, 'id' | 'parentId' | 'meta'> & {
  meta?: Omit<MessageMeta, 'createdAt'>;
};

/** 本文の文字列。添付は印だけ出す。 */
export function textOf(content: ContentPart[]): string {
  return content
    .map((p) => (p.type === 'text' ? (p as { text: string }).text : `[添付: ${p.type}]`))
    .join('');
}

export class Conversation {
  readonly header: ConversationHeader;
  /** 新しい版で書かれた会話。読むだけにして、書き込まない（07-data.md）。 */
  readonly readOnly: boolean;
  readonly problems: LoadProblem[];
  private readonly store: ConversationStore;
  private readonly messages = new Map<string, StoredMessage>();
  private inflightStartedAt: string | null = null;

  constructor(
    store: ConversationStore,
    header: ConversationHeader,
    messages: StoredMessage[],
    readOnly: boolean,
    problems: LoadProblem[],
  ) {
    this.store = store;
    this.header = header;
    this.readOnly = readOnly;
    this.problems = problems;
    for (const m of messages) this.messages.set(m.id, m);
  }

  get id(): string {
    return this.header.id;
  }

  get(id: string): StoredMessage | undefined {
    return this.messages.get(id);
  }

  /** すべてのメッセージ（ファイルの順）。 */
  all(): StoredMessage[] {
    return [...this.messages.values()];
  }

  /** 先頭から末端までの道筋。既定は今表示している枝。 */
  thread(leafId: string | null = this.header.activeLeafId): StoredMessage[] {
    const out: StoredMessage[] = [];
    const seen = new Set<string>();
    let cur = leafId ? this.messages.get(leafId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parentId ? this.messages.get(cur.parentId) : undefined;
    }
    return out.reverse();
  }

  /** 今の末端の子として1件足す。ID を渡せばそれを使う（実行エンジンが振った ID）。 */
  async append(input: NewMessage, opts: { id?: string } = {}): Promise<StoredMessage> {
    this.assertWritable();
    const message: StoredMessage = {
      ...input,
      id: opts.id ?? ulid(),
      parentId: this.header.activeLeafId,
      meta: { ...input.meta, createdAt: new Date().toISOString() },
    };
    await appendLine(this.store.messagesPath(this.id), JSON.stringify(message));
    this.messages.set(message.id, message);
    this.header.activeLeafId = message.id;
    this.header.messageCount = this.messages.size;
    if (this.header.titleSource === 'auto' && this.header.title === '' && message.role === 'user') {
      this.header.title = makeTitle(textOf(message.content));
    }
    await this.saveHeader();
    return message;
  }

  /** 圧縮の記録を足す。生のメッセージは変えない（16-context.md）。 */
  async addCompaction(c: Compaction): Promise<void> {
    this.assertWritable();
    this.header.compactions.push(c);
    await this.saveHeader();
  }

  /** いちばん新しい圧縮の記録。形が読めないものは使わない（推測で補わない）。 */
  latestCompaction(): Compaction | null {
    for (let i = this.header.compactions.length - 1; i >= 0; i--) {
      const c = this.header.compactions[i] as Partial<Compaction> | undefined;
      if (
        c &&
        typeof c.id === 'string' &&
        Array.isArray(c.coveredMessageIds) &&
        typeof c.digest === 'object' &&
        c.digest !== null
      ) {
        return c as Compaction;
      }
    }
    return null;
  }

  async updateSettings(patch: ConversationSettings): Promise<void> {
    this.assertWritable();
    this.header.settings = { ...this.header.settings, ...patch };
    await this.saveHeader();
  }

  async setTitle(title: string): Promise<void> {
    this.assertWritable();
    this.header.title = title;
    this.header.titleSource = 'manual';
    await this.saveHeader();
  }

  async runStarted(run: { runId: string; model: string; endpointId: string }): Promise<void> {
    this.assertWritable();
    this.header.runs.push({ ...run, startedAt: new Date().toISOString(), pid: process.pid });
    await this.saveHeader();
  }

  async runEnded(runId: string, reason: RunSummary['reason']): Promise<void> {
    this.assertWritable();
    const run = this.header.runs.find((r) => r.runId === runId);
    if (!run) return;
    run.endedAt = new Date().toISOString();
    run.reason = reason;
    await this.saveHeader();
  }

  /** 生成中の途中経過。落ちたときに、ここまでの応答を残すため（07-data.md）。 */
  async setInflight(
    partial: (InflightPartial & { runId: string; model?: string; endpointId?: string }) | null,
  ): Promise<void> {
    if (this.readOnly) return;
    const file = this.store.inflightPath(this.id);
    if (partial === null) {
      this.inflightStartedAt = null;
      await fs.rm(file, { force: true });
      return;
    }
    this.inflightStartedAt ??= new Date().toISOString();
    const data: InflightFile = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      pid: process.pid,
      startedAt: this.inflightStartedAt,
      ...partial,
    };
    await writeJsonAtomic(file, data, FILE_MODE);
  }

  /** 実行エンジンに渡す記録係。 */
  recorder(opts: { model: string; endpointId: string }): ConversationRecorder {
    return {
      runStarted: (runId) => this.runStarted({ runId, ...opts }),
      runEnded: (runId, reason) => this.runEnded(runId, reason),
      inflight: (runId, partial) =>
        this.setInflight(partial === null ? null : { ...partial, runId, ...opts }),
      record: async (runId, m) => {
        await this.append(fromRecorded(m, runId, opts), { id: m.id });
      },
      compacted: (c) => this.addCompaction(c),
    };
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new AkariError(
        'conversation.readOnly',
        `会話 ${this.id} は新しい版の Akari で保存されているため、書き込めません。`,
        { hint: 'Akari を更新してください。' },
      );
    }
  }

  private async saveHeader(): Promise<void> {
    this.header.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.store.headerPath(this.id), this.header, FILE_MODE);
  }
}

function fromRecorded(
  m: RecordedMessage,
  runId: string,
  opts: { model: string; endpointId: string },
): NewMessage {
  const text = (t: string): ContentPart[] => [{ type: 'text', text: t }];
  if (m.role === 'user') {
    return {
      role: 'user',
      content: text(m.text),
      meta: { runId, ...(m.source ? { source: m.source } : {}) },
    };
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: text(m.text),
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            toolCalls: m.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              argumentsRaw: c.argumentsRaw,
              origin: c.origin,
            })),
          }
        : {}),
      meta: {
        runId,
        step: m.step,
        model: opts.model,
        endpointId: opts.endpointId,
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.finishReason ? { finishReason: m.finishReason } : {}),
        ...(m.error ? { error: m.error } : {}),
        ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
      },
    };
  }
  return {
    role: 'tool',
    content: text(m.content),
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    ok: m.ok,
    origin: m.origin,
    meta: { runId, step: m.step, ...(m.synthetic ? { synthetic: m.synthetic } : {}) },
  };
}

export class ConversationStore {
  readonly root: string;

  constructor(root: string = akariHome()) {
    this.root = root;
  }

  get dir(): string {
    return paths.conversations(this.root);
  }

  headerPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  messagesPath(id: string): string {
    return path.join(this.dir, `${id}.messages.jsonl`);
  }

  inflightPath(id: string): string {
    return path.join(this.dir, `${id}.inflight.json`);
  }

  async create(init: {
    kind: ConversationKind;
    workspace: string | null;
    settings?: ConversationSettings;
  }): Promise<Conversation> {
    const now = new Date().toISOString();
    const header: ConversationHeader = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      id: ulid(),
      kind: init.kind,
      title: '',
      titleSource: 'auto',
      workspace: init.workspace,
      projectId: null,
      activeLeafId: null,
      messageCount: 0,
      settings: init.settings ?? {},
      runs: [],
      compactions: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.headerPath(header.id), header, FILE_MODE);
    return new Conversation(this, header, [], false, []);
  }

  /** 開く。ID は前方一致でよい。途中経過が残っていれば、落ちた応答として回収する。 */
  async open(idOrPrefix: string): Promise<Conversation> {
    const id = await this.resolveId(idOrPrefix);
    const problems: LoadProblem[] = [];
    const read = await readJson<Partial<ConversationHeader>>(this.headerPath(id));
    if (read.status !== 'ok') {
      throw new AkariError('conversation.unreadable', `会話 ${id} の見出しが読めません。`, {
        detail: read.status === 'unreadable' ? read.error.message : 'ファイルがありません',
      });
    }
    const header = normalizeHeader(read.value, id);
    const readOnly = header.schemaVersion > CONVERSATION_SCHEMA_VERSION;
    if (readOnly) {
      problems.push({
        conversationId: id,
        message: `新しい版（schemaVersion ${header.schemaVersion}）で保存された会話です。読むだけにします。`,
      });
    }

    const messages = await readMessages(this.messagesPath(id), id, problems);
    const conv = new Conversation(this, header, messages, readOnly, problems);
    header.messageCount = messages.length;

    if (!readOnly) await this.recover(conv, problems);
    return conv;
  }

  /** 落ちたプロセスの途中経過と、終わりの記録が無い実行を片付ける。 */
  private async recover(conv: Conversation, problems: LoadProblem[]): Promise<void> {
    const inflight = await readJson<InflightFile>(this.inflightPath(conv.id));
    if (inflight.status === 'ok') {
      const f = inflight.value;
      if (f.pid !== process.pid && isAlive(f.pid)) {
        problems.push({
          conversationId: conv.id,
          message: `この会話は別のプロセス（PID ${f.pid}）で実行中です。`,
        });
      } else {
        await conv.append({
          role: 'assistant',
          content: [{ type: 'text', text: f.text ?? '' }],
          ...(f.reasoning ? { reasoning: f.reasoning } : {}),
          meta: {
            runId: f.runId,
            step: f.step,
            ...(f.model ? { model: f.model } : {}),
            ...(f.endpointId ? { endpointId: f.endpointId } : {}),
            finishReason: 'aborted',
            interrupted: 'process-exit',
          },
        });
        await fs.rm(this.inflightPath(conv.id), { force: true });
        problems.push({
          conversationId: conv.id,
          message: 'プロセスが途中で終わった応答を「途中で止まった応答」として残しました。',
        });
      }
    } else if (inflight.status === 'unreadable') {
      problems.push({
        conversationId: conv.id,
        message: `生成中の途中経過のファイルが読めません（${this.inflightPath(conv.id)}）。消さずに残しています。`,
      });
    }

    let changed = false;
    for (const run of conv.header.runs) {
      if (run.endedAt === undefined && run.pid !== process.pid && !isAlive(run.pid)) {
        run.reason = 'interrupted';
        run.endedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(this.headerPath(conv.id), conv.header, FILE_MODE);
  }

  /** ID を確定させる。前方一致が複数に当たれば、候補を示して止める（推測しない）。 */
  async resolveId(idOrPrefix: string): Promise<string> {
    const wanted = idOrPrefix.trim().toUpperCase();
    if (wanted === '' || !/^[0-9A-Z]+$/.test(wanted)) {
      throw new AkariError('conversation.notFound', `会話 "${idOrPrefix}" が見つかりません。`);
    }
    const ids = await this.ids();
    if (ids.includes(wanted)) return wanted;
    const hits = ids.filter((id) => id.startsWith(wanted));
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) {
      throw new AkariError('conversation.notFound', `会話 "${idOrPrefix}" が見つかりません。`, {
        hint: 'akari conversations で一覧を確認できます。',
      });
    }
    throw new AkariError(
      'conversation.ambiguous',
      `"${idOrPrefix}" に当たる会話が ${hits.length} 件あります。もう少し長く指定してください。`,
      { detail: hits.slice(0, 10).join('\n') },
    );
  }

  /** 見出しだけを読んで一覧にする。更新の新しい順。 */
  async list(
    filter: { kind?: ConversationKind; workspace?: string; limit?: number } = {},
  ): Promise<{ items: ConversationHeader[]; problems: LoadProblem[] }> {
    const items: ConversationHeader[] = [];
    const problems: LoadProblem[] = [];
    for (const id of await this.ids()) {
      const read = await readJson<Partial<ConversationHeader>>(this.headerPath(id));
      if (read.status !== 'ok') {
        problems.push({ conversationId: id, message: `会話 ${id} の見出しが読めません。` });
        continue;
      }
      const h = normalizeHeader(read.value, id);
      if (filter.kind && h.kind !== filter.kind) continue;
      if (filter.workspace !== undefined && h.workspace !== filter.workspace) continue;
      items.push(h);
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: filter.limit ? items.slice(0, filter.limit) : items, problems };
  }

  async latest(filter: {
    kind: ConversationKind;
    workspace?: string;
  }): Promise<ConversationHeader | null> {
    return (await this.list({ ...filter, limit: 1 })).items[0] ?? null;
  }

  /**
   * ゴミ箱へ移す。消さない（07-data.md）。30日を過ぎたゴミ箱の会話は、このときに片付ける。
   */
  async trash(idOrPrefix: string): Promise<{ id: string; messageCount: number; purged: number }> {
    const id = await this.resolveId(idOrPrefix);
    const read = await readJson<Partial<ConversationHeader>>(this.headerPath(id));
    const messageCount = read.status === 'ok' ? (read.value.messageCount ?? 0) : 0;
    const dest = path.join(this.trashDir, id);
    await fs.mkdir(dest, { recursive: true });
    for (const file of [this.headerPath(id), this.messagesPath(id), this.inflightPath(id)]) {
      await fs
        .rename(file, path.join(dest, path.basename(file)))
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
    }
    const files = path.join(this.dir, `${id}.files`);
    await fs.rename(files, path.join(dest, `${id}.files`)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await writeJsonAtomic(
      path.join(dest, 'deleted.json'),
      { deletedAt: new Date().toISOString() },
      FILE_MODE,
    );
    const purged = await this.purgeTrash();
    return { id, messageCount, purged };
  }

  /** 30日を過ぎたゴミ箱の会話を消す。消した件数を返す。 */
  async purgeTrash(now: number = Date.now()): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.trashDir);
    } catch {
      return 0;
    }
    let purged = 0;
    for (const name of entries) {
      const marker = await readJson<{ deletedAt?: string }>(
        path.join(this.trashDir, name, 'deleted.json'),
      );
      // 印が読めないものは消さない（いつ消されたか分からないものを消さない）
      if (marker.status !== 'ok' || typeof marker.value.deletedAt !== 'string') continue;
      const at = Date.parse(marker.value.deletedAt);
      if (Number.isNaN(at) || now - at < TRASH_RETENTION_MS) continue;
      await fs.rm(path.join(this.trashDir, name), { recursive: true, force: true });
      purged += 1;
    }
    return purged;
  }

  private get trashDir(): string {
    return path.join(paths.trash(this.root), 'conversations');
  }

  private async ids(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^[0-9A-Z]{26}\.json$/.test(n))
      .map((n) => n.slice(0, -'.json'.length));
  }
}

/** 足りない項目を補う。知らない項目は消さない。 */
function normalizeHeader(raw: Partial<ConversationHeader>, id: string): ConversationHeader {
  return {
    ...raw,
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    id: raw.id ?? id,
    kind: raw.kind === 'chat' ? 'chat' : 'agent',
    title: typeof raw.title === 'string' ? raw.title : '',
    titleSource: raw.titleSource === 'manual' ? 'manual' : 'auto',
    workspace: typeof raw.workspace === 'string' ? raw.workspace : null,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    activeLeafId: typeof raw.activeLeafId === 'string' ? raw.activeLeafId : null,
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
    settings: raw.settings ?? {},
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    compactions: Array.isArray(raw.compactions) ? raw.compactions : [],
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
  };
}

/** メッセージのファイルを読む。読めない行は飛ばし、何行目かを知らせる（行は消さない）。 */
async function readMessages(
  file: string,
  conversationId: string,
  problems: LoadProblem[],
): Promise<StoredMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n');
  const endsWithNewline = raw.endsWith('\n');
  const byId = new Map<string, StoredMessage>();
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const isLast = i === lines.length - 1 && !endsWithNewline;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      problems.push({
        conversationId,
        message: `${i + 1}行目が読めません${isLast ? '（最後の行。書き込みの途中で止まった可能性）' : ''}。ファイルには残しています。`,
      });
      return;
    }
    if (!isMessage(value)) {
      problems.push({
        conversationId,
        message: `${i + 1}行目はメッセージの形をしていません。ファイルには残しています。`,
      });
      return;
    }
    if (byId.has(value.id)) {
      problems.push({
        conversationId,
        message: `${i + 1}行目のメッセージ ${value.id} は前にもあります。後の行を使います。`,
      });
      byId.delete(value.id);
    }
    byId.set(value.id, value);
  });
  return [...byId.values()];
}

function isMessage(v: unknown): v is StoredMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    (m.parentId === null || typeof m.parentId === 'string') &&
    (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
    Array.isArray(m.content) &&
    typeof m.meta === 'object' &&
    m.meta !== null
  );
}

/**
 * 1行を追記する。直前の行が途中で切れていれば、まず改行を入れてから書く
 * （壊れた行に繋げて、正しい行まで読めなくしないため）。07-data.md「追記の規則」
 */
async function appendLine(file: string, line: string): Promise<void> {
  await withFileQueue(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let prefix = '';
    try {
      const st = await fs.stat(file);
      if (st.size > 0) {
        const h = await fs.open(file, 'r');
        try {
          const b = Buffer.alloc(1);
          await h.read(b, 0, 1, st.size - 1);
          if (b[0] !== 0x0a) prefix = '\n';
        } finally {
          await h.close();
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // 1回の書き込みで足す。別プロセスからの追記と1行の中で混ざりにくくするため。
    const buf = Buffer.from(prefix + line + '\n', 'utf8');
    const h = await fs.open(file, 'a', FILE_MODE);
    try {
      let written = 0;
      while (written < buf.length) {
        const r = await h.write(buf, written, buf.length - written);
        written += r.bytesWritten;
      }
      await h.datasync();
    } finally {
      await h.close();
    }
  });
}

function makeTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH)}…` : flat;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 権限が無いだけなら生きている
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

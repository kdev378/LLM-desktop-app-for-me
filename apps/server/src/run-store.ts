import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, type PermissionMode } from '@akari/core';

/**
 * 実行の記録の保存。仕様: docs/spec/12-harness-api.md「記録の保存」
 *
 * <root>/server/runs/<runId>.json           状態（原子的に書き換える）
 * <root>/server/runs/<runId>.events.ndjson  イベント（追記のみ）
 *
 * 再起動しても API から取れるようにするため。会話の中身と変更の記録は、
 * それぞれ会話（04-chat.md）と変更記録（05-agent.md）に残るので、ここには持たない。
 */

export const RUN_SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'done'
  | 'aborted'
  | 'failed'
  | 'max-steps'
  | 'interrupted';

export const FINISHED: ReadonlySet<RunStatus> = new Set([
  'done',
  'aborted',
  'failed',
  'max-steps',
  'interrupted',
]);

export type PendingApproval = {
  callId: string;
  name: string;
  risk: string;
  prompt: string;
  /** 選べる答え（allow / allowSession / deny / abort）と、allowSession の範囲。 */
  decisions: string[];
  scope: string | null;
  since: string;
};

export type RunRecord = {
  schemaVersion: number;
  runId: string;
  prompt: string;
  conversationId: string | null;
  /** 実際に作業したフォルダ（worktree ならその場所）。 */
  workspace: string;
  /** 頼まれた作業フォルダ（worktree の元）。 */
  sourceWorkspace: string;
  worktree: boolean;
  branch: string | null;
  endpointId: string;
  model: string | null;
  permissionMode: PermissionMode;
  maxSteps: number;
  tools: string[] | null;
  labels: Record<string, string>;
  idempotencyKey: string | null;
  status: RunStatus;
  step: number;
  pendingApproval: PendingApproval | null;
  changedFiles: string[];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** RunEvent の run-end の reason（loop / context-full なども含む）。 */
  endReason: string | null;
  error: string | null;
  usage: { prompt: number; completion: number };
  /** 続きとして作った実行（/messages）。 */
  continuedFrom: string | null;
  /** この記録を書いたサーバのプロセス。落ちた実行を見分けるため。 */
  pid: number;
};

export type StoredEvent = { seq: number; ts: string; event: Record<string, unknown> };

export class RunStore {
  readonly dir: string;
  /** 追記の順番を保つための列（実行ごと）。 */
  private writes = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.dir = path.join(root, 'server', 'runs');
  }

  async init(): Promise<void> {
    await ensureDir(this.dir);
  }

  private recordPath(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }

  eventsPath(runId: string): string {
    return path.join(this.dir, `${runId}.events.ndjson`);
  }

  async save(record: RunRecord): Promise<void> {
    await this.queue(record.runId, () =>
      writeJsonAtomic(this.recordPath(record.runId), record, FILE_MODE),
    );
  }

  async loadAll(): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    for (const name of names) {
      if (!/^[0-9A-Z]{26}\.json$/.test(name)) continue;
      const read = await readJson<RunRecord>(path.join(this.dir, name));
      // 読めない記録は飛ばす（壊れた1件で全部を止めない）。新しい版の記録も読まない
      if (read.status !== 'ok') continue;
      if ((read.value.schemaVersion ?? 0) > RUN_SCHEMA_VERSION) continue;
      records.push(read.value);
    }
    return records;
  }

  /** イベントを1件足す。書く順番は呼んだ順。 */
  appendEvent(runId: string, ev: StoredEvent): Promise<void> {
    return this.queue(runId, async () => {
      await fs.appendFile(this.eventsPath(runId), JSON.stringify(ev) + '\n', { mode: FILE_MODE });
    });
  }

  async readEvents(runId: string): Promise<StoredEvent[]> {
    let text: string;
    try {
      text = await fs.readFile(this.eventsPath(runId), 'utf8');
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as StoredEvent);
      } catch {
        // 途中で切れた最後の行（落ちたとき）は飛ばす
      }
    }
    return out;
  }

  /** 保持を超えた古いイベントを落とす（直近 keep 件だけ残す）。 */
  async trimEvents(runId: string, keep: number): Promise<void> {
    await this.queue(runId, async () => {
      const events = await this.readEvents(runId);
      if (events.length <= keep) return;
      const rest =
        events
          .slice(-keep)
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n';
      const tmp = `${this.eventsPath(runId)}.tmp`;
      await fs.writeFile(tmp, rest, { mode: FILE_MODE });
      await fs.rename(tmp, this.eventsPath(runId));
    });
  }

  async dropEvents(runId: string): Promise<void> {
    await this.queue(runId, () => fs.rm(this.eventsPath(runId), { force: true }));
  }

  /** 書き込み待ちをすべて終える（閉じる前に）。 */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
  }

  private queue(runId: string, task: () => Promise<unknown>): Promise<void> {
    const prev = this.writes.get(runId) ?? Promise.resolve();
    const next = prev.then(task).then(() => undefined);
    // 1件の失敗で後ろの書き込みを止めない。失敗そのものは呼び出し側へ返す（黙らない）
    this.writes.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }
}

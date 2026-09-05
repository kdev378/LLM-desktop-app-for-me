import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { paths, ensureDir } from '../util/paths.js';
import { writeJsonAtomic, readJson } from '../util/json.js';

/**
 * 変更記録。ファイルを変える「前」に必ず通す。
 * これが「実行単位で取り消せる」ことの根拠。
 * 仕様: docs/spec/05-agent.md「変更記録と取り消し」
 */

export const JOURNAL_SCHEMA_VERSION = 1;

export type ChangeOp = 'create' | 'modify' | 'delete';

export type FileChange = {
  callId: string;
  op: ChangeOp;
  /** 作業フォルダからの相対パス。 */
  path: string;
  /** バックアップの相対パス（backups/<runId>/ から）。create のときは null。 */
  backupPath: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  at: string;
};

export type JournalFile = {
  schemaVersion: number;
  runId: string;
  workspace: string;
  startedAt: string;
  changes: FileChange[];
};

export type UndoResult = {
  runId: string;
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
};

export async function sha256OfFile(absolute: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absolute);
    return 'sha256:' + createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 1回の実行が行ったファイル変更の記録。 */
export class ChangeJournal {
  readonly runId: string;
  readonly dir: string;
  private readonly file: string;
  private data: JournalFile;
  private seq = 0;

  private constructor(runId: string, dir: string, data: JournalFile) {
    this.runId = runId;
    this.dir = dir;
    this.file = path.join(dir, 'journal.json');
    this.data = data;
    this.seq = data.changes.length;
  }

  static async create(runId: string, workspace: string, root?: string): Promise<ChangeJournal> {
    const dir = path.join(paths.backups(root), runId);
    await ensureDir(dir);
    const data: JournalFile = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      workspace,
      startedAt: new Date().toISOString(),
      changes: [],
    };
    const journal = new ChangeJournal(runId, dir, data);
    await journal.flush();
    return journal;
  }

  static async load(runId: string, root?: string): Promise<ChangeJournal | null> {
    const dir = path.join(paths.backups(root), runId);
    const res = await readJson<JournalFile>(path.join(dir, 'journal.json'));
    if (res.status !== 'ok') return null;
    const data = res.value;
    if (data.schemaVersion > JOURNAL_SCHEMA_VERSION) return null; // 未来の形式は触らない
    return new ChangeJournal(runId, dir, data);
  }

  /** 新しい順に実行IDを並べる。 */
  static async listRuns(root?: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(paths.backups(root));
      return entries
        .filter((e) => /^[0-9A-Z]{26}$/.test(e))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  get changes(): readonly FileChange[] {
    return this.data.changes;
  }

  get workspace(): string {
    return this.data.workspace;
  }

  get startedAt(): string {
    return this.data.startedAt;
  }

  /**
   * ファイルを変える前に呼ぶ。中身をバックアップし、記録の下書きを返す。
   * 実際の書き込みは呼び出し側が行い、そのあと commit() する。
   */
  async before(
    callId: string,
    op: ChangeOp,
    relative: string,
    absolute: string,
  ): Promise<PendingChange> {
    const beforeSha256 = await sha256OfFile(absolute);
    let backupPath: string | null = null;

    if (beforeSha256 !== null) {
      this.seq += 1;
      const name = `${String(this.seq).padStart(3, '0')}-${path.basename(relative).slice(0, 80)}`;
      backupPath = name;
      await fs.copyFile(absolute, path.join(this.dir, name));
    } else if (op !== 'create') {
      // 存在しないのに modify/delete と言われた。記録の整合を保つため create として扱う。
      op = 'create';
    }
    return { callId, op, relative, absolute, backupPath, beforeSha256 };
  }

  /** 書き込み後に呼ぶ。結果のハッシュを取り、記録を確定して fsync する。 */
  async commit(pending: PendingChange): Promise<FileChange> {
    const afterSha256 = await sha256OfFile(pending.absolute);
    const change: FileChange = {
      callId: pending.callId,
      op: pending.op,
      path: pending.relative,
      backupPath: pending.backupPath,
      beforeSha256: pending.beforeSha256,
      afterSha256,
      at: new Date().toISOString(),
    };
    this.data.changes.push(change);
    await this.flush();
    return change;
  }

  /** 書き込みに失敗したときに呼ぶ。取ったバックアップを捨て、記録に残さない。 */
  async discard(pending: PendingChange): Promise<void> {
    if (pending.backupPath) {
      await fs.rm(path.join(this.dir, pending.backupPath), { force: true }).catch(() => undefined);
    }
  }

  /** 変更したファイルの一覧（重複なし、新しい順）。 */
  changedFiles(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = this.data.changes.length - 1; i >= 0; i--) {
      const c = this.data.changes[i]!;
      if (!seen.has(c.path)) {
        seen.add(c.path);
        out.push(c.path);
      }
    }
    return out;
  }

  private async flush(): Promise<void> {
    await writeJsonAtomic(this.file, this.data);
  }

  /**
   * 記録を逆順に適用して元へ戻す。
   * 実行後に手で変更されたファイルは、上書きせずに飛ばして報告する。
   */
  async undo(): Promise<UndoResult> {
    const restored: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    // ファイルごとにまとめる。同じファイルを何度変えていても、戻すべきは
    // 「最初のバックアップ」。最後のバックアップは途中の状態でしかない。
    const byPath = new Map<string, FileChange[]>();
    for (const c of this.data.changes) {
      const list = byPath.get(c.path);
      if (list) list.push(c);
      else byPath.set(c.path, [c]);
    }

    for (const [relative, list] of [...byPath.entries()].reverse()) {
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const absolute = path.join(this.data.workspace, relative);
      const current = await sha256OfFile(absolute);

      // 実行が最後に残した状態と違うなら、実行後に誰かが触っている。上書きしない。
      if (current !== last.afterSha256) {
        skipped.push({
          path: relative,
          reason: current === null ? '実行後に削除されています' : '実行後に手で変更されています',
        });
        continue;
      }

      try {
        if (first.backupPath === null) {
          // この実行が作ったファイル → 消す
          await fs.rm(absolute, { force: true });
        } else {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.copyFile(path.join(this.dir, first.backupPath), absolute);
        }
        restored.push(relative);
      } catch (err) {
        skipped.push({ path: relative, reason: `戻せませんでした: ${(err as Error).message}` });
      }
    }
    return { runId: this.runId, restored, skipped };
  }
}

export type PendingChange = {
  callId: string;
  op: ChangeOp;
  relative: string;
  absolute: string;
  backupPath: string | null;
  beforeSha256: string | null;
};

/**
 * 保持期間と合計サイズを超えたバックアップを消す。
 * 消した実行IDを返す。呼び出し側が利用者へ見せる。
 */
export async function pruneBackups(
  opts: { retainDays?: number; maxTotalBytes?: number; root?: string } = {},
): Promise<string[]> {
  const retainDays = opts.retainDays ?? 30;
  const maxTotalBytes = opts.maxTotalBytes ?? 1024 * 1024 * 1024;
  const base = paths.backups(opts.root);
  const runs = await ChangeJournal.listRuns(opts.root);
  const removed: string[] = [];
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;

  const sized: Array<{ id: string; bytes: number; at: number }> = [];
  for (const id of runs) {
    const dir = path.join(base, id);
    const st = await fs.stat(dir).catch(() => null);
    if (!st) continue;
    let bytes = 0;
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const s = await fs.stat(path.join(dir, name)).catch(() => null);
      if (s) bytes += s.size;
    }
    sized.push({ id, bytes, at: st.mtimeMs });
  }

  // 古いものから消す
  let total = sized.reduce((n, s) => n + s.bytes, 0);
  for (const s of [...sized].sort((a, b) => a.at - b.at)) {
    const tooOld = s.at < cutoff;
    const tooBig = total > maxTotalBytes;
    if (!tooOld && !tooBig) continue;
    await fs.rm(path.join(base, s.id), { recursive: true, force: true }).catch(() => undefined);
    total -= s.bytes;
    removed.push(s.id);
  }
  return removed;
}

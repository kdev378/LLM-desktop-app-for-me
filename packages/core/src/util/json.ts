import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 同一パスへの書き込みを直列化する。プロセス内の複数箇所が同じファイルへ
 * 同時に書いても、後勝ちで壊れた中身にならないようにする。
 */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * 一時ファイルへ書いて fsync してから rename する。
 * 途中でプロセスが落ちても、旧版か新版のどちらかが残る（docs/spec/07-data.md）。
 */
export async function writeFileAtomic(file: string, text: string, mode?: number): Promise<void> {
  return serialize(path.resolve(file), async () => {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
    );
    try {
      const handle = await fs.open(tmp, 'w', mode ?? 0o666);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);
      if (mode !== undefined) await fs.chmod(file, mode).catch(() => undefined);
      if (process.platform !== 'win32') {
        const dh = await fs.open(dir, 'r').catch(() => null);
        if (dh) {
          await dh.sync().catch(() => undefined);
          await dh.close();
        }
      }
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });
}

export async function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', mode);
}

export type ReadJsonResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'unreadable'; error: Error; raw?: string };

/** JSON を読む。壊れていても例外を投げず、呼び出し側が扱いを決められるようにする。 */
export async function readJson<T = unknown>(file: string): Promise<ReadJsonResult<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: e };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T };
  } catch (err) {
    return { status: 'unreadable', error: err as Error, raw };
  }
}

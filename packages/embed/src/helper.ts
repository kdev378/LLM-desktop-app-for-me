import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadEngine, type Engine } from './engine.js';
import { modelDir, readInstalledModel } from './model.js';
import {
  alive,
  helperFiles,
  readHelperInfo,
  runDir,
  type HelperIdentity,
  type HelperInfo,
} from './protocol.js';

/**
 * 埋め込みの係（段階1: 同じ PC の中で1つを共有する）。仕様: docs/spec/14-memory.md
 *
 * - 係は1つだけ（目印のファイル）。先にいる係が生きていれば、自分は何もせずに終わる
 * - 127.0.0.1 の空いているポートで待ち、居場所とトークンを embed.json（権限600）に書く
 * - 使われない時間が idleMs 続いたら終わる（モデルを手放してメモリを空ける）
 */

export type HelperOptions = {
  dataRoot: string;
  modelId: string;
  idleMs: number;
  runtime?: 'auto' | 'node' | 'wasm';
};

const MAX_BODY = 8 * 1024 * 1024;
const MAX_INPUTS = 256;
/** 目印がこれより古く、持ち主が係として答えなければ、取り直す（モデルの読み込みはこれより短い）。 */
const LOCK_STALE_MS = 2 * 60 * 1000;

export async function runHelper(opts: HelperOptions): Promise<'served' | 'another-helper'> {
  const files = helperFiles(opts.dataRoot);
  await fs.mkdir(runDir(opts.dataRoot), { recursive: true, mode: 0o700 });
  const log = (line: string) =>
    fs
      .appendFile(files.log, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
      .catch(() => undefined);

  if (!(await takeLock(opts.dataRoot, files.lock))) return 'another-helper';
  let engine: Engine | null = null;
  let server: http.Server | null = null;
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  let stopping = false;

  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    await log(`止めます（${why}）`);
    server?.close();
    // 自分の書いたものだけを消す（後から来た係のものは消さない）
    const info = await readOwn(files.info);
    if (info?.pid === process.pid) await fs.rm(files.info, { force: true });
    const lock = await readOwn(files.lock);
    if (lock?.pid === process.pid) await fs.rm(files.lock, { force: true });
    await engine?.close().catch(() => undefined);
    done();
  };

  try {
    const model = await readInstalledModel(opts.dataRoot, opts.modelId);
    if (!model) throw new Error(`内蔵のモデル ${opts.modelId} が取り込まれていません`);
    engine = await loadEngine({
      modelDir: modelDir(opts.dataRoot, opts.modelId),
      runtime: opts.runtime ?? 'auto',
      pooling: model.pooling,
      maxLength: model.maxLength,
      padTokenId: model.padTokenId,
    });
    // 古い目印を2つの係が同時に取り直すと、両方が持ったつもりになりうる。読み込みの後で、まだ自分のものか確かめる
    if ((await readOwn(files.lock))?.pid !== process.pid) {
      await stop('ほかの係が目印を取った');
      return 'another-helper';
    }
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
    const identity: HelperIdentity = {
      model: model.id,
      fileSha256: model.fileSha256,
      runtime: engine.runtime,
      ...(engine.fallbackReason ? { fallbackReason: engine.fallbackReason } : {}),
      pid: process.pid,
    };

    let idle: NodeJS.Timeout | undefined;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => void stop('使われない時間が続いた'), opts.idleMs);
    };

    const eng = engine;
    server = http.createServer((req, res) => {
      touch();
      const port = (server!.address() as AddressInfo).port;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // この PC の中からだけ。宛先とトークンを確かめる（DNS の書き換えで外のページから叩かせない）
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
        return send(403, { error: 'host' });
      const given = createHash('sha256')
        .update(req.headers.authorization ?? '')
        .digest();
      if (!timingSafeEqual(given, tokenHash)) return send(401, { error: 'unauthorized' });

      if (req.method === 'GET' && req.url === '/akari/embedding-identity')
        return send(200, identity);
      if (req.method === 'GET' && req.url === '/health')
        return send(200, { ok: true, pid: process.pid });
      if (req.method !== 'POST' || req.url !== '/v1/embeddings')
        return send(404, { error: 'not found' });

      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        void (async () => {
          let input: string[];
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown };
            input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
          } catch {
            return send(400, { error: 'JSON ではありません' });
          }
          if (input.length > MAX_INPUTS) return send(413, { error: `一度に ${MAX_INPUTS} 件まで` });
          try {
            const vecs = await eng.embed(input);
            touch();
            send(200, {
              object: 'list',
              model: identity.model,
              data: vecs.map((v, index) => ({
                object: 'embedding',
                index,
                embedding: Array.from(v),
              })),
            });
          } catch (err) {
            await log(`埋め込みに失敗: ${(err as Error).message}`);
            send(500, { error: (err as Error).message });
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const info: HelperInfo = {
      pid: process.pid,
      port: (server.address() as AddressInfo).port,
      token,
      fileSha256: model.fileSha256,
      model: model.id,
      runtime: engine.runtime,
      startedAt: new Date().toISOString(),
    };
    // 書きかけを読ませないよう、別名で書いてから差し替える
    const tmp = path.join(runDir(opts.dataRoot), `.embed.json.${process.pid}`);
    await fs.writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
    await fs.rename(tmp, files.info);
    touch();
    await log(
      `待ち受けます（${engine.runtime}${engine.fallbackReason ? `、${engine.fallbackReason}` : ''}、ポート ${info.port}）`,
    );
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
  } catch (err) {
    await log(`起動できませんでした: ${(err as Error).message}`);
    await stop('起動の失敗');
    throw err;
  }
  await finished;
  return 'served';
}

/** 目印を取る。持ち主が生きていれば false。持ち主が消えていれば取り直す。 */
async function takeLock(dataRoot: string, file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // 中身を書いた別のファイルを、目印の名前へリンクする（既にあれば失敗する）。書きかけの目印を読ませない
    const tmp = `${file}.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
      mode: 0o600,
    });
    try {
      await fs.link(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readOwn(file);
      if (holder && holder.pid !== process.pid && alive(holder.pid)) {
        // 持ち主が本当に係なら譲る。読み込み中（まだ居場所を書いていない）かもしれないので、新しい目印も譲る。
        // 古い目印で誰も答えなければ、落ちた係の pid を別のプロセスが使っているとみなして取り直す
        if (await answers(dataRoot, holder.pid)) return false;
        const age = Date.now() - Date.parse(holder.at ?? '');
        if (!(age > LOCK_STALE_MS)) return false;
      }
      await fs.rm(file, { force: true });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  return false;
}

/** その pid の係が、居場所に書いたトークンで答えるか。 */
async function answers(dataRoot: string, pid: number): Promise<boolean> {
  const info = await readHelperInfo(dataRoot);
  if (!info || info.pid !== pid) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok && ((await res.json()) as { pid?: number }).pid === pid;
  } catch {
    return false;
  }
}

async function readOwn(file: string): Promise<{ pid: number; at?: string } | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number; at?: string };
  } catch {
    return null;
  }
}

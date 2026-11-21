import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CANARY_MIN,
  builtinModelId,
  alive,
  helperFiles,
  readHelperInfo,
  readInstalledModel,
  type HelperIdentity,
  type HelperInfo,
  type InstalledModel,
} from '@akari/embed';
import { EmbeddingError } from '../provider/embeddings.js';
import type { Embedder, EmbeddingIdentity, EmbedKind } from './embedder.js';

/**
 * 内蔵の埋め込み。仕様: docs/spec/14-memory.md「埋め込みの係（段階1）」「同じとみなす条件」
 *
 * モデルは自分では動かさず、埋め込みの係（@akari/embed の helper）に頼む。係がいなければ裏で起こす。
 * 係につないだら、まず「同じモデルファイルか（指紋）」と「見本の文で元のモデルと同じ答えが出るか」を確かめる。
 */

const BATCH = 16;

export type BuiltinOptions = {
  idleMs: number;
  modelId?: string;
  /** 係が起きて待ち受けるまで待つ時間。モデルの読み込みに数秒〜十数秒かかる。 */
  startTimeoutMs?: number;
  runtime?: 'auto' | 'node' | 'wasm';
};

export class BuiltinEmbedder implements Embedder {
  private model: InstalledModel | null = null;
  private conn: HelperInfo | null = null;
  private readonly modelId: string;

  constructor(
    private readonly dataRoot: string,
    private readonly opts: BuiltinOptions,
  ) {
    this.modelId = opts.modelId ?? builtinModelId();
  }

  /** 取り込んだモデルが無ければ null（呼び出し側が案内を出す）。 */
  static async installed(
    dataRoot: string,
    modelId = builtinModelId(),
  ): Promise<InstalledModel | null> {
    return readInstalledModel(dataRoot, modelId);
  }

  async identity(): Promise<EmbeddingIdentity> {
    const m = await this.loadModel();
    return {
      source: 'builtin',
      model: m.id,
      revision: m.revision,
      fileSha256: m.fileSha256,
      contract: m.contract,
      dims: m.dims,
      maxTokens: m.maxLength,
    };
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const m = await this.loadModel();
    const prefix = kind === 'query' ? m.prefixes.query : m.prefixes.document;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => prefix + t);
      out.push(...(await this.request(batch, signal)));
    }
    return out;
  }

  /** 係へ送る。係が使われずに終わっていたら（つながらなければ）、1度だけ起こし直して送り直す。 */
  private async request(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    for (let attempt = 0; ; attempt++) {
      const info = await this.connect(signal);
      try {
        return await this.post(info, input, signal);
      } catch (err) {
        if (signal?.aborted || attempt > 0 || !(err instanceof HelperGone)) throw err;
        this.conn = null;
      }
    }
  }

  private async loadModel(): Promise<InstalledModel> {
    this.model ??= await readInstalledModel(this.dataRoot, this.modelId);
    if (!this.model) {
      throw new EmbeddingError(
        `内蔵の埋め込みモデル（${this.modelId}）が入っていません。akari index model import <書き出したフォルダ> で取り込んでください。`,
        null,
      );
    }
    return this.model;
  }

  /** 係につなぐ。いなければ起こす。違うモデルを動かしている係は止めて起こし直す。 */
  private async connect(signal?: AbortSignal): Promise<HelperInfo> {
    if (this.conn && alive(this.conn.pid)) return this.conn;
    const m = await this.loadModel();
    let info = await readHelperInfo(this.dataRoot);
    if (info && alive(info.pid) && info.fileSha256 !== m.fileSha256) {
      // 取り込み直す前のモデルを動かしている係。止めて、新しいモデルで起こし直す。
      // 止めるのは、トークンで話せて自分の pid を名乗った相手だけ（落ちた係の pid を別のプロセスが使っていることがある）
      if (await this.ping(info)) {
        try {
          process.kill(info.pid, 'SIGTERM');
        } catch {
          /* もういない */
        }
        await waitUntil(() => !alive(info!.pid), 5000);
      }
      info = null;
    }
    if (!info || !alive(info.pid) || !(await this.ping(info))) {
      info = await this.start(signal);
    }
    await this.verify(info, m, signal);
    this.conn = info;
    return info;
  }

  private async start(signal?: AbortSignal): Promise<HelperInfo> {
    const m = await this.loadModel();
    const entry = fileURLToPath(import.meta.resolve('@akari/embed/helper'));
    const child = spawn(
      process.execPath,
      [
        entry,
        '--root',
        this.dataRoot,
        '--model',
        this.modelId,
        '--idle-ms',
        String(this.opts.idleMs),
        '--runtime',
        this.opts.runtime ?? 'auto',
      ],
      // 呼んだ Akari が終わっても、係は使われなくなるまで残る（ほかの Akari が使う）
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    const until = Date.now() + (this.opts.startTimeoutMs ?? 60_000);
    while (Date.now() < until) {
      if (signal?.aborted) throw new EmbeddingError('中断しました。', null);
      const info = await readHelperInfo(this.dataRoot);
      // 同時に起こした別の係が勝っていても、同じモデルならそれを使う
      if (info && alive(info.pid) && info.fileSha256 === m.fileSha256 && (await this.ping(info)))
        return info;
      await new Promise((r) => setTimeout(r, 100));
    }
    const log = await fs.readFile(helperFiles(this.dataRoot).log, 'utf8').catch(() => '');
    const last = log.trim().split('\n').slice(-3).join(' / ');
    throw new EmbeddingError(
      `埋め込みの係が起動しませんでした${last ? `（${last}）` : ''}。`,
      null,
    );
  }

  private async ping(info: HelperInfo): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/akari/embedding-identity`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const id = (await res.json()) as HelperIdentity;
      return id.pid === info.pid && id.fileSha256 === info.fileSha256;
    } catch {
      return false;
    }
  }

  /** 見本の文で、元のモデル（Python）と同じ答えが出るか。外れたら、その係は使わない。 */
  private async verify(info: HelperInfo, m: InstalledModel, signal?: AbortSignal): Promise<void> {
    if (this.conn?.pid === info.pid) return;
    const got = await this.post(
      info,
      m.canary.map((c) => c.text),
      signal,
    );
    const cos = got.map((v, i) => dot(v, m.canary[i]!.vector));
    const min = Math.min(...cos);
    if (!(min >= CANARY_MIN)) {
      throw new EmbeddingError(
        `埋め込みの係の答えが、元のモデルの見本と合いません（近さ ${min.toFixed(4)}、下限 ${CANARY_MIN}）。` +
          '使いません。akari index model import で取り込み直してください。',
        null,
      );
    }
  }

  private async post(
    info: HelperInfo,
    input: string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${info.port}/v1/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new EmbeddingError('中断しました。', null);
      throw new HelperGone((err as Error).message);
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ index: number; embedding: number[] }>;
      error?: string;
    };
    if (!res.ok || !body.data) {
      throw new EmbeddingError(
        `埋め込みの係が失敗しました（HTTP ${res.status}）: ${body.error ?? '不明'}`,
        null,
      );
    }
    return [...body.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding));
  }
}

class HelperGone extends Error {}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

async function waitUntil(cond: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

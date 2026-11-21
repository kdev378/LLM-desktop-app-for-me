import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 埋め込みの係との取り決め。仕様: docs/spec/14-memory.md「埋め込みの係（段階1）」
 *
 * 係は 127.0.0.1 の空いているポートで待ち、<root>/run/embed.json（権限600）に居場所とトークンを書く。
 * 話し方は OpenAI 互換の POST /v1/embeddings と、何者かを返す GET /akari/embedding-identity。
 * 係は1つだけ（<root>/run/embed.lock）。使われない時間が続いたら自分で終わる。
 */

export type HelperInfo = {
  pid: number;
  port: number;
  token: string;
  /** 動かしているモデルの指紋（取り込んだものと同じか、つなぐ側が確かめる）。 */
  fileSha256: string;
  model: string;
  runtime: 'node' | 'wasm';
  startedAt: string;
};

export type HelperIdentity = {
  model: string;
  fileSha256: string;
  runtime: 'node' | 'wasm';
  /** onnxruntime-node が使えず WebAssembly にした理由（あれば）。 */
  fallbackReason?: string;
  pid: number;
};

export function runDir(dataRoot: string): string {
  return path.join(dataRoot, 'run');
}

export const helperFiles = (dataRoot: string) => ({
  info: path.join(runDir(dataRoot), 'embed.json'),
  lock: path.join(runDir(dataRoot), 'embed.lock'),
  log: path.join(runDir(dataRoot), 'embed.log'),
});

export async function readHelperInfo(dataRoot: string): Promise<HelperInfo | null> {
  try {
    return JSON.parse(await fs.readFile(helperFiles(dataRoot).info, 'utf8')) as HelperInfo;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

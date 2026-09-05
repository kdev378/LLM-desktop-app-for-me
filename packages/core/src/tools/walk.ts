import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * ファイル走査と glob の照合。
 * glob / grep / list_dir で**同じ除外規則**を使うためにここへ集める。
 * Node 22 の fs.glob は使わない（Node 20 に無く、除外の意味も揃えたいため）。
 */

/** 既定で走査しないディレクトリ。大きくて、ほぼ読む価値がない。 */
export const DEFAULT_IGNORE_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.gradle',
  '.idea',
  '.pytest_cache',
];

export type WalkOptions = {
  /** 走査を打ち切る最大件数。既定 20000。 */
  maxEntries?: number;
  /** 深さの上限。0 は root 直下のみ。既定は無制限。 */
  maxDepth?: number;
  ignoreDirs?: string[];
  /** ディレクトリも返すか。既定 false（ファイルのみ）。 */
  includeDirs?: boolean;
  signal?: AbortSignal;
};

export type WalkEntry = { relative: string; absolute: string; isDir: boolean; size: number };

export type WalkResult = { entries: WalkEntry[]; truncated: boolean };

/**
 * root 以下を幅優先で走査する。シンボリックリンクは**辿らない**。
 * 辿ると作業フォルダの外へ出るうえ、循環しうる。
 */
export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const maxEntries = opts.maxEntries ?? 20000;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const ignore = new Set(opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const entries: WalkEntry[] = [];
  let truncated = false;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    if (opts.signal?.aborted) break;
    const { dir, depth } = queue.shift()!;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 読めないディレクトリは飛ばす。全体を止めない
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return { entries, truncated };
      }
      const absolute = path.join(dir, d.name);
      const relative = path.relative(root, absolute);

      if (d.isSymbolicLink()) continue; // 辿らない
      if (d.isDirectory()) {
        if (ignore.has(d.name)) continue;
        if (opts.includeDirs) entries.push({ relative, absolute, isDir: true, size: 0 });
        if (depth < maxDepth) queue.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (!d.isFile()) continue;
      let size = 0;
      try {
        size = (await fs.stat(absolute)).size;
      } catch {
        continue;
      }
      entries.push({ relative, absolute, isDir: false, size });
    }
  }
  return { entries, truncated };
}

/**
 * glob を正規表現へ変換する。対応する記法:
 *   `**` 任意の階層 / `*` 区切りを跨がない任意 / `?` 1文字 / `{a,b}` / `[abc]`
 * 正規表現として意味のある文字はすべて退避する。
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  let braceDepth = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        // `**/` は「0階層以上」。`a/**/b` が `a/b` にも当たるように。
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]*(?:/|$))*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      re += '(?:';
      i += 1;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1;
      re += ')';
      i += 1;
      continue;
    }
    if (ch === ',' && braceDepth > 0) {
      re += '|';
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

/** パス区切りを `/` に揃える。Windows でも glob は `/` で書けるようにする。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function matchGlob(pattern: string, relativePath: string): boolean {
  return globToRegExp(pattern).test(toPosix(relativePath));
}

/** 先頭 8KB に NUL があればバイナリとみなす。 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 上限を超えた出力の中央を省く。先頭60%・末尾40%を残す。
 * 何文字省いたかを必ず書く（黙って切らない）。
 */
export function truncateMiddle(
  text: string,
  limitBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limitBytes) return { text, truncated: false };
  const keep = Math.floor(limitBytes * 0.95);
  const head = Math.floor(keep * 0.6);
  const tail = keep - head;
  const chars = [...text];
  // 文字数での近似。多バイト文字でも上限をわずかに超えない側へ倒す
  const ratio = chars.length / bytes;
  const headChars = Math.max(0, Math.floor(head * ratio));
  const tailChars = Math.max(0, Math.floor(tail * ratio));
  const omitted = chars.length - headChars - tailChars;
  if (omitted <= 0) return { text, truncated: false };
  return {
    text:
      chars.slice(0, headChars).join('') +
      `\n…（中央の ${omitted} 文字を省略）…\n` +
      chars.slice(chars.length - tailChars).join(''),
    truncated: true,
  };
}

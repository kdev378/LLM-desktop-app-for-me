import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_IGNORE_DIRS, matchGlob, toPosix, walk } from '../tools/walk.js';
import { isSecretName } from '../tools/workspace.js';

/**
 * 索引にするファイルを選ぶ。仕様: docs/spec/14-memory.md「何を索引にするか」
 *
 * - git のリポジトリなら、git に一覧を出させる（.gitignore を自前で解釈しない）
 * - 秘密のファイルは入れない（検索結果として中身がモデルへ渡る抜け道になるため）
 */

const run = promisify(execFile);

/** 中身を読む価値が低いもの。 */
const SKIP_FILE_GLOBS = [
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
];

export type IndexTarget = { relative: string; absolute: string; size: number; mtimeMs: number };

export type TargetList = {
  files: IndexTarget[];
  source: 'git' | 'walk';
  skipped: { secret: number; large: number; ignored: number };
  /** 走査が上限で打ち切られた。 */
  truncated: boolean;
};

const MAX_FILES = 50_000;

export async function listIndexTargets(
  root: string,
  opts: { maxFileBytes: number; signal?: AbortSignal },
): Promise<TargetList> {
  const skipped = { secret: 0, large: 0, ignored: 0 };
  const ignore = await readAkariIgnore(root);
  const fromGit = await gitFiles(root);
  let relatives: string[];
  let truncated = false;
  if (fromGit) {
    relatives = fromGit;
  } else {
    const r = await walk(root, {
      maxEntries: MAX_FILES,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    relatives = r.entries.filter((e) => !e.isDir).map((e) => e.relative);
    truncated = r.truncated;
  }
  if (relatives.length > MAX_FILES) {
    relatives = relatives.slice(0, MAX_FILES);
    truncated = true;
  }

  const files: IndexTarget[] = [];
  for (const raw of relatives) {
    if (opts.signal?.aborted) break;
    const relative = toPosix(raw);
    const parts = relative.split('/');
    if (parts.slice(0, -1).some((p) => DEFAULT_IGNORE_DIRS.includes(p))) {
      skipped.ignored++;
      continue;
    }
    if (isSecretName(parts[parts.length - 1]!)) {
      skipped.secret++;
      continue;
    }
    if (
      SKIP_FILE_GLOBS.some((g) => matchGlob(g, relative)) ||
      ignore.some((g) => matches(g, relative))
    ) {
      skipped.ignored++;
      continue;
    }
    const absolute = path.join(root, relative);
    let st;
    try {
      // シンボリックリンクは辿らない（作業フォルダの外へ出うる）
      st = await fs.lstat(absolute);
    } catch {
      continue; // git には載っているが消えたファイル
    }
    if (!st.isFile()) continue;
    if (st.size > opts.maxFileBytes) {
      skipped.large++;
      continue;
    }
    files.push({ relative, absolute, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
  }
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return { files, source: fromGit ? 'git' : 'walk', skipped, truncated };
}

/** git のリポジトリなら、追跡中と、無視されていない未追跡のファイル。git でなければ null。 */
async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    );
    return [...new Set(stdout.split('\0').filter(Boolean))];
  } catch {
    return null;
  }
}

/** .akariignore（1行1パターン。# で始まる行は注釈）。 */
async function readAkariIgnore(root: string): Promise<string[]> {
  try {
    const text = await fs.readFile(path.join(root, '.akariignore'), 'utf8');
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** `/` を含まないパターンはどの階層の名前にも当てる。末尾の `/` はディレクトリ。 */
function matches(pattern: string, relative: string): boolean {
  let p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) p = `${p}**`;
  if (!p.includes('/')) return matchGlob(`**/${p}`, relative) || matchGlob(`**/${p}/**`, relative);
  return matchGlob(p.replace(/^\//, ''), relative);
}

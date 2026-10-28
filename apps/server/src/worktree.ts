import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ApiError } from './http.js';

/**
 * 作業の隔離（git worktree）。仕様: docs/spec/12-harness-api.md「作業の隔離」
 *
 * Akari は commit も merge も push もしない。worktree を作り、実行が終わっても消さない
 * （中身が成果物だから）。消すのは DELETE で明示されたときだけ。
 */

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: 60_000, maxBuffer: 10_000_000 });
  return stdout.trim();
}

export function worktreesDir(root: string): string {
  return path.join(root, 'worktrees');
}

/** ブランチ名として安全か（git check-ref-format に任せる）。 */
async function isValidBranch(cwd: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['check-ref-format', '--branch', branch], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(opts: {
  root: string;
  repo: string;
  runId: string;
  branch?: string;
  base?: string;
}): Promise<{ path: string; branch: string; base: string }> {
  let top: string;
  try {
    top = await git(opts.repo, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new ApiError(400, 'not_git_repo', `${opts.repo} は git のリポジトリではありません。`);
  }
  const branch = opts.branch ?? `akari/${opts.runId}`;
  // 「-」で始まる名前は git にオプションとして読まれる。名前として受け付けない
  for (const [what, v] of [
    ['branch', branch],
    ['base', opts.base],
  ] as const) {
    if (v !== undefined && v.startsWith('-')) {
      throw new ApiError(400, 'invalid_branch', `${what} に「-」で始まる名前は使えません: ${v}`);
    }
  }
  if (!(await isValidBranch(top, branch))) {
    throw new ApiError(400, 'invalid_branch', `ブランチ名として使えません: ${branch}`);
  }
  try {
    await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    throw new ApiError(
      409,
      'branch_exists',
      `ブランチ ${branch} は既にあります。別の名前を指定してください。`,
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // 無い（＝作ってよい）
  }
  let base: string;
  try {
    base = await git(top, ['rev-parse', opts.base ?? 'HEAD']);
  } catch {
    throw new ApiError(
      400,
      'invalid_base',
      `元にするコミット ${opts.base ?? 'HEAD'} が見つかりません（コミットが1つも無いかもしれません）。`,
    );
  }
  const dir = path.join(worktreesDir(opts.root), opts.runId);
  await fs.mkdir(worktreesDir(opts.root), { recursive: true });
  try {
    await git(top, ['worktree', 'add', '-b', branch, dir, base]);
  } catch (err) {
    throw new ApiError(
      500,
      'worktree_failed',
      'git worktree を作れませんでした。',
      (err as Error).message,
    );
  }
  return { path: await fs.realpath(dir), branch, base };
}

/** 消す。変更が残っていても消す（DELETE は明示の指示）。ブランチは消さない（成果物）。 */
export async function removeWorktree(root: string, runId: string, repo: string): Promise<boolean> {
  const dir = path.join(worktreesDir(root), runId);
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  try {
    await git(repo, ['worktree', 'remove', '--force', dir]);
  } catch {
    // リポジトリ側が消えているなど。フォルダだけでも消す
    await fs.rm(dir, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']).catch(() => '');
  }
  return true;
}

export async function listWorktrees(root: string): Promise<Array<{ runId: string; path: string }>> {
  let names: string[];
  try {
    names = await fs.readdir(worktreesDir(root));
  } catch {
    return [];
  }
  return names
    .filter((n) => /^[0-9A-Z]{26}$/.test(n))
    .map((runId) => ({ runId, path: path.join(worktreesDir(root), runId) }));
}

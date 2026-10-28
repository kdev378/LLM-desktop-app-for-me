import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SandboxSettings } from '../config/schema.js';
import { isSecretName } from './workspace.js';
import { walk } from './walk.js';

/**
 * コマンドの閉じ込め。仕様: docs/spec/05-agent.md「コマンドの閉じ込め」
 *
 * 道具は使えるまま、書き込みと秘密を塞ぐ。
 * macOS は Seatbelt（sandbox-exec）、Linux は bubblewrap。閉じ込められない環境では、
 * そう返す（閉じ込めているふりをしない）。
 */

const run = promisify(execFile);

export type SandboxKind = 'seatbelt' | 'bubblewrap';

export type SandboxStatus = { active: true; kind: SandboxKind } | { active: false; reason: string };

/** 1回のコマンドに効かせる範囲。 */
export type SandboxPolicy = {
  workspace: string;
  akariRoot: string;
  settings: SandboxSettings;
  /** 秘密でも読んでよいと許されたファイル（絶対パス。request_secret_access）。 */
  grantedSecrets: string[];
  /** そのほかに書き込みを許す場所（worktree の元の .git など）。 */
  extraWrite: string[];
};

export function describeSandbox(s: SandboxStatus): string {
  if (!s.active) return `閉じ込めなし（${s.reason}）`;
  return s.kind === 'seatbelt' ? '閉じ込めあり（macOS Seatbelt）' : '閉じ込めあり（bubblewrap）';
}

// ---------------- 使えるか ----------------

let detected: Promise<SandboxStatus> | null = null;

/** 使えるかを1度だけ確かめる（プロセスの中で覚えておく）。 */
export function detectSandbox(): Promise<SandboxStatus> {
  detected ??= probe();
  return detected;
}

/** テスト用。確かめ直す。 */
export function resetSandboxDetection(): void {
  detected = null;
}

async function probe(): Promise<SandboxStatus> {
  if (process.platform === 'darwin') {
    try {
      await run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
        timeout: 10_000,
      });
      return { active: true, kind: 'seatbelt' };
    } catch (err) {
      return { active: false, reason: `sandbox-exec が動きません: ${firstLine(err)}` };
    }
  }
  if (process.platform === 'linux') {
    const bwrap = await which('bwrap');
    if (!bwrap) {
      return {
        active: false,
        reason: 'bubblewrap が入っていません（例: sudo apt install bubblewrap）',
      };
    }
    try {
      await run(
        bwrap,
        [
          '--ro-bind',
          '/',
          '/',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--unshare-pid',
          '--die-with-parent',
          '--new-session',
          '--',
          '/bin/true',
        ],
        { timeout: 10_000 },
      );
      return { active: true, kind: 'bubblewrap' };
    } catch (err) {
      return { active: false, reason: `bubblewrap が動きません: ${firstLine(err)}` };
    }
  }
  return { active: false, reason: `${process.platform} ではまだ閉じ込められません` };
}

async function which(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      await fs.access(p, fs.constants.X_OK);
      return p;
    } catch {
      /* 次へ */
    }
  }
  return null;
}

// ---------------- 範囲 ----------------

/** 既定で書き込みを許す、道具のキャッシュ（ホームからの相対）。 */
const CACHE_DIRS = [
  '.npm',
  '.cache',
  '.cargo/registry',
  '.cargo/git',
  '.rustup/tmp',
  '.gradle',
  '.m2',
  'go/pkg',
  '.pnpm-store',
  '.local/share/pnpm',
  '.yarn',
  '.bun',
  '.deno',
  'Library/Caches',
  'Library/pnpm',
];

/** 読ませない秘密の場所（ホームからの相対）。ディレクトリ。 */
const SECRET_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.config/gh',
  '.config/gcloud',
  '.password-store',
  'Library/Keychains',
];

/** 読ませない秘密の場所（ホームからの相対）。ファイル。 */
const SECRET_FILES = ['.netrc', '.git-credentials', '.docker/config.json'];

function home(): string {
  return os.homedir();
}

function expandHome(p: string): string {
  return p === '~' ? home() : p.startsWith('~/') ? path.join(home(), p.slice(2)) : path.resolve(p);
}

/** あるものだけを、実体のパスで返す（macOS の /tmp → /private/tmp など）。 */
async function existing(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(await fs.realpath(p));
    } catch {
      /* 無い */
    }
  }
  return [...new Set(out)];
}

async function writablePaths(policy: SandboxPolicy): Promise<string[]> {
  const tmp = await existing([os.tmpdir(), '/tmp', '/var/tmp']);
  // macOS の一時フォルダ（/var/folders/<x>/<y>/T）は、隣のキャッシュ（…/C）ごと許す
  const tmpParents = process.platform === 'darwin' ? tmp.map((t) => path.dirname(t)) : [];
  return existing([
    policy.workspace,
    ...tmp,
    ...tmpParents,
    ...CACHE_DIRS.map((d) => path.join(home(), d)),
    ...policy.settings.allowWrite.map(expandHome),
    ...policy.extraWrite,
  ]);
}

async function secretPaths(policy: SandboxPolicy): Promise<{ dirs: string[]; files: string[] }> {
  const dirs = await existing([...SECRET_DIRS.map((d) => path.join(home(), d)), policy.akariRoot]);
  const files = await existing(SECRET_FILES.map((f) => path.join(home(), f)));
  return { dirs, files };
}

/**
 * 作業フォルダの中の秘密のファイル（コマンドを始める時点）。許されたものは除く。
 * 探しきれなかったら complete: false（黙って一部だけ隠したことにしない）。
 */
export async function workspaceSecrets(
  policy: SandboxPolicy,
): Promise<{ files: string[]; complete: boolean }> {
  if (policy.settings.allowWorkspaceSecrets) return { files: [], complete: true };
  const granted = new Set(policy.grantedSecrets);
  const { entries, truncated } = await walk(policy.workspace, { maxEntries: 20_000 });
  const files = entries
    .filter((e) => !e.isDir && isSecretName(path.basename(e.relative)))
    .map((e) => e.absolute)
    .filter((a) => !granted.has(a));
  return { files, complete: !truncated };
}

/** 作業フォルダに秘密のファイルがあるか（request_secret_access を渡すかどうか）。 */
export async function hasWorkspaceSecrets(workspace: string): Promise<boolean> {
  const { entries } = await walk(workspace, { maxEntries: 20_000 });
  return entries.some((e) => !e.isDir && isSecretName(path.basename(e.relative)));
}

// ---------------- 組み立て ----------------

export type SandboxedCommand = {
  file: string;
  args: string[];
  /** 作業フォルダが大きく、秘密のファイルを探しきれなかった（bubblewrap のとき）。 */
  secretsIncomplete?: boolean;
};

/** コマンドを閉じ込めの中で動かす形にする。 */
export async function sandboxCommand(
  status: Extract<SandboxStatus, { active: true }>,
  policy: SandboxPolicy,
  command: string,
  cwd: string,
): Promise<SandboxedCommand> {
  if (status.kind === 'seatbelt') {
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-p', await seatbeltProfile(policy), '/bin/sh', '-c', command],
    };
  }
  const { args, secretsIncomplete } = await bubblewrapPlan(policy, cwd);
  return {
    file: 'bwrap',
    args: [...args, '/bin/sh', '-c', command],
    ...(secretsIncomplete ? { secretsIncomplete } : {}),
  };
}

/**
 * Seatbelt の規則。後に書いた規則ほど強い（同じ操作に複数当たれば、後ろが勝つ）前提で並べる。
 * 書き込み: 全部塞いでから、許す場所を開ける。読み取り: 秘密を塞いでから、許されたものを開ける。
 */
export async function seatbeltProfile(policy: SandboxPolicy): Promise<string> {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const writable = await writablePaths(policy);
  const { dirs, files } = await secretPaths(policy);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((w) => `(subpath ${q(w)})`).join(' ')} ` +
      '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") ' +
      '(regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  ];
  const reads = [...dirs.map((d) => `(subpath ${q(d)})`), ...files.map((f) => `(literal ${q(f)})`)];
  if (reads.length > 0) lines.push(`(deny file-read* ${reads.join(' ')})`);
  if (!policy.settings.allowWorkspaceSecrets) {
    lines.push(`(deny file-read* (regex #"${workspaceSecretRegex(policy.workspace)}"))`);
  }
  // 作業フォルダが Akari のデータの中（worktree）なら、そこだけは読み書きできるように戻す
  if (isInsideOrSame(policy.akariRoot, policy.workspace)) {
    lines.push(`(allow file-read* (subpath ${q(policy.workspace)}))`);
    if (!policy.settings.allowWorkspaceSecrets) {
      lines.push(`(deny file-read* (regex #"${workspaceSecretRegex(policy.workspace)}"))`);
    }
  }
  if (policy.grantedSecrets.length > 0) {
    lines.push(
      `(allow file-read* ${policy.grantedSecrets.map((g) => `(literal ${q(g)})`).join(' ')})`,
    );
  }
  if (!policy.settings.network) {
    // 外への通信だけを塞ぐ（同じ PC の中の UNIX ソケットは残す）
    lines.push('(deny network-outbound (remote ip "*:*"))');
  }
  return lines.join('\n');
}

/** ファイルの道具の秘密の規則（workspace.ts の SECRET_FILE_PATTERNS）を、パス全体の正規表現にする。 */
function workspaceSecretRegex(workspace: string): string {
  const esc = workspace.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const name =
    '(\\.?env(\\.[^/]+)?|[^/]*\\.env(\\.[^/]+)?|credentials\\.json|\\.npmrc|\\.netrc|' +
    'id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?|[^/]*\\.(pem|key|p12|pfx))';
  return `^${esc}/(.*/)?${name}$`;
}

/**
 * bubblewrap の引数。重ねる順番に意味がある（後から重ねたものが見える）:
 * 1. 全体を読み取り専用で見せる
 * 2. 秘密の場所を空のフォルダで隠す
 * 3. 書いてよい場所を書けるように重ねる（作業フォルダが隠した場所の中にあっても、そこだけ見える）
 * 4. 書いてよい場所の中にある秘密の場所を、もう一度隠す（3 で見えてしまうため）。
 *    ただし作業フォルダを中に含む場所（worktree のときの Akari のデータ）は隠し直さない
 * 5. 秘密のファイルを空のファイルで隠す（作業フォルダの中のものも）
 */
export async function bubblewrapArgs(policy: SandboxPolicy, cwd: string): Promise<string[]> {
  return (await bubblewrapPlan(policy, cwd)).args;
}

async function bubblewrapPlan(
  policy: SandboxPolicy,
  cwd: string,
): Promise<{ args: string[]; secretsIncomplete: boolean }> {
  const writable = await writablePaths(policy);
  const { dirs, files } = await secretPaths(policy);
  const { files: inWorkspace, complete } = await workspaceSecrets(policy);
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  for (const d of dirs) args.push('--tmpfs', d);
  for (const w of writable) args.push('--bind', w, w);
  for (const d of dirs) {
    const reExposed = writable.some((w) => isInsideOrSame(w, d) && w !== d);
    if (reExposed && !isInsideOrSame(d, policy.workspace)) args.push('--tmpfs', d);
  }
  for (const f of [...files, ...inWorkspace]) args.push('--ro-bind', '/dev/null', f);
  if (!policy.settings.network) args.push('--unshare-net');
  args.push('--unshare-pid', '--die-with-parent', '--new-session', '--chdir', cwd, '--');
  return { args, secretsIncomplete: !complete };
}

/** 塞がれて失敗したらしいか（モデルへの添え書きに使う）。 */
export function looksBlocked(stderr: string): boolean {
  return /Operation not permitted|Read-only file system|Permission denied|deny\(1\)/i.test(stderr);
}

function isInsideOrSame(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (
    (e.stderr || e.message || String(err))
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  );
}

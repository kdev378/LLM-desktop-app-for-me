import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { akariHome } from '../util/paths.js';

/**
 * 作業フォルダの境界。ツールが触ってよい範囲を決める唯一の場所。
 * 仕様: docs/spec/05-agent.md「パス境界」
 *
 * ここが破れると、作業フォルダの外のファイルが壊れる。
 * 実装で迷ったら、必ず厳しい側（拒否）へ倒す。
 */

export type AccessMode = 'read' | 'write';

export type ResolveOk = {
  ok: true;
  /** シンボリックリンクを解決した実体の絶対パス。実際に触るのはこれ。 */
  absolute: string;
  /** 作業フォルダからの相対パス。表示と記録に使う。 */
  relative: string;
  /** 実体が既に存在するか。 */
  exists: boolean;
};

export type ResolveDenied = {
  ok: false;
  reason: 'outside' | 'denied' | 'invalid';
  /** モデルへ返す文言。理由が分かれば別の手を採れる。 */
  message: string;
};

export type ResolveResult = ResolveOk | ResolveDenied;

/** 読み取りを禁じるファイル名。鍵や資格情報が入りやすいもの。 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\.)env(\..+)?$/i, // .env, .env.local, env
  /^credentials\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx)$/i,
];

/** 書き込みを禁じるディレクトリ（作業フォルダからの相対）。 */
const NO_WRITE_DIRS = ['.git'];

export class Workspace {
  /** 利用者が指定した作業フォルダ（シンボリックリンク解決済み）。 */
  readonly root: string;
  private readonly akariRoot: string;

  private constructor(root: string, akariRoot: string) {
    this.root = root;
    this.akariRoot = akariRoot;
  }

  /**
   * 作業フォルダを開く。範囲が広すぎる場所は開かせない（docs/spec/06-work-and-code.md）。
   */
  static async open(dir: string, akariHomeDir = akariHome()): Promise<Workspace> {
    const requested = path.resolve(dir);
    let real: string;
    try {
      real = await fs.realpath(requested);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') throw new Error(`作業フォルダがありません: ${requested}`);
      throw new Error(`作業フォルダを開けません: ${requested} (${e.code ?? e.message})`);
    }
    const st = await fs.stat(real);
    if (!st.isDirectory())
      throw new Error(`作業フォルダがディレクトリではありません: ${requested}`);

    const akariReal = await fs.realpath(akariHomeDir).catch(() => path.resolve(akariHomeDir));

    const forbidden = await forbiddenRoots(akariReal);
    for (const [bad, why] of forbidden) {
      if (samePath(real, bad)) {
        throw new Error(`${why}を作業フォルダにはできません: ${requested}`);
      }
    }
    // Akari のデータディレクトリの中も不可
    if (isInside(akariReal, real)) {
      throw new Error(`Akari のデータの中を作業フォルダにはできません: ${requested}`);
    }
    return new Workspace(real, akariReal);
  }

  /** テスト用。実在チェックを飛ばして組み立てる。 */
  static forTesting(root: string, akariHomeDir: string): Workspace {
    return new Workspace(path.resolve(root), path.resolve(akariHomeDir));
  }

  /**
   * ツールの引数のパスを、実際に触ってよい絶対パスへ解決する。
   *
   * 1. 作業フォルダ基準で絶対化する
   * 2. 存在する最も深い祖先まで realpath する（シンボリックリンクを解く）
   * 3. 結果が作業フォルダの配下かを、区切り境界で比較する
   * 4. 禁止規則に当たらないか見る
   */
  async resolve(input: string, mode: AccessMode): Promise<ResolveResult> {
    if (typeof input !== 'string' || input.trim() === '') {
      return { ok: false, reason: 'invalid', message: 'パスが空です。' };
    }
    if (input.includes('\0')) {
      return { ok: false, reason: 'invalid', message: 'パスに使えない文字が含まれています。' };
    }

    const absolute = path.resolve(this.root, input);
    const resolved = await realpathBestEffort(absolute);

    if (!isInsideOrSame(this.root, resolved.real)) {
      return {
        ok: false,
        reason: 'outside',
        message: `作業フォルダの外です: ${input}（作業フォルダ: ${this.root}）。この外は読み書きできません。`,
      };
    }

    // Akari 自身のデータは、作業フォルダの中に置かれていても触らせない
    if (isInsideOrSame(this.akariRoot, resolved.real)) {
      return {
        ok: false,
        reason: 'denied',
        message: 'Akari 自身の設定・データは触れません。',
      };
    }

    const relative = path.relative(this.root, resolved.real);
    const denied = this.checkRules(relative, mode);
    if (denied) return denied;

    return {
      ok: true,
      absolute: resolved.real,
      relative: relative === '' ? '.' : relative,
      exists: resolved.exists,
    };
  }

  private checkRules(relative: string, mode: AccessMode): ResolveDenied | null {
    const segments = relative.split(path.sep).filter((s) => s !== '');
    const base = segments[segments.length - 1] ?? '';

    if (mode === 'write') {
      for (const dir of NO_WRITE_DIRS) {
        if (segments[0] === dir) {
          return {
            ok: false,
            reason: 'denied',
            message: `${dir}/ の中は書き換えられません。git の操作は run_command で行ってください。`,
          };
        }
      }
    }

    if (mode === 'read') {
      for (const re of SECRET_FILE_PATTERNS) {
        if (re.test(base)) {
          return {
            ok: false,
            reason: 'denied',
            message: `${base} は鍵や資格情報が入りうるため読めません。`,
          };
        }
      }
    }
    return null;
  }
}

// ---- 補助 ----

/**
 * 存在しないパスでも realpath 相当を得る。
 * 存在する最も深い祖先を realpath し、残りの区間をつなぐ。
 * write_file が新しいファイルを作る場合に必要。
 */
async function realpathBestEffort(absolute: string): Promise<{ real: string; exists: boolean }> {
  try {
    return { real: await fs.realpath(absolute), exists: true };
  } catch {
    /* 下で祖先を辿る */
  }
  const parts: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      // 根まで来た。解決できないのでそのまま返す
      return { real: path.resolve(absolute), exists: false };
    }
    parts.unshift(path.basename(current));
    current = parent;
    try {
      const realParent = await fs.realpath(current);
      return { real: path.join(realParent, ...parts), exists: false };
    } catch {
      /* さらに上へ */
    }
  }
}

/** 大文字小文字を区別しないOSでの比較のため。 */
function normalizeForCompare(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * child が parent の配下か。文字列の前方一致ではなく、区切りを境界として比較する。
 * これをしないと /work と /workspace を取り違える。
 */
export function isInside(parent: string, child: string): boolean {
  const p = normalizeForCompare(parent);
  const c = normalizeForCompare(child);
  if (p === c) return false;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

export function isInsideOrSame(parent: string, child: string): boolean {
  return samePath(parent, child) || isInside(parent, child);
}

/** 作業フォルダにしてはいけない場所。範囲が広すぎて取り消しが現実的でない。 */
async function forbiddenRoots(akariReal: string): Promise<Array<[string, string]>> {
  const home = os.homedir();
  const list: Array<[string, string]> = [
    [path.parse(process.cwd()).root, 'ドライブの根'],
    [home, 'ホームディレクトリそのもの'],
    [akariReal, 'Akari のデータディレクトリ'],
  ];
  if (process.platform !== 'win32') {
    list.push(
      ['/', 'ルート'],
      ['/etc', 'システム設定'],
      ['/usr', 'システム領域'],
      ['/var', 'システム領域'],
    );
  }
  const out: Array<[string, string]> = [];
  for (const [p, why] of list) {
    out.push([await fs.realpath(p).catch(() => p), why]);
  }
  return out;
}

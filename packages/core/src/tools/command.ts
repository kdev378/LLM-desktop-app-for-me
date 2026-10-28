import { spawn } from 'node:child_process';
import { looksBlocked, sandboxCommand, type SandboxedCommand } from './sandbox.js';
import { z } from 'zod';
import { truncateMiddle } from './walk.js';
import {
  denied,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type ToolPreview,
} from './types.js';

/**
 * コマンド実行。仕様: docs/spec/05-agent.md
 *
 * 書き込みより危険度が高い扱いにする。ここからファイルを書けるため、
 * 書き込みだけ自動許可にすると承認を迂回できてしまう。
 */

const args = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
});

/** 拒否リストに当たるか。当たったら承認画面すら出さずに拒否する。 */
export function matchesDenied(command: string, deniedCommands: string[]): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();
  for (const pattern of deniedCommands) {
    const p = pattern.replace(/\s+/g, ' ').trim();
    if (p !== '' && normalized.includes(p)) return pattern;
  }
  return null;
}

/** 削除をするコマンド。`run_command` で消したものは undo で戻せないので、full でも聞く。 */
const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put']);
/** 削除をする git のサブコマンド。 */
const DELETE_GIT_SUBCOMMANDS = new Set(['clean', 'rm']);
/** 前に付いても本体ではないもの。飛ばして次の語を見る。 */
const PREFIX_WORDS = new Set(['sudo', 'env', 'xargs', 'command', 'exec', 'nohup', 'time', 'nice']);

/**
 * 削除系のコマンドを含むか。含めば見つけた名前（例 "rm"、"git clean"、"find -delete"）を返す。
 * 仕様: docs/spec/05-agent.md「削除系のコマンド」
 *
 * 名前で見つける仕組みで、完全な防壁ではない（`python -c` などは見抜けない）。
 * 取りこぼしより誤検知のほうが害が小さい（承認が1回増えるだけ）ので、広めに拾う。
 */
export function findDeleteCommand(command: string): string | null {
  // つなぎ記号で区切って、各部分の先頭の語を見る
  const segments = command.split(/&&|\|\||;|\||\n|\$\(|`|\(|\)/);
  for (const segment of segments) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    let i = 0;
    let prefixed = false;
    // 前置きの語（sudo など）と、変数代入（A=1）を飛ばす
    while (i < words.length) {
      const w = words[i]!;
      if (PREFIX_WORDS.has(basename(w))) {
        prefixed = true;
        i += 1;
        while (i < words.length && words[i]!.startsWith('-')) i += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i += 1;
        continue;
      }
      break;
    }
    const head = words[i] === undefined ? '' : basename(stripQuotes(words[i]!));
    if (DELETE_COMMANDS.has(head)) return head;
    // sudo -u root rm … のように、前置きの語のオプションが値を取ると本体の位置が分からない。
    // 前置きがあったときは、残りの語に削除コマンドの名前があれば拾う（誤検知は承認が1回増えるだけ）。
    if (prefixed) {
      const found = words.slice(i).find((w) => DELETE_COMMANDS.has(basename(stripQuotes(w))));
      if (found) return basename(stripQuotes(found));
    }
    if (head === 'git') {
      // 値を取る全体オプション（git -C dir rm …）は、値ごと飛ばす
      let j = i + 1;
      while (j < words.length && words[j]!.startsWith('-')) {
        j += GIT_VALUE_OPTIONS.has(words[j]!) ? 2 : 1;
      }
      const sub = words[j];
      if (sub && DELETE_GIT_SUBCOMMANDS.has(sub)) return `git ${sub}`;
    }
    if (head === 'find') {
      if (words.includes('-delete')) return 'find -delete';
      // find … -exec rm {} \;
      if (words.some((w) => DELETE_COMMANDS.has(basename(stripQuotes(w))))) return 'find -exec rm';
    }
    // bash -c "rm …" は、引用の中身を同じ規則で見る
    if (SHELLS.has(head)) {
      const c = words.indexOf('-c', i + 1);
      if (c >= 0) {
        const inner = findDeleteCommand(stripQuotes(words.slice(c + 1).join(' ')));
        if (inner) return inner;
      }
    }
  }
  return null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** 値を取る git の全体オプション（`--git-dir=x` のような = 付きは1語なので含めない）。 */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function basename(word: string): string {
  const i = word.lastIndexOf('/');
  return i >= 0 ? word.slice(i + 1) : word;
}

function stripQuotes(word: string): string {
  return word.replace(/^['"]+|['"]+$/g, '');
}

/**
 * 「同じものとみなす」範囲。承認の allow-session はこの単位で効く。
 * `npm test` を許可しても `npm publish` は再度聞く。
 */
export function commandScope(command: string): string {
  const parts = command.trim().split(/\s+/);
  const head = parts[0] ?? '';
  const sub = parts[1] ?? '';
  // 引数がオプションでなければ、サブコマンドまでを範囲に含める
  if (sub !== '' && !sub.startsWith('-')) return `${head} ${sub}`;
  return head;
}

/** 鍵が入りうる環境変数を子プロセスへ渡さない。 */
function safeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AKARI_')) continue;
    // 環境変数で渡す git の設定（GIT_CONFIG_COUNT / KEY_n / VALUE_n）は組で外す。
    // 値に認証のヘッダが入りうるうえ、KEY_n だけを外すと git が全部のコマンドで失敗する
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) continue;
    if (/(_|^)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)(_|$)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export const runCommandTool: ToolSpec = {
  name: 'run_command',
  description:
    'シェルでコマンドを実行する。作業フォルダの中でのみ動く。標準出力・標準エラー・終了コードが返る。',
  risk: 'execute',
  // cwd は作業フォルダの中に限る。承認より前に検査する。
  pathsOf: (raw) => {
    const cwd = (raw as { cwd?: unknown } | null)?.cwd;
    return typeof cwd === 'string' && cwd !== '' && cwd !== '.'
      ? [{ value: cwd, mode: 'read' as const }]
      : [];
  },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '実行するコマンド全文' },
      cwd: { type: 'string', description: '作業フォルダからの相対パス。既定は作業フォルダ直下' },
      timeoutMs: { type: 'integer', description: '上限時間（ミリ秒）' },
    },
    required: ['command'],
  },
  async preview(raw, ctx): Promise<ToolPreview | undefined> {
    const a = args.safeParse(raw);
    if (!a.success) return undefined;
    const cwd = await resolveCwd(a.data.cwd, ctx);
    return {
      kind: 'command',
      command: a.data.command,
      cwd: typeof cwd === 'string' ? cwd : '(解決できません)',
    };
  },
  async run(raw, ctx) {
    const parsed = args.safeParse(raw);
    if (!parsed.success) {
      return denied(
        `引数が正しくありません: ${parsed.error.issues.map((i) => i.message).join(' / ')}`,
        'invalid',
      );
    }
    const a = parsed.data;

    const hit = matchesDenied(a.command, ctx.limits.deniedCommands);
    if (hit !== null) {
      return denied(`このコマンドは実行できません（拒否リストの "${hit}" に一致）。`, 'denied');
    }

    const cwd = await resolveCwd(a.cwd, ctx);
    if (typeof cwd !== 'string') return cwd;

    // 閉じ込め（05-agent.md「コマンドの閉じ込め」）
    let launch: SandboxedCommand | null = null;
    const sb = ctx.sandbox;
    if (sb && !sb.status.active && sb.settings.mode === 'required') {
      return denied(
        `コマンドを閉じ込められないため実行しません（agent.sandbox.mode が required）。${sb.status.reason}`,
        'denied',
      );
    }
    if (sb?.status.active) {
      launch = await sandboxCommand(
        sb.status,
        {
          workspace: ctx.workspace.root,
          akariRoot: ctx.workspace.dataRoot,
          settings: sb.settings,
          grantedSecrets: ctx.workspace.grantedSecrets,
          extraWrite: sb.extraWrite,
        },
        a.command,
        cwd,
      );
    }

    const timeoutMs = a.timeoutMs ?? ctx.limits.commandTimeoutMs;
    const started = Date.now();
    const result = await execute(a.command, cwd, timeoutMs, ctx, launch);
    const durationMs = Date.now() - started;

    const parts: string[] = [];
    if (result.stdout) parts.push(`--- 標準出力 ---\n${result.stdout}`);
    if (result.stderr) parts.push(`--- 標準エラー ---\n${result.stderr}`);
    if (parts.length === 0) parts.push('(出力なし)');
    const body = truncateMiddle(parts.join('\n\n'), ctx.limits.toolOutputLimitBytes);

    if (result.timedOut) {
      return {
        ok: false,
        errorKind: 'timeout',
        summary: `タイムアウト（${Math.round(timeoutMs / 1000)}秒）`,
        // 打ち切っただけで、失敗したとは限らない。伸ばす手があることを伝える。
        content:
          `コマンドが ${Math.round(timeoutMs / 1000)} 秒を超えたため終了させました。\n` +
          `時間のかかるコマンドなら、timeoutMs を大きくして呼び直せます` +
          `（例: {"command": ${JSON.stringify(a.command)}, "timeoutMs": ${Math.min(timeoutMs * 4, 1_800_000)}}）。\n\n` +
          body.text,
      };
    }
    if (result.aborted) {
      return {
        ok: false,
        errorKind: 'failed',
        summary: '中断されました',
        content: `実行が中断されました。\n\n${body.text}`,
      };
    }

    const ok = result.code === 0;
    // 塞がれて失敗したらしいときは、そう添える。モデルが別の手で何度も試して迷わないため
    const note =
      !ok && launch && looksBlocked(result.stderr)
        ? '\n\n[akari] このコマンドは閉じ込めの中で動いています。作業フォルダ・一時フォルダ・道具のキャッシュの外への書き込みと、' +
          '秘密の場所（~/.ssh など）や作業フォルダの中の秘密のファイル（.env など）の読み取りは塞いでいます。' +
          '作業フォルダの中の秘密のファイルが要るなら、request_secret_access で理由を添えて利用者に許可を求めてください。'
        : '';
    const incomplete = launch?.secretsIncomplete
      ? '\n\n[akari] 作業フォルダが大きいため、秘密のファイル（.env など）を全部は探しきれず、一部はコマンドから読めた可能性があります。'
      : '';
    return {
      ok,
      errorKind: ok ? undefined : 'failed',
      summary: `終了コード ${result.code}（${(durationMs / 1000).toFixed(1)}秒）`,
      content: `終了コード: ${result.code}\n所要時間: ${(durationMs / 1000).toFixed(1)}秒\n\n${body.text}${note}${incomplete}`,
    };
  },
};

async function resolveCwd(rel: string | undefined, ctx: ToolContext): Promise<string | ToolResult> {
  if (rel === undefined || rel === '' || rel === '.') return ctx.workspace.root;
  const r = await ctx.workspace.resolve(rel, 'read');
  if (!r.ok) return denied(r.message);
  if (!r.exists) return denied(`ディレクトリがありません: ${rel}`, 'not-found');
  return r.absolute;
}

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
  launch: SandboxedCommand | null,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const [file, argv] = launch
      ? [launch.file, launch.args]
      : isWin
        ? ['cmd', ['/c', command]]
        : ['/bin/sh', ['-c', command]];
    const child = spawn(file, argv, {
      cwd,
      env: safeEnv(),
      // POSIX では新しいプロセスグループにする。子孫ごと確実に止めるため。
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const limit = ctx.limits.toolOutputLimitBytes * 2; // 収集の上限。表示の切り詰めとは別
    const append = (which: 'stdout' | 'stderr', text: string) => {
      if (which === 'stdout') {
        if (stdout.length < limit) stdout += text;
      } else if (stderr.length < limit) stderr += text;
      ctx.onOutput?.(which, text);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => append('stdout', d));
    child.stderr?.on('data', (d: string) => append('stderr', d));

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (isWin) {
          child.kill(signal);
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, signal); // プロセスグループごと
        }
      } catch {
        /* すでに終わっている */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000).unref?.();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };

    child.on('error', (err) => {
      stderr += `\n起動できませんでした: ${err.message}`;
      finish(127);
    });
    child.on('close', (code, signal) => {
      finish(code ?? (signal ? 143 : 1));
    });
  });
}

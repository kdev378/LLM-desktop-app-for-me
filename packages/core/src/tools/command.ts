import { spawn } from 'node:child_process';
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

    const timeoutMs = a.timeoutMs ?? ctx.limits.commandTimeoutMs;
    const started = Date.now();
    const result = await execute(a.command, cwd, timeoutMs, ctx);
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
        content: `コマンドが ${Math.round(timeoutMs / 1000)} 秒を超えたため終了させました。\n\n${body.text}`,
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
    return {
      ok,
      errorKind: ok ? undefined : 'failed',
      summary: `終了コード ${result.code}（${(durationMs / 1000).toFixed(1)}秒）`,
      content: `終了コード: ${result.code}\n所要時間: ${(durationMs / 1000).toFixed(1)}秒\n\n${body.text}`,
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
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd' : '/bin/sh', isWin ? ['/c', command] : ['-c', command], {
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

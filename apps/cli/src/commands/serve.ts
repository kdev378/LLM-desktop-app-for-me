import path from 'node:path';
import { Workspace, describeSandbox, detectSandbox, tildify } from '@akari/core';
import { ApiError, startServer } from '@akari/server';
import { createContext, type GlobalOptions } from '../context.js';
import { ExitError, EXIT } from '../exit.js';
import { c, out } from '../term.js';
import { VERSION } from '../version.js';

/**
 * akari serve — ハーネスAPI。仕様: docs/spec/12-harness-api.md
 * 127.0.0.1 にだけ束ねる。Ctrl+C で、走っている実行を止めてから閉じる（変更の記録は残る）。
 */

export type ServeOptions = GlobalOptions & {
  port?: string;
  workspace?: string;
  printToken?: boolean;
};

export async function serveCommand(opts: ServeOptions): Promise<void> {
  const ctx = await createContext(opts);
  const port = opts.port !== undefined ? Number(opts.port) : ctx.config.server.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ExitError(EXIT.usage, '--port は 1024〜65535 の整数で指定してください。');
  }
  let defaultWorkspace: string | null = null;
  if (opts.workspace) {
    try {
      defaultWorkspace = (await Workspace.open(path.resolve(opts.workspace))).root;
    } catch (err) {
      throw new ExitError(EXIT.usage, (err as Error).message);
    }
  }

  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer({
      root: ctx.root,
      port,
      version: VERSION,
      logger: ctx.logger,
      defaultWorkspace,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'port_in_use') {
      throw new ExitError(EXIT.usage, err.message, {
        hint: '--port で別のポートを指定できます。',
      });
    }
    throw err;
  }

  // 人向けの案内は標準エラーへ。標準出力にはトークンだけ（--print-token）
  const info = (s: string) => process.stderr.write(`${s}\n`);
  info(c.bold(`Akari ハーネスAPI ${VERSION}`));
  info(`  ${handle.url}  （この PC の中からだけ）`);
  info(c.dim(`  トークン: ${tildify(path.join(ctx.root, 'server.json'))} の token`));
  info(
    c.dim(
      `  既定の作業フォルダ: ${defaultWorkspace ? tildify(defaultWorkspace) : 'なし（実行ごとに workspace を指定）'}`,
    ),
  );
  const sandbox =
    ctx.config.agent.sandbox.mode === 'off'
      ? ({ active: false, reason: 'agent.sandbox.mode が off' } as const)
      : await detectSandbox();
  info(c.dim(`  コマンド: ${describeSandbox(sandbox)}`));
  const full = !ctx.config.server.allowFullPermission
    ? 'いいえ（既定）'
    : sandbox.active
      ? c.yellow('はい（server.allowFullPermission）')
      : 'いいえ（閉じ込められないため。server.allowFullPermission は入っています）';
  info(c.dim(`  HTTP から full で頼めるか: ${full}`));
  info(c.dim('  止めるには Ctrl+C'));
  if (opts.printToken) out(handle.token);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(EXIT.interrupted);
      stopping = true;
      info(c.yellow('\n止めています…（走っている実行を中断します。もう一度 Ctrl+C で即座に終了）'));
      void handle.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  info('止めました。');
}

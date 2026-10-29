import readlinePromises from 'node:readline/promises';
import path from 'node:path';
import {
  MemoryConfigError,
  Workspace,
  createEmbedder,
  createProvider,
  describeIdentity,
  hasLeftovers,
  indexDir,
  isLikelyChatModel,
  listIndexTargets,
  loadIndex,
  readCurrentMeta,
  removeIndex,
  resolveEndpoint,
  sameIdentity,
  searchIndex,
  tildify,
  updateIndex,
  type Embedder,
  type IndexProgress,
} from '@akari/core';
import { createContext, type CliContext, type GlobalOptions } from '../context.js';
import { c, out, isInteractive, formatDuration } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/**
 * akari index — 作業フォルダの索引（記憶）。仕様: docs/spec/14-memory.md「CLI」
 */

export type IndexOptions = GlobalOptions & { cwd?: string; yes?: boolean };

export async function indexBuild(opts: IndexOptions, mode: 'build' | 'update'): Promise<void> {
  const ctx = await createContext(opts);
  const workspace = await openWorkspace(opts);
  const dir = indexDir(ctx.root, workspace.root);
  const embedder = await embedderOrExit(ctx);
  const exists = (await readCurrentMeta(dir)) !== null;

  // 外部の接続先へは、作業フォルダの中身が送られる。初めて作るときは量を見せて確かめる
  if (mode === 'build' || !exists) {
    const ep = await embeddingEndpoint(ctx);
    if (ep?.isExternal) {
      const targets = await listIndexTargets(workspace.root, {
        maxFileBytes: ctx.config.memory.maxFileBytes,
      });
      const bytes = targets.files.reduce((n, f) => n + f.size, 0);
      process.stderr.write(
        c.yellow(
          `埋め込みの接続先 "${ep.name}"（${ep.baseUrl}）はインターネット上にあります。\n` +
            `索引を作ると、ファイル ${targets.files.length} 件（約 ${formatBytes(bytes)}）の中身がそこへ送られます。\n`,
        ),
      );
      if (!opts.yes) {
        if (!isInteractive()) {
          throw new ExitError(
            EXIT.denied,
            '確認できない環境です。送ってよければ -y を付けてください。',
          );
        }
        if (!(await confirm('送って索引を作りますか？ [y/N] '))) {
          out('やめました。');
          return;
        }
      }
    }
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  const started = Date.now();
  const progress = progressPrinter(ctx, started);
  try {
    const r = await updateIndex({
      dataRoot: ctx.root,
      workspaceRoot: workspace.root,
      embedder,
      settings: ctx.config.memory,
      rebuild: mode === 'build',
      signal: controller.signal,
      onProgress: progress,
    });
    progress.done();
    if (r.status === 'too-many') return; // 上限を付けていないので来ない
    if (ctx.json) {
      out(
        JSON.stringify({
          status: r.status,
          files: r.meta.counts.files,
          chunks: r.meta.counts.chunks,
          ...(r.status === 'updated' ? { summary: r.summary, ms: r.ms } : {}),
          skipped: r.targets.skipped,
        }),
      );
      return;
    }
    if (r.status === 'unchanged') {
      out('変わったファイルはありません。索引はそのままです。');
    } else {
      const s = r.summary;
      out(
        r.rebuilt
          ? `索引を作りました: ファイル ${r.meta.counts.files} 件、チャンク ${r.meta.counts.chunks} 件（${formatDuration(r.ms)}）`
          : `索引を更新しました: 追加 ${s.added.length}・変更 ${s.changed.length}・削除 ${s.removed.length}（${formatDuration(r.ms)}）`,
      );
    }
    const sk = r.targets.skipped;
    const parts = [
      sk.secret ? `秘密のファイル ${sk.secret}` : null,
      sk.large ? `大きいファイル ${sk.large}` : null,
      sk.ignored ? `除外の規則 ${sk.ignored}` : null,
      r.status === 'updated' && r.summary.unreadable
        ? `バイナリ・読めない ${r.summary.unreadable}`
        : null,
    ].filter(Boolean);
    if (parts.length) out(c.dim(`索引に入れなかったもの: ${parts.join('、')}`));
    if (r.targets.truncated) out(c.yellow('ファイルが多いため、途中までしか索引にしていません。'));
    out(c.dim(`埋め込み: ${describeIdentity(r.meta.embedding)}`));
  } catch (err) {
    progress.done();
    if (controller.signal.aborted) {
      throw new ExitError(EXIT.interrupted, '中断しました。前の索引はそのまま使えます。');
    }
    throw new ExitError(EXIT.runtime, `索引を作れませんでした: ${(err as Error).message}`);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

export async function indexStatus(opts: IndexOptions): Promise<void> {
  const ctx = await createContext(opts);
  const workspace = await openWorkspace(opts);
  const dir = indexDir(ctx.root, workspace.root);
  const meta = await readCurrentMeta(dir);
  if (meta === null) {
    if (ctx.json) out(JSON.stringify({ exists: false }));
    else {
      out(`この作業フォルダ（${tildify(workspace.root)}）の索引はありません。`);
      out(c.dim('作るには: akari index build'));
    }
    return;
  }
  if (meta === 'broken') {
    throw new ExitError(
      EXIT.runtime,
      '索引の記録が読めません。akari index build で作り直してください。',
    );
  }
  // いまのファイルと比べて、索引の後で変わったものを数える（中身は読まない）
  const targets = await listIndexTargets(workspace.root, {
    maxFileBytes: ctx.config.memory.maxFileBytes,
  });
  const now = new Map(targets.files.map((f) => [f.relative, f]));
  let changed = 0;
  for (const f of targets.files) {
    const m = meta.files[f.relative];
    if (!m || m.size !== f.size || m.mtimeMs !== f.mtimeMs) changed++;
  }
  for (const k of Object.keys(meta.files)) if (!now.has(k)) changed++;
  const leftovers = await hasLeftovers(dir, meta.generation);
  let usable: string;
  try {
    const embedder = await createEmbedder(ctx.config, ctx.root);
    usable = sameIdentity(meta.embedding, await embedder.identity())
      ? '使える'
      : `使えない（今の設定は ${describeIdentity(await embedder.identity())}。akari index build で作り直す）`;
  } catch (err) {
    usable = `使えない（${(err as Error).message}）`;
  }
  if (ctx.json) {
    out(
      JSON.stringify({
        exists: true,
        root: meta.root,
        files: meta.counts.files,
        chunks: meta.counts.chunks,
        embedding: meta.embedding,
        builtAt: meta.builtAt,
        updatedAt: meta.updatedAt,
        changedSince: changed,
        interruptedUpdate: leftovers,
        usable,
      }),
    );
    return;
  }
  out(`作業フォルダ: ${tildify(meta.root)}`);
  out(`ファイル ${meta.counts.files} 件、チャンク ${meta.counts.chunks} 件`);
  out(`埋め込み: ${describeIdentity(meta.embedding)}（${meta.embedding.dims} 次元）`);
  out(`作成 ${fmtTime(meta.builtAt)}、最終更新 ${fmtTime(meta.updatedAt)}`);
  out(
    `索引の後で変わったファイル: ${changed} 件${changed ? c.dim('（実行の最初に自動で更新。多ければ akari index update）') : ''}`,
  );
  out(`今の設定で: ${usable}`);
  if (leftovers)
    out(
      c.dim('前回の更新は途中で止まりました（その前の索引を使っています。次の更新で片付きます）。'),
    );
  if (meta.embedding.source === 'endpoint') {
    out(
      c.dim(
        '外部の接続先がモデルを差し替えても、Akari には分かりません。結果がおかしければ作り直してください。',
      ),
    );
  }
}

export async function indexSearch(
  query: string,
  opts: IndexOptions & { k?: string; path?: string },
): Promise<void> {
  const ctx = await createContext(opts);
  const workspace = await openWorkspace(opts);
  const state = await loadIndex(indexDir(ctx.root, workspace.root));
  if (state.kind === 'none')
    throw new ExitError(EXIT.usage, '索引がありません。', {
      hint: 'akari index build で作れます。',
    });
  if (state.kind === 'broken') throw new ExitError(EXIT.runtime, state.reason);
  const embedder = await embedderOrExit(ctx);
  const identity = await embedder.identity();
  if (!sameIdentity(state.index.meta.embedding, identity)) {
    throw new ExitError(
      EXIT.usage,
      `索引は ${describeIdentity(state.index.meta.embedding)} で作られていますが、今の設定は ${describeIdentity(identity)} です。混ぜられないので探しません。`,
      { hint: 'akari index build で作り直してください。' },
    );
  }
  const k = opts.k !== undefined ? Number(opts.k) : ctx.config.memory.topK;
  if (!Number.isInteger(k) || k < 1 || k > 30)
    throw new ExitError(EXIT.usage, '-k は 1〜30 の整数です。');
  const [q] = await embedder.embed([query], 'query');
  const hits = await searchIndex(state.index, q!, {
    k,
    ...(opts.path ? { pathPrefix: opts.path } : {}),
  });
  if (ctx.json) {
    out(JSON.stringify(hits));
    return;
  }
  if (hits.length === 0) {
    out('当たるものがありませんでした。');
    return;
  }
  for (const [n, h] of hits.entries()) {
    out(
      `${c.bold(`${n + 1}. ${h.path}:${h.startLine}-${h.endLine}`)}  ${c.dim(`点数 ${h.score.toFixed(3)}`)}` +
        (h.stale ? c.yellow('  索引の後で変わっています') : ''),
    );
    const lines = h.text.split('\n');
    for (const l of lines.slice(0, 4)) out(c.dim(`   ${l.slice(0, 160)}`));
    if (lines.length > 4) out(c.dim(`   …（ほか ${lines.length - 4} 行）`));
  }
}

export async function indexRemove(opts: IndexOptions): Promise<void> {
  const ctx = await createContext(opts);
  const workspace = await openWorkspace(opts);
  const removed = await removeIndex(indexDir(ctx.root, workspace.root));
  out(
    removed
      ? '索引を消しました（作業フォルダのファイルには触っていません）。'
      : 'この作業フォルダの索引はありません。',
  );
}

// ---- 下請け ----

async function openWorkspace(opts: IndexOptions): Promise<Workspace> {
  try {
    return await Workspace.open(path.resolve(opts.cwd ?? process.cwd()));
  } catch (err) {
    throw new ExitError(EXIT.usage, (err as Error).message, {
      hint: '-C で作業フォルダを指定できます。',
    });
  }
}

async function embedderOrExit(ctx: CliContext): Promise<Embedder> {
  try {
    return await createEmbedder(ctx.config, ctx.root);
  } catch (err) {
    if (!(err instanceof MemoryConfigError)) throw err;
    let hint: string | undefined;
    // モデル未指定なら、接続先の一覧から埋め込み用らしいものを候補として出す（選ぶのは利用者）
    if (ctx.config.memory.embedding.source === 'endpoint' && !ctx.config.memory.embedding.model) {
      const ep = await embeddingEndpoint(ctx).catch(() => null);
      if (ep) {
        const ids = await createProvider(ep, { logger: ctx.logger })
          .listModels()
          .then((ms) => ms.map((m) => m.id).filter((id) => !isLikelyChatModel(id)))
          .catch(() => []);
        if (ids.length) hint = `接続先 "${ep.name}" の埋め込み用らしいモデル: ${ids.join(', ')}`;
      }
    }
    throw new ExitError(EXIT.usage, err.message, hint ? { hint } : undefined);
  }
}

async function embeddingEndpoint(ctx: CliContext) {
  const m = ctx.config.memory.embedding;
  if (m.source !== 'endpoint') return null;
  return resolveEndpoint(ctx.config, m.endpointId ?? ctx.config.activeEndpointId, ctx.root);
}

function progressPrinter(ctx: CliContext, started: number) {
  const tty = process.stderr.isTTY && !ctx.json;
  let last = 0;
  const fn = (p: IndexProgress) => {
    if (ctx.json || ctx.quiet) return;
    const t = formatDuration(Date.now() - started);
    const line =
      p.phase === 'scan'
        ? `ファイルを調べています…`
        : p.phase === 'embed'
          ? `埋め込み中 ${p.done}/${p.total} チャンク（${t}）`
          : `書き込み中…`;
    // 端末なら同じ行を書き換える。そうでなければ、たまにだけ出す
    if (tty) process.stderr.write(`\r\x1b[2K${c.dim(line)}`);
    else if (p.phase !== 'embed' || Date.now() - last > 5000 || p.done === p.total) {
      process.stderr.write(`${line}\n`);
      last = Date.now();
    }
  };
  fn.done = () => {
    if (tty) process.stderr.write('\r\x1b[2K');
  };
  return fn;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

function formatBytes(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`;
}

function fmtTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

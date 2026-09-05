import fs from 'node:fs/promises';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { ChangeJournal, formatUnifiedDiff, type FileChange } from '@akari/core';
import { createContext, type GlobalOptions } from '../context.js';
import { c, out, table, isInteractive } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/**
 * akari runs / diff / undo。仕様: docs/spec/10-cli.md
 * 変更記録（docs/spec/05-agent.md）を読むだけ。モデルには繋がない。
 */

export type RunRefOptions = GlobalOptions & { run?: string; yes?: boolean; path?: string };

async function pickJournal(root: string, runId?: string): Promise<ChangeJournal> {
  if (runId) {
    const j = await ChangeJournal.load(runId, root);
    if (!j)
      throw new ExitError(EXIT.usage, `実行 ${runId} の記録が見つかりません。`, {
        hint: 'akari runs で一覧が見られます。',
      });
    return j;
  }
  const ids = await ChangeJournal.listRuns(root);
  for (const id of ids) {
    const j = await ChangeJournal.load(id, root);
    if (j && j.changes.length > 0) return j;
  }
  throw new ExitError(EXIT.usage, 'ファイルを変更した実行がまだありません。');
}

export async function runsCommand(opts: GlobalOptions & { limit?: string }): Promise<void> {
  const ctx = await createContext(opts);
  const ids = await ChangeJournal.listRuns(ctx.root);
  const limit = opts.limit ? Number(opts.limit) : 20;

  const rows: Array<Record<string, unknown>> = [];
  for (const id of ids.slice(0, Number.isFinite(limit) ? limit : 20)) {
    const j = await ChangeJournal.load(id, ctx.root);
    if (!j) continue;
    rows.push({
      runId: id,
      startedAt: j.startedAt,
      workspace: j.workspace,
      changedFiles: j.changedFiles(),
    });
  }

  if (ctx.json) {
    out(JSON.stringify(rows));
    return;
  }
  if (rows.length === 0) {
    out('実行の記録がありません。');
    return;
  }
  out(
    table(
      rows.map((r) => [
        String(r.runId),
        String(r.startedAt).replace('T', ' ').slice(0, 19),
        String((r.changedFiles as string[]).length) + ' 件',
        String(r.workspace),
      ]),
      ['実行ID', '開始', '変更', '作業フォルダ'],
    ),
  );
  out(c.dim('\n差分: akari diff --run <ID>   取り消し: akari undo --run <ID>'));
}

export async function diffCommand(opts: RunRefOptions): Promise<void> {
  const ctx = await createContext(opts);
  const journal = await pickJournal(ctx.root, opts.run);

  // 各ファイルについて「最初のバックアップ」と「現在の中身」を比べる
  const byPath = new Map<string, FileChange[]>();
  for (const ch of journal.changes) {
    const list = byPath.get(ch.path);
    if (list) list.push(ch);
    else byPath.set(ch.path, [ch]);
  }

  const results: Array<{ path: string; diff: string; note?: string }> = [];
  for (const [relative, list] of byPath) {
    if (opts.path && relative !== opts.path) continue;
    const first = list[0]!;
    const before = first.backupPath
      ? await fs.readFile(path.join(journal.dir, first.backupPath), 'utf8').catch(() => '')
      : '';
    const after = await fs.readFile(path.join(journal.workspace, relative), 'utf8').catch(() => '');
    const text = formatUnifiedDiff(relative, before, after);
    results.push({
      path: relative,
      diff: text,
      ...(text === ''
        ? { note: '実行前と同じ内容です（取り消し済みか、元に戻されています）' }
        : {}),
    });
  }

  if (ctx.json) {
    out(JSON.stringify({ runId: journal.runId, workspace: journal.workspace, files: results }));
    return;
  }
  if (results.length === 0) {
    out('この実行はファイルを変更していません。');
    return;
  }
  out(c.dim(`実行 ${journal.runId}  ${journal.workspace}`));
  for (const r of results) {
    out('');
    if (r.note) {
      out(c.dim(`${r.path}: ${r.note}`));
      continue;
    }
    for (const line of r.diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) out(c.bold(line));
      else if (line.startsWith('@@')) out(c.cyan(line));
      else if (line.startsWith('+')) out(c.green(line));
      else if (line.startsWith('-')) out(c.red(line));
      else out(line);
    }
  }
}

export async function undoCommand(opts: RunRefOptions): Promise<void> {
  const ctx = await createContext(opts);
  const journal = await pickJournal(ctx.root, opts.run);
  const files = journal.changedFiles();

  if (files.length === 0) {
    out('この実行はファイルを変更していません。');
    return;
  }

  if (!opts.yes && !ctx.json) {
    out(`実行 ${journal.runId} の変更を元に戻します。対象 ${files.length} 件:`);
    for (const f of files) out(`  ${f}`);
    if (!isInteractive()) {
      throw new ExitError(EXIT.denied, '確認できない環境です。-y を付けると確認なしで実行します。');
    }
    const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (await rl.question('戻しますか？ [y/N] ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        out('やめました。');
        return;
      }
    } finally {
      rl.close();
    }
  }

  const result = await journal.undo();

  if (ctx.json) {
    out(JSON.stringify(result));
  } else {
    if (result.restored.length > 0) {
      out(c.green(`戻しました (${result.restored.length}):`));
      for (const f of result.restored) out(`  ${f}`);
    }
    if (result.skipped.length > 0) {
      out(c.yellow(`戻せなかったもの (${result.skipped.length}):`));
      for (const s of result.skipped) out(`  ${s.path} — ${s.reason}`);
      out(c.dim('これらは上書きしていません。中身を確認してから手で戻してください。'));
    }
    if (result.restored.length === 0 && result.skipped.length === 0)
      out('戻す対象がありませんでした。');
  }

  if (result.skipped.length > 0) process.exitCode = EXIT.runtime;
}

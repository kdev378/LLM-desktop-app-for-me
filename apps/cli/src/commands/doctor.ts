import fs from 'node:fs/promises';
import path from 'node:path';
import { collectDiagnostics, formatDiagnostics, findEndpoint, updateEndpoint } from '@akari/core';
import { createContext, persist, type GlobalOptions } from '../context.js';
import { out, c, formatBytes } from '../term.js';
import { ExitError, EXIT } from '../exit.js';
import { VERSION } from '../version.js';

export type DoctorOptions = GlobalOptions & { export?: string; noProbe?: boolean };

/** akari doctor — 接続先・設定・データの状態を出す。--export で書き出す。 */
export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  const ctx = await createContext(opts);
  const bundle = await collectDiagnostics({
    root: ctx.root,
    version: VERSION,
    logger: ctx.logger,
    probe: opts.noProbe !== true,
  });

  // doctor も判定を1回走らせている。その結果を捨てない。
  // 捨てると「doctor で見たのに判定済みモデルが増えない」ことになる。
  for (const ep of bundle.endpoints) {
    const probe = ep.probe;
    if (!probe?.reachable || !probe.testedModel) continue;
    const target = findEndpoint(ctx.config, ep.name);
    if (!target) continue;
    // 今回の判定結果を、この回の表示にも反映する。
    // 保存だけして表示に混ぜないと、常に1回前の内容が出ることになる。
    const row = {
      id: probe.testedModel,
      tools: probe.tools,
      contextTokens: probe.contextTokens,
    };
    ep.models = [...(ep.models ?? []).filter((m) => m.id !== row.id), row];

    const known = target.capabilities.byModel[probe.testedModel];
    if (known && known.tools === probe.tools && known.contextTokens === probe.contextTokens)
      continue;
    try {
      await persist(
        ctx,
        updateEndpoint(ctx.config, target.id, {
          capabilities: {
            ...target.capabilities,
            byModel: {
              ...target.capabilities.byModel,
              [probe.testedModel]: {
                tools: probe.tools,
                usageReported: probe.usageReported,
                streamsToolCalls: probe.streamsToolCalls,
                contextTokens: probe.contextTokens,
                probedAt: new Date().toISOString(),
              },
            },
          },
        }),
      );
    } catch (err) {
      // 保存できなくても診断は出す。ただし黙らない。
      process.stderr.write(`判定結果を保存できませんでした: ${(err as Error).message}\n`);
    }
  }

  if (opts.export) {
    const target = path.resolve(opts.export);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, formatDiagnostics(bundle), 'utf8');
    out(`診断を書き出しました: ${target}`);
    out('');
    out('このファイルに含まれるもの:');
    out(
      '  バージョン / 実行環境 / 接続先のURLと判定結果 / 設定の要約 / 保存データの件数 / 直近のログ',
    );
    out('含まれないもの:');
    out('  APIキー / 会話の本文 / ファイルの中身（ホームのパスは ~ に置換）');
    out('');
    out(c.dim('中身を確認してから共有してください。'));
    return;
  }

  if (ctx.json) {
    out(JSON.stringify(bundle, null, 2));
    return;
  }

  out(c.bold('Akari 診断'));
  out('');
  out(`バージョン: ${bundle.version}`);
  out(
    `実行環境:   Node ${bundle.runtime.node} / ${bundle.runtime.platform}-${bundle.runtime.arch}`,
  );
  out(`データ:     ${bundle.home}`);
  out('');

  out(c.bold('接続先'));
  if (bundle.endpoints.length === 0) {
    out('  登録なし');
    out(c.dim('  → akari config endpoints add --name "ローカル" --url http://localhost:11434/v1'));
  }
  for (const ep of bundle.endpoints) {
    const mark = ep.probe?.reachable
      ? c.green('●')
      : ep.probe || ep.probeError
        ? c.red('●')
        : c.gray('●');
    out(`  ${mark} ${ep.name}${ep.external ? c.yellow(' [外部]') : ''}`);
    out(`      URL:   ${ep.baseUrl}`);
    out(`      鍵:    ${ep.keySource}`);
    out(`      モデル: ${ep.defaultModel ?? c.dim('(未設定)')}`);
    if (ep.models && ep.models.length > 0) {
      out(`      判定済みのモデル:`);
      for (const m of ep.models) {
        const ctx = m.contextTokens
          ? `${m.contextTokens.toLocaleString()} トークン`
          : c.dim('文脈長 不明');
        out(`        ${m.id}  ツール: ${m.tools}  ${ctx}`);
      }
    }
    if (ep.probe) {
      for (const n of ep.probe.notes) out(c.dim(`      - ${n}`));
      if (ep.probe.error) out(c.red(`      ! ${ep.probe.error.message}`));
    }
    if (ep.probeError) out(c.red(`      ! ${ep.probeError}`));
  }
  out('');

  if (bundle.configProblems.length > 0 || bundle.credentialsWarning) {
    out(c.bold(c.yellow('設定の問題')));
    for (const p of bundle.configProblems) out(`  - ${p}`);
    if (bundle.credentialsWarning) out(`  - ${bundle.credentialsWarning}`);
    out('');
  }

  out(c.bold('保存データ'));
  out(
    `  会話 ${bundle.storage.conversations}件 / プロジェクト ${bundle.storage.projects}件 / 実行の記録 ${bundle.storage.backupRuns}件`,
  );
  out(`  合計 ${formatBytes(bundle.storage.totalBytes)}`);
  out('');
  out(c.dim('問題を報告するときは: akari doctor --export akari-diagnostics.txt'));

  const unreachable = bundle.endpoints.filter((e) => e.probe && !e.probe.reachable);
  if (unreachable.length > 0 && unreachable.length === bundle.endpoints.length) {
    throw new ExitError(EXIT.unreachable, 'どの接続先にも到達できませんでした。');
  }
}

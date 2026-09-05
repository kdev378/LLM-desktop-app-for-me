import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths, tildify } from '../util/paths.js';
import { redact } from './redact.js';
import { loadConfig } from '../config/config.js';
import { loadCredentials, resolveKey } from '../config/credentials.js';
import { isExternalUrl, resolveEndpoint } from '../config/endpoints.js';
import { createProvider } from '../provider/openai.js';
import type { Logger } from './logger.js';
import type { EndpointProbeResult } from '../provider/types.js';

/**
 * 問題報告用の書き出し。仕様: docs/spec/09-security.md
 * 含めないもの: 鍵、会話の本文、ファイルの中身。パスは ~ に置換する。
 */

export type EndpointDiagnostic = {
  name: string;
  baseUrl: string;
  external: boolean;
  keySource: 'なし' | 'ファイル' | '環境変数' | '環境変数が未設定';
  defaultModel: string | null;
  capabilities: Record<string, unknown>;
  probe?: EndpointProbeResult;
  probeError?: string;
};

export type DiagnosticsBundle = {
  generatedAt: string;
  version: string;
  runtime: { node: string; platform: string; arch: string; osRelease: string };
  home: string;
  configProblems: string[];
  credentialsWarning: string | null;
  endpoints: EndpointDiagnostic[];
  settings: Record<string, unknown>;
  storage: { conversations: number; projects: number; backupRuns: number; totalBytes: number };
  logs: string[];
};

export type CollectOptions = {
  root?: string;
  version?: string;
  logger?: Logger;
  /** 接続先へ実際に問い合わせるか。false なら設定の要約だけ。 */
  probe?: boolean;
  logLines?: number;
  signal?: AbortSignal;
};

export async function collectDiagnostics(opts: CollectOptions = {}): Promise<DiagnosticsBundle> {
  const root = opts.root ?? paths.home();
  const { config, problems } = await loadConfig(root);
  const { credentials, permissionWarning } = await loadCredentials(root).catch(() => ({
    credentials: { schemaVersion: 1, keys: {} },
    permissionWarning: 'credentials.json を読めませんでした。',
  }));

  const endpoints: EndpointDiagnostic[] = [];
  for (const ep of config.endpoints) {
    const key = resolveKey(ep.apiKeyRef, credentials);
    const diag: EndpointDiagnostic = {
      name: ep.name,
      baseUrl: ep.baseUrl,
      external: isExternalUrl(ep.baseUrl),
      keySource:
        key.kind === 'none'
          ? 'なし'
          : key.kind === 'missing-env'
            ? '環境変数が未設定'
            : key.source === 'env'
              ? '環境変数'
              : 'ファイル',
      defaultModel: ep.defaultModel,
      capabilities: { ...ep.capabilities },
    };
    if (opts.probe) {
      try {
        const resolved = await resolveEndpoint(config, ep.id, root);
        const provider = createProvider(resolved, opts.logger ? { logger: opts.logger } : {});
        diag.probe = await provider.probe(ep.defaultModel ?? undefined, opts.signal);
      } catch (err) {
        diag.probeError = redact((err as Error).message);
      }
    }
    endpoints.push(diag);
  }

  return {
    generatedAt: new Date().toISOString(),
    version: opts.version ?? '0.1.0',
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    },
    home: tildify(root),
    configProblems: problems.map((p) => `${p.message}${p.detail ? ` — ${p.detail}` : ''}`),
    credentialsWarning: permissionWarning,
    endpoints,
    settings: {
      activeEndpoint: config.endpoints.find((e) => e.id === config.activeEndpointId)?.name ?? null,
      generation: config.generation,
      agent: { ...config.agent, allowedCommands: config.agent.allowedCommands.length },
      ui: config.ui,
      logging: config.logging,
      concurrency: config.concurrency,
    },
    storage: await measureStorage(root),
    logs: opts.logger ? await opts.logger.tail(opts.logLines ?? 500) : [],
  };
}

async function measureStorage(root: string) {
  const count = async (dir: string) => {
    try {
      return (await fsp.readdir(dir)).length;
    } catch {
      return 0;
    }
  };
  let totalBytes = 0;
  const walk = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else {
        const st = await fsp.stat(p).catch(() => null);
        if (st) totalBytes += st.size;
      }
    }
  };
  await walk(root);
  return {
    conversations: await count(paths.conversations(root)),
    projects: await count(paths.projects(root)),
    backupRuns: await count(paths.backups(root)),
    totalBytes,
  };
}

/** 人が読めるテキストに整える。書き出しファイルの中身。 */
export function formatDiagnostics(d: DiagnosticsBundle): string {
  const lines: string[] = [];
  const h = (t: string) => lines.push('', `## ${t}`, '');

  lines.push('# Akari 診断');
  lines.push('');
  lines.push(`生成日時: ${d.generatedAt}`);
  lines.push(`バージョン: ${d.version}`);
  lines.push(
    `実行環境: Node ${d.runtime.node} / ${d.runtime.platform}-${d.runtime.arch} / ${d.runtime.osRelease}`,
  );
  lines.push(`データの場所: ${d.home}`);

  h('接続先');
  if (d.endpoints.length === 0) lines.push('（登録なし）');
  for (const ep of d.endpoints) {
    lines.push(`- ${ep.name}${ep.external ? ' [外部]' : ''}`);
    lines.push(`  URL: ${ep.baseUrl}`);
    lines.push(`  鍵: ${ep.keySource}`);
    lines.push(`  既定モデル: ${ep.defaultModel ?? '(未設定)'}`);
    lines.push(`  機能: ${JSON.stringify(ep.capabilities)}`);
    if (ep.probe) {
      lines.push(
        `  到達: ${ep.probe.reachable ? 'はい' : 'いいえ'} / モデル ${ep.probe.models.length}件`,
      );
      for (const n of ep.probe.notes) lines.push(`  - ${n}`);
      if (ep.probe.error)
        lines.push(`  エラー: [${ep.probe.error.kind}] ${ep.probe.error.message}`);
    }
    if (ep.probeError) lines.push(`  判定失敗: ${ep.probeError}`);
  }

  h('設定の要約（鍵は含みません）');
  lines.push('```json');
  lines.push(JSON.stringify(d.settings, null, 2));
  lines.push('```');

  if (d.configProblems.length > 0 || d.credentialsWarning) {
    h('設定の問題');
    for (const p of d.configProblems) lines.push(`- ${p}`);
    if (d.credentialsWarning) lines.push(`- ${d.credentialsWarning}`);
  }

  h('保存データ');
  lines.push(`会話: ${d.storage.conversations} 件`);
  lines.push(`プロジェクト: ${d.storage.projects} 件`);
  lines.push(`実行のバックアップ: ${d.storage.backupRuns} 件`);
  lines.push(`合計サイズ: ${(d.storage.totalBytes / 1024 / 1024).toFixed(1)} MB`);

  h(`ログ（直近 ${d.logs.length} 行）`);
  lines.push('```');
  lines.push(...d.logs);
  lines.push('```');

  lines.push('');
  lines.push('---');
  lines.push('このファイルに含まれないもの: APIキー、会話の本文、ファイルの中身。');
  lines.push('ホームディレクトリのパスは ~ に置き換えてあります。');
  return redact(lines.join('\n')) + '\n';
}

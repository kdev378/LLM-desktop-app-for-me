import { resolveEndpoint } from '../config/endpoints.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../diagnostics/logger.js';
import type { ToolSpec } from '../tools/types.js';
import { EndpointEmbedder, describeIdentity, sameIdentity, type Embedder } from './embedder.js';
import { updateIndex } from './indexer.js';
import { IndexBusyError, indexDir, loadIndex, type LoadedIndex } from './store.js';
import { createMemorySearchTool } from './tool.js';

/**
 * 実行の始めの下ごしらえ。仕様: docs/spec/14-memory.md「更新」「検索」
 * CLI（run・対話画面）・ハーネスAPI・mcp serve で共有する。
 *
 * memory_search は使えるときだけ渡す（索引が無い・壊れている・埋め込みが違う・つながらない、では渡さない）。
 */

export type MemoryNotice = { level: 'info' | 'warn'; message: string };

export type PreparedMemory = {
  tool: ToolSpec | null;
  notices: MemoryNotice[];
  index: LoadedIndex | null;
};

export class MemoryConfigError extends Error {}

/** 設定から埋め込みの口を作る。作れなければ理由を投げる。 */
export async function createEmbedder(
  config: Config,
  dataRoot: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Embedder> {
  const m = config.memory;
  if (m.embedding.source === 'builtin') {
    // 内蔵（埋め込みの係）はまだ組み込んでいない。モデルを決めてから足す（14-memory.md「モデルの選び方」）
    throw new MemoryConfigError(
      '内蔵の埋め込みモデルはまだ使えません（準備中）。外部の接続先を使うには: ' +
        'akari config set memory.embedding.source endpoint と akari config set memory.embedding.model <埋め込み用モデル>',
    );
  }
  if (!m.embedding.model) {
    throw new MemoryConfigError(
      '埋め込みに使うモデルが決まっていません。akari config set memory.embedding.model <埋め込み用モデル> で指定してください（akari models で一覧）。',
    );
  }
  const ep = await resolveEndpoint(
    config,
    m.embedding.endpointId ?? config.activeEndpointId,
    dataRoot,
  );
  return new EndpointEmbedder(ep, m.embedding.model, m.batchSize, opts.fetchImpl);
}

export async function prepareMemory(opts: {
  dataRoot: string;
  /** 索引の元の作業フォルダ（worktree なら元のリポジトリ）。 */
  indexRoot: string;
  config: Config;
  /** 実行の最初に、変わったファイルだけ更新するか（worktree では読むだけなので false）。 */
  autoUpdate: boolean;
  logger?: Logger;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<PreparedMemory> {
  const none = (notices: MemoryNotice[] = []): PreparedMemory => ({
    tool: null,
    notices,
    index: null,
  });
  const m = opts.config.memory;
  if (!m.enabled) return none();
  const dir = indexDir(opts.dataRoot, opts.indexRoot);
  let state = await loadIndex(dir);
  if (state.kind === 'none') return none(); // 索引を作っていない人に毎回知らせない
  if (state.kind === 'broken')
    return none([{ level: 'warn', message: `索引を使いません: ${state.reason}` }]);

  let embedder: Embedder;
  try {
    embedder = await createEmbedder(
      opts.config,
      opts.dataRoot,
      opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
    );
  } catch (err) {
    return none([
      { level: 'warn', message: `索引はありますが使えません: ${(err as Error).message}` },
    ]);
  }
  const identity = await embedder.identity();
  if (!sameIdentity(state.index.meta.embedding, identity)) {
    return none([
      {
        level: 'warn',
        message:
          `索引は ${describeIdentity(state.index.meta.embedding)} で作られていますが、今の設定は ${describeIdentity(identity)} です。` +
          '混ぜられないので使いません。akari index build で作り直してください。',
      },
    ]);
  }

  const notices: MemoryNotice[] = [];
  if (opts.autoUpdate && m.autoUpdateMaxFiles > 0) {
    try {
      const r = await updateIndex({
        dataRoot: opts.dataRoot,
        workspaceRoot: opts.indexRoot,
        embedder,
        settings: m,
        maxChangedFiles: m.autoUpdateMaxFiles,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (r.status === 'updated') {
        const n = r.summary.added.length + r.summary.changed.length + r.summary.removed.length;
        if (n > 0)
          notices.push({
            level: 'info',
            message: `索引を更新しました（変わったファイル ${n} 件）。`,
          });
        state = await loadIndex(dir);
      } else if (r.status === 'too-many') {
        notices.push({
          level: 'info',
          message: `索引の後で変わったファイルが ${r.changedFiles} 件あり、自動の更新の上限（${r.limit}）を超えています。古いまま使います。akari index update で更新できます。`,
        });
      }
    } catch (err) {
      const busy = err instanceof IndexBusyError;
      notices.push({
        level: busy ? 'info' : 'warn',
        message: busy
          ? `索引は更新しません: ${err.message}`
          : `索引を更新できませんでした（古いまま使います）: ${(err as Error).message}`,
      });
      opts.logger?.warn('memory.auto_update_failed', { error: (err as Error).message });
    }
  }
  if (state.kind !== 'ready') return none(notices);
  return {
    tool: createMemorySearchTool({ index: state.index, embedder, topK: m.topK }),
    notices,
    index: state.index,
  };
}

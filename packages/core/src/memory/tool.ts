import { z } from 'zod';
import { truncateMiddle } from '../tools/walk.js';
import { denied, type ToolSpec } from '../tools/types.js';
import type { Embedder } from './embedder.js';
import { MAX_K, formatHits, searchIndex } from './search.js';
import type { LoadedIndex } from './store.js';

/** memory_search。仕様: docs/spec/14-memory.md「検索」「ツールとしての位置づけ」 */

export const MEMORY_SEARCH_TOOL_NAME = 'memory_search';

const args = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(MAX_K).nullish(),
  path: z.string().min(1).nullish(),
});

export function createMemorySearchTool(opts: {
  index: LoadedIndex;
  embedder: Embedder;
  topK: number;
}): ToolSpec {
  return {
    name: MEMORY_SEARCH_TOOL_NAME,
    description:
      '作業フォルダの索引を、意味の近さで探す。ファイルの場所が分かっているなら read_file、名前や文字で探せるなら glob / grep を先に使う。' +
      'これは「どこにあるか分からない」ときの補助。返るのは候補（ファイル名・行番号・点数）であって答えではないので、' +
      '必ず read_file で現物を確かめてから使う・編集する。',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探したいこと（自然な文でよい）' },
        k: { type: 'integer', description: `何件返すか。既定 ${opts.topK}、最大 ${MAX_K}` },
        path: {
          type: 'string',
          description: 'このフォルダの下だけに絞る（作業フォルダからの相対）',
        },
      },
      required: ['query'],
    },
    async run(raw, ctx) {
      const a = args.safeParse(raw);
      if (!a.success) {
        return denied(
          `引数が正しくありません: ${a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ')}`,
          'invalid',
        );
      }
      let query: Float32Array;
      try {
        [query] = (await opts.embedder.embed([a.data.query], 'query', ctx.signal)) as [
          Float32Array,
        ];
      } catch (err) {
        const msg = `問いを埋め込めませんでした: ${(err as Error).message}。grep / glob で探してください。`;
        return { ok: false, summary: msg, content: msg, errorKind: 'failed' };
      }
      const hits = await searchIndex(opts.index, query, {
        k: a.data.k ?? opts.topK,
        ...(a.data.path ? { pathPrefix: a.data.path } : {}),
      });
      const { text } = truncateMiddle(formatHits(hits), ctx.limits.toolOutputLimitBytes);
      return {
        ok: true,
        summary: `${hits.length} 件${hits[0] ? `（最も近い ${hits[0].path}:${hits[0].startLine}、点数 ${hits[0].score.toFixed(3)}）` : ''}`,
        content: text,
      };
    },
  };
}

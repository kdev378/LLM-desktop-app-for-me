import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  walk,
  matchGlob,
  toPosix,
  looksBinary,
  truncateMiddle,
  DEFAULT_IGNORE_DIRS,
} from './walk.js';
import {
  denied,
  type PathUse,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type ToolPreview,
} from './types.js';

/**
 * ファイル系のツール。すべて Workspace.resolve を通してから触る。
 * 仕様: docs/spec/05-agent.md「各ツールの契約」
 */

function parse<S extends z.ZodTypeAny>(schema: S, args: unknown): z.output<S> | ToolResult {
  const r = schema.safeParse(args);
  if (r.success) return r.data;
  const detail = r.error.issues
    .map((i) => `${i.path.join('.') || '(引数)'}: ${i.message}`)
    .join(' / ');
  return denied(`引数が正しくありません: ${detail}`, 'invalid');
}

/** 引数の path を境界検査の対象として取り出す。 */
function strPath(args: unknown, mode: 'read' | 'write'): PathUse[] {
  const p = (args as { path?: unknown } | null)?.path;
  return typeof p === 'string' && p !== '' ? [{ value: p, mode }] : [];
}

const isResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && 'ok' in v && 'summary' in v;

// ---------------- read_file ----------------

const readArgs = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    'ファイルをテキストとして読む。行番号付きで返る。offset は1始まりの行番号、limit は行数。',
  risk: 'read',
  pathsOf: (args) => strPath(args, 'read'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '作業フォルダからの相対パス' },
      offset: { type: 'integer', description: '開始行（1始まり）' },
      limit: { type: 'integer', description: '読む行数' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const a = parse(readArgs, args);
    if (isResult(a)) return a;

    const r = await ctx.workspace.resolve(a.path, 'read');
    if (!r.ok) return denied(r.message, r.reason === 'outside' ? 'denied' : 'denied');
    if (!r.exists) return denied(`ファイルがありません: ${a.path}`, 'not-found');

    const st = await fs.stat(r.absolute);
    if (st.isDirectory())
      return denied(`${a.path} はディレクトリです。list_dir を使ってください。`, 'invalid');

    const buf = await fs.readFile(r.absolute);
    if (looksBinary(buf)) {
      return denied(`${a.path} はバイナリのため読めません（${st.size} バイト）。`, 'binary');
    }

    const all = buf.toString('utf8').split('\n');
    const start = (a.offset ?? 1) - 1;
    const limit = a.limit ?? ctx.limits.readMaxLines;
    const slice = all.slice(start, start + limit);
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(5)}| ${line}`)
      .join('\n');
    const { text, truncated } = truncateMiddle(numbered, ctx.limits.readMaxBytes);

    const shownTo = start + slice.length;
    const notes: string[] = [];
    if (start > 0) notes.push(`${start} 行を飛ばしました`);
    if (shownTo < all.length)
      notes.push(`${all.length - shownTo} 行が残っています（全 ${all.length} 行）`);
    if (truncated) notes.push('長すぎるため中央を省略しました');

    return {
      ok: true,
      summary: `${r.relative} を ${slice.length} 行読んだ`,
      content: text + (notes.length > 0 ? `\n\n[${notes.join(' / ')}]` : ''),
    };
  },
};

// ---------------- list_dir ----------------

const listArgs = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(1).max(5).default(1),
});

export const listDirTool: ToolSpec = {
  name: 'list_dir',
  description: 'ディレクトリの中身を一覧する。node_modules や .git など大きいものは除外される。',
  risk: 'read',
  pathsOf: (args) => strPath(args, 'read'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '作業フォルダからの相対パス。既定は "."' },
      depth: { type: 'integer', description: '辿る深さ。既定1' },
    },
    required: [],
  },
  async run(args, ctx) {
    const a = parse(listArgs, args ?? {});
    if (isResult(a)) return a;

    const r = await ctx.workspace.resolve(a.path, 'read');
    if (!r.ok) return denied(r.message);
    if (!r.exists) return denied(`ディレクトリがありません: ${a.path}`, 'not-found');

    const { entries, truncated } = await walk(r.absolute, {
      maxDepth: a.depth - 1,
      includeDirs: true,
      maxEntries: 2000,
      signal: ctx.signal,
    });
    if (entries.length === 0) {
      return { ok: true, summary: `${r.relative} は空`, content: '(空のディレクトリ)' };
    }
    const lines = entries.map((e) =>
      e.isDir ? `${toPosix(e.relative)}/` : `${toPosix(e.relative)}  (${e.size} B)`,
    );
    if (truncated)
      lines.push(`… 件数が多いため打ち切りました（除外: ${DEFAULT_IGNORE_DIRS.join(', ')}）`);
    const { text } = truncateMiddle(lines.join('\n'), ctx.limits.toolOutputLimitBytes);
    return { ok: true, summary: `${r.relative} に ${entries.length} 件`, content: text };
  },
};

// ---------------- glob ----------------

const globArgs = z.object({ pattern: z.string().min(1), path: z.string().default('.') });

export const globTool: ToolSpec = {
  name: 'glob',
  description: 'ファイル名のパターンで探す。例: "src/**/*.ts", "**/{a,b}.json"',
  risk: 'read',
  pathsOf: (args) => strPath(args, 'read'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob パターン。区切りは / で書く' },
      path: { type: 'string', description: '探し始める相対パス。既定は "."' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const a = parse(globArgs, args);
    if (isResult(a)) return a;

    const r = await ctx.workspace.resolve(a.path, 'read');
    if (!r.ok) return denied(r.message);
    if (!r.exists) return denied(`ディレクトリがありません: ${a.path}`, 'not-found');

    const { entries, truncated } = await walk(r.absolute, { signal: ctx.signal });
    const hits = entries
      .filter((e) => matchGlob(a.pattern, e.relative))
      .map((e) => toPosix(e.relative));
    if (hits.length === 0) {
      return {
        ok: true,
        summary: `${a.pattern} に一致なし`,
        content: `一致するファイルはありませんでした（${a.pattern}）。`,
      };
    }
    const { text } = truncateMiddle(hits.join('\n'), ctx.limits.toolOutputLimitBytes);
    return {
      ok: true,
      summary: `${a.pattern} に ${hits.length} 件`,
      content: text + (truncated ? '\n[走査を途中で打ち切りました]' : ''),
    };
  },
};

// ---------------- grep ----------------

const grepArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().default('.'),
  glob: z.string().optional(),
  maxMatches: z.number().int().min(1).max(1000).default(200),
  ignoreCase: z.boolean().default(false),
});

export const grepTool: ToolSpec = {
  name: 'grep',
  description: 'ファイルの中身を正規表現で探す。結果は ファイル:行番号: 本文 の形で返る。',
  risk: 'read',
  pathsOf: (args) => strPath(args, 'read'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript の正規表現' },
      path: { type: 'string', description: '探す範囲。既定は "."' },
      glob: { type: 'string', description: '対象を絞る glob。例 "**/*.ts"' },
      maxMatches: { type: 'integer', description: '返す最大件数。既定200' },
      ignoreCase: { type: 'boolean', description: '大文字小文字を無視する' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const a = parse(grepArgs, args);
    if (isResult(a)) return a;

    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.ignoreCase ? 'i' : '');
    } catch (err) {
      return denied(`正規表現として読めません: ${(err as Error).message}`, 'invalid');
    }

    const r = await ctx.workspace.resolve(a.path, 'read');
    if (!r.ok) return denied(r.message);
    if (!r.exists) return denied(`ディレクトリがありません: ${a.path}`, 'not-found');

    const { entries } = await walk(r.absolute, { signal: ctx.signal });
    const targets = a.glob ? entries.filter((e) => matchGlob(a.glob!, e.relative)) : entries;

    const lines: string[] = [];
    let scanned = 0;
    let matched = 0;
    for (const e of targets) {
      if (ctx.signal.aborted) break;
      if (lines.length >= a.maxMatches) break;
      if (e.size > 2_000_000) continue;
      let buf: Buffer;
      try {
        buf = await fs.readFile(e.absolute);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      scanned += 1;
      const text = buf.toString('utf8');
      if (!re.test(text)) continue;
      matched += 1;
      const fileLines = text.split('\n');
      for (let i = 0; i < fileLines.length && lines.length < a.maxMatches; i++) {
        const line = fileLines[i]!;
        if (re.test(line)) {
          lines.push(`${toPosix(e.relative)}:${i + 1}: ${line.slice(0, 400)}`);
        }
      }
    }

    if (lines.length === 0) {
      return {
        ok: true,
        summary: `一致なし（${scanned} ファイルを検索）`,
        content: `一致はありませんでした。検索したファイル: ${scanned}。パターン: ${a.pattern}`,
      };
    }
    const { text } = truncateMiddle(lines.join('\n'), ctx.limits.toolOutputLimitBytes);
    const capped =
      lines.length >= a.maxMatches ? `\n[上限 ${a.maxMatches} 件で打ち切りました]` : '';
    return {
      ok: true,
      summary: `${matched} ファイルに ${lines.length} 件`,
      content: text + capped,
    };
  },
};

// ---------------- write_file ----------------

const writeArgs = z.object({ path: z.string(), content: z.string() });

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description: 'ファイルを書く。既にあれば上書きする。親ディレクトリは自動で作られる。',
  risk: 'write',
  pathsOf: (args) => strPath(args, 'write'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '作業フォルダからの相対パス' },
      content: { type: 'string', description: 'ファイルの中身すべて' },
    },
    required: ['path', 'content'],
  },
  async preview(args, ctx): Promise<ToolPreview | undefined> {
    const a = writeArgs.safeParse(args);
    if (!a.success) return undefined;
    const r = await ctx.workspace.resolve(a.data.path, 'write');
    if (!r.ok) return undefined;
    const before = r.exists ? await fs.readFile(r.absolute, 'utf8').catch(() => '') : '';
    return { kind: 'diff', path: r.relative, before, after: a.data.content };
  },
  async run(args, ctx) {
    const a = parse(writeArgs, args);
    if (isResult(a)) return a;

    const r = await ctx.workspace.resolve(a.path, 'write');
    if (!r.ok) return denied(r.message);

    const pending = await ctx.journal.before(
      ctx.callId,
      r.exists ? 'modify' : 'create',
      r.relative,
      r.absolute,
    );
    try {
      await fs.mkdir(path.dirname(r.absolute), { recursive: true });
      await fs.writeFile(r.absolute, a.content, 'utf8');
    } catch (err) {
      await ctx.journal.discard(pending);
      return denied(`書き込みに失敗しました: ${(err as Error).message}`, 'failed');
    }
    const change = await ctx.journal.commit(pending);
    const lines = a.content.split('\n').length;
    return {
      ok: true,
      summary: `${r.relative} を${r.exists ? '上書き' : '作成'}（${lines} 行）`,
      content: `${r.relative} に ${Buffer.byteLength(a.content)} バイト書きました（${r.exists ? '上書き' : '新規作成'}）。`,
      change,
    };
  },
};

// ---------------- edit_file ----------------

const editArgs = z.object({
  path: z.string(),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false),
});

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    'ファイルの一部を置き換える。oldText はちょうど1箇所に一致する必要がある。複数一致するなら前後を含めて一意にするか replaceAll を使う。',
  risk: 'write',
  pathsOf: (args) => strPath(args, 'write'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string', description: '置き換える前の文字列。周囲を含めて一意にする' },
      newText: { type: 'string', description: '置き換えた後の文字列' },
      replaceAll: { type: 'boolean', description: '一致する全箇所を置き換える' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  async preview(args, ctx): Promise<ToolPreview | undefined> {
    const a = editArgs.safeParse(args);
    if (!a.success) return undefined;
    const r = await ctx.workspace.resolve(a.data.path, 'write');
    if (!r.ok || !r.exists) return undefined;
    const before = await fs.readFile(r.absolute, 'utf8').catch(() => null);
    if (before === null) return undefined;
    const count = countOccurrences(before, a.data.oldText);
    if (count === 0) return undefined;
    const after = a.data.replaceAll
      ? before.split(a.data.oldText).join(a.data.newText)
      : before.replace(a.data.oldText, a.data.newText);
    return { kind: 'diff', path: r.relative, before, after };
  },
  async run(args, ctx) {
    const a = parse(editArgs, args);
    if (isResult(a)) return a;

    const r = await ctx.workspace.resolve(a.path, 'write');
    if (!r.ok) return denied(r.message);
    if (!r.exists) return denied(`ファイルがありません: ${a.path}`, 'not-found');

    const before = await fs.readFile(r.absolute, 'utf8');
    const count = countOccurrences(before, a.oldText);

    if (count === 0) {
      return denied(
        `${a.path} に oldText が見つかりません。read_file で現在の中身を確かめてください。`,
        'no-match',
      );
    }
    if (count > 1 && !a.replaceAll) {
      return denied(
        `${a.path} に oldText が ${count} 箇所あります。どこを直すか決められないので実行していません。前後を含めて一意にするか、replaceAll: true を指定してください。`,
        'ambiguous',
      );
    }

    const after = a.replaceAll
      ? before.split(a.oldText).join(a.newText)
      : before.replace(a.oldText, a.newText);
    if (after === before) {
      return denied('置き換えても中身が変わりません。実行していません。', 'no-match');
    }

    const pending = await ctx.journal.before(ctx.callId, 'modify', r.relative, r.absolute);
    try {
      await fs.writeFile(r.absolute, after, 'utf8');
    } catch (err) {
      await ctx.journal.discard(pending);
      return denied(`書き込みに失敗しました: ${(err as Error).message}`, 'failed');
    }
    const change = await ctx.journal.commit(pending);
    return {
      ok: true,
      summary: `${r.relative} を ${a.replaceAll ? count + '箇所' : '1箇所'} 置換`,
      content: `${r.relative} を書き換えました（${a.replaceAll ? count : 1} 箇所）。`,
      change,
    };
  },
};

// ---------------- delete_file ----------------

const deleteArgs = z.object({ path: z.string() });

export const deleteFileTool: ToolSpec = {
  name: 'delete_file',
  description: 'ファイルを削除する。ディレクトリは消せない。',
  risk: 'write',
  pathsOf: (args) => strPath(args, 'write'),
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async preview(args, ctx): Promise<ToolPreview | undefined> {
    const a = deleteArgs.safeParse(args);
    if (!a.success) return undefined;
    const r = await ctx.workspace.resolve(a.data.path, 'write');
    if (!r.ok || !r.exists) return undefined;
    const st = await fs.stat(r.absolute).catch(() => null);
    return { kind: 'delete', path: r.relative, bytes: st?.size ?? 0 };
  },
  async run(args, ctx) {
    const a = parse(deleteArgs, args);
    if (isResult(a)) return a;

    const r = await ctx.workspace.resolve(a.path, 'write');
    if (!r.ok) return denied(r.message);
    if (!r.exists) return denied(`ファイルがありません: ${a.path}`, 'not-found');

    const st = await fs.stat(r.absolute);
    if (st.isDirectory()) {
      return denied('ディレクトリは削除できません。必要ならコマンドで行ってください。', 'invalid');
    }

    const pending = await ctx.journal.before(ctx.callId, 'delete', r.relative, r.absolute);
    try {
      await fs.rm(r.absolute);
    } catch (err) {
      await ctx.journal.discard(pending);
      return denied(`削除に失敗しました: ${(err as Error).message}`, 'failed');
    }
    const change = await ctx.journal.commit(pending);
    return {
      ok: true,
      summary: `${r.relative} を削除`,
      content: `${r.relative} を削除しました（取り消しで戻せます）。`,
      change,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return count;
    count += 1;
    i = at + needle.length;
  }
}

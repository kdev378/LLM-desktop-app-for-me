import readlinePromises from 'node:readline/promises';
import {
  SearchError,
  WebError,
  createSearchProvider,
  fetchPage,
  htmlToText,
  type WebSettings,
} from '@akari/core';
import { createContext, persist, type GlobalOptions } from '../context.js';
import { c, out, isInteractive } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/**
 * akari web — Web 検索とページ取得。仕様: docs/spec/15-web.md「CLI」
 * コマンドから直接使う search / fetch は、web.enabled が false でも動く（打った本人が同意している）。
 * SSRF の検査は、モデルの道具と同じようにかかる。
 */

export async function webSearch(
  query: string,
  opts: GlobalOptions & { count?: string },
): Promise<void> {
  const ctx = await createContext(opts);
  const count = opts.count !== undefined ? Number(opts.count) : ctx.config.web.search.count;
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new ExitError(EXIT.usage, '-n は 1〜10 の整数です。');
  const provider = await providerOrExit(ctx.config.web, ctx.root);
  if (!ctx.json && !ctx.quiet)
    process.stderr.write(c.dim(`検索語「${query}」を ${provider.label} へ送ります…\n`));
  let results;
  try {
    results = await provider.search(query, count);
  } catch (err) {
    const e = err as SearchError;
    throw new ExitError(
      EXIT.unreachable,
      `検索できませんでした: ${e.message}`,
      e.hint ? { hint: e.hint } : undefined,
    );
  }
  if (ctx.json) {
    out(JSON.stringify(results));
    return;
  }
  if (results.length === 0) {
    out('見つかりませんでした。');
    return;
  }
  results.forEach((r, i) => {
    out(c.bold(`${i + 1}. ${r.title || '(題なし)'}`));
    out(`   ${r.url}`);
    if (r.snippet) out(c.dim(`   ${r.snippet.slice(0, 200)}`));
  });
}

export async function webFetch(
  url: string,
  opts: GlobalOptions & { start?: string; raw?: boolean },
): Promise<void> {
  const ctx = await createContext(opts);
  const f = ctx.config.web.fetch;
  const start = opts.start !== undefined ? Number(opts.start) : 0;
  if (!Number.isInteger(start) || start < 0)
    throw new ExitError(EXIT.usage, '--start は 0 以上の整数です。');
  let page;
  try {
    page = await fetchPage(url, f);
  } catch (err) {
    if (err instanceof WebError) {
      const code =
        err.kind === 'network_error' || err.kind === 'timeout' || err.kind === 'http_error'
          ? EXIT.unreachable
          : EXIT.denied;
      throw new ExitError(code, `取得しませんでした（${err.kind}）: ${err.message}`);
    }
    throw err;
  }
  const html = /^(text\/html|application\/xhtml\+xml)/i.test(page.contentType.trim());
  const conv = html && !opts.raw ? htmlToText(page.body, page.finalUrl) : { text: page.body };
  const text = conv.text.slice(start, start + f.maxChars);
  if (ctx.json) {
    out(
      JSON.stringify({
        url: page.url,
        finalUrl: page.finalUrl,
        status: page.status,
        ...('title' in conv && conv.title ? { title: conv.title } : {}),
        text,
        start,
        totalChars: conv.text.length,
        truncated: page.truncated || start + f.maxChars < conv.text.length,
      }),
    );
    return;
  }
  if (!ctx.quiet) {
    const meta = [
      `${page.finalUrl}  HTTP ${page.status}  ${Math.max(1, Math.round(page.bytes / 1024))}KB`,
      page.redirects.length ? `リダイレクト ${page.redirects.length} 回（${page.url} から）` : null,
      'title' in conv && conv.title ? `題: ${conv.title}` : null,
      `文字: ${conv.text.length === 0 ? 'なし' : `${start + 1}〜${start + text.length} / ${conv.text.length} 字`}` +
        (start + text.length < conv.text.length ? `（続きは --start ${start + text.length}）` : ''),
      page.truncated
        ? `取りに行く量の上限（${Math.round(f.maxBytes / 1024)}KB）で切りました`
        : null,
    ].filter(Boolean);
    process.stderr.write(c.dim(meta.join('\n') + '\n\n'));
  }
  out(text);
}

export async function webDoctor(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  const w = ctx.config.web;
  const rows: Array<{ item: string; ok: boolean | null; detail: string; hint?: string }> = [];
  rows.push({
    item: 'モデルへ渡すか',
    ok: w.enabled ? true : null,
    detail: w.enabled
      ? `有効（検索の承認: ${w.consent === 'perRun' ? '実行ごとに最初の1回' : '聞かない'}）`
      : '無効（akari web enable で有効にする）',
  });
  try {
    const p = await createSearchProvider(w, ctx.root);
    try {
      const r = await p.search('Akari web doctor', 1);
      rows.push({
        item: '検索',
        ok: true,
        detail: `${p.label} から ${r.length} 件の結果が返りました`,
      });
    } catch (err) {
      const e = err as SearchError;
      rows.push({
        item: '検索',
        ok: false,
        detail: `${p.label}: ${e.message}`,
        ...(e.hint ? { hint: e.hint } : {}),
      });
    }
  } catch (err) {
    const e = err as SearchError;
    rows.push({ item: '検索', ok: false, detail: e.message, ...(e.hint ? { hint: e.hint } : {}) });
  }
  rows.push({
    item: '取得',
    ok: null,
    detail:
      `この PC から直接取りに行きます（プロキシは使いません）。上限 ${Math.round(w.fetch.maxBytes / 1024)}KB・` +
      `${w.fetch.timeoutMs / 1000}秒・リダイレクト ${w.fetch.maxRedirects} 回。` +
      (w.fetch.privateHosts.length
        ? `内部でも許すホスト: ${w.fetch.privateHosts.join(', ')}`
        : '内部のアドレスは取りません'),
  });
  if (ctx.json) {
    out(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      const mark = r.ok === true ? c.green('✓') : r.ok === false ? c.red('✗') : c.dim('・');
      out(`${mark} ${r.item}: ${r.detail}`);
      if (r.hint) out(c.dim(`    → ${r.hint}`));
    }
  }
  if (rows.some((r) => r.ok === false)) process.exitCode = EXIT.unreachable;
}

export async function webEnable(opts: GlobalOptions & { yes?: boolean }): Promise<void> {
  const ctx = await createContext(opts);
  const w = ctx.config.web;
  const dest =
    w.search.provider === 'searxng'
      ? `SearXNG（${w.search.url}）。あなたが立てたサーバで、そこから先の検索エンジンへ送られます`
      : 'Tavily（https://api.tavily.com）。外部の会社のサービスです';
  process.stderr.write(
    [
      'Web 検索とページ取得を、モデルの道具として渡します。',
      `- 検索語の送り先: ${dest}`,
      '- ページは、この PC からそのサイトへ直接取りに行きます（この PC・社内などの内部のアドレスは取りません）',
      `- 承認: 検索は${w.consent === 'perRun' ? '実行ごとに最初の1回、送る検索語を見せて聞きます' : '聞きません（検索語は毎回表示します）'}。` +
        'ページの取得は、権限が full でなければ URL を見せて聞きます',
      '- 取ってきた中身には、モデルを騙そうとする文章が混ざりうるため、ファイルの書き込みとコマンドの承認は外しません',
      '',
    ].join('\n'),
  );
  if (!opts.yes) {
    if (!isInteractive())
      throw new ExitError(
        EXIT.denied,
        '確認できない環境です。有効にしてよければ -y を付けてください。',
      );
    if (!(await confirm('有効にしますか？ [y/N] '))) {
      out('やめました。');
      return;
    }
  }
  await persist(ctx, { ...ctx.config, web: { ...w, enabled: true } });
  out('Web の道具を有効にしました。');
  // 使えないものは今のうちに伝える（鍵が無いなど）
  try {
    await createSearchProvider(w, ctx.root);
  } catch (err) {
    const e = err as SearchError;
    out(c.yellow(`ただし Web 検索はまだ使えません: ${e.message}`));
    if (e.hint) out(c.dim(`  → ${e.hint}`));
  }
  out(c.dim('確かめるには: akari web doctor'));
}

export async function webDisable(opts: GlobalOptions): Promise<void> {
  const ctx = await createContext(opts);
  await persist(ctx, { ...ctx.config, web: { ...ctx.config.web, enabled: false } });
  out('Web の道具を無効にしました（モデルには渡しません）。');
}

async function providerOrExit(w: WebSettings, root: string) {
  try {
    return await createSearchProvider(w, root);
  } catch (err) {
    const e = err as SearchError;
    throw new ExitError(EXIT.usage, e.message, e.hint ? { hint: e.hint } : undefined);
  }
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

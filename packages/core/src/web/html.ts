import { parse } from 'parse5';

/**
 * HTML を、構造を残した文字（Markdown 風）にする。仕様: docs/spec/15-web.md「HTML → テキスト」
 *
 * - <main>（なければ role="main"、<article>）があればその中だけ、なければ <body>
 * - スクリプト・スタイル・ナビ・フッター・サイドバーなどを落とす
 * - 見出し・段落・リスト・表・引用・コードを残す。リンクは「テキスト (URL)」
 */

type Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
};

const DROP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'canvas',
  'form',
  'button',
  'select',
  'input',
  'textarea',
  'nav',
  'footer',
  'aside',
  'dialog',
  'head',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
  'address',
  'hr',
  'body',
  'html',
]);

export function htmlToText(html: string, baseUrl: string): { title?: string; text: string } {
  const doc = parse(html) as unknown as Node;
  const title = clean(textOf(find(doc, (n) => n.tagName === 'title')));
  const root =
    find(doc, (n) => n.tagName === 'main') ??
    find(doc, (n) => attr(n, 'role') === 'main') ??
    find(doc, (n) => n.tagName === 'article') ??
    find(doc, (n) => n.tagName === 'body') ??
    doc;
  const inMain =
    root.tagName === 'main' || root.tagName === 'article' || attr(root, 'role') === 'main';
  const out = new Writer();
  walk(root, out, { base: baseUrl, inMain, list: [] });
  const text = out
    .done()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { ...(title ? { title } : {}), text };
}

type State = { base: string; inMain: boolean; list: Array<{ ordered: boolean; n: number }> };

function walk(node: Node, out: Writer, st: State): void {
  if (node.nodeName === '#text') {
    out.inline(node.value ?? '');
    return;
  }
  const tag = node.tagName;
  if (!tag) {
    for (const c of node.childNodes ?? []) walk(c, out, st);
    return;
  }
  if (DROP.has(tag) || attr(node, 'hidden') !== null || attr(node, 'aria-hidden') === 'true')
    return;
  // 本文の外の header はサイトの見出し・ナビ。記事の中の header（題が入る）は残す
  if (tag === 'header' && !st.inMain) return;
  const kids = () => {
    for (const c of node.childNodes ?? []) walk(c, out, st);
  };
  const h = /^h([1-6])$/.exec(tag);
  if (h) {
    out.block();
    out.raw(`${'#'.repeat(Number(h[1]))} `);
    kids();
    out.block();
    return;
  }
  switch (tag) {
    case 'br':
      out.newline();
      return;
    case 'hr':
      out.block();
      out.raw('---');
      out.block();
      return;
    case 'pre': {
      const code = textOf(node).replace(/\n+$/, '');
      const lang =
        /language-([\w+-]+)/.exec(attr(firstTag(node, 'code') ?? node, 'class') ?? '')?.[1] ?? '';
      out.block();
      out.raw(`\`\`\`${lang}\n${code}\n\`\`\``);
      out.block();
      return;
    }
    case 'code': {
      const t = textOf(node);
      if (t.trim()) out.inline(`\`${t.replace(/\s+/g, ' ')}\``);
      return;
    }
    case 'a': {
      const href = attr(node, 'href');
      const before = out.mark();
      kids();
      const label = out.since(before).trim();
      const url = absolute(href, st.base);
      if (url && label && label !== url) out.inline(` (${url})`);
      else if (url && !label) out.inline(url);
      return;
    }
    case 'img': {
      const alt = attr(node, 'alt')?.trim();
      if (alt) out.inline(`[画像: ${alt}] `);
      return;
    }
    case 'ul':
    case 'ol': {
      // 入れ子のリストは段落を空けない
      const nested = st.list.length > 0;
      if (nested) out.newline();
      else out.block();
      st.list.push({ ordered: tag === 'ol', n: 0 });
      kids();
      st.list.pop();
      if (nested) out.newline();
      else out.block();
      return;
    }
    case 'li': {
      const l = st.list[st.list.length - 1];
      out.newline();
      out.raw('  '.repeat(Math.max(0, st.list.length - 1)) + (l?.ordered ? `${++l.n}. ` : '- '));
      kids();
      return;
    }
    case 'blockquote': {
      const inner = new Writer();
      for (const c of node.childNodes ?? []) walk(c, inner, st);
      out.block();
      out.raw(
        inner
          .done()
          .trim()
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
      );
      out.block();
      return;
    }
    case 'table': {
      out.block();
      for (const row of all(node, (n) => n.tagName === 'tr')) {
        const cells = (row.childNodes ?? []).filter(
          (c) => c.tagName === 'td' || c.tagName === 'th',
        );
        out.raw(`| ${cells.map((c) => clean(textOf(c)).replace(/\|/g, '\\|')).join(' | ')} |`);
        out.newline();
      }
      out.block();
      return;
    }
  }
  if (BLOCK.has(tag)) {
    out.block();
    kids();
    out.block();
    return;
  }
  kids();
}

/** 書き出し。段落の切れ目と、行の中の空白をまとめる。 */
class Writer {
  private buf = '';
  inline(text: string): void {
    const t = text.replace(/\s+/g, ' ');
    if (!t) return;
    // 行の頭の空白は捨てる
    if (t === ' ' && (this.buf === '' || this.buf.endsWith('\n') || this.buf.endsWith(' '))) return;
    this.buf += this.buf === '' || this.buf.endsWith('\n') ? t.replace(/^ /, '') : t;
  }
  raw(text: string): void {
    this.buf += text;
  }
  newline(): void {
    if (this.buf !== '' && !this.buf.endsWith('\n')) this.buf += '\n';
  }
  block(): void {
    if (this.buf === '') return;
    if (this.buf.endsWith('\n\n')) return;
    this.buf += this.buf.endsWith('\n') ? '\n' : '\n\n';
  }
  mark(): number {
    return this.buf.length;
  }
  since(at: number): string {
    return this.buf.slice(at);
  }
  done(): string {
    return this.buf;
  }
}

function attr(n: Node, name: string): string | null {
  return n.attrs?.find((a) => a.name === name)?.value ?? null;
}

function find(n: Node, pred: (n: Node) => boolean): Node | undefined {
  if (pred(n)) return n;
  for (const c of n.childNodes ?? []) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
}

function all(n: Node, pred: (n: Node) => boolean, acc: Node[] = []): Node[] {
  if (pred(n)) acc.push(n);
  for (const c of n.childNodes ?? []) all(c, pred, acc);
  return acc;
}

function firstTag(n: Node, tag: string): Node | undefined {
  return find(n, (x) => x.tagName === tag);
}

function textOf(n: Node | undefined): string {
  if (!n) return '';
  if (n.nodeName === '#text') return n.value ?? '';
  if (n.tagName && DROP.has(n.tagName) && n.tagName !== 'head') return '';
  return (n.childNodes ?? []).map(textOf).join('');
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function absolute(href: string | null, base: string): string | null {
  if (!href || href.startsWith('#')) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

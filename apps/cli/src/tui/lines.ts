import { DIGEST_KEYS, DIGEST_LABELS, type Compaction } from '@akari/core';
import type { Tone } from './theme.js';

/**
 * 対話画面に流す行の形と、決まった中身（ヘルプ・差分・圧縮版）の組み立て。
 * 仕様: docs/spec/17-interactive.md
 */

/** 色の付いたひと続きの文字。 */
export type Seg = { text: string; tone?: Tone };
/** 1行。色の違う部分を並べる。 */
export type Line = Seg[];

export const seg = (text: string, tone?: Tone): Seg => (tone ? { text, tone } : { text });
export const line = (text: string, tone?: Tone): Line => [seg(text, tone)];

/** 末尾の空行を落とす（差分の文字列は改行で終わるので、そのまま割ると空行が出る）。 */
export function trimEnd(lines: string[]): string[] {
  let n = lines.length;
  while (n > 0 && lines[n - 1]!.trim() === '') n -= 1;
  return lines.slice(0, n);
}

export function diffLine(l: string): Line {
  if (l.startsWith('+++') || l.startsWith('---')) return line(l, 'bold');
  if (l.startsWith('@@')) return line(l, 'hunk');
  if (l.startsWith('+')) return line(l, 'add');
  if (l.startsWith('-')) return line(l, 'del');
  return line(l, 'dim');
}

export function digestLines(c: Compaction): Line[] {
  const lines: Line[] = [
    line(
      `${c.model}  ${c.coveredTurns}手を圧縮  約${c.beforeTokens.toLocaleString()} → 約${c.afterTokens.toLocaleString()}トークン${c.estimated ? '（概算）' : ''}`,
      'dim',
    ),
  ];
  if (c.fallback) {
    lines.push([
      seg('! ', 'warn'),
      seg(
        `モデルが圧縮版を書けなかった分は、機械的な要約で残しています（理由: ${c.fallback}）。`,
        'warn',
      ),
    ]);
  }
  for (const key of DIGEST_KEYS) {
    const items = c.digest[key];
    lines.push(line(`${DIGEST_LABELS[key]}（${items.length}）`, 'bold'));
    if (items.length === 0) lines.push(line('  なし', 'dim'));
    for (const it of items) lines.push(line(`  - ${it.text}`));
  }
  return lines;
}

export function helpLines(): Line[] {
  const rows: Array<[string, string]> = [
    ['Enter', '送信'],
    ['Shift+Enter / Ctrl+J', '改行（Shift+Enter が効かない端末では Ctrl+J）'],
    ['↑ ↓', '入力の履歴'],
    ['Esc', '生成・実行を止める。承認の表示中は拒否'],
    ['Ctrl+C', '止める／入力を消す／2回で終了'],
    ['Shift+Tab', '権限を切り替える'],
    ['/new', '新しい会話'],
    ['/model [ID]', 'モデルの一覧・切り替え'],
    ['/permission [ask|auto-edit|full]', '権限'],
    ['/tools [all|read-only|off]', '渡す道具の範囲'],
    ['/context', '文脈の量'],
    ['/digest', '圧縮版を見る'],
    ['/diff', '直前の実行の差分'],
    ['/undo', '直前の実行の変更を戻す'],
    ['/exit', '終了'],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => [seg(`  ${k.padEnd(width)}  `, 'accent'), seg(v, 'dim')]);
}

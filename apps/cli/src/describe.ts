import { compactThreshold, type PermissionMode, type ToolsMode } from '@akari/core';

/**
 * 実行の様子を人へ伝える文言。ヘッドレス（akari run）と対話画面（docs/spec/17-interactive.md）で共有する。
 * 同じ状態を、使い口によって違う言葉で言わないため。
 */

export function describeToolsMode(m: ToolsMode): string {
  if (m === 'native') return '関数呼び出し';
  if (m === 'prompted') return '本文ブロック（代替方式）';
  return '両対応';
}

/**
 * どの閾値で圧縮するかを、どの設定から来ているかと一緒に出す。
 * 文脈長が分かると compactAtTokens は使われない。見えないと、試すときに迷う（実際に迷った）。
 */
export function describeContext(
  settings: { mode: string; compactAtRatio: number; compactAtTokens: number },
  windowTokens: number | null,
): string {
  if (settings.mode === 'off') return '文脈: 圧縮しない（context.mode が off）';
  if (windowTokens === null) {
    return `文脈: 長さ不明 / 約${settings.compactAtTokens.toLocaleString()}トークンを超えたら圧縮（context.compactAtTokens）`;
  }
  const hi = compactThreshold(settings, windowTokens, false);
  const lo = compactThreshold(settings, windowTokens, true);
  const range =
    hi === lo ? `約${hi.toLocaleString()}` : `約${lo.toLocaleString()}〜${hi.toLocaleString()}`;
  return `文脈: 長さ ${windowTokens.toLocaleString()} / ${range}トークンを超えたら圧縮（context.compactAtRatio ${settings.compactAtRatio}。サーバがトークン数を報告しなければ低いほう）`;
}

export function describeMode(m: PermissionMode): string {
  return m === 'ask' ? '承認する' : m === 'autoEdit' ? '編集は自動・コマンドは承認' : 'すべて自動';
}

export function describeEnd(reason: string): string {
  const map: Record<string, string> = {
    done: '完了',
    aborted: '中断',
    'max-steps': 'ステップ上限で停止',
    error: 'エラーで停止',
    denied: '拒否により停止',
    loop: '同じ操作の繰り返しを検出して停止',
    'context-full': '文脈に入りきらないため停止',
  };
  return map[reason] ?? reason;
}

export function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  const rec = args as Record<string, unknown>;
  if (typeof rec.command === 'string') return rec.command.slice(0, 120);
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.pattern === 'string') return rec.pattern;
  // MCP の道具など、形の決まっていない引数は短い JSON で見せる
  const json = JSON.stringify(rec);
  if (json === '{}') return '';
  return json.length > 120 ? `${json.slice(0, 119)}…` : json;
}

/**
 * 代替方式のとき、本文に混ざる akari-tool ブロックを画面から隠す。
 * 呼び出しの内容は直後の tool-call 行に出るので、情報は失われない。
 * チャンクの途中でフェンスが割れても壊れないよう、末尾を持ち越す。
 */
export function createBlockFilter(): { feed: (chunk: string) => string; flush: () => string } {
  const OPEN = '```akari-tool';
  const CLOSE = '```';
  let buf = '';
  let hidden = false;

  const feed = (chunk: string): string => {
    buf += chunk;
    let out = '';
    for (;;) {
      if (!hidden) {
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          // フェンスの先頭が末尾に掛かっているかもしれない分だけ残す
          const keep = Math.min(buf.length, OPEN.length - 1);
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          return out;
        }
        out += buf.slice(0, i);
        buf = buf.slice(i + OPEN.length);
        hidden = true;
      } else {
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          const keep = Math.min(buf.length, CLOSE.length - 1);
          buf = buf.slice(buf.length - keep);
          return out;
        }
        buf = buf.slice(j + CLOSE.length);
        hidden = false;
      }
    }
  };

  const flush = (): string => {
    const rest = hidden ? '' : buf;
    buf = '';
    return rest;
  };

  return { feed, flush };
}

/**
 * 行単位の統一差分。CLI の `akari diff`、承認前のプレビュー、
 * のちに画面とハーネスAPIでも同じものを使う。
 */

export type DiffLine = { kind: ' ' | '-' | '+'; text: string; oldNo?: number; newNo?: number };
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffResult = {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** 中身が同じなら true。 */
  identical: boolean;
};

/** 最長共通部分列。行数が多いときは計算量を抑えるため打ち切る。 */
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

/** 行数が大きすぎる場合の上限。超えたら全置換として扱う。 */
const MAX_LINES_FOR_LCS = 4000;

export function diffLines(before: string, after: string, context = 3): DiffResult {
  if (before === after) return { hunks: [], added: 0, removed: 0, identical: true };

  const a = before.split('\n');
  const b = after.split('\n');

  let raw: DiffLine[];
  if (a.length > MAX_LINES_FOR_LCS || b.length > MAX_LINES_FOR_LCS) {
    // 大きすぎるので行ごとの対応は取らない。丸ごと置き換えとして見せる。
    raw = [
      ...a.map((text, i) => ({ kind: '-' as const, text, oldNo: i + 1 })),
      ...b.map((text, i) => ({ kind: '+' as const, text, newNo: i + 1 })),
    ];
  } else {
    const dp = lcsTable(a, b);
    raw = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        raw.push({ kind: ' ', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        raw.push({ kind: '-', text: a[i]!, oldNo: i + 1 });
        i++;
      } else {
        raw.push({ kind: '+', text: b[j]!, newNo: j + 1 });
        j++;
      }
    }
    while (i < a.length) raw.push({ kind: '-', text: a[i]!, oldNo: ++i });
    while (j < b.length) raw.push({ kind: '+', text: b[j]!, newNo: ++j });
  }

  const added = raw.filter((l) => l.kind === '+').length;
  const removed = raw.filter((l) => l.kind === '-').length;

  // 変更のある行の周りだけを hunk にまとめる
  const keep = new Array<boolean>(raw.length).fill(false);
  raw.forEach((l, idx) => {
    if (l.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(raw.length - 1, idx + context); k++)
      keep[k] = true;
  });

  const hunks: DiffHunk[] = [];
  let cur: DiffLine[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const oldNos = cur.filter((l) => l.oldNo !== undefined).map((l) => l.oldNo!);
    const newNos = cur.filter((l) => l.newNo !== undefined).map((l) => l.newNo!);
    hunks.push({
      oldStart: oldNos[0] ?? 0,
      oldLines: oldNos.length,
      newStart: newNos[0] ?? 0,
      newLines: newNos.length,
      lines: cur,
    });
    cur = [];
  };
  for (let idx = 0; idx < raw.length; idx++) {
    if (keep[idx]) cur.push(raw[idx]!);
    else flush();
  }
  flush();

  return { hunks, added, removed, identical: false };
}

/** git 風の統一差分テキスト。 */
export function formatUnifiedDiff(
  pathLabel: string,
  before: string,
  after: string,
  context = 3,
): string {
  const d = diffLines(before, after, context);
  if (d.identical) return '';
  const out: string[] = [`--- a/${pathLabel}`, `+++ b/${pathLabel}`];
  for (const h of d.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) out.push(l.kind + l.text);
  }
  return out.join('\n');
}

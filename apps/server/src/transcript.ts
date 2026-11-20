import type { TranscriptEntry } from '@akari/core';
import type { RunRecord } from './run-store.js';

/**
 * チャットへ貼れる形。仕様: docs/spec/12-harness-api.md「transcript」
 * 本文の全文ではなく、貼って読める要約にする。全文が要るならイベントか会話を読む。
 */

export type TranscriptFormat = 'markdown' | 'text' | 'json';

export type TranscriptStep = {
  /** モデルが書いたこと（先頭だけ）。 */
  said?: string;
  tools: Array<{ name: string; target: string; ok: boolean | null; result: string }>;
};

export type TranscriptData = {
  runId: string;
  goal: string;
  status: string;
  endReason: string | null;
  model: string | null;
  workspace: string;
  branch: string | null;
  steps: TranscriptStep[];
  /** 最後の応答（長ければ先頭だけ）。 */
  answer: string;
  changedFiles: string[];
  durationMs: number | null;
};

const SAID_MAX = 200;
const ANSWER_MAX = 1500;

/** その実行の生の記録から、要約の材料を作る。 */
export function buildTranscript(record: RunRecord, entries: TranscriptEntry[]): TranscriptData {
  const results = new Map<string, TranscriptEntry>();
  for (const e of entries) if (e.role === 'tool' && e.toolCallId) results.set(e.toolCallId, e);

  const steps: TranscriptStep[] = [];
  let answer = '';
  for (const e of entries) {
    if (e.role !== 'assistant' || e.failed) continue;
    const text = e.text.trim();
    const tools = (e.toolCalls ?? []).map((call) => {
      const r = results.get(call.id);
      return {
        name: call.name,
        target: describeArgs(call.argumentsRaw),
        ok: r ? (r.ok ?? null) : null,
        result: r ? firstLine(r.text, 120) : '結果なし',
      };
    });
    if (tools.length === 0 && text !== '') {
      answer = text;
      continue;
    }
    steps.push({ ...(text ? { said: firstLine(text, SAID_MAX) } : {}), tools });
  }

  const started = record.startedAt ? Date.parse(record.startedAt) : NaN;
  const ended = record.endedAt ? Date.parse(record.endedAt) : NaN;
  return {
    runId: record.runId,
    goal: record.prompt,
    status: record.status,
    endReason: record.endReason,
    model: record.model,
    workspace: record.workspace,
    branch: record.branch,
    steps,
    answer: answer.length > ANSWER_MAX ? `${answer.slice(0, ANSWER_MAX)}…（以下省略）` : answer,
    changedFiles: record.changedFiles,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null,
  };
}

export function renderTranscript(t: TranscriptData, format: 'markdown' | 'text'): string {
  const md = format === 'markdown';
  const b = (s: string) => (md ? `**${s}**` : s);
  const code = (s: string) => (md && s ? `\`${s.replace(/`/g, "'")}\`` : s);
  const lines: string[] = [];
  lines.push(`${b('目的')}: ${t.goal}`);
  const where = t.branch ? `${t.workspace}（ブランチ ${t.branch}）` : t.workspace;
  lines.push(
    `${b('状態')}: ${describeStatus(t.status, t.endReason)}${t.durationMs !== null ? `  ${(t.durationMs / 1000).toFixed(1)}秒` : ''}  / ${t.model ?? 'モデル未定'} / ${where}`,
  );
  if (t.steps.length > 0) {
    lines.push('');
    lines.push(b('経過'));
    t.steps.forEach((s, i) => {
      if (s.said) lines.push(`${i + 1}. ${s.said}`);
      for (const tool of s.tools) {
        const mark = tool.ok === null ? '…' : tool.ok ? '✓' : '✗';
        lines.push(
          `${s.said ? '   ' : `${i + 1}. `}${tool.name} ${code(tool.target)} → ${mark} ${tool.result}`,
        );
      }
    });
  }
  if (t.answer) {
    lines.push('');
    lines.push(b('応答'));
    lines.push(t.answer);
  }
  lines.push('');
  lines.push(
    `${b('変更したファイル')}: ${t.changedFiles.length > 0 ? t.changedFiles.map(code).join(', ') : 'なし'}`,
  );
  return lines.join('\n');
}

/**
 * 文字数の上限以下に割る（Discord の2000字など）。行の境目で割り、コードブロックの途中では割らない。
 * ブロックそのものが上限より長いときだけ、ブロックを閉じてから割り、次の塊の先頭で開き直す
 * （どの塊も、それだけで正しく表示される）。
 */
export function chunkText(text: string, max: number): string[] {
  const limit = Math.max(200, max);
  const chunks: string[] = [];
  let cur: string[] = [];
  const size = (lines: string[]) => lines.join('\n').length;
  const fits = (more: string[]) => size([...cur, ...more]) <= limit;
  const flush = () => {
    if (cur.length > 0) chunks.push(cur.join('\n'));
    cur = [];
  };

  for (const block of toBlocks(text)) {
    if (block.kind === 'line') {
      for (const piece of splitLong(block.text, limit)) {
        if (!fits([piece])) flush();
        cur.push(piece);
      }
      continue;
    }
    // コードブロック: まるごと入るならそのまま。空の塊になら入るなら、次の塊へ送る
    if (fits(block.lines)) {
      cur.push(...block.lines);
      continue;
    }
    if (size(block.lines) <= limit) {
      flush();
      cur.push(...block.lines);
      continue;
    }
    // ブロックが上限より長い。開く行 + 中身の一部 + 閉じる行、の塊に分ける
    flush();
    const open = block.lines[0]!;
    const body = block.closed ? block.lines.slice(1, -1) : block.lines.slice(1);
    let part: string[] = [open];
    for (const l of body.flatMap((b) => splitLong(b, limit - open.length - 8))) {
      if (size([...part, l, '```']) > limit) {
        chunks.push([...part, '```'].join('\n'));
        part = [open];
      }
      part.push(l);
    }
    if (block.closed) part.push('```');
    cur = part;
  }
  flush();
  return chunks;
}

type Block = { kind: 'line'; text: string } | { kind: 'code'; lines: string[]; closed: boolean };

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let code: string[] | null = null;
  for (const line of text.split('\n')) {
    const isFence = /^\s*```/.test(line);
    if (code) {
      code.push(line);
      if (isFence) {
        blocks.push({ kind: 'code', lines: code, closed: true });
        code = null;
      }
    } else if (isFence) {
      code = [line];
    } else {
      blocks.push({ kind: 'line', text: line });
    }
  }
  if (code) blocks.push({ kind: 'code', lines: code, closed: false });
  return blocks;
}

function splitLong(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
  return out;
}

function describeStatus(status: string, reason: string | null): string {
  const map: Record<string, string> = {
    queued: '待機中',
    running: '実行中',
    'waiting-approval': '承認待ち',
    done: '完了',
    aborted: '中断',
    failed: '失敗',
    'max-steps': 'ステップ上限で停止',
    interrupted: 'サーバが止まったため途中で終了',
  };
  const base = map[status] ?? status;
  if (status === 'failed' && reason) {
    const why: Record<string, string> = {
      loop: '同じ操作の繰り返し',
      'context-full': '文脈に入りきらない',
      error: 'エラー',
      denied: '拒否',
    };
    return `${base}（${why[reason] ?? reason}）`;
  }
  return base;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const flat = line.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeArgs(raw: string): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    if (typeof a.path === 'string') return a.path;
    if (typeof a.command === 'string') return a.command.slice(0, 120);
    if (typeof a.pattern === 'string') return a.pattern;
    return '';
  } catch {
    return '';
  }
}

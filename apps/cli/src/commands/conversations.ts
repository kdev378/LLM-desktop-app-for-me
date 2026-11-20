import readlinePromises from 'node:readline/promises';
import {
  ConversationStore,
  isAkariError,
  textOf,
  tildify,
  type Conversation,
  type StoredMessage,
} from '@akari/core';
import { createContext, type GlobalOptions } from '../context.js';
import { c, out, table, note, isInteractive } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

/**
 * akari conversations — 保存した会話の一覧と操作。仕様: docs/spec/10-cli.md
 * モデルには繋がない。読めないものは黙って飛ばさず、最後に知らせる。
 */

export async function conversationsListCommand(
  opts: GlobalOptions & { limit?: string },
): Promise<void> {
  const ctx = await createContext(opts);
  const limit = opts.limit !== undefined ? Number(opts.limit) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ExitError(EXIT.usage, '--limit は 1 以上の整数で指定してください。');
  }
  const store = new ConversationStore(ctx.root);
  const { items, problems } = await store.list({ limit });

  if (ctx.json) {
    out(JSON.stringify({ conversations: items, problems }));
    return;
  }
  if (items.length === 0) {
    out('保存した会話はありません。');
  } else {
    out(
      table(
        items.map((h) => [
          h.id,
          formatTime(h.updatedAt),
          h.kind === 'agent' ? 'run' : 'chat',
          String(h.messageCount),
          h.workspace ? tildify(h.workspace) : '',
          h.title || c.dim('（無題）'),
        ]),
        ['ID', '更新', '種類', '件数', '作業フォルダ', 'タイトル'],
      ),
    );
    out(
      c.dim(
        '\n続けるには: akari run --conversation <ID> "…"（chat なら akari chat --conversation <ID>）',
      ),
    );
  }
  for (const p of problems) note(p.message);
}

export async function conversationsShowCommand(
  id: string,
  opts: GlobalOptions & { reasoning?: boolean; full?: boolean },
): Promise<void> {
  const ctx = await createContext(opts);
  const conv = await openOrExit(new ConversationStore(ctx.root), id);
  const thread = conv.thread();

  if (ctx.json) {
    out(JSON.stringify({ header: conv.header, thread, problems: conv.problems }));
    return;
  }

  const h = conv.header;
  out(c.bold(h.title || '（無題）'));
  out(
    c.dim(
      `${h.id}  ${h.kind === 'agent' ? 'run' : 'chat'}  ${h.workspace ? tildify(h.workspace) : ''}  ${thread.length}件  ${formatTime(h.createdAt)}〜${formatTime(h.updatedAt)}`,
    ),
  );
  if (h.runs.length > 0) {
    const counts = new Map<string, number>();
    for (const r of h.runs)
      counts.set(r.reason ?? '実行中か不明', (counts.get(r.reason ?? '実行中か不明') ?? 0) + 1);
    out(
      c.dim(
        `実行 ${h.runs.length}回: ${[...counts].map(([k, v]) => `${describeReason(k)} ${v}`).join(' / ')}`,
      ),
    );
  }
  out('');

  let lastRun: string | undefined;
  for (const m of thread) {
    if (m.meta.runId && m.meta.runId !== lastRun && h.kind === 'agent') {
      lastRun = m.meta.runId;
      const run = h.runs.find((r) => r.runId === m.meta.runId);
      out(
        c.dim(`── 実行 ${m.meta.runId}${run?.reason ? `（${describeReason(run.reason)}）` : ''}`),
      );
    }
    printMessage(m, { reasoning: opts.reasoning === true, full: opts.full === true });
  }
  for (const p of conv.problems) note(p.message);
}

export async function conversationsRmCommand(
  id: string,
  opts: GlobalOptions & { yes?: boolean },
): Promise<void> {
  const ctx = await createContext(opts);
  const store = new ConversationStore(ctx.root);
  const conv = await openOrExit(store, id);

  if (!opts.yes && !ctx.json) {
    out(`会話 ${conv.id}「${conv.header.title || '（無題）'}」をゴミ箱へ移します。`);
    out(`メッセージ ${conv.all().length}件が入っています。ゴミ箱の中身は30日後に消えます。`);
    if (!isInteractive()) {
      throw new ExitError(EXIT.denied, '確認できない環境です。-y を付けると確認なしで実行します。');
    }
    const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (await rl.question('移しますか？ [y/N] ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        out('やめました。');
        return;
      }
    } finally {
      rl.close();
    }
  }

  const result = await store.trash(conv.id);
  if (ctx.json) {
    out(JSON.stringify(result));
    return;
  }
  out(`ゴミ箱へ移しました: ${result.id}`);
  if (result.purged > 0) out(c.dim(`30日を過ぎたゴミ箱の会話を ${result.purged} 件消しました。`));
}

function printMessage(m: StoredMessage, opts: { reasoning: boolean; full: boolean }): void {
  const body = textOf(m.content);
  if (m.role === 'user') {
    const label = m.meta.source === 'akari' ? c.dim('[akari]') : c.cyan('あなた');
    out(`${label}  ${c.dim(formatTime(m.meta.createdAt))}`);
    out(indent(body));
    out('');
    return;
  }
  if (m.role === 'assistant') {
    const marks: string[] = [];
    if (m.meta.model) marks.push(m.meta.model);
    if (m.meta.error) marks.push(c.red(`失敗: ${m.meta.error.message}`));
    if (m.meta.finishReason === 'aborted') {
      marks.push(c.yellow(m.meta.interrupted ? '途中で止まった（プロセスが終了）' : '途中で停止'));
    }
    out(`${c.green('モデル')}  ${c.dim(marks.join('  '))}`);
    if (m.reasoning) {
      if (opts.reasoning) out(c.dim(indent(m.reasoning)));
      else out(c.dim(`  （思考 ${m.reasoning.length}文字。--reasoning で表示）`));
    }
    if (body.trim() !== '') out(indent(body));
    for (const call of m.toolCalls ?? []) {
      out(c.cyan(`  → ${call.name}`) + c.dim(` ${call.argumentsRaw.slice(0, 200)}`));
    }
    out('');
    return;
  }
  // tool
  const mark = m.ok ? c.green('✓') : c.red('✗');
  const extra = m.meta.synthetic ? c.yellow('（実行されなかった）') : '';
  out(`  ${mark} ${m.toolName ?? ''} ${extra}`);
  const lines = body.split('\n');
  const shown = opts.full ? lines : lines.slice(0, 8);
  out(c.dim(indent(shown.join('\n'), '    ')));
  if (!opts.full && lines.length > shown.length) {
    out(c.dim(`    …（残り ${lines.length - shown.length} 行。--full で全部）`));
  }
  out('');
}

async function openOrExit(store: ConversationStore, id: string): Promise<Conversation> {
  try {
    return await store.open(id);
  } catch (err) {
    if (isAkariError(err) && err.code.startsWith('conversation.')) {
      throw new ExitError(EXIT.usage, err.message, {
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    throw err;
  }
}

function describeReason(reason: string): string {
  const map: Record<string, string> = {
    done: '完了',
    aborted: '中断',
    'max-steps': 'ステップ上限',
    error: 'エラー',
    denied: '拒否',
    loop: '繰り返しで停止',
    interrupted: '途中で終了',
  };
  return map[reason] ?? reason;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function indent(text: string, pad = '  '): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

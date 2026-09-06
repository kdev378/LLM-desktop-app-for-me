import readline from 'node:readline';
import { createProvider, getProviderError, type ChatMessage, type Provider } from '@akari/core';
import { createContext, pickEndpoint, pickModel, type GlobalOptions } from '../context.js';
import { c, out, write, note, isInteractive, formatDuration } from '../term.js';
import { ExitError, EXIT } from '../exit.js';

export type ChatOptions = GlobalOptions & {
  prompt?: string;
  system?: string;
  temperature?: string;
  maxTokens?: string;
};

/**
 * akari chat — ツールなしの対話。
 * P0 の時点では会話を保存しない。保存は P1（デスクトップの Chat）で入る。
 */
export async function chatCommand(opts: ChatOptions): Promise<void> {
  const ctx = await createContext(opts);
  const endpoint = await pickEndpoint(ctx, opts.endpoint);
  const provider = createProvider(endpoint, { logger: ctx.logger });
  const model = await pickModel(endpoint, opts.model, async () =>
    (await provider.listModels()).map((m) => m.id),
  );

  const temperature =
    opts.temperature !== undefined ? Number(opts.temperature) : ctx.config.generation.temperature;
  if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
    throw new ExitError(EXIT.usage, '--temperature は 0.0〜2.0 の数値で指定してください。');
  }
  const maxTokens =
    opts.maxTokens !== undefined ? Number(opts.maxTokens) : ctx.config.generation.maxTokens;
  if (maxTokens !== null && (Number.isNaN(maxTokens) || maxTokens < 1)) {
    throw new ExitError(EXIT.usage, '--max-tokens は 1 以上の整数で指定してください。');
  }

  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });

  const params = { temperature, maxTokens };
  // -p - は「標準入力から読む」（docs/spec/10-cli.md）
  const explicit = opts.prompt === '-' ? null : (opts.prompt ?? null);
  const oneShot = explicit ?? (await readStdinIfPiped());

  if (oneShot !== null && oneShot !== undefined) {
    messages.push({ role: 'user', content: oneShot });
    const result = await runTurn(
      provider,
      model,
      messages,
      params,
      ctx.json,
      ctx.quiet,
      endpoint.isExternal,
    );
    if (result.error) throw toExitError(result.error, !ctx.json);
    return;
  }

  if (!isInteractive()) {
    throw new ExitError(EXIT.usage, '対話できる端末ではありません。', {
      hint: 'akari chat -p "質問" のように渡すか、標準入力からパイプしてください。',
    });
  }

  // ---- 対話モード ----
  out(c.bold('Akari chat'));
  out(
    c.dim(
      `${endpoint.name}${endpoint.isExternal ? c.yellow(' [外部]') : ''}  ${model}  temperature=${temperature}`,
    ),
  );
  out(c.dim('この対話は保存されません（保存はデスクトップ版で対応予定）。/help で操作一覧。'));
  out('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan('> '),
  });
  let generating: AbortController | null = null;
  let interruptedOnce = false;

  rl.on('SIGINT', () => {
    if (generating) {
      generating.abort();
      return;
    }
    if (interruptedOnce) {
      rl.close();
      return;
    }
    interruptedOnce = true;
    out(c.gray('\nもう一度 Ctrl+C で終了します（/exit でも終了）。'));
    rl.prompt();
  });

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    interruptedOnce = false;
    if (input === '') {
      rl.prompt();
      continue;
    }
    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') {
      printHelp();
      rl.prompt();
      continue;
    }
    if (input === '/clear') {
      messages.length = 0;
      if (opts.system) messages.push({ role: 'system', content: opts.system });
      out(c.gray('文脈を消しました。'));
      rl.prompt();
      continue;
    }
    if (input === '/context') {
      out(
        c.gray(
          `メッセージ ${messages.length}件 / 概算 ${estimateTokens(messages)} トークン（概算です）`,
        ),
      );
      rl.prompt();
      continue;
    }

    messages.push({ role: 'user', content: input });
    generating = new AbortController();
    const result = await runTurn(
      provider,
      model,
      messages,
      params,
      false,
      false,
      endpoint.isExternal,
      generating.signal,
    );
    generating = null;
    if (result.error && result.error.kind !== 'aborted') {
      // 失敗した往復は文脈から外す。壊れた履歴のまま続けない。
      messages.pop();
    }
    rl.prompt();
  }
  rl.close();
  out(c.gray('終了しました。'));
}

type TurnResult = {
  text: string;
  error?: ReturnType<typeof getProviderError> extends null
    ? never
    : NonNullable<ReturnType<typeof getProviderError>>;
};

async function runTurn(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  params: { temperature: number; maxTokens: number | null },
  json: boolean,
  quiet: boolean,
  isExternal: boolean,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const started = Date.now();
  let text = '';
  let reasoning = '';
  let firstTokenAt: number | null = null;
  let waiting: NodeJS.Timeout | null = null;
  const showWaiting = !json && !quiet && process.stdout.isTTY === true;

  if (showWaiting) {
    waiting = setInterval(() => {
      if (firstTokenAt === null) {
        const secs = Math.round((Date.now() - started) / 1000);
        write(`\r${c.gray(`待機中 ${secs}秒`)}   `);
      }
    }, 1000);
    waiting.unref?.();
  }

  const stopWaiting = () => {
    if (waiting) {
      clearInterval(waiting);
      waiting = null;
    }
    if (showWaiting) write('\r' + ' '.repeat(24) + '\r');
  };

  try {
    for await (const ev of provider.chat(
      {
        model,
        messages,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      },
      signal,
    )) {
      if (json) {
        out(JSON.stringify({ ts: new Date().toISOString(), ...ev }));
      }
      switch (ev.type) {
        case 'text-delta':
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            stopWaiting();
          }
          text += ev.text;
          if (!json) write(ev.text);
          break;
        case 'reasoning-delta':
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            stopWaiting();
          }
          reasoning += ev.text;
          break;
        case 'finish': {
          stopWaiting();
          if (!json) {
            if (!text.endsWith('\n')) out('');
            if (ev.reason === 'length') out(c.yellow('（上限に達して途中で止まりました）'));
            if (ev.reason === 'aborted') out(c.yellow('（停止しました）'));
            if (!quiet) {
              const parts = [`${formatDuration(Date.now() - started)}`];
              if (firstTokenAt)
                parts.push(`最初の応答まで ${formatDuration(firstTokenAt - started)}`);
              if (ev.usage) parts.push(`${ev.usage.prompt}+${ev.usage.completion} トークン`);
              else
                parts.push(
                  `~${estimateTokens([{ role: 'assistant', content: text }])} トークン（概算）`,
                );
              if (reasoning) parts.push(`思考出力 ${reasoning.length}文字（非表示）`);
              out(c.gray(parts.join('  ')));
            }
            out('');
          }
          messages.push({ role: 'assistant', content: text });
          return { text };
        }
        case 'error': {
          stopWaiting();
          if (!json) {
            if (text !== '' && ev.error.kind !== 'aborted') {
              out('');
              out(c.yellow('（応答が途中で切れました。上までが受け取った内容です）'));
            }
            if (ev.error.kind === 'aborted') {
              out('');
              out(c.yellow('（停止しました）'));
            } else {
              out('');
              process.stderr.write(c.red('エラー: ') + ev.error.message + '\n');
              if (ev.error.bodyExcerpt)
                process.stderr.write(c.gray('  ' + ev.error.bodyExcerpt.slice(0, 500)) + '\n');
              if (isExternal) process.stderr.write(c.gray('  この接続先は外部です。') + '\n');
            }
            out('');
          }
          if (text !== '') messages.push({ role: 'assistant', content: text });
          return { text, error: ev.error as never };
        }
        default:
          break;
      }
    }
    stopWaiting();
    return { text };
  } finally {
    stopWaiting();
  }
}

/** 失敗の内容は runTurn がすでに出しているので、終了コードだけを運ぶ。 */
function toExitError(pe: { kind: string; message: string }, alreadyPrinted: boolean): ExitError {
  const code = pe.kind === 'unreachable' ? EXIT.unreachable : EXIT.runtime;
  return new ExitError(code, pe.message, { silent: alreadyPrinted });
}

/** 概算。実測ではないことを呼び出し側で必ず明示する。 */
function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 2.2);
}

function printHelp(): void {
  out(c.dim('  /help     この一覧'));
  out(c.dim('  /clear    文脈を消す'));
  out(c.dim('  /context  今の文脈の量'));
  out(c.dim('  /exit     終了'));
  out(c.dim('  Ctrl+C    生成中なら停止。そうでなければ2回で終了'));
}

async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? null : text;
}

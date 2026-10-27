import {
  ConversationStore,
  getProviderError,
  isAkariError,
  toApiMessages,
  tildify,
  type ChatMessage,
  type Conversation,
  type ConversationKind,
  type ConversationSettings,
} from '@akari/core';
import type { CliContext } from './context.js';
import { note } from './term.js';
import { ExitError, EXIT } from './exit.js';

/**
 * run / chat が、どの会話に書くか・続きをどう読むかを決める。
 * 仕様: docs/spec/10-cli.md（-c / --conversation / --no-save）
 */

export type ConversationOptions = {
  continue?: boolean;
  conversation?: string;
  /** commander の --no-save は save === false になる */
  save?: boolean;
};

export type ConversationChoice = {
  /** 書き込む先。--no-save なら null。 */
  target: Conversation | null;
  /** 続きを始めるときの、これまでのやり取り（システムプロンプトは含まない）。 */
  history: ChatMessage[];
  /** 続きから始めたか。 */
  continued: boolean;
  /** 読んだ会話（続きの場合）。保存しなくても設定の引き継ぎに使う。 */
  source: Conversation | null;
};

export async function chooseConversation(
  ctx: CliContext,
  opts: ConversationOptions,
  init: { kind: ConversationKind; workspace: string | null; settings: ConversationSettings },
): Promise<ConversationChoice> {
  const store = new ConversationStore(ctx.root);
  const save = opts.save !== false;

  if (opts.continue && opts.conversation) {
    throw new ExitError(EXIT.usage, '-c と --conversation は同時に使えません。');
  }

  let source: Conversation | null = null;
  if (opts.conversation) {
    source = await openOrExit(store, opts.conversation);
  } else if (opts.continue) {
    const latest = await store.latest({
      kind: init.kind,
      ...(init.workspace !== null ? { workspace: init.workspace } : {}),
    });
    if (!latest) {
      throw new ExitError(
        EXIT.usage,
        init.kind === 'agent'
          ? `この作業フォルダ（${tildify(init.workspace ?? '')}）で続ける会話がありません。`
          : '続ける chat の会話がありません。',
        { hint: 'akari conversations で一覧を確認できます。' },
      );
    }
    source = await openOrExit(store, latest.id);
  }

  if (source) {
    if (source.header.kind !== init.kind) {
      throw new ExitError(
        EXIT.usage,
        `会話 ${source.id} は ${source.header.kind === 'agent' ? 'akari run' : 'akari chat'} の会話です。`,
        {
          hint: `続けるには ${source.header.kind === 'agent' ? 'akari run' : 'akari chat'} --conversation ${source.id}`,
        },
      );
    }
    // 前の会話は前のフォルダのファイルを前提にしている。混ぜない（10-cli.md）
    if (init.kind === 'agent' && source.header.workspace !== init.workspace) {
      throw new ExitError(
        EXIT.usage,
        `この会話の作業フォルダは ${tildify(source.header.workspace ?? '(なし)')} です。今の作業フォルダ（${tildify(init.workspace ?? '')}）では続けられません。`,
        { hint: `-C ${source.header.workspace ?? ''} を付けて実行してください。` },
      );
    }
    if (source.readOnly && save) {
      throw new ExitError(
        EXIT.usage,
        `会話 ${source.id} は新しい版の Akari で保存されているため、続きを書き込めません。`,
        { hint: 'Akari を更新するか、--no-save で読むだけにしてください。' },
      );
    }
    for (const p of source.problems) note(p.message);
  }

  const history = source
    ? toApiMessages(source.thread(), { dropFailedTurns: init.kind === 'chat' })
    : [];
  const target = !save ? null : (source ?? (await store.create(init)));
  return { target, history, continued: source !== null, source };
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

/** 保存に失敗しても会話そのものは続ける。ただし黙らない（最初の1回だけ知らせる）。 */
export function safeSaver(): (task: () => Promise<unknown>) => Promise<void> {
  let warned = false;
  return async (task) => {
    try {
      await task();
    } catch (err) {
      if (warned) return;
      warned = true;
      const pe = getProviderError(err);
      note(
        `会話の保存に失敗しました。続けますが、記録が欠けます: ${pe?.message ?? (err as Error).message}`,
      );
    }
  };
}

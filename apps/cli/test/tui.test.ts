import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { render } from 'ink';
import { ConversationStore, Workspace } from '@akari/core';
import type { ChatEvent, ChatRequest, Provider } from '@akari/core';
import {
  InputHistory,
  backslashNewline,
  backspace,
  down,
  emptyEditor,
  insert,
  layout,
  left,
  up,
} from '../dist/tui/editor.js';
import { Controller } from '../dist/tui/controller.js';
import { App } from '../dist/tui/App.js';
import { newlineHint } from '../dist/tui/lines.js';
import { createContext } from '../dist/context.js';
import { chooseConversation } from '../dist/conversation.js';

/**
 * 対話画面。仕様: docs/spec/17-interactive.md
 * 画面（Ink）なしで中身（Controller）を試し、最後に画面へキーを送って通しで確かめる。
 */

// ---------------- 入力欄の編集 ----------------

test('入力欄: 全角を幅2で数え、カーソル位置を折り返しに合わせて返す', () => {
  const s = insert(emptyEditor, 'あいうえお');
  assert.deepEqual(layout(s, 20), { rows: ['あいうえお'], cursorRow: 0, cursorCol: 10 });
  const wrapped = layout(s, 6);
  assert.deepEqual(wrapped.rows, ['あいう', 'えお']);
  assert.equal(wrapped.cursorRow, 1);
  assert.equal(wrapped.cursorCol, 4);
  const moved = left(left(s));
  assert.equal(layout(moved, 20).cursorCol, 6);
});

test('入力欄: 改行は行として扱い、↑↓ は行の移動を先にする', () => {
  let s = insert(emptyEditor, '一行目');
  s = insert(s, '\n');
  s = insert(s, '二');
  assert.deepEqual(layout(s, 20).rows, ['一行目', '二']);
  const upped = up(s)!;
  assert.equal(upped.cursor, 1, '幅で同じくらいの位置へ（「二」の後ろ＝幅2）');
  assert.equal(up(upped), null, '先頭行で ↑ は履歴へ回す');
  assert.ok(down(upped));
  assert.equal(down(s), null);
});

test('入力欄: 貼り付けの CRLF は改行1つ。絵文字を半分だけ消さない', () => {
  assert.equal(insert(emptyEditor, 'a\r\nb\rc').text, 'a\nb\nc');
  const s = insert(emptyEditor, 'x😀');
  assert.equal(backspace(s).text, 'x');
});

test('入力欄: 「\\」+ Enter で改行。macOS 標準のターミナルでは Shift+Enter を案内しない', () => {
  const s = insert(emptyEditor, '一行目\\');
  assert.deepEqual(backslashNewline(s), { text: '一行目\n', cursor: 4 });
  assert.equal(backslashNewline(insert(emptyEditor, '普通')), null, '直前が \\ でなければ送信');
  assert.match(newlineHint({ TERM_PROGRAM: 'Apple_Terminal' }), /Shift\+Enter を区別できません/);
  assert.match(newlineHint({ TERM_PROGRAM: 'ghostty' }), /^改行は Shift\+Enter/);
});

test('入力欄: 履歴は書きかけを残し、戻ってくると返す', () => {
  const h = new InputHistory();
  h.push('一つ目');
  h.push('二つ目');
  assert.equal(h.prev('書きかけ'), '二つ目');
  assert.equal(h.prev(''), '一つ目');
  assert.equal(h.prev(''), null);
  assert.equal(h.next(), '二つ目');
  assert.equal(h.next(), '書きかけ');
});

// ---------------- 中身（Controller） ----------------

type Step = { text: string } | { tool: string; args: unknown };

function fakeProvider(steps: Step[]): Provider & { calls: ChatRequest[] } {
  let turn = 0;
  const calls: ChatRequest[] = [];
  return {
    endpointId: 'ep_tui',
    calls,
    async listModels() {
      return [{ id: 'm1' }, { id: 'm2' }];
    },
    async probe() {
      throw new Error('使わない');
    },
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
      calls.push(structuredClone(req));
      const step = steps[turn++] ?? { text: '（台本の終わり）' };
      yield { type: 'start', model: req.model };
      if ('text' in step) {
        yield { type: 'text-delta', text: step.text };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield {
        type: 'tool-call',
        id: `call_${turn}`,
        name: step.tool,
        argumentsRaw: JSON.stringify(step.args),
      };
      yield { type: 'finish', reason: 'tool_calls' };
    },
  } as Provider & { calls: ChatRequest[] };
}

async function setup(files: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-tui-')));
  const root = path.join(base, 'work');
  const home = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  for (const [p, content] of Object.entries(files)) await fs.writeFile(path.join(root, p), content);
  process.env.AKARI_HOME = home;
  const ctx = await createContext({});
  const workspace = await Workspace.open(root, home);
  return { root, home, ctx, workspace };
}

const endpoint = {
  id: 'ep_tui',
  name: '試験',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: null,
  isExternal: false,
  timeoutMs: 1000,
  capabilities: {},
} as never;

async function agentController(
  steps: Step[],
  opts: { files?: Record<string, string>; permission?: 'ask' | 'autoEdit' | 'full' } = {},
) {
  const env = await setup(opts.files);
  const provider = fakeProvider(steps);
  const conversation = await chooseConversation(
    env.ctx,
    {},
    {
      kind: 'agent',
      workspace: env.workspace.root,
      settings: { endpointId: 'ep_tui', model: 'm1' },
    },
  );
  const controller = new Controller({
    ctx: env.ctx,
    endpoint,
    provider,
    model: 'm1',
    conversation,
    save: true,
    setup: {
      kind: 'agent',
      workspace: env.workspace,
      permission: opts.permission ?? 'ask',
      scope: 'all',
      forced: null,
      toolsMode: 'native',
      maxSteps: 10,
    },
    version: 'test',
  });
  return { ...env, provider, controller, conversation };
}

/** 画面に出た文字（流れていく分）を1つの文字列にする。 */
function shown(c: InstanceType<typeof Controller>): string {
  return c
    .getSnapshot()
    .items.map((it) =>
      it.kind === 'user' || it.kind === 'assistant'
        ? it.text
        : it.lines.map((l) => l.map((s) => s.text).join('')).join('\n'),
    )
    .join('\n');
}

/** 状態が条件を満たすまで待つ（実行は非同期に進むため）。 */
async function until(c: InstanceType<typeof Controller>, cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`待ちきれませんでした:\n${shown(c)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('送ると、道具の呼び出し・結果・応答・終わり方が流れ、1回ごとに記録される', async () => {
  const { controller, root, home, conversation } = await agentController(
    [
      { tool: 'write_file', args: { path: 'a.txt', content: 'x\n' } },
      { text: '書きました' },
      { text: '2回目です' },
    ],
    { permission: 'full' },
  );
  await controller.submit('a.txt を書いて');
  const text = shown(controller);
  assert.match(text, /a\.txt を書いて/);
  assert.match(text, /write_file a\.txt/);
  assert.match(text, /✓/);
  assert.match(text, /書きました/);
  assert.match(text, /完了/);
  assert.match(text, /変更したファイル \(1\)/);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'x\n');

  await controller.submit('もう一度');
  const conv = await new ConversationStore(home).open(conversation.target!.id);
  assert.equal(conv.header.runs.length, 2, '送るたびに1つの実行');
  assert.notEqual(conv.header.runs[0]!.runId, conv.header.runs[1]!.runId);
  assert.ok(conv.header.runs.every((r) => r.reason === 'done'));
});

test('承認: 選択肢が出て、選ぶと続く。拒否なら理由を入れられ、モデルへ伝わる', async () => {
  const { controller, root, provider } = await agentController([
    { tool: 'write_file', args: { path: 'a.txt', content: 'x\n' } },
    { text: '書きました' },
    { tool: 'write_file', args: { path: 'b.txt', content: 'y\n' } },
    { text: 'やめました' },
  ]);
  const first = controller.submit('a を書いて');
  await until(controller, () => controller.getSnapshot().dialog !== null);
  const dialog = controller.getSnapshot().dialog!;
  assert.equal(dialog.title, '承認が必要です');
  assert.ok(
    dialog.body.some((l) => l.some((s) => s.text.startsWith('+x'))),
    '差分が出る',
  );
  assert.deepEqual(
    dialog.options.map((o) => o.key),
    ['y', 'a', 'n', 'q'],
  );
  controller.moveSelection(1);
  controller.moveSelection(-1);
  controller.chooseSelected();
  await first;
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'x\n');

  const second = controller.submit('b を書いて');
  await until(controller, () => controller.getSnapshot().dialog !== null);
  assert.equal(controller.pickByKey('z'), false, '無いキーは何もしない');
  controller.pickByKey('n');
  await until(controller, () => controller.getSnapshot().inputHint !== null);
  await controller.submit('いらない');
  await second;
  await assert.rejects(() => fs.stat(path.join(root, 'b.txt')));
  assert.match(shown(controller), /拒否（理由: いらない）/);
  const last = provider.calls.at(-1)!;
  assert.ok(
    last.messages.some((m) => m.role === 'tool' && m.content.includes('いらない')),
    '理由がモデルへ渡る',
  );
});

test('承認中の Esc は理由を聞かずに拒否する', async () => {
  const { controller, root } = await agentController([
    { tool: 'write_file', args: { path: 'a.txt', content: 'x\n' } },
    { text: '了解' },
  ]);
  const p = controller.submit('書いて');
  await until(controller, () => controller.getSnapshot().dialog !== null);
  controller.escape();
  await p;
  assert.equal(controller.getSnapshot().inputHint, null);
  await assert.rejects(() => fs.stat(path.join(root, 'a.txt')));
});

test('/ コマンド: 知らないものはモデルへ送らない。権限と道具を変えられる', async () => {
  const { controller, provider } = await agentController([{ text: 'はい' }]);
  await controller.submit('/nosuch');
  assert.match(shown(controller), /知らないコマンドです: \/nosuch/);
  assert.equal(provider.calls.length, 0);

  await controller.submit('/permission full');
  assert.equal(controller.getSnapshot().status.permission, 'full');
  controller.cyclePermission();
  assert.equal(controller.getSnapshot().status.permission, 'ask', 'Shift+Tab で一周する');

  await controller.submit('/tools read-only');
  assert.match(controller.getSnapshot().status.tools, /読み取りのみ/);
  await controller.submit('こんにちは');
  assert.deepEqual(provider.calls[0]!.tools?.map((t) => t.name).sort(), [
    'glob',
    'grep',
    'list_dir',
    'read_file',
  ]);
});

test('/undo は確かめてから、直前の実行の変更を戻す', async () => {
  const { controller, root } = await agentController(
    [{ tool: 'write_file', args: { path: 'a.txt', content: '新\n' } }, { text: '書きました' }],
    { files: { 'a.txt': '元\n' }, permission: 'full' },
  );
  await controller.submit('書き換えて');
  const undo = controller.submit('/undo');
  await until(controller, () => controller.getSnapshot().dialog !== null);
  assert.match(controller.getSnapshot().dialog!.title, /戻します/);
  controller.pickByKey('y');
  await undo;
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '元\n');
  assert.match(shown(controller), /a\.txt を戻しました/);
});

test('/ コマンドが失敗しても画面ごと落とさず、失敗として出す', async () => {
  const { controller, provider } = await agentController([{ text: 'はい' }]);
  provider.listModels = async () => {
    throw new Error('つながりません');
  };
  await controller.submit('/model m2');
  assert.match(shown(controller), /モデル一覧を取れませんでした: つながりません/);
  assert.equal(controller.isBusy, false);
  await controller.submit('まだ使える');
  assert.match(shown(controller), /はい/);
});

test('/new で新しい会話になり、前の会話は残る', async () => {
  const { controller, home, conversation } = await agentController([
    { text: '一' },
    { text: '二' },
  ]);
  await controller.submit('最初');
  await controller.submit('/new');
  await controller.submit('次');
  const { items } = await new ConversationStore(home).list();
  assert.equal(items.length, 2);
  assert.ok(items.some((c) => c.id === conversation.target!.id));
  assert.match(controller.farewell(), /akari -c/);
});

test('道具なしの会話: chat として保存し、/tools は使えないと言う', async () => {
  const env = await setup();
  const provider = fakeProvider([{ text: 'やあ' }]);
  const conversation = await chooseConversation(
    env.ctx,
    {},
    { kind: 'chat', workspace: null, settings: { endpointId: 'ep_tui', model: 'm1' } },
  );
  const controller = new Controller({
    ctx: env.ctx,
    endpoint,
    provider,
    model: 'm1',
    conversation,
    save: true,
    setup: {
      kind: 'chat',
      reason: 'ホームディレクトリそのものを作業フォルダにはできません',
      params: { temperature: 0.7, maxTokens: null },
    },
    version: 'test',
  });
  assert.match(shown(controller), /道具なしの会話で始めます/);
  await controller.submit('こんにちは');
  assert.match(shown(controller), /やあ/);
  assert.equal(provider.calls[0]!.tools, undefined, '道具を渡さない');
  await controller.submit('/tools all');
  assert.match(shown(controller), /道具なしの会話では/);
  const conv = await new ConversationStore(env.home).open(conversation.target!.id);
  assert.equal(conv.header.kind, 'chat');
  assert.equal(conv.thread().length, 2);
  assert.match(controller.farewell(), /akari chat -c/);
});

// ---------------- 画面へキーを送る ----------------

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 30;
  isTTY = true;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => this.queue.shift() ?? null;
  type(data: string) {
    this.queue.push(data);
    this.emit('readable');
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('画面: 打った文字が入力欄に出て、Enter で送られ、Shift+Enter（kitty 方式）は改行', async () => {
  const { controller, provider } = await agentController([{ text: '返事です' }]);
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = render(createElement(App, { controller }), {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout() as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await tick();
    stdin.type('一行目');
    await tick();
    stdin.type('\u001b[13;2u');
    await tick();
    stdin.type('二行目\\');
    await tick();
    stdin.type('\r');
    await tick();
    stdin.type('三行目');
    await tick();
    assert.match(stdout.frames.at(-1)!, /一行目/);
    assert.match(stdout.frames.at(-1)!, /二行目/);
    stdin.type('\r');
    await until(controller, () => provider.calls.length > 0 && !controller.isBusy);
    assert.equal(
      provider.calls[0]!.messages.at(-1)!.content,
      '一行目\n二行目\n三行目',
      'Shift+Enter と「\\」+ Enter の改行ごと送る',
    );
    await tick();
    assert.match(stdout.frames.join(''), /返事です/);

    // Ctrl+C 2回で閉じる
    stdin.type('\u0003');
    await tick();
    assert.match(stdout.frames.at(-1)!, /もう一度 Ctrl\+C で終了/);
    stdin.type('\u0003');
    await Promise.race([app.waitUntilExit(), tick(2000)]);
  } finally {
    app.unmount();
  }
});

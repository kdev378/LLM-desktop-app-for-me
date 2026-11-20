import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidForApi } from './api-shape.ts';
import { ConversationStore, toApiMessages, type StoredMessage } from '../dist/index.js';

/**
 * 会話の保存。仕様: docs/spec/04-chat.md / docs/spec/07-data.md
 * 生の記録を失わないこと、壊れたものを黙って捨てないことを重点的に見る。
 */

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'akari-store-'));
  return { root, store: new ConversationStore(root) };
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

/** すでに終わったプロセスの PID。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

// ---------------- 基本 ----------------

test('書いたメッセージを、別のインスタンスから同じ順で読める', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  await conv.append({ role: 'user', content: text('README を直して') });
  await conv.append({
    role: 'assistant',
    content: text('読みます'),
    reasoning: 'まず読む',
    toolCalls: [
      { id: 'c1', name: 'read_file', argumentsRaw: '{"path":"README.md"}', origin: 'native' },
    ],
  });
  await conv.append({
    role: 'tool',
    content: text('# 中身'),
    toolCallId: 'c1',
    toolName: 'read_file',
    ok: true,
    origin: 'native',
  });

  const again = await new ConversationStore(root).open(conv.id);
  assert.deepEqual(
    again.thread().map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.equal(again.thread()[1]!.reasoning, 'まず読む', '思考も残る');
  assert.equal(again.header.title, 'README を直して', '最初の入力がタイトルになる');
  assert.equal(again.header.messageCount, 3);
  assert.equal(again.problems.length, 0);
});

test('タイトルは最初の入力の先頭40文字', async () => {
  const { store } = await tmpStore();
  const conv = await store.create({ kind: 'chat', workspace: null });
  await conv.append({ role: 'user', content: text('あ'.repeat(60)) });
  assert.equal(conv.header.title, 'あ'.repeat(40) + '…');
});

test('一覧は更新の新しい順で、種類と作業フォルダで絞れる', async () => {
  const { store } = await tmpStore();
  const a = await store.create({ kind: 'agent', workspace: '/a' });
  await a.append({ role: 'user', content: text('1') });
  const b = await store.create({ kind: 'chat', workspace: null });
  await b.append({ role: 'user', content: text('2') });
  const c = await store.create({ kind: 'agent', workspace: '/a' });
  await c.append({ role: 'user', content: text('3') });

  const all = await store.list();
  assert.deepEqual(
    all.items.map((h) => h.id),
    [c.id, b.id, a.id],
  );
  const agentsHere = await store.list({ kind: 'agent', workspace: '/a' });
  assert.deepEqual(
    agentsHere.items.map((h) => h.id),
    [c.id, a.id],
  );
  assert.equal((await store.latest({ kind: 'chat' }))?.id, b.id);
  assert.equal((await store.list({ limit: 1 })).items.length, 1);
});

test('ID は一意に決まる前方一致で開ける。複数に当たれば推測しない', async () => {
  const { store } = await tmpStore();
  const conv = await store.create({ kind: 'chat', workspace: null });
  assert.equal((await store.open(conv.id.slice(0, 20))).id, conv.id);
  assert.equal((await store.open(conv.id.toLowerCase())).id, conv.id, '小文字でもよい');
  await assert.rejects(() => store.open('ZZZZZZZZ'), /見つかりません/);

  // 同じミリ秒に作れば先頭10文字（時刻部分）が同じになる。その前方一致は曖昧
  const other = await store.create({ kind: 'chat', workspace: null });
  const common = commonPrefix(conv.id, other.id);
  if (common.length > 0) {
    await assert.rejects(() => store.open(common), /件あります/);
  }
});

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

// ---------------- 壊れたときに失わない ----------------

test('途中で切れた最後の行は、消さずに残して知らせる。次の追記は新しい行から始まる', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  await conv.append({ role: 'user', content: text('一') });
  // 書き込みの途中で落ちた状態を作る
  await fs.appendFile(store.messagesPath(conv.id), '{"id":"01BROKEN","role":"assis');

  const opened = await new ConversationStore(root).open(conv.id);
  assert.equal(opened.all().length, 1, '読める行は読む');
  assert.ok(
    opened.problems.some((p) => /最後の行/.test(p.message)),
    '何が起きたかを知らせる',
  );

  await opened.append({ role: 'user', content: text('二') });
  const raw = await fs.readFile(store.messagesPath(conv.id), 'utf8');
  assert.ok(raw.includes('"role":"assis\n'), '壊れた行は残っていて、次の行と繋がっていない');

  const reopened = await new ConversationStore(root).open(conv.id);
  assert.deepEqual(
    reopened.all().map((m) => (m.content[0] as { text: string }).text),
    ['一', '二'],
  );
  assert.ok(reopened.problems.some((p) => /読めません/.test(p.message)));
});

test('メッセージの形でない行と、同じIDの行を知らせる', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  const m = await conv.append({ role: 'user', content: text('一') });
  await fs.appendFile(
    store.messagesPath(conv.id),
    '{"hello":"world"}\n' + JSON.stringify(m) + '\n',
  );
  const opened = await new ConversationStore(root).open(conv.id);
  assert.equal(opened.all().length, 1);
  assert.ok(opened.problems.some((p) => /形をしていません/.test(p.message)));
  assert.ok(opened.problems.some((p) => /前にもあります/.test(p.message)));
});

test('見出しの知らない項目は、書き直しても消えない', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  const file = store.headerPath(conv.id);
  const header = JSON.parse(await fs.readFile(file, 'utf8'));
  header.futureField = { keep: true };
  await fs.writeFile(file, JSON.stringify(header));

  const opened = await new ConversationStore(root).open(conv.id);
  await opened.append({ role: 'user', content: text('一') });
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.futureField, { keep: true });
});

test('新しい版で保存された会話は読むだけにして、書き込まない', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  await conv.append({ role: 'user', content: text('一') });
  const file = store.headerPath(conv.id);
  const header = JSON.parse(await fs.readFile(file, 'utf8'));
  header.schemaVersion = 2;
  await fs.writeFile(file, JSON.stringify(header));
  const before = await fs.readFile(store.messagesPath(conv.id), 'utf8');

  const opened = await new ConversationStore(root).open(conv.id);
  assert.equal(opened.readOnly, true);
  assert.equal(opened.thread().length, 1, '読むことはできる');
  assert.ok(opened.problems.some((p) => /読むだけ/.test(p.message)));
  await assert.rejects(
    () => opened.append({ role: 'user', content: text('二') }),
    /書き込めません/,
  );
  assert.equal(await fs.readFile(store.messagesPath(conv.id), 'utf8'), before, '何も書かない');
});

// ---------------- 落ちたプロセスの後始末 ----------------

test('落ちたプロセスの生成途中の応答を、途中で止まった応答として残す', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  await conv.append({ role: 'user', content: text('書いて') });
  await fs.writeFile(
    store.inflightPath(conv.id),
    JSON.stringify({
      schemaVersion: 1,
      pid: await deadPid(),
      runId: 'RUN1',
      step: 1,
      startedAt: new Date().toISOString(),
      text: 'ここまで書い',
      reasoning: '考え中',
    }),
  );

  const opened = await new ConversationStore(root).open(conv.id);
  const last = opened.thread().at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal((last.content[0] as { text: string }).text, 'ここまで書い');
  assert.equal(last.reasoning, '考え中');
  assert.equal(last.meta.finishReason, 'aborted');
  assert.equal(last.meta.interrupted, 'process-exit');
  await assert.rejects(() => fs.stat(store.inflightPath(conv.id)), '途中経過のファイルは片付ける');
  assert.ok(opened.problems.some((p) => /途中で止まった応答/.test(p.message)));
});

test('生きているプロセスの途中経過は、実行中とみなして触らない', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await fs.writeFile(
      store.inflightPath(conv.id),
      JSON.stringify({
        schemaVersion: 1,
        pid: child.pid,
        runId: 'RUN1',
        step: 1,
        startedAt: new Date().toISOString(),
        text: '生成中',
        reasoning: '',
      }),
    );
    const opened = await new ConversationStore(root).open(conv.id);
    assert.equal(opened.all().length, 0, '勝手に確定させない');
    assert.ok(opened.problems.some((p) => /実行中/.test(p.message)));
    await fs.stat(store.inflightPath(conv.id));
  } finally {
    child.kill();
  }
});

test('終わりの記録が無いまま落ちた実行は「途中で終わった」と記録する', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  const file = store.headerPath(conv.id);
  const header = JSON.parse(await fs.readFile(file, 'utf8'));
  header.runs = [
    {
      runId: 'R1',
      startedAt: new Date().toISOString(),
      model: 'm',
      endpointId: 'e',
      pid: await deadPid(),
    },
  ];
  await fs.writeFile(file, JSON.stringify(header));
  const opened = await new ConversationStore(root).open(conv.id);
  assert.equal(opened.header.runs[0]!.reason, 'interrupted');
});

// ---------------- ゴミ箱 ----------------

test('削除はゴミ箱へ移すだけ。30日を過ぎたものだけ消える', async () => {
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'chat', workspace: null });
  await conv.append({ role: 'user', content: text('一') });
  const r = await store.trash(conv.id);
  assert.equal(r.messageCount, 1);
  assert.equal((await store.list()).items.length, 0, '一覧から消える');
  const trashed = path.join(root, 'trash', 'conversations', conv.id);
  await fs.stat(path.join(trashed, `${conv.id}.messages.jsonl`));

  assert.equal(await store.purgeTrash(Date.now() + 29 * 86400_000), 0, '30日前は消さない');
  assert.equal(await store.purgeTrash(Date.now() + 31 * 86400_000), 1);
  await assert.rejects(() => fs.stat(trashed));
});

test('いつ消されたか分からないゴミ箱の中身は、自動では消さない', async () => {
  const { root, store } = await tmpStore();
  const stray = path.join(root, 'trash', 'conversations', 'UNKNOWN');
  await fs.mkdir(stray, { recursive: true });
  await fs.writeFile(path.join(stray, 'x.json'), '{}');
  assert.equal(await store.purgeTrash(Date.now() + 365 * 86400_000), 0);
  await fs.stat(stray);
});

// ---------------- 同時に書く ----------------

test('2つのプロセスから同じ会話へ同時に追記しても、メッセージは全部残る', async () => {
  // 仕様（07-data.md）: 後勝ちになるのは見出しだけ。Linux でのみ確認している
  const { root, store } = await tmpStore();
  const conv = await store.create({ kind: 'agent', workspace: '/w' });
  const script = `
    const { ConversationStore } = await import(${JSON.stringify(DIST)});
    const conv = await new ConversationStore(process.argv[1]).open(process.argv[2]);
    const big = 'x'.repeat(8000);
    for (let i = 0; i < 150; i++) {
      await conv.append({ role: 'user', content: [{ type: 'text', text: process.argv[3] + i + big }] });
    }`;
  const run = (tag: string) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script, root, conv.id, tag], {
        stdio: 'inherit',
      });
      p.on('exit', (code) => resolve(code ?? 1));
    });
  const codes = await Promise.all([run('A'), run('B')]);
  assert.deepEqual(codes, [0, 0]);

  const opened = await new ConversationStore(root).open(conv.id);
  assert.equal(opened.problems.length, 0, '混ざった行が無い');
  const texts = opened.all().map((m) => (m.content[0] as { text: string }).text);
  assert.equal(texts.filter((t) => t.startsWith('A')).length, 150);
  assert.equal(texts.filter((t) => t.startsWith('B')).length, 150);
});

// ---------------- 送るメッセージの組み立て ----------------

let n = 0;
function msg(m: Partial<StoredMessage> & Pick<StoredMessage, 'role'>): StoredMessage {
  n += 1;
  return {
    id: `M${n}`,
    parentId: null,
    content: text(''),
    meta: { createdAt: '2026-10-27T00:00:00.000Z' },
    ...m,
  };
}

test('関数呼び出しの記録は、tool メッセージとして組み立てる', () => {
  const api = toApiMessages([
    msg({ role: 'user', content: text('読んで') }),
    msg({
      role: 'assistant',
      content: text(''),
      toolCalls: [{ id: 'c1', name: 'read_file', argumentsRaw: '{}', origin: 'native' }],
    }),
    msg({
      role: 'tool',
      content: text('中身'),
      toolCallId: 'c1',
      toolName: 'read_file',
      ok: true,
      origin: 'native',
    }),
  ]);
  assert.deepEqual(
    api.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assertValidForApi(api);
});

test('本文ブロックで呼んだ記録は、今の方式に関係なく本文ブロックの形で再現する', () => {
  const api = toApiMessages([
    msg({ role: 'user', content: text('読んで') }),
    msg({
      role: 'assistant',
      content: text('```akari-tool\n{"name":"read_file"}\n```'),
      toolCalls: [{ id: 'p1', name: 'read_file', argumentsRaw: '{}', origin: 'prompted' }],
    }),
    msg({
      role: 'tool',
      content: text('中身'),
      toolCallId: 'p1',
      toolName: 'read_file',
      ok: true,
      origin: 'prompted',
    }),
  ]);
  assert.equal(api[1]!.toolCalls, undefined, '関数呼び出しとしては送らない');
  assert.equal(api[2]!.role, 'user');
  assert.match(api[2]!.content, /\[akari-tool-result\]/);
  assertValidForApi(api);
});

test('結果の無い呼び出しには「実行されませんでした」を補う', () => {
  const api = toApiMessages([
    msg({ role: 'user', content: text('2つ読んで') }),
    msg({
      role: 'assistant',
      content: text(''),
      toolCalls: [
        { id: 'c1', name: 'read_file', argumentsRaw: '{}', origin: 'native' },
        { id: 'c2', name: 'read_file', argumentsRaw: '{}', origin: 'native' },
      ],
    }),
    msg({
      role: 'tool',
      content: text('中身'),
      toolCallId: 'c1',
      toolName: 'read_file',
      ok: true,
      origin: 'native',
    }),
    // ここでプロセスが落ち、c2 の結果が無いまま、利用者が続きを頼んだ
    msg({ role: 'user', content: text('続けて') }),
  ]);
  assertValidForApi(api);
  assert.match(api[3]!.content, /実行されませんでした/);
  assert.equal(api[4]!.role, 'user');
});

test('思考は送らない。失敗した応答は送らない。停止した途中の本文は送る', () => {
  const api = toApiMessages([
    msg({ role: 'user', content: text('一') }),
    msg({ role: 'assistant', content: text('答え'), reasoning: '長い思考' }),
    msg({ role: 'user', content: text('二') }),
    msg({
      role: 'assistant',
      content: text(''),
      meta: { createdAt: 'x', error: { kind: 'unreachable', message: '繋がらない' } as never },
    }),
    msg({ role: 'user', content: text('三') }),
    msg({
      role: 'assistant',
      content: text('途中ま'),
      meta: { createdAt: 'x', finishReason: 'aborted' },
    }),
  ]);
  assert.deepEqual(
    api.map((m) => `${m.role}:${m.content}`),
    ['user:一', 'assistant:答え', 'user:二', 'user:三', 'assistant:途中ま'],
  );
  assert.ok(!api.some((m) => m.content.includes('長い思考')));
});

test('chat では失敗した往復を外し、エージェントでは外さない', () => {
  const thread = [
    msg({ role: 'user', content: text('一') }),
    msg({ role: 'assistant', content: text('答え') }),
    msg({ role: 'user', content: text('二') }),
    msg({
      role: 'assistant',
      content: text(''),
      meta: { createdAt: 'x', error: { kind: 'unreachable', message: '繋がらない' } as never },
    }),
    msg({ role: 'user', content: text('三') }),
  ];
  assert.deepEqual(
    toApiMessages(thread, { dropFailedTurns: true }).map((m) => m.content),
    ['一', '答え', '三'],
    'chat: 交互の並びを保つ',
  );
  assert.deepEqual(
    toApiMessages(thread).map((m) => m.content),
    ['一', '答え', '二', '三'],
    'エージェント: 頼んだことを消さない',
  );
});

test(
  '会話のファイルは本人だけが読める（POSIX）',
  { skip: process.platform === 'win32' },
  async () => {
    // エージェントが読んだファイルの中身やコマンドの出力が入るため
    const { store } = await tmpStore();
    const conv = await store.create({ kind: 'agent', workspace: '/w' });
    await conv.append({ role: 'user', content: text('一') });
    await conv.setInflight({ text: '途中', reasoning: '', step: 1, runId: 'R' });
    for (const file of [
      store.headerPath(conv.id),
      store.messagesPath(conv.id),
      store.inflightPath(conv.id),
    ]) {
      const mode = (await fs.stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, `${path.basename(file)} の権限が ${mode.toString(8)}`);
    }
  },
);

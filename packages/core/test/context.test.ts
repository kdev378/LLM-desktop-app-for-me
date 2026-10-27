import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  Workspace,
  Session,
  ConversationStore,
  toTranscript,
  parseDigest,
  selectForCompaction,
  compactThreshold,
  defaultConfig,
  type ChatEvent,
  type ChatRequest,
  type ChatMessage,
  type Provider,
  type RunEvent,
  type TranscriptEntry,
} from '../dist/index.js';
import { assertValidForApi } from './api-shape.ts';

/**
 * 文脈の圧縮と recall。仕様: docs/spec/16-context.md
 * いちばん落ちやすいのは「圧縮してもターンの境界が壊れないこと」なので、
 * 送ったすべてのリクエストで呼び出しと結果の対応を確かめる。
 */

const fence = (obj: unknown) => '```akari-digest\n' + JSON.stringify(obj) + '\n```';
const isDigestCall = (req: ChatRequest) =>
  req.messages[0]?.content.startsWith('あなたは作業記録の要約係') === true;

type Call = { tool: string; args: unknown };
/** calls は1手で複数の道具を呼ぶ（モデルがまとめて読むとき）。 */
type Step = { text: string } | Call | { calls: Call[] };

/**
 * 作業の呼び出しには台本どおりに、圧縮の呼び出しには digest() の返す文字列で答える。
 * 送られてきたリクエストは、送った時点の形で控える。
 */
function provider(
  steps: Step[],
  digest: (req: ChatRequest, n: number) => string = (req) => fence(validDigestFor(req)),
  usage?: (req: ChatRequest) => number,
) {
  let turn = 0;
  let digestCalls = 0;
  const work: ChatRequest[] = [];
  const digests: ChatRequest[] = [];
  const p: Provider = {
    endpointId: 'ep_ctx',
    async listModels() {
      return [{ id: 'm' }];
    },
    async probe(): Promise<never> {
      throw new Error('使わない');
    },
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
      const snapshot = structuredClone(req);
      yield { type: 'start', model: req.model };
      if (isDigestCall(req)) {
        digests.push(snapshot);
        yield { type: 'text-delta', text: digest(req, digestCalls++) };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      work.push(snapshot);
      const step = steps[turn++] ?? { text: '終わりです。' };
      const u = usage
        ? { usage: { prompt: usage(req), completion: 5, total: usage(req) + 5 } }
        : {};
      if ('text' in step) {
        yield { type: 'text-delta', text: step.text };
        yield { type: 'finish', reason: 'stop', ...u };
        return;
      }
      const calls = 'calls' in step ? step.calls : [step];
      for (const [i, c] of calls.entries()) {
        yield {
          type: 'tool-call',
          id: `call_${turn}_${i}`,
          name: c.tool,
          argumentsRaw: JSON.stringify(c.args),
        };
      }
      yield { type: 'finish', reason: 'tool_calls', ...u };
    },
  };
  return { p, work, digests };
}

/** 圧縮の呼び出しに含まれる ID のうち、最初のものを根拠にした正しい Digest。 */
function validDigestFor(req: ChatRequest) {
  const ids = [...req.messages[1]!.content.matchAll(/\[ID ([0-9A-Z]{26})\]/g)].map((m) => m[1]);
  return {
    decisions: [{ text: 'big.txt を読んで中身を確かめることにした', sources: ids.slice(0, 1) }],
    confirmed: [{ text: 'big.txt は大きい', sources: ids.slice(0, 2) }],
    rejected: [{ text: 'grep では見つからなかった。名前が違ったため', sources: ids.slice(0, 1) }],
    open: [],
    next: [{ text: '残りを読む', sources: [] }],
  };
}

async function setup(files: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-ctx-')));
  const root = path.join(base, 'work');
  const home = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  for (const [p, content] of Object.entries(files)) await fs.writeFile(path.join(root, p), content);
  return { root, home, workspace: await Workspace.open(root, home) };
}

async function run(session: Session, input: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of session.send(input)) {
    events.push(ev);
    if (ev.type === 'approval-request') session.approve(ev.callId, { kind: 'allow' });
  }
  return events;
}

const settings = (over: Partial<ReturnType<typeof defaultConfig>['context']> = {}) => ({
  ...defaultConfig().context,
  ...over,
});

// 1ファイル約8000文字（≒3600トークン、概算）。同じ呼び出しの繰り返しで止まらないよう、別々のファイルを読ませる
const BIG = Array.from({ length: 80 }, (_, i) => `${i}行目 ${'あいうえお'.repeat(19)}`).join('\n');
const bigFiles = (extra = '') =>
  Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`big${i + 1}.txt`, BIG + extra]));
const readBig = (i: number): Step => ({ tool: 'read_file', args: { path: `big${i}.txt` } });

// ---------------- 部品 ----------------

test('圧縮版は厳格に読む。空の分類の省略だけは許す', () => {
  const known = new Set(['A', 'B']);
  const ok = parseDigest(fence({ decisions: [{ text: '決めた', sources: ['A'] }] }), known);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.digest.decisions[0]!.text, '決めた');
  assert.deepEqual(ok.ok && ok.digest.rejected, [], '省いた分類は空として扱う');

  assert.equal(parseDigest('{"decisions":[]}', known).ok, false, 'フェンスが無ければ読まない');
  assert.equal(parseDigest('```akari-digest\n{decisions:[]}\n```', known).ok, false);
  assert.equal(parseDigest(fence({ decisions: [42] }), known).ok, false, '形が違えば推測しない');
  assert.equal(
    parseDigest(fence({ decisions: [{ sources: ['A'] }] }), known).ok,
    false,
    '本文の無い項目は受け付けない',
  );
});

test('項目が文字列だけなら、根拠の無い項目として受け付ける（小さいモデルがこう書く）', () => {
  // Granite 8B が "next": ["残りを読む"] のように書き、全部を捨てて機械的な要約へ落ちていた
  const r = parseDigest(
    fence({ decisions: [{ text: '決めた', sources: ['A'] }], next: ['残りを読む'] }),
    new Set(['A']),
  );
  assert.ok(r.ok);
  assert.deepEqual(
    r.ok && r.digest.next,
    [{ text: '残りを読む', sources: [] }],
    '根拠は空として残す',
  );
  assert.equal(r.ok && r.bareItems, 1);
});

test('知らない ID を根拠にした項目は、残したうえで根拠を空にする', () => {
  const r = parseDigest(
    fence({ confirmed: [{ text: '事実', sources: ['A', 'ZZZ'] }] }),
    new Set(['A']),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.digest.confirmed[0], { text: '事実', sources: [] });
  assert.equal(r.ok && r.unknownSources, 1);
});

test('圧縮する範囲は、最初の依頼・最新の依頼・直近の手を残し、手の途中では切らない', () => {
  const e = (id: string, role: TranscriptEntry['role'], extra: Partial<TranscriptEntry> = {}) =>
    ({ id, role, text: id, ...extra }) as TranscriptEntry;
  const entries: TranscriptEntry[] = [
    e('U1', 'user'),
    e('A1', 'assistant', {
      toolCalls: [{ id: 'c1', name: 'x', argumentsRaw: '{}', origin: 'native' }],
    }),
    e('T1', 'tool', { toolCallId: 'c1', origin: 'native' }),
    e('A2', 'assistant'),
    e('U2', 'user'),
    e('A3', 'assistant', {
      toolCalls: [{ id: 'c3', name: 'x', argumentsRaw: '{}', origin: 'native' }],
    }),
    e('T3', 'tool', { toolCallId: 'c3', origin: 'native' }),
    e('K1', 'user', { source: 'akari' }),
    e('A4', 'assistant'),
    e('A5', 'assistant'),
  ];
  const units = selectForCompaction(entries, new Set(), 2);
  const ids = units.flatMap((u) => u.entries.map((x) => x.id));
  assert.deepEqual(
    ids,
    ['A1', 'T1', 'A2', 'A3', 'T3', 'K1'],
    '呼び出しと結果、Akari の指摘は一緒に動く',
  );
  assert.ok(!ids.includes('U1'), '最初の依頼は残す');
  assert.ok(!ids.includes('U2'), '最新の依頼は残す');
  assert.ok(!ids.includes('A4') && !ids.includes('A5'), '直近2手は残す');
});

test('概算しか無いときは、早めに圧縮する側へ倒す', () => {
  const s = { compactAtRatio: 0.7, compactAtTokens: 12000 };
  assert.equal(compactThreshold(s, 10000, false), 7000);
  assert.equal(compactThreshold(s, 10000, true), 6000);
  assert.equal(compactThreshold(s, null, true), 12000, '文脈長が分からなければ絶対値');
});

// ---------------- 実行の中での圧縮 ----------------

test('閾値を超えたら古い手を圧縮し、以後は圧縮版を送る。呼び出しと結果の対応は崩れない', async () => {
  const { workspace, home } = await setup(bigFiles());
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const { p, work, digests } = provider([
    readBig(1),
    readBig(2),
    readBig(3),
    readBig(4),
    { text: '読み終えました。' },
  ]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    recorder: conv.recorder({ model: 'm', endpointId: 'ep_ctx' }),
    context: {
      settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, 'big.txt を何度も読んで');

  const start = events.find((e) => e.type === 'compaction-start') as Extract<
    RunEvent,
    { type: 'compaction-start' }
  >;
  const end = events.find((e) => e.type === 'compaction-end') as Extract<
    RunEvent,
    { type: 'compaction-end' }
  >;
  assert.ok(start && end, '圧縮したことをイベントで知らせる');
  assert.ok(
    end.afterTokens < start.beforeTokens,
    `小さくなる: ${start.beforeTokens} → ${end.afterTokens}`,
  );
  assert.ok(digests.length >= 1);

  for (const req of work) assertValidForApi(req.messages);
  const last = work.at(-1)!;
  assert.match(last.messages[0]!.content, /これまでの経過（圧縮版）/);
  assert.match(last.messages[0]!.content, /棄却案/);
  assert.match(last.messages[1]!.content, /big.txt を何度も読んで/, '最初の依頼は生のまま残る');

  // 生の記録は消えない。圧縮の記録が会話に残る
  const saved = await store.open(conv.id);
  assert.equal(saved.thread().filter((m) => m.role === 'tool').length, 4, '生の記録は全部残る');
  const c = saved.latestCompaction();
  assert.ok(c);
  assert.ok(c.coveredMessageIds.length > 0);
  assert.ok(
    c.digest.decisions[0]!.sources.every((id) => c.coveredMessageIds.includes(id)),
    '根拠は実在する ID',
  );
  const ends = events.filter((e) => e.type === 'run-end') as Array<
    Extract<RunEvent, { type: 'run-end' }>
  >;
  assert.equal(ends[0]!.reason, 'done');
});

test('圧縮版を書けなければ1度やり直させ、それでも駄目なら機械的な要約へ落ちて知らせる', async () => {
  const { workspace, home } = await setup(bigFiles());
  const { p, digests, work } = provider(
    [readBig(1), readBig(2), readBig(3), { text: '終わり' }],
    () => '要約です。（形式を守らない）',
  );
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    context: {
      settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  const compactions = events.filter((e) => e.type === 'compaction-start').length;
  assert.ok(compactions >= 1);
  assert.equal(digests.length, compactions * 2, 'やり直しは圧縮1回につき1度だけ');
  assert.match(digests[1]!.messages.at(-1)!.content, /形式が違います/, '何が違ったかを伝える');
  const end = events.find((e) => e.type === 'compaction-end') as Extract<
    RunEvent,
    { type: 'compaction-end' }
  >;
  assert.equal(end.fallback, 'parse-failed');
  assert.ok(events.some((e) => e.type === 'notice' && /機械的な要約/.test(e.message)));
  assert.match(work.at(-1)!.messages[0]!.content, /（機械的な要約）read_file big1.txt → 成功/);
  for (const req of work) assertValidForApi(req.messages);
});

test('2回目の圧縮には、前回の圧縮版を材料として渡す（積み増す）', async () => {
  const { workspace, home } = await setup(bigFiles());
  const { p, digests } = provider([
    readBig(1),
    readBig(2),
    readBig(3),
    readBig(4),
    readBig(5),
    readBig(6),
    { text: '終わり' },
  ]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    context: {
      settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  await run(session, '読んで');
  assert.ok(digests.length >= 2, `圧縮が2回以上起きる: ${digests.length}`);
  assert.match(digests[0]!.messages[1]!.content, /前回までのまとめ\nなし/);
  assert.match(digests[1]!.messages[1]!.content, /前回までのまとめ\n\{"decisions"/);
});

test('圧縮した後だけ recall の道具が渡り、圧縮した生の記録を引ける', async () => {
  const { workspace, home } = await setup(bigFiles('\n秘密の合言葉はりんごパイ'));
  const { p, work } = provider([
    readBig(1),
    readBig(2),
    readBig(3),
    { tool: 'recall_search', args: { query: 'りんごパイ' } },
    { text: '見つけました。' },
  ]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    context: {
      settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  const toolNames = (req: ChatRequest) => (req.tools ?? []).map((t) => t.name);
  assert.ok(!toolNames(work[0]!).includes('recall_search'), '圧縮前は渡さない');
  assert.ok(toolNames(work.at(-1)!).includes('recall_search'), '圧縮後は渡す');
  assert.match(work.at(-1)!.messages[0]!.content, /recall_search で探し/);

  const result = events.find(
    (e) => e.type === 'tool-result' && e.name === 'recall_search',
  ) as Extract<RunEvent, { type: 'tool-result' }>;
  assert.ok(result?.ok);
  const sent = work
    .at(-1)!
    .messages.find((m: ChatMessage) => m.role === 'tool' && /りんごパイ/.test(m.content));
  assert.ok(sent, '検索の結果がモデルへ渡る');
});

test('圧縮が入った会話を続けると、圧縮版と、圧縮していない部分の生だけを送る', async () => {
  const { workspace, home } = await setup(bigFiles());
  const store = new ConversationStore(home);
  const conv = await store.create({ kind: 'agent', workspace: workspace.root });
  const ctx = {
    settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
    windowTokens: null,
    endpointId: 'ep_ctx',
  };
  const first = provider([readBig(1), readBig(2), readBig(3), { text: '読みました。' }]);
  await run(
    Session.create({
      provider: first.p,
      model: 'm',
      workspace,
      root: home,
      permissionMode: 'full',
      recorder: conv.recorder({ model: 'm', endpointId: 'ep_ctx' }),
      context: ctx,
    }),
    '読んで',
  );

  const reopened = await store.open(conv.id);
  const compaction = reopened.latestCompaction()!;
  const second = provider([{ text: '続きです。' }]);
  await run(
    Session.create({
      provider: second.p,
      model: 'm',
      workspace,
      root: home,
      permissionMode: 'full',
      transcript: toTranscript(reopened.thread()),
      compaction,
      context: ctx,
    }),
    '続けて',
  );
  const req = second.work[0]!;
  assert.match(req.messages[0]!.content, /これまでの経過（圧縮版）/);
  const sentTools = req.messages.filter((m) => m.role === 'tool').length;
  assert.ok(sentTools < 3, `圧縮した道具の結果は送らない（送った数: ${sentTools}）`);
  if (second.digests.length > 0) {
    // 残りの生だけでまだ多ければ、もう一度圧縮してよい。そのときは前回の圧縮版から積み増す
    assert.match(second.digests[0]!.messages[1]!.content, /前回までのまとめ\n\{"decisions"/);
  }
  assertValidForApi(req.messages);
});

test('圧縮できない直近の大きな出力は、送るときだけ切り詰める（生の記録は変えない）', async () => {
  const huge = 'x'.repeat(30000);
  const { workspace, home } = await setup({ 'huge.txt': huge });
  const { p, work } = provider([
    { tool: 'read_file', args: { path: 'huge.txt' } },
    { tool: 'recall_read', args: { messageId: 'dummy' } },
    { text: '終わり' },
  ]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    limits: { toolOutputLimitBytes: 100000 },
    context: {
      settings: settings({ keepRecentTurns: 3 }),
      windowTokens: 12000,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  assert.ok(events.some((e) => e.type === 'notice' && /切り詰めました/.test(e.message)));
  const sent = work[1]!.messages.find((m) => m.role === 'tool')!;
  assert.match(sent.content, /文字を省きました/);
  assert.ok(sent.content.length < 10000);
});

test('1手でまとめて読んで入りきらないときは、段階的に短く切り詰めて続ける', async () => {
  // Ling が文脈長 8000 で5ファイルを1手で読み、4000字の切り詰めでも入らず止まっていた（2026-10-27）
  const file = Array.from({ length: 120 }, (_, i) => `${i}行目 ${'かきくけこ'.repeat(10)}`).join(
    '\n',
  );
  const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}.txt`);
  const { workspace, home } = await setup(Object.fromEntries(names.map((n) => [n, file])));
  const { p, work } = provider([
    { calls: names.map((n) => ({ tool: 'read_file', args: { path: n } })) },
    { text: '終わり' },
  ]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    limits: { toolOutputLimitBytes: 100000 },
    context: { settings: settings(), windowTokens: 8000, endpointId: 'ep_ctx' },
  });
  const events = await run(session, '5つ読んで');
  const end = events.find((e) => e.type === 'run-end') as Extract<RunEvent, { type: 'run-end' }>;
  assert.equal(end.reason, 'done', String(end.error ?? ''));
  const notice = events.find((e) => e.type === 'notice' && /切り詰めました/.test(e.message));
  assert.ok(notice && notice.type === 'notice');
  assert.match(notice.message, /短いもので (2000|1000) 字/, '4000字で諦めずにさらに短くした');
  const sent = work[1]!.messages.filter((m) => m.role === 'tool');
  assert.equal(sent.length, 5);
  assert.ok(
    sent.every((m) => m.content.length <= 2300),
    '5件とも短くして送った',
  );
  // 圧縮が起きていないので recall は渡っていない。渡っていない道具を案内しない
  assert.ok(sent.every((m) => !/recall_read/.test(m.content)));
  assert.match(sent[0]!.content, /read_file の offset と limit/);
  assertValidForApi(work[1]!.messages);
});

test('どうしても入りきらないときは、送らずに止める（理由つき）', async () => {
  const { workspace, home } = await setup();
  const { p, work } = provider([{ text: '呼ばれないはず' }]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    context: { settings: settings(), windowTokens: 600, endpointId: 'ep_ctx' },
  });
  const events = await run(session, 'やって');
  const end = events.find((e) => e.type === 'run-end') as Extract<RunEvent, { type: 'run-end' }>;
  assert.equal(end.reason, 'context-full');
  assert.match(String(end.error), /入りきりませんでした/);
  assert.equal(work.length, 0, '溢れると分かっているものは送らない');
});

test('context.mode が off なら圧縮しないが、超えていることは知らせる', async () => {
  const { workspace, home } = await setup(bigFiles());
  const { p, digests } = provider([readBig(1), readBig(2), readBig(3), { text: '終わり' }]);
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    context: {
      settings: settings({ mode: 'off', compactAtTokens: 6000 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  assert.equal(digests.length, 0);
  assert.ok(events.some((e) => e.type === 'notice' && /off のため圧縮しません/.test(e.message)));
});

test('サーバがトークン数を報告すれば、それで補正した量で判断する', async () => {
  const { workspace, home } = await setup(bigFiles());
  // 実際は概算の倍かかっている、と報告するサーバ
  const { p } = provider([readBig(1), readBig(2), { text: '終わり' }], undefined, (req) =>
    Math.ceil(JSON.stringify(req.messages).length / 1.1),
  );
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    context: {
      settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  const start = events.find((e) => e.type === 'compaction-start') as Extract<
    RunEvent,
    { type: 'compaction-start' }
  >;
  assert.ok(start, '実測では閾値を超えているので圧縮が起きる');
  assert.equal(start.estimated, false, '実測で補正した量だと分かる');
});

test('概算から大きく外れたトークン数の報告は信じすぎない（圧縮しなくなるのを防ぐ）', async () => {
  const { workspace, home } = await setup(bigFiles());
  // いつも「30トークン」と報告するサーバ（実際には数千トークン送っている）
  const { p } = provider(
    [readBig(1), readBig(2), readBig(3), readBig(4), { text: '終わり' }],
    undefined,
    () => 30,
  );
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    context: {
      settings: settings({ compactAtTokens: 6000, keepRecentTurns: 1 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  assert.ok(
    events.some((e) => e.type === 'compaction-start'),
    '報告を鵜呑みにせず、圧縮は起きる',
  );
});

test('残す直近の手が大きすぎるときは、残す手数を減らして、1手ごとに圧縮しないようにする', async () => {
  const { workspace, home } = await setup(bigFiles());
  const { p, digests } = provider(
    [1, 2, 3, 4, 5, 6, 7, 8].map(readBig).concat([{ text: '終わり' }]),
  );
  const session = Session.create({
    provider: p,
    model: 'm',
    workspace,
    root: home,
    permissionMode: 'full',
    // 1手（約3600トークン）は閾値（12000）の3割。残す3手だけで閾値の9割になる
    context: {
      settings: settings({ compactAtTokens: 12000, keepRecentTurns: 3 }),
      windowTokens: null,
      endpointId: 'ep_ctx',
    },
  });
  const events = await run(session, '読んで');
  const compactions = events.filter((e) => e.type === 'compaction-start').length;
  assert.ok(compactions >= 1);
  assert.ok(compactions <= 3, `8手で圧縮は ${compactions} 回（毎手ではない）`);
  assert.ok(digests.length >= 1);
});

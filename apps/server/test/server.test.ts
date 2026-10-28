import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  configSchema,
  nullLogger,
  saveConfig,
  type ChatEvent,
  type ChatRequest,
  type Provider,
} from '@akari/core';
import { startServer, chunkText } from '../dist/index.js';

/**
 * ハーネスAPI。仕様: docs/spec/12-harness-api.md
 * 本物の HTTP で叩く。モデルだけ台本どおりに答える偽物にする。
 */

type Step = { text: string } | { tool: string; args: unknown };

/** 台本はリクエストごとに決める（同時に走る実行どうしで取り合わないよう、依頼文で分ける）。 */
type Script = (req: ChatRequest, turn: number) => Step;

function fakeProvider(script: Script): Provider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    endpointId: 'ep_t',
    calls,
    async listModels() {
      return [{ id: 'm' }];
    },
    async probe(): Promise<never> {
      throw new Error('判定は済んでいる');
    },
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
      calls.push(structuredClone(req));
      const assistants = req.messages.filter((m) => m.role === 'assistant').length;
      const step = script(req, assistants);
      yield { type: 'start', model: req.model };
      if ('text' in step) {
        yield { type: 'text-delta', text: step.text };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield {
        type: 'tool-call',
        id: `call_${calls.length}`,
        name: step.tool,
        argumentsRaw: JSON.stringify(step.args),
      };
      yield { type: 'finish', reason: 'tool_calls' };
    },
  } as Provider & { calls: ChatRequest[] };
}

/** 1つ目の利用者の発言（依頼文）。 */
const promptOf = (req: ChatRequest) => req.messages.find((m) => m.role === 'user')?.content ?? '';

async function setup(
  opts: {
    script?: Script;
    full?: boolean;
    approvalTimeoutMs?: number;
    eventsKeep?: number;
    sandboxMode?: 'auto' | 'required' | 'off';
    root?: string;
    files?: Record<string, string>;
  } = {},
) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'akari-srv-')));
  const root = opts.root ?? path.join(base, 'home');
  const repo = path.join(base, 'repo');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  for (const [p, c] of Object.entries(opts.files ?? { 'README.md': '# サンプル\nタイポ\n' })) {
    await fs.writeFile(path.join(repo, p), c);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  if (!opts.root) {
    const config = configSchema.parse({
      endpoints: [
        {
          id: 'ep_t',
          name: '試験',
          baseUrl: 'http://127.0.0.1:9/v1',
          defaultModel: 'm',
          capabilities: {
            tools: 'native',
            probedModel: 'm',
            byModel: { m: { tools: 'native', probedAt: '2026-10-28T00:00:00Z' } },
          },
        },
      ],
      activeEndpointId: 'ep_t',
      server: { allowFullPermission: opts.full ?? false },
      agent: {
        approvalTimeoutMs: opts.approvalTimeoutMs ?? null,
        sandbox: { mode: opts.sandboxMode ?? 'auto' },
      },
    });
    await saveConfig(config, root);
  }
  const provider = fakeProvider(opts.script ?? (() => ({ text: '了解' })));
  const server = await startServer({
    root,
    port: 0,
    version: 'test',
    logger: nullLogger,
    providerFor: () => provider,
    ...(opts.eventsKeep ? { eventsKeep: opts.eventsKeep } : {}),
  });
  const call = async (
    method: string,
    p: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${server.url}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { base, root, repo, server, provider, call, git };
}

/** SSE を読む。閉じるまで、または n 件まで。 */
async function readEvents(
  url: string,
  token: string,
  opts: { from?: number; lastEventId?: number; max?: number } = {},
): Promise<Array<{ id: number | null; event: string; data: Record<string, unknown> }>> {
  const q = opts.from !== undefined ? `?from=${opts.from}` : '';
  const res = await fetch(`${url}${q}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.lastEventId !== undefined ? { 'last-event-id': String(opts.lastEventId) } : {}),
    },
  });
  const out: Array<{ id: number | null; event: string; data: Record<string, unknown> }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.startsWith(':')) continue;
      const id = /^id: (\d+)$/m.exec(block)?.[1];
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(block)?.[1];
      out.push({ id: id ? Number(id) : null, event, data: data ? JSON.parse(data) : {} });
      if (opts.max && out.length >= opts.max) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

async function waitFor(check: () => Promise<boolean>, ms = 5000, what = '条件'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`${what}が満たされませんでした`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const statusOf = async (s: Awaited<ReturnType<typeof setup>>, id: string) =>
  (await s.call('GET', `/v1/runs/${id}`)).body;

// ---------------- 認証と受け付け ----------------

test('トークンなし・誤トークンは 401。health だけはトークン不要', async () => {
  const s = await setup();
  try {
    const none = await fetch(`${s.server.url}/v1/runs`);
    assert.equal(none.status, 401);
    assert.equal((await none.json()).error.code, 'unauthorized');
    const wrong = await s.call('GET', '/v1/runs', undefined, {
      authorization: 'Bearer wrong-token',
    });
    assert.equal(wrong.status, 401);
    const health = await fetch(`${s.server.url}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await s.server.close();
  }
});

test('127.0.0.1 にだけ束ねる。トークンは server.json（権限600）に保ち、再起動しても同じ', async () => {
  const s = await setup();
  const first = s.server.token;
  try {
    const info = JSON.parse(await fs.readFile(path.join(s.root, 'server.json'), 'utf8'));
    assert.equal(info.token, first);
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(s.root, 'server.json'));
      assert.equal(st.mode & 0o777, 0o600);
    }
    // 外向きの住所では繋がらない（127.0.0.1 以外では待っていない）
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (external) {
      await assert.rejects(() =>
        fetch(`http://${external}:${s.server.port}/v1/health`, {
          signal: AbortSignal.timeout(2000),
        }),
      );
    }
  } finally {
    await s.server.close();
  }
  const again = await setup({ root: s.root });
  try {
    assert.equal(again.server.token, first, '再起動してもトークンは変わらない');
  } finally {
    await again.server.close();
  }
});

test('Origin 付き（ブラウザ）と、宛先が localhost でない要求は、トークンが正しくても断る', async () => {
  const s = await setup();
  try {
    const origin = await s.call('GET', '/v1/runs', undefined, { origin: 'https://evil.example' });
    assert.equal(origin.status, 403);
    assert.equal(origin.body.error.code, 'origin_not_allowed');
    const host = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: s.server.port,
          path: '/v1/runs',
          headers: {
            host: `evil.example:${s.server.port}`,
            authorization: `Bearer ${s.server.token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(host, 403, 'DNS リバインディングを塞ぐ');
  } finally {
    await s.server.close();
  }
});

test('HTTP からの full は、設定で許したときだけ', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/v1/runs', {
      prompt: 'x',
      workspace: s.repo,
      permissionMode: 'full',
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'full_permission_disabled');
  } finally {
    await s.server.close();
  }
  const allowed = await setup({ full: true });
  try {
    const r = await allowed.call('POST', '/v1/runs', {
      prompt: 'x',
      workspace: allowed.repo,
      permissionMode: 'full',
    });
    assert.equal(r.status, 201);
  } finally {
    await allowed.server.close();
  }
});

test('閉じ込められないなら、allowFullPermission でも HTTP からの full は断る', async () => {
  const s = await setup({ full: true, sandboxMode: 'off' });
  try {
    const r = await s.call('POST', '/v1/runs', {
      prompt: 'x',
      workspace: s.repo,
      permissionMode: 'full',
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'full_without_sandbox');
    const health = await (await fetch(`${s.server.url}/v1/health`)).json();
    assert.deepEqual(health.sandbox, { active: false, reason: 'agent.sandbox.mode が off' });
  } finally {
    await s.server.close();
  }
});

test('作業フォルダなしでは走らせない。git の道具は API から有効にできない', async () => {
  const s = await setup();
  try {
    const none = await s.call('POST', '/v1/runs', { prompt: 'x' });
    assert.equal(none.body.error.code, 'workspace_required');
    const git = await s.call('POST', '/v1/runs', {
      prompt: 'x',
      workspace: s.repo,
      tools: ['read_file', 'git_push'],
    });
    assert.equal(git.body.error.code, 'git_tools_disabled');
    const bad = await s.call('POST', '/v1/runs', { prompt: '', workspace: s.repo });
    assert.equal(bad.body.error.code, 'invalid_body');
    const dash = await s.call('POST', '/v1/runs', {
      prompt: 'x',
      workspace: s.repo,
      git: { worktree: true, base: '--output=/tmp/x' },
    });
    assert.equal(dash.body.error.code, 'invalid_branch', 'git のオプションとして読ませない');
    const notRepo = await s.call('POST', '/v1/runs', {
      prompt: 'x',
      workspace: s.base,
      git: { worktree: true },
    });
    assert.equal(notRepo.body.error.code, 'not_git_repo');
  } finally {
    await s.server.close();
  }
});

// ---------------- 実行・承認・イベント ----------------

test('承認要求が HTTP に出て、HTTP で許可・拒否できる。解決済みへの答えは 409', async () => {
  const s = await setup({
    script: (req, turn) =>
      turn === 0
        ? { tool: 'edit_file', args: { path: 'README.md', oldText: 'タイポ', newText: '誤字' } }
        : { text: '終わり' },
  });
  try {
    const created = await s.call('POST', '/v1/runs', { prompt: '直して', workspace: s.repo });
    assert.equal(created.status, 201);
    const id = created.body.runId;
    await waitFor(
      async () => (await statusOf(s, id)).status === 'waiting-approval',
      5000,
      '承認待ち',
    );
    const pending = (await statusOf(s, id)).pendingApproval;
    assert.equal(pending.name, 'edit_file');
    assert.deepEqual(pending.decisions, ['allow', 'allowSession', 'deny', 'abort']);
    const ok = await s.call('POST', `/v1/runs/${id}/approvals/${pending.callId}`, {
      decision: 'allow',
    });
    assert.equal(ok.status, 200);
    const again = await s.call('POST', `/v1/runs/${id}/approvals/${pending.callId}`, {
      decision: 'allow',
    });
    assert.equal(again.status, 409);
    await waitFor(async () => (await statusOf(s, id)).status === 'done', 5000, '完了');
    assert.equal(await fs.readFile(path.join(s.repo, 'README.md'), 'utf8'), '# サンプル\n誤字\n');

    // 拒否: 理由がモデルへ渡り、ファイルは変わらない
    const second = await s.call('POST', '/v1/runs', {
      prompt: 'もう一度直して',
      workspace: s.repo,
    });
    const id2 = second.body.runId;
    await waitFor(async () => (await statusOf(s, id2)).status === 'waiting-approval');
    const p2 = (await statusOf(s, id2)).pendingApproval;
    await s.call('POST', `/v1/runs/${id2}/approvals/${p2.callId}`, {
      decision: 'deny',
      feedback: '今はいらない',
    });
    await waitFor(async () => (await statusOf(s, id2)).status === 'done');
    const last = s.provider.calls.at(-1)!;
    assert.ok(last.messages.some((m) => m.role === 'tool' && m.content.includes('今はいらない')));
  } finally {
    await s.server.close();
  }
});

test('SSE を途中で切っても、?from= / Last-Event-ID で取りこぼしなく続きが読める', async () => {
  const s = await setup({
    script: (req, turn) =>
      turn === 0 ? { tool: 'read_file', args: { path: 'README.md' } } : { text: '読みました' },
  });
  try {
    const id = (await s.call('POST', '/v1/runs', { prompt: '読んで', workspace: s.repo })).body
      .runId;
    const url = `${s.server.url}/v1/runs/${id}/events`;
    const head = await readEvents(url, s.server.token, { max: 3 });
    assert.deepEqual(
      head.map((e) => e.id),
      [1, 2, 3],
    );
    const rest = await readEvents(url, s.server.token, { from: 3 });
    assert.equal(rest[0]!.id, 4, '切った次から');
    assert.equal(rest.at(-1)!.event === 'run-end' || rest.at(-1)!.event === 'status', true);
    const all = await readEvents(url, s.server.token);
    const ids = all.map((e) => e.id);
    assert.deepEqual(
      ids,
      [...head, ...rest].map((e) => e.id),
      '合わせると全部、重複なし',
    );
    const resumed = await readEvents(url, s.server.token, { lastEventId: 3 });
    assert.equal(resumed[0]!.id, 4, 'Last-Event-ID でも同じ');
    assert.ok(all.some((e) => e.event === 'run-end'));
  } finally {
    await s.server.close();
  }
});

test('保持を超えて取りこぼしたら、gap で正直に伝える', async () => {
  const s = await setup({ eventsKeep: 5 });
  try {
    const id = (await s.call('POST', '/v1/runs', { prompt: 'やあ', workspace: s.repo })).body.runId;
    await waitFor(async () => (await statusOf(s, id)).status === 'done');
    const events = await readEvents(`${s.server.url}/v1/runs/${id}/events`, s.server.token, {
      from: 0,
    });
    assert.equal(events[0]!.event, 'gap');
    assert.ok(Number(events[0]!.data.firstAvailable) > 1);
    assert.equal(events.length, 6, 'gap と、残っている5件');
  } finally {
    await s.server.close();
  }
});

test('同じ idempotencyKey で2回叩いても、実行は1つ', async () => {
  const s = await setup();
  try {
    const body = { prompt: 'やあ', workspace: s.repo, idempotencyKey: 'abc' };
    const a = await s.call('POST', '/v1/runs', body);
    const b = await s.call('POST', '/v1/runs', body);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.runId, b.body.runId);
    const list = await s.call('GET', '/v1/runs');
    assert.equal(list.body.runs.length, 1);
  } finally {
    await s.server.close();
  }
});

test('2つの実行を別々の worktree で同時に走らせても、互いのファイルを踏まない', async () => {
  const s = await setup({
    full: true,
    script: (req, turn) => {
      const who = promptOf(req).includes('A') ? 'a' : 'b';
      return turn === 0
        ? { tool: 'write_file', args: { path: 'README.md', content: `${who} が書いた\n` } }
        : { text: `${who} 終わり` };
    },
  });
  try {
    const mk = (p: string) =>
      s.call('POST', '/v1/runs', {
        prompt: p,
        workspace: s.repo,
        permissionMode: 'full',
        git: { worktree: true },
        labels: { agent: p },
      });
    const [a, b] = await Promise.all([mk('A を書いて'), mk('B を書いて')]);
    assert.notEqual(a.body.workspace, b.body.workspace);
    await waitFor(async () =>
      (await Promise.all([statusOf(s, a.body.runId), statusOf(s, b.body.runId)])).every(
        (r) => r.status === 'done',
      ),
    );
    assert.equal(
      await fs.readFile(path.join(a.body.workspace, 'README.md'), 'utf8'),
      'a が書いた\n',
    );
    assert.equal(
      await fs.readFile(path.join(b.body.workspace, 'README.md'), 'utf8'),
      'b が書いた\n',
    );
    assert.equal(
      await fs.readFile(path.join(s.repo, 'README.md'), 'utf8'),
      '# サンプル\nタイポ\n',
      '元のリポジトリは無傷',
    );
    assert.match(s.git('branch'), /akari\//);
    const filtered = await s.call('GET', '/v1/runs?label.agent=A%20を書いて');
    assert.equal(filtered.body.runs.length, 1, 'ラベルで絞れる');
    const wts = await s.call('GET', '/v1/worktrees');
    assert.equal(wts.body.worktrees.length, 2);
    const del = await s.call('DELETE', `/v1/runs/${a.body.runId}/worktree`);
    assert.equal(del.body.removed, true);
    await assert.rejects(() => fs.stat(a.body.workspace));
  } finally {
    await s.server.close();
  }
});

test('worktree の中の git commit は、閉じ込めの中でも通る（元の .git には書ける）', async () => {
  const s = await setup({
    full: true,
    script: (req, turn) =>
      turn === 0
        ? {
            tool: 'run_command',
            args: {
              command:
                'echo 追記 >> README.md && git -c user.email=a@a -c user.name=a commit -qam 変更 && git log --oneline | head -1',
            },
          }
        : { text: 'コミットしました' },
  });
  try {
    const health = await (await fetch(`${s.server.url}/v1/health`)).json();
    const { runId, branch } = (
      await s.call('POST', '/v1/runs', {
        prompt: 'コミットして',
        workspace: s.repo,
        permissionMode: 'full',
        git: { worktree: true },
      })
    ).body;
    await waitFor(async () => (await statusOf(s, runId)).status === 'done');
    const result = s.provider.calls.at(-1)!.messages.find((m) => m.role === 'tool')!.content;
    assert.match(result, /終了コード: 0/, `閉じ込め: ${JSON.stringify(health.sandbox)}\n${result}`);
    assert.match(s.git('log', '--oneline', branch), /変更/, 'ブランチにコミットが入った');
  } finally {
    await s.server.close();
  }
});

test('実行中の追記は次の手の前に入り、終わった後の追記は同じ会話の続きの実行になる', async () => {
  const s = await setup({
    script: (req, turn) =>
      turn === 0
        ? { tool: 'edit_file', args: { path: 'README.md', oldText: 'タイポ', newText: '誤字' } }
        : { text: `返事 ${turn}` },
  });
  try {
    const { runId, conversationId } = (
      await s.call('POST', '/v1/runs', { prompt: '直して', workspace: s.repo })
    ).body;
    await waitFor(async () => (await statusOf(s, runId)).status === 'waiting-approval');
    const injected = await s.call('POST', `/v1/runs/${runId}/messages`, { text: '短くお願い' });
    assert.equal(injected.status, 202);
    assert.equal(injected.body.injected, true);
    const pending = (await statusOf(s, runId)).pendingApproval;
    await s.call('POST', `/v1/runs/${runId}/approvals/${pending.callId}`, { decision: 'allow' });
    await waitFor(async () => (await statusOf(s, runId)).status === 'done');
    assert.equal(s.provider.calls[1]!.messages.at(-1)!.content, '短くお願い');

    const after = await s.call('POST', `/v1/runs/${runId}/messages`, { text: 'ありがとう' });
    assert.equal(after.status, 201);
    assert.equal(after.body.injected, false);
    assert.notEqual(after.body.runId, runId);
    assert.equal(after.body.conversationId, conversationId, '同じ会話の続き');
    await waitFor(async () => (await statusOf(s, after.body.runId)).status === 'done');
    const sent = s.provider.calls.at(-1)!.messages;
    assert.ok(
      sent.some((m) => m.content === '直して'),
      '前のやり取りが渡る',
    );
  } finally {
    await s.server.close();
  }
});

test('承認の期限（approvalTimeoutMs）を過ぎたら拒否として扱う', async () => {
  const s = await setup({
    approvalTimeoutMs: 1000,
    script: (req, turn) =>
      turn === 0
        ? { tool: 'write_file', args: { path: 'x.txt', content: 'x' } }
        : { text: '待ちきれませんでした' },
  });
  try {
    const id = (await s.call('POST', '/v1/runs', { prompt: '書いて', workspace: s.repo })).body
      .runId;
    await waitFor(async () => (await statusOf(s, id)).status === 'done', 5000, '期限で拒否');
    await assert.rejects(() => fs.stat(path.join(s.repo, 'x.txt')));
    const events = await readEvents(`${s.server.url}/v1/runs/${id}/events`, s.server.token);
    assert.ok(events.some((e) => e.event === 'notice' && String(e.data.message).includes('拒否')));
  } finally {
    await s.server.close();
  }
});

test('中断・差分・取り消しが HTTP からできる', async () => {
  const s = await setup({
    full: true,
    script: (req, turn) =>
      promptOf(req).includes('止め')
        ? { tool: 'write_file', args: { path: 'y.txt', content: 'y' } }
        : turn === 0
          ? { tool: 'edit_file', args: { path: 'README.md', oldText: 'タイポ', newText: '誤字' } }
          : { text: '直しました' },
  });
  try {
    const id = (
      await s.call('POST', '/v1/runs', {
        prompt: '直して',
        workspace: s.repo,
        permissionMode: 'full',
      })
    ).body.runId;
    await waitFor(async () => (await statusOf(s, id)).status === 'done');
    const diff = await s.call('GET', `/v1/runs/${id}/diff`);
    assert.match(diff.body.files[0].diff, /\+誤字/);
    const undo = await s.call('POST', `/v1/runs/${id}/undo`);
    assert.deepEqual(undo.body.restored, ['README.md']);
    assert.equal(await fs.readFile(path.join(s.repo, 'README.md'), 'utf8'), '# サンプル\nタイポ\n');

    const stop = (await s.call('POST', '/v1/runs', { prompt: '止めて', workspace: s.repo })).body
      .runId;
    await waitFor(async () => (await statusOf(s, stop)).status === 'waiting-approval');
    const aborted = await s.call('POST', `/v1/runs/${stop}/abort`);
    assert.equal(aborted.status, 202);
    await waitFor(async () => (await statusOf(s, stop)).status === 'aborted');
    const twice = await s.call('POST', `/v1/runs/${stop}/abort`);
    assert.equal(twice.status, 409);
  } finally {
    await s.server.close();
  }
});

// ---------------- 記録の保存（再起動） ----------------

test('再起動しても、実行の記録・要約・差分を API で取れる。落ちたときに走っていた実行は interrupted', async () => {
  const s = await setup({
    script: (req, turn) =>
      turn === 0
        ? { tool: 'edit_file', args: { path: 'README.md', oldText: 'タイポ', newText: '誤字' } }
        : { text: '直しました' },
  });
  const id = (
    await s.call('POST', '/v1/runs', {
      prompt: '直して',
      workspace: s.repo,
      labels: { channel: '42' },
    })
  ).body.runId;
  await waitFor(async () => (await statusOf(s, id)).status === 'waiting-approval');
  const pending = (await statusOf(s, id)).pendingApproval;
  await s.call('POST', `/v1/runs/${id}/approvals/${pending.callId}`, { decision: 'allow' });
  await waitFor(async () => (await statusOf(s, id)).status === 'done');
  await s.server.close();

  // 落ちたサーバが残した「走っている」記録を作る（書いたプロセスはもう居ない）
  const ghostId = '01JGHOSTGHOSTGHOSTGHOSTGHO';
  const ghost = JSON.parse(
    await fs.readFile(path.join(s.root, 'server', 'runs', `${id}.json`), 'utf8'),
  );
  await fs.writeFile(
    path.join(s.root, 'server', 'runs', `${ghostId}.json`),
    JSON.stringify({ ...ghost, runId: ghostId, status: 'running', endedAt: null, pid: 999999 }),
  );

  const again = await setup({ root: s.root });
  try {
    const list = await again.call('GET', '/v1/runs?label.channel=42');
    assert.equal(list.body.runs.length, 2);
    const got = await again.call('GET', `/v1/runs/${id}`);
    assert.equal(got.body.status, 'done');
    assert.equal(got.body.changedFiles, 1);
    const t = await again.call('GET', `/v1/runs/${id}/transcript?format=text`);
    assert.match(t.body.text, /目的: 直して/);
    assert.match(t.body.text, /edit_file README\.md → ✓/);
    const diff = await again.call('GET', `/v1/runs/${id}/diff`);
    assert.match(diff.body.files[0].diff, /\+誤字/, '変更記録が残っている');
    const events = await readEvents(`${again.server.url}/v1/runs/${id}/events`, again.server.token);
    assert.ok(
      events.some((e) => e.event === 'run-end'),
      'イベントも保持の範囲なら読み直せる',
    );
    const g = await again.call('GET', `/v1/runs/${ghostId}`);
    assert.equal(g.body.status, 'interrupted');
    const conv = await again.call('GET', `/v1/conversations/${got.body.conversationId}`);
    assert.ok(conv.body.messages.length >= 3);
  } finally {
    await again.server.close();
  }
});

// ---------------- 要約 ----------------

test('transcript を2000字で割っても、コードブロックを壊さない', () => {
  const code = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i}; // ${'x'.repeat(20)}`);
  const text = [
    '**目的**: 長いコードを書く',
    ...Array.from({ length: 30 }, (_, i) => `説明 ${i} ${'あ'.repeat(30)}`),
    '```ts',
    ...code,
    '```',
    'おわり',
  ].join('\n');
  const chunks = chunkText(text, 2000);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `塊が上限を超えている: ${c.length}`);
    const fences = c.split('\n').filter((l) => l.trim().startsWith('```')).length;
    assert.equal(fences % 2, 0, `フェンスが閉じていない塊がある:\n${c.slice(0, 200)}`);
  }
  // 割っても中身は欠けない（開き直しのフェンスを除いて元に戻る）
  const joined = chunks.join('\n');
  for (const l of code) assert.ok(joined.includes(l));
});

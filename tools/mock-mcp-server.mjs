#!/usr/bin/env node
/**
 * 開発・テスト用の模擬 MCP サーバ。SDK を使わず、JSON-RPC を手で話す
 * （Akari 側の SDK の使い方が、仕様どおりの相手と話せるかを確かめるため）。
 *
 *   node tools/mock-mcp-server.mjs              # stdio（1行に1メッセージ）
 *   node tools/mock-mcp-server.mjs --http 7999  # Streamable HTTP（JSON で返すだけ）
 *
 * 振る舞いは環境変数で変える。
 *   MOCK_MCP_FAIL=1            起動してすぐ、stderr に書いて終わる
 *   MOCK_MCP_SLOW_MS=ms        initialize に答えるまで待つ
 *   MOCK_MCP_GRANDCHILD=file   孫プロセスを起こし、その pid を file に書く（後始末の確認）
 *   MOCK_MCP_PAGE_SIZE=n       tools/list を n 件ずつのページに分ける
 *   MOCK_MCP_TOKEN=value       HTTP で Authorization: Bearer value を求める
 *   MOCK_MCP_PREFIX=name       道具名の先頭に付ける（名前の衝突・長さの確認）
 *
 * 道具:
 *   echo      readOnlyHint: true。text をそのまま返す
 *   touch     注釈なし。path にファイルを書く（副作用の確認）
 *   fail      isError: true を返す
 *   sleep     ms だけ待つ（上限・中断の確認）
 *   picture   画像を返す
 *   env_keys  readOnlyHint: true。受け取った環境変数の名前の一覧
 */
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

const prefix = process.env.MOCK_MCP_PREFIX ?? '';
const TOOLS = [
  {
    name: `${prefix}echo`,
    description: '受け取った文字をそのまま返す',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: `${prefix}touch`,
    description: 'ファイルを書く',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: `${prefix}fail`,
    description: '必ず失敗を返す',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: `${prefix}sleep`,
    description: '待つ',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: `${prefix}picture`,
    description: '画像を返す',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: `${prefix}env_keys`,
    description: '環境変数の名前の一覧',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

if (process.env.MOCK_MCP_FAIL === '1') {
  process.stderr.write('mock-mcp: 起動に失敗するように指定されています\n');
  process.exit(3);
}

if (process.env.MOCK_MCP_GRANDCHILD) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  fs.writeFileSync(process.env.MOCK_MCP_GRANDCHILD, String(child.pid));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1つの要求に答える。通知なら null。 */
async function handle(msg) {
  if (msg.id === undefined || msg.id === null) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const slow = Number(process.env.MOCK_MCP_SLOW_MS ?? 0);
      if (slow > 0) await sleep(slow);
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.1' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list': {
      const size = Number(process.env.MOCK_MCP_PAGE_SIZE ?? 0);
      if (!size) return reply({ tools: TOOLS });
      const start = Number(msg.params?.cursor ?? 0);
      const page = TOOLS.slice(start, start + size);
      const next = start + size < TOOLS.length ? String(start + size) : undefined;
      return reply({ tools: page, ...(next ? { nextCursor: next } : {}) });
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '').slice(prefix.length);
      const args = msg.params?.arguments ?? {};
      switch (name) {
        case 'echo':
          return reply({ content: [{ type: 'text', text: String(args.text ?? '') }] });
        case 'touch':
          fs.writeFileSync(String(args.path), String(args.content ?? 'touched'));
          return reply({ content: [{ type: 'text', text: `wrote ${args.path}` }] });
        case 'fail':
          return reply({ content: [{ type: 'text', text: 'わざと失敗しました' }], isError: true });
        case 'sleep':
          await sleep(Number(args.ms ?? 1000));
          return reply({ content: [{ type: 'text', text: 'slept' }] });
        case 'picture':
          return reply({
            content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
          });
        case 'env_keys':
          return reply({
            content: [{ type: 'text', text: Object.keys(process.env).sort().join('\n') }],
          });
        default:
          return error(-32602, `unknown tool: ${name}`);
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

const httpIndex = process.argv.indexOf('--http');
if (httpIndex >= 0) {
  const port = Number(process.argv[httpIndex + 1] ?? 7999);
  const server = http.createServer((req, res) => {
    const token = process.env.MOCK_MCP_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      // 待ち受けの SSE は持たない（仕様上、405 で断ってよい）
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const msg = JSON.parse(body);
      const out = await handle(msg);
      if (out === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`mock-mcp listening on ${server.address().port}\n`);
  });
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      void handle(JSON.parse(line)).then((out) => {
        if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('mock-mcp: ready\n');
}

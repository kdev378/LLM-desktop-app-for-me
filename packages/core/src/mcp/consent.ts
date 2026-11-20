import { createHash } from 'node:crypto';
import type { McpServerConfig } from '../config/schema.js';

/**
 * MCP サーバを起動してよいという同意。仕様: docs/spec/13-mcp.md「追加時の確認」
 *
 * 同意したときの「起動する内容」の指紋を設定に残し、内容が変わっていたら同意し直すまで起動しない。
 * 誰かが設定を書き換えて、別のプログラムを動かす手口を塞ぐため。
 */

/** 起動する内容の指紋。名前・承認の扱い・時間の上限は含めない（変えても別のプログラムにはならない）。 */
export function mcpFingerprint(server: McpServerConfig): string {
  const subject = {
    transport: server.transport,
    command: server.command ?? null,
    args: server.args,
    env: sortKeys(server.env),
    cwd: server.cwd,
    url: server.url ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(subject)).digest('hex')}`;
}

export type ConsentState = 'ok' | 'missing' | 'changed';

export function consentState(server: McpServerConfig): ConsentState {
  if (!server.consent) return 'missing';
  return server.consent.fingerprint === mcpFingerprint(server) ? 'ok' : 'changed';
}

/** 同意を記録した設定（新しいオブジェクトを返す）。 */
export function withConsent(server: McpServerConfig, now = new Date()): McpServerConfig {
  return { ...server, consent: { fingerprint: mcpFingerprint(server), at: now.toISOString() } };
}

/** 同意を求めるときに見せる文。何が動くか、何の制限を受けないか。 */
export function describeLaunch(server: McpServerConfig): string {
  const lines: string[] = [];
  if (server.transport === 'stdio') {
    lines.push('このMCPサーバを使うと、次のコマンドがあなたのPCで実行されます。');
    lines.push(`  ${[server.command ?? '', ...server.args].map(quote).join(' ')}`);
    if (server.cwd) lines.push(`  作業ディレクトリ: ${server.cwd}`);
    const envNames = Object.keys(server.env);
    if (envNames.length > 0) lines.push(`  渡す環境変数: ${envNames.join(', ')}`);
    lines.push('このプログラムは Akari の作業フォルダの制限とコマンドの閉じ込めを受けません。');
  } else {
    lines.push('このMCPサーバを使うと、次のアドレスへ接続し、モデルの求めに応じて道具を呼びます。');
    lines.push(`  ${server.url ?? ''}`);
    lines.push(
      '道具の引数（作業中のファイルの中身を含むことがあります）が、この相手へ送られます。',
    );
  }
  lines.push('提供元を信頼できる場合だけ同意してください。');
  return lines.join('\n');
}

function sortKeys(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function quote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

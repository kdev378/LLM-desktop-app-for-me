import type { Workspace } from './workspace.js';
import type { ChangeJournal, FileChange } from '../agent/journal.js';
import type { TranscriptEntry } from '../agent/transcript.js';
import type { Logger } from '../diagnostics/logger.js';
import type { SandboxSettings } from '../config/schema.js';
import type { SandboxStatus } from './sandbox.js';

/** 仕様: docs/spec/05-agent.md「ツール一覧」 */

export type Risk = 'read' | 'write' | 'execute';

export type ToolLimits = {
  toolOutputLimitBytes: number;
  commandTimeoutMs: number;
  readMaxLines: number;
  readMaxBytes: number;
  deniedCommands: string[];
};

export const DEFAULT_LIMITS: ToolLimits = {
  toolOutputLimitBytes: 100_000,
  commandTimeoutMs: 120_000,
  readMaxLines: 2000,
  readMaxBytes: 262_144,
  deniedCommands: [],
};

export type ToolContext = {
  workspace: Workspace;
  journal: ChangeJournal;
  limits: ToolLimits;
  signal: AbortSignal;
  callId: string;
  /** run_command の逐次出力。無反応の時間を作らないため。 */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  logger?: Logger;
  /** この会話の生の記録（recall_search / recall_read が使う。16-context.md）。 */
  transcript?: () => readonly TranscriptEntry[];
  /** request_secret_access を渡していない呼び出し（akari mcp serve）なら false。案内の文を変える。 */
  canRequestSecrets?: boolean;
  /** コマンドの閉じ込め（05-agent.md）。省略すると閉じ込めない（テストや、閉じ込めを持たない呼び出し）。 */
  sandbox?: {
    status: SandboxStatus;
    settings: SandboxSettings;
    /** 既定の場所に加えて書き込みを許す場所（worktree の元の .git など）。 */
    extraWrite: string[];
  };
};

export type ToolResult = {
  ok: boolean;
  /** 画面・CLI・イベントに出す1行。 */
  summary: string;
  /** モデルへ返す本文。 */
  content: string;
  /** ファイルを変えた場合の記録。 */
  change?: FileChange;
  /** 失敗の種別。モデルが別の手を採れるように、必ず理由を返す。 */
  errorKind?:
    'denied' | 'not-found' | 'no-match' | 'ambiguous' | 'binary' | 'timeout' | 'failed' | 'invalid';
};

/** 承認画面に出すもの。差分やコマンド全文。 */
export type ToolPreview =
  | { kind: 'diff'; path: string; before: string; after: string }
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'delete'; path: string; bytes: number }
  | { kind: 'text'; text: string };

export type PathUse = { value: string; mode: 'read' | 'write' };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema。そのまま OpenAI の function.parameters に入る。 */
  parameters: Record<string, unknown>;
  risk: Risk;
  /**
   * 引数のうち、作業フォルダの境界を検査すべきパス。
   * 実行ループはこれを使い、**承認を出す前に**境界を確かめる。
   * 境界の外なら承認画面すら出さずに拒否する（docs/spec/05-agent.md）。
   */
  pathsOf?: (args: unknown) => PathUse[];
  /**
   * 承認を求める前の検査。結果を返したら、承認も実行もせずにそれをモデルへ返す
   * （求めても意味のない承認を、利用者に出さないため）。
   */
  check?: (args: unknown, ctx: ToolContext) => Promise<ToolResult | null>;
  /** 承認を求める前に、何が起きるかを見せるための材料。 */
  preview?: (args: unknown, ctx: ToolContext) => Promise<ToolPreview | undefined>;
  run: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * MCP サーバの道具なら、その出どころ（docs/spec/13-mcp.md）。
   * 承認の決め方（trust と権限モードの厳しいほう）と、「取り消せない」表示に使う。
   */
  mcp?: { server: string; tool: string; trust: McpTrust; readOnlyHint: boolean };
};

export type McpTrust = 'ask' | 'readOnly' | 'full';

export function denied(message: string, kind: ToolResult['errorKind'] = 'denied'): ToolResult {
  return { ok: false, summary: message, content: message, errorKind: kind };
}

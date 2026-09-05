import type { Workspace } from './workspace.js';
import type { ChangeJournal, FileChange } from '../agent/journal.js';
import type { Logger } from '../diagnostics/logger.js';

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
  /** 承認を求める前に、何が起きるかを見せるための材料。 */
  preview?: (args: unknown, ctx: ToolContext) => Promise<ToolPreview | undefined>;
  run: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
};

export function denied(message: string, kind: ToolResult['errorKind'] = 'denied'): ToolResult {
  return { ok: false, summary: message, content: message, errorKind: kind };
}

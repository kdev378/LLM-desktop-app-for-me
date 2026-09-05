import type { Risk, ToolPreview } from '../tools/types.js';
import type { FileChange } from './journal.js';
import type { ProviderError, Usage } from '../provider/types.js';

/**
 * 実行のイベント。仕様: docs/spec/05-agent.md
 *
 * 画面・ターミナル・--json・ハーネスAPI は、**すべてこの1本の列**から作る。
 * 「同じはず」ではなく「同じ情報から作る」ため。
 */

export type PermissionMode = 'ask' | 'autoEdit' | 'full';

export type ApprovalOption = {
  /** 端末で押す1文字。UIではボタンのラベルに使う。 */
  key: string;
  label: string;
  decision: ApprovalDecision;
};

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'allow-session'; scope: string }
  | { kind: 'deny'; feedback?: string }
  | { kind: 'abort' };

export type RunEndReason = 'done' | 'aborted' | 'max-steps' | 'error' | 'denied' | 'loop';

export type RunEvent =
  | {
      type: 'run-start';
      runId: string;
      workspace: string;
      model: string;
      permissionMode: PermissionMode;
      instructionFiles: string[];
      toolNames: string[];
      promptedTools: boolean;
    }
  | { type: 'step-start'; step: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | {
      type: 'tool-call';
      callId: string;
      name: string;
      args: unknown;
      risk: Risk;
      preview?: ToolPreview;
    }
  | {
      type: 'approval-request';
      callId: string;
      name: string;
      risk: Risk;
      prompt: string;
      options: ApprovalOption[];
      preview?: ToolPreview;
    }
  | { type: 'approval-resolved'; callId: string; decision: ApprovalDecision }
  | { type: 'tool-start'; callId: string; name: string }
  | { type: 'tool-output'; callId: string; stream: 'stdout' | 'stderr'; text: string }
  | {
      type: 'tool-result';
      callId: string;
      name: string;
      ok: boolean;
      summary: string;
      change?: FileChange;
    }
  | { type: 'step-end'; step: number; usage?: Usage }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | {
      type: 'run-end';
      reason: RunEndReason;
      changedFiles: string[];
      error?: ProviderError | string;
    };

export function approvalOptions(scope: string | null): ApprovalOption[] {
  const opts: ApprovalOption[] = [{ key: 'y', label: '許可', decision: { kind: 'allow' } }];
  if (scope) {
    opts.push({
      key: 'a',
      label: `この実行中は ${scope} を許可`,
      decision: { kind: 'allow-session', scope },
    });
  }
  opts.push({ key: 'n', label: '拒否', decision: { kind: 'deny' } });
  opts.push({ key: 'q', label: '実行を中止', decision: { kind: 'abort' } });
  return opts;
}

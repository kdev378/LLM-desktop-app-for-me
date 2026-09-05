/** 終了コード。仕様: docs/spec/10-cli.md */
export const EXIT = {
  ok: 0,
  runtime: 1,
  usage: 2,
  denied: 3,
  unreachable: 4,
  maxSteps: 5,
  interrupted: 130,
} as const;

export class ExitError extends Error {
  readonly code: number;
  readonly hint?: string;
  readonly detail?: string;
  /** すでに画面へ出した内容なら true。同じ文言を2回出さないため。 */
  readonly silent: boolean;
  constructor(
    code: number,
    message: string,
    opts: { hint?: string; detail?: string; silent?: boolean } = {},
  ) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
    this.hint = opts.hint;
    this.detail = opts.detail;
    this.silent = opts.silent === true;
  }
}

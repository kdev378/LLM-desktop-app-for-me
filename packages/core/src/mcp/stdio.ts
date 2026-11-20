import { spawn, type ChildProcess } from 'node:child_process';
import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';

/**
 * MCP の stdio の接続。仕様: docs/spec/13-mcp.md「起動と生存」
 *
 * 公式 SDK の StdioClientTransport は直接の子しか止めない（npx が起こした孫が残る）。
 * ここでは新しいプロセスグループで起こし、止めるときはグループごと止める。
 * Akari が落ちたときも、process の exit で残さず止める。
 */

const live = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of live) killGroup(pid, 'SIGKILL');
  });
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    /* すでに終わっている */
  }
}

export type StdioOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** サーバの標準エラー（画面には出さず、ログへ流す）。 */
  onStderr?: (text: string) => void;
};

export class GroupStdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private readonly buffer = new ReadBuffer();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly opts: StdioOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    installExitHook();
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const child = spawn(this.opts.command, this.opts.args, {
        env: this.opts.env,
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX では新しいプロセスグループにする。孫ごと確実に止めるため
        detached: !isWin,
        windowsHide: true,
        shell: false,
      });
      this.child = child;
      child.on('error', (err) => {
        if (child.pid !== undefined) live.delete(child.pid);
        reject(err);
        this.onerror?.(err);
      });
      child.on('spawn', () => {
        if (child.pid !== undefined) live.add(child.pid);
        resolve();
      });
      child.on('close', () => {
        if (child.pid !== undefined) live.delete(child.pid);
        this.child = null;
        this.onclose?.();
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let msg: JSONRPCMessage | null;
          try {
            msg = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (msg === null) break;
          this.onmessage?.(msg);
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (t: string) => this.opts.onStderr?.(t));
      child.stdin?.on('error', (err) => this.onerror?.(err));
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) {
        reject(new Error('MCP サーバのプロセスがありません。'));
        return;
      }
      stdin.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  /** 止める。まず入力を閉じ、待っても終わらなければグループごと止める。 */
  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    const closed = new Promise<void>((r) => child.once('close', () => r()));
    const wait = (ms: number) =>
      Promise.race([closed, new Promise<void>((r) => setTimeout(r, ms).unref())]);
    try {
      child.stdin?.end();
    } catch {
      /* 閉じている */
    }
    await wait(1000);
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(pid, 'SIGTERM');
      await wait(2000);
    }
    // 子が先に終わっても、孫が残っていればグループごと止める
    killGroup(pid, 'SIGKILL');
    live.delete(pid);
    this.buffer.clear();
  }
}

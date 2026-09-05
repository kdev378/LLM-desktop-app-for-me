import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../util/paths.js';
import { redact, redactDeep } from './redact.js';

/**
 * NDJSON のログ。仕様: docs/spec/09-security.md
 *
 * - event は安定した識別子（例 'provider.retry'）。文章にしない。後から検索・集計できるように。
 * - info 以下ではメッセージ本文を記録しない。trace のみ本文を含む。
 * - 水準は再起動なしで変えられる。
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export type LoggerOptions = {
  level?: LogLevel;
  dir?: string;
  /** ファイルへ書かず、この関数へ渡す（テスト・デスクトップのメモリ内表示用）。 */
  sink?: (line: string) => void;
  retainDays?: number;
};

export type LogFields = Record<string, unknown>;

export class Logger {
  private level: LogLevel;
  private readonly dir: string;
  private readonly sink: ((line: string) => void) | undefined;
  private stream: fs.WriteStream | null = null;
  private streamDay = '';

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.dir = opts.dir ?? paths.logs();
    this.sink = opts.sink;
  }

  /** 再起動なしの水準変更。 */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  isEnabled(level: LogLevel): boolean {
    return ORDER[level] <= ORDER[this.level];
  }

  error(event: string, fields: LogFields = {}): void {
    this.write('error', event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }
  debug(event: string, fields: LogFields = {}): void {
    this.write('debug', event, fields);
  }
  trace(event: string, fields: LogFields = {}): void {
    this.write('trace', event, fields);
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (!this.isEnabled(level)) return;
    const record = { ts: new Date().toISOString(), level, event, ...redactDeep(fields) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        ts: record.ts,
        level,
        event,
        _note: 'フィールドを直列化できませんでした',
      });
    }
    if (this.sink) {
      this.sink(line);
      return;
    }
    try {
      this.streamFor(record.ts).write(line + '\n');
    } catch {
      // ログが書けないことでアプリを止めない
    }
  }

  private streamFor(ts: string): fs.WriteStream {
    const day = ts.slice(0, 10);
    if (this.stream && this.streamDay === day) return this.stream;
    this.stream?.end();
    fs.mkdirSync(this.dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, `akari-${day}.log`), { flags: 'a' });
    this.streamDay = day;
    return this.stream;
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }

  /** 保持期間を過ぎたログを消す。起動時に1回だけ呼ぶ。 */
  async prune(retainDays: number): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const m = /^akari-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!m) continue;
      if (Date.parse(m[1]!) < cutoff) {
        await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }

  /** 直近 n 行を読む。診断の書き出し用。 */
  async tail(n: number): Promise<string[]> {
    let entries: string[];
    try {
      entries = (await fsp.readdir(this.dir))
        .filter((f) => /^akari-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort();
    } catch {
      return [];
    }
    const lines: string[] = [];
    for (const name of entries.slice(-3).reverse()) {
      const text = await fsp.readFile(path.join(this.dir, name), 'utf8').catch(() => '');
      const fileLines = text.split('\n').filter((l) => l.trim() !== '');
      lines.unshift(...fileLines.slice(-Math.max(0, n - lines.length)));
      if (lines.length >= n) break;
    }
    return lines.slice(-n).map((l) => redact(l));
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(opts);
}

/** 何も書かないロガー。テストと、ログを持たない呼び出し用。 */
export const nullLogger = new Logger({ level: 'error', sink: () => undefined });

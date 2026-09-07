import {
  isLikelyChatModel,
  loadConfig,
  saveConfig,
  createLogger,
  resolveEndpoint,
  akariHome,
  type Config,
  type Logger,
  type ResolvedEndpoint,
  type LogLevel,
} from '@akari/core';
import { ExitError, EXIT } from './exit.js';
import type { ReasoningLevel } from '@akari/core';
import { c, setNotes, note } from './term.js';

/**
 * 各コマンドが使う共通の下ごしらえ。
 * 設定の問題は、握り潰さず必ず一度は見せる。
 */

export type GlobalOptions = {
  endpoint?: string;
  model?: string;
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
  verbose?: boolean;
};

export type CliContext = {
  root: string;
  config: Config;
  readOnly: boolean;
  logger: Logger;
  json: boolean;
  quiet: boolean;
};

export async function createContext(opts: GlobalOptions): Promise<CliContext> {
  const root = akariHome();
  // --json は標準出力だけで完結させる。人向けの補助行は出さない。
  setNotes(opts.json !== true && opts.quiet !== true);
  const { config, problems, readOnly } = await loadConfig(root);

  const level: LogLevel = opts.verbose ? 'debug' : config.logging.level;
  const logger = createLogger({ level, dir: `${root}/logs` });
  await logger.prune(config.logging.retainDays).catch(() => 0);

  // 設定の問題は --json でも標準エラーへ出す。黙って既定で動かさない。
  for (const p of problems) {
    process.stderr.write(`${c.yellow('設定: ')}${p.message}\n`);
    if (p.detail) process.stderr.write(c.gray('  ' + p.detail.split('\n').join('\n  ')) + '\n');
    logger.warn('config.problem', { kind: p.kind, message: p.message });
  }

  return { root, config, readOnly, logger, json: opts.json === true, quiet: opts.quiet === true };
}

/** 環境変数 → 引数の順に強くなる（docs/spec/03-config.md の優先順位）。 */
export async function pickEndpoint(
  ctx: CliContext,
  name?: string,
  timeout?: string,
): Promise<ResolvedEndpoint> {
  const chosen = name ?? process.env.AKARI_ENDPOINT;
  if (ctx.config.endpoints.length === 0) {
    throw new ExitError(EXIT.usage, '接続先が1つも登録されていません。', {
      hint: 'akari config endpoints add --name "ローカル" --url http://localhost:11434/v1',
    });
  }
  const endpoint = await resolveEndpoint(ctx.config, chosen ?? null, ctx.root);
  const timeoutMs = pickTimeoutMs(timeout);
  // その1回だけ待ち時間を延ばす。設定は書き換えない。
  return timeoutMs === null ? endpoint : { ...endpoint, timeoutMs };
}

/**
 * --think / AKARI_REASONING / generation.reasoning。
 * auto（既定）はサーバに任せる＝何も送らない。
 */
export function pickReasoning(
  opt: string | undefined,
  fromConfig: 'auto' | ReasoningLevel,
): ReasoningLevel | undefined {
  const raw = opt ?? process.env.AKARI_REASONING ?? fromConfig;
  if (raw === 'auto' || raw === undefined || raw === '') return undefined;
  if (raw === 'off' || raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  throw new ExitError(
    EXIT.usage,
    `--think は auto / off / low / medium / high のいずれかです（受け取った値: ${raw}）。`,
  );
}

/** --timeout / AKARI_TIMEOUT（秒）。指定が無ければ null。 */
function pickTimeoutMs(timeout?: string): number | null {
  const raw = timeout ?? process.env.AKARI_TIMEOUT;
  if (raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
    throw new ExitError(
      EXIT.usage,
      `--timeout は 1〜3600 の秒数で指定してください（受け取った値: ${raw}）。`,
    );
  }
  return Math.round(seconds * 1000);
}

/** モデルの決め方: 引数 > 環境変数 > 接続先の既定 > サーバの先頭。 */
export async function pickModel(
  endpoint: ResolvedEndpoint,
  explicit: string | undefined,
  listModels: () => Promise<string[]>,
): Promise<string> {
  const fromEnv = process.env.AKARI_MODEL;
  const chosen = explicit ?? fromEnv ?? endpoint.defaultModel ?? null;
  if (chosen) return chosen;

  const models = await listModels();
  // 一覧の先頭をそのまま使わない。LM Studio のように埋め込みモデルが混ざる環境で
  // chat を投げられないモデルを掴むため（docs/spec/02-provider.md）。
  const first = models.find((m) => isLikelyChatModel(m)) ?? models[0];
  if (!first) {
    throw new ExitError(EXIT.usage, `接続先 "${endpoint.name}" にモデルが1件もありません。`, {
      hint: 'サーバ側にモデルを入れるか、--model で明示してください。',
    });
  }
  note(`モデル未指定のため ${first} を使います（-m で指定できます）。`);
  return first;
}

export async function persist(ctx: CliContext, next: Config): Promise<void> {
  if (ctx.readOnly) {
    throw new ExitError(EXIT.usage, '設定が読み取り専用のため保存できません。', {
      hint: '新しいバージョンのAkariで作られた設定です。更新するか、config.json を退避してください。',
    });
  }
  await saveConfig(next, ctx.root);
  ctx.config = next;
}

import { z } from 'zod';

/**
 * 設定の形と有効範囲。仕様: docs/spec/03-config.md
 * ここが設定項目の正本。ドキュメントの表と食い違ったら、両方直す。
 */

export const CONFIG_SCHEMA_VERSION = 1;

const urlWithScheme = z
  .string()
  .trim()
  .min(1, 'ベースURLが空です')
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'http:// または https:// で始まるURLを入れてください')
  .transform((v) => v.replace(/\/+$/, '')); // 末尾スラッシュは除去して保存

/** 1つのモデルに対する判定結果。ツール対応はモデルごとに変わる。 */
export const modelCapabilitySchema = z.object({
  tools: z.enum(['native', 'prompted', 'none']),
  usageReported: z.boolean().default(false),
  streamsToolCalls: z.boolean().default(false),
  /** そのモデルの文脈長。分からなければ null（docs/spec/16-context.md）。 */
  contextTokens: z.number().int().min(256).nullable().default(null),
  probedAt: z.string(),
});

export const capabilitiesSchema = z.object({
  tools: z.enum(['auto', 'native', 'prompted', 'none']).default('auto'),
  vision: z.enum(['auto', 'yes', 'no']).default('auto'),
  usageReported: z.boolean().default(false),
  streamsToolCalls: z.boolean().default(false),
  probedAt: z.string().nullable().default(null),
  probedModel: z.string().nullable().default(null),
  /**
   * モデルごとの判定結果。モデルを行き来しても判定し直さないため。
   * 上の tools/probedModel は「最後に判定したモデル」の写しで、表示用に残している。
   */
  byModel: z.record(modelCapabilitySchema).default({}),
});

export const endpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, '表示名を入れてください'),
  baseUrl: urlWithScheme,
  /** 鍵そのものではなく参照。'env:NAME' か、credentials.json のキー名。 */
  apiKeyRef: z.string().nullable().default(null),
  defaultModel: z.string().nullable().default(null),
  headers: z.record(z.string()).default({}),
  /**
   * リクエストを出してから最初のトークンが来るまでの上限。
   * ローカルのサーバはモデルの読み込みと入力の処理を先に済ませるため、
   * 小さいモデルでも数分かかることがある。
   */
  timeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  capabilities: capabilitiesSchema.default({}),
  /** 外部（localhost以外）への送信に同意済みか。docs/spec/09-security.md */
  externalConsent: z.boolean().default(false),
});

export const generationSchema = z.object({
  /**
   * 思考（reasoning）の量。docs/spec/02-provider.md「思考量の指定」
   * auto はサーバに任せる（何も送らない）。
   */
  reasoning: z.enum(['auto', 'off', 'low', 'medium', 'high']).default('auto'),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(1),
  maxTokens: z.number().int().min(1).nullable().default(null),
});

export const agentSchema = z.object({
  permissionMode: z.enum(['ask', 'autoEdit', 'full']).default('ask'),
  /**
   * 道具の渡し方（docs/spec/02-provider.md）。
   * auto     … 判定結果に従う。判定できなければ both
   * native   … 関数呼び出しだけ
   * prompted … 本文のブロックだけ
   * both     … 両方受け付ける
   */
  toolsMode: z.enum(['auto', 'native', 'prompted', 'both']).default('auto'),
  maxSteps: z.number().int().min(1).max(200).default(25),
  commandTimeoutMs: z.number().int().min(1000).max(1800000).default(120000),
  toolOutputLimitBytes: z.number().int().min(1000).max(10000000).default(100000),
  allowedCommands: z.array(z.string()).default([]),
  /**
   * 承認待ちの上限（ミリ秒）。過ぎたら拒否として扱う。null は無期限。
   * 外部ツール（ハーネスAPI）が落ちたまま実行が残るのを避けたいときに有限にする。docs/spec/12-harness-api.md
   */
  approvalTimeoutMs: z.number().int().min(1000).max(86_400_000).nullable().default(null),
  /** コマンドの閉じ込め。docs/spec/05-agent.md「コマンドの閉じ込め」 */
  sandbox: z
    .object({
      /** auto … 使えれば使う / required … 使えなければコマンドを実行しない / off … 使わない */
      mode: z.enum(['auto', 'required', 'off']).default('auto'),
      /** 既定のキャッシュに加えて、書き込みを許す場所。~ で始めてよい。 */
      allowWrite: z.array(z.string().min(1)).default([]),
      /** 作業フォルダの中の秘密のファイル（.env など）を読めるようにする。 */
      allowWorkspaceSecrets: z.boolean().default(false),
      network: z.boolean().default(true),
    })
    .default({}),
  /**
   * 一致したら承認画面すら出さずに拒否する。docs/spec/05-agent.md
   * git の履歴を書き換える操作は、gitTools を有効にしても通さない。
   */
  deniedCommands: z
    .array(z.string())
    .default([
      'rm -rf /',
      'mkfs',
      'dd if=',
      'shutdown',
      'reboot',
      ':(){',
      'git push --force',
      'git push -f',
      'git reset --hard',
      'git commit --amend',
      'git rebase',
      'git filter-branch',
    ]),
});

/** ハーネスAPI（akari serve）。docs/spec/12-harness-api.md */
export const serverSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(7801),
  /** ブラウザからの要求を許すオリジン。空なら全拒否。 */
  allowOrigins: z.array(z.string()).default([]),
  /**
   * 真のときだけ HTTP から permissionMode "full" を受け付ける。
   * コマンドがまだ作業フォルダに閉じ込められていないため、既定では受け付けない。
   */
  allowFullPermission: z.boolean().default(false),
});

export const uiSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  style: z.enum(['modern', 'classic']).default('modern'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  fontScale: z.number().min(0.8).max(2).default(1),
});

export const loggingSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
  retainDays: z.number().int().min(1).max(365).default(14),
});

/** 文脈の管理と圧縮（docs/spec/16-context.md「設定のまとめ」）。 */
export const contextSchema = z.object({
  /** auto なら圧縮する。off なら圧縮せず、入りきらなければ止める。 */
  mode: z.enum(['auto', 'off']).default('auto'),
  /** 文脈長の何割を超えたら圧縮するか（文脈長が分かるとき）。 */
  compactAtRatio: z.number().min(0.3).max(0.95).default(0.7),
  /** 文脈長が分からないときの絶対値。 */
  compactAtTokens: z.number().int().min(1000).default(12000),
  /** 生のまま残す直近の手数（モデルの応答1回とその道具の結果で1手）。 */
  keepRecentTurns: z.number().int().min(1).max(20).default(3),
  /** 圧縮に使うモデル。null なら実行と同じ。同じ接続先のモデル名。 */
  digestModel: z.string().min(1).nullable().default(null),
});

export const configSchema = z.object({
  schemaVersion: z.number().int().default(CONFIG_SCHEMA_VERSION),
  endpoints: z.array(endpointSchema).default([]),
  activeEndpointId: z.string().nullable().default(null),
  generation: generationSchema.default({}),
  agent: agentSchema.default({}),
  context: contextSchema.default({}),
  ui: uiSchema.default({}),
  logging: loggingSchema.default({}),
  concurrency: z
    .object({ maxParallelRuns: z.number().int().min(1).max(16).default(4) })
    .default({}),
  server: serverSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type EndpointCapabilities = z.infer<typeof capabilitiesSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type GenerationSettings = z.infer<typeof generationSchema>;
export type AgentSettings = z.infer<typeof agentSchema>;
export type ContextSettings = z.infer<typeof contextSchema>;
export type ServerSettings = z.infer<typeof serverSchema>;
export type SandboxSettings = AgentSettings['sandbox'];
export type PermissionMode = AgentSettings['permissionMode'];

export function defaultConfig(): Config {
  return configSchema.parse({});
}

export const credentialsSchema = z.object({
  schemaVersion: z.number().int().default(1),
  keys: z.record(z.string()).default({}),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/** zod のエラーを、どの項目がなぜ駄目かの1行ずつに直す。 */
export function describeIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const at = i.path.length > 0 ? i.path.join('.') : '(全体)';
    return `${at}: ${i.message}`;
  });
}

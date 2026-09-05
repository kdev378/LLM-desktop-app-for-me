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

export const capabilitiesSchema = z.object({
  tools: z.enum(['auto', 'native', 'prompted', 'none']).default('auto'),
  vision: z.enum(['auto', 'yes', 'no']).default('auto'),
  usageReported: z.boolean().default(false),
  streamsToolCalls: z.boolean().default(false),
  probedAt: z.string().nullable().default(null),
  probedModel: z.string().nullable().default(null),
});

export const endpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, '表示名を入れてください'),
  baseUrl: urlWithScheme,
  /** 鍵そのものではなく参照。'env:NAME' か、credentials.json のキー名。 */
  apiKeyRef: z.string().nullable().default(null),
  defaultModel: z.string().nullable().default(null),
  headers: z.record(z.string()).default({}),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  capabilities: capabilitiesSchema.default({}),
  /** 外部（localhost以外）への送信に同意済みか。docs/spec/09-security.md */
  externalConsent: z.boolean().default(false),
});

export const generationSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(1),
  maxTokens: z.number().int().min(1).nullable().default(null),
});

export const agentSchema = z.object({
  permissionMode: z.enum(['ask', 'autoEdit', 'full']).default('ask'),
  maxSteps: z.number().int().min(1).max(200).default(25),
  commandTimeoutMs: z.number().int().min(1000).max(1800000).default(120000),
  toolOutputLimitBytes: z.number().int().min(1000).max(10000000).default(100000),
  allowedCommands: z.array(z.string()).default([]),
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
      'git reset --hard',
    ]),
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

export const configSchema = z.object({
  schemaVersion: z.number().int().default(CONFIG_SCHEMA_VERSION),
  endpoints: z.array(endpointSchema).default([]),
  activeEndpointId: z.string().nullable().default(null),
  generation: generationSchema.default({}),
  agent: agentSchema.default({}),
  ui: uiSchema.default({}),
  logging: loggingSchema.default({}),
  concurrency: z
    .object({ maxParallelRuns: z.number().int().min(1).max(16).default(4) })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type EndpointCapabilities = z.infer<typeof capabilitiesSchema>;
export type GenerationSettings = z.infer<typeof generationSchema>;
export type AgentSettings = z.infer<typeof agentSchema>;
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

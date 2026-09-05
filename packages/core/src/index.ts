/**
 * @akari/core の公開面。ここに無いものは内部実装として自由に変えてよい。
 * 仕様: docs/spec/01-architecture.md
 */

// 設定
export { loadConfig, saveConfig, type LoadedConfig, type ConfigProblem } from './config/config.js';
export {
  configSchema,
  defaultConfig,
  describeIssues,
  CONFIG_SCHEMA_VERSION,
  type Config,
  type Endpoint,
  type EndpointCapabilities,
  type GenerationSettings,
  type AgentSettings,
  type PermissionMode,
  type Credentials,
} from './config/schema.js';
export {
  loadCredentials,
  saveCredentials,
  setKey,
  removeKey,
  resolveKey,
  type ResolvedKey,
} from './config/credentials.js';
export {
  resolveEndpoint,
  findEndpoint,
  addEndpoint,
  removeEndpoint,
  updateEndpoint,
  isExternalUrl,
  type ResolvedEndpoint,
  type AddEndpointInput,
} from './config/endpoints.js';

// 接続先
export {
  createProvider,
  getProviderError,
  buildRequestBody,
  type ProviderOptions,
} from './provider/openai.js';
export { probeEndpoint } from './provider/probe.js';
export { SseParser, ToolCallBuffer } from './provider/sse.js';
export {
  classifyHttp,
  classifyNetwork,
  isRetriableBeforeFirstByte,
  providerError,
} from './provider/errors.js';
export type {
  Provider,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ToolCallRequest,
  ToolDefinition,
  ModelInfo,
  ProviderError,
  ProviderErrorKind,
  EndpointProbeResult,
  FinishReason,
  Usage,
  Role,
} from './provider/types.js';

// 診断
export {
  createLogger,
  Logger,
  nullLogger,
  type LogLevel,
  type LoggerOptions,
} from './diagnostics/logger.js';
export { redact, redactDeep, registerSecret, forgetSecrets } from './diagnostics/redact.js';
export {
  collectDiagnostics,
  formatDiagnostics,
  type DiagnosticsBundle,
  type EndpointDiagnostic,
  type CollectOptions,
} from './diagnostics/doctor.js';

// 補助
export { akariHome, paths, ensureDir, tildify } from './util/paths.js';
export { ulid, shortId } from './util/ids.js';
export { readJson, writeJsonAtomic, writeFileAtomic } from './util/json.js';
export { AkariError, isAkariError, messageOf } from './util/errors.js';

export const CORE_VERSION = '0.1.0';

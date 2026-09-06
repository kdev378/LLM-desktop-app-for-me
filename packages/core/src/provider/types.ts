/**
 * Provider の契約。仕様: docs/spec/02-provider.md
 * ここに無いものを Provider の外へ出さない。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: Role;
  content: string;
  /** assistant がツールを呼んだとき */
  toolCalls?: ToolCallRequest[];
  /** role:'tool' のとき、どの呼び出しへの結果か */
  toolCallId?: string;
  /** role:'tool' のとき、ツール名（一部サーバが要求する） */
  name?: string;
};

export type ToolCallRequest = {
  id: string;
  name: string;
  /** モデルが出した生の文字列。JSONとして読めない場合があるので、解釈は呼び出し側で行う。 */
  argumentsRaw: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema。OpenAI の function.parameters にそのまま入る。 */
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number | null;
  stop?: string[];
  seed?: number;
};

export type FinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'aborted' | 'unknown';

export type Usage = { prompt: number; completion: number; total: number };

export type ChatEvent =
  | { type: 'start'; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; argumentsRaw: string }
  | { type: 'finish'; reason: FinishReason; usage?: Usage }
  | { type: 'error'; error: ProviderError };

export type ModelInfo = {
  id: string;
  ownedBy?: string;
  created?: number;
  /**
   * サーバが文脈長を返した場合のみ入る。返さないサーバが多いので、
   * 無いことを「分かっている」ように扱わない（docs/spec/16-context.md）。
   */
  contextTokens?: number;
};

export type ProviderErrorKind =
  | 'unreachable'
  | 'unauthorized'
  | 'model_not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server_error'
  | 'incompatible'
  | 'aborted';

export type ProviderError = {
  kind: ProviderErrorKind;
  /** 利用者に見せる1行。原因と、可能なら対処。 */
  message: string;
  status?: number;
  /** サーバの返した本文の先頭（伏字化済み・最大2KB）。診断用。 */
  bodyExcerpt?: string;
  endpointId: string;
  model?: string;
  retryAfterMs?: number;
};

export type EndpointProbeResult = {
  reachable: boolean;
  models: ModelInfo[];
  /** 判定に使ったモデルの文脈長。分からなければ null。 */
  contextTokens: number | null;
  tools: 'native' | 'prompted' | 'none';
  usageReported: boolean;
  streamsToolCalls: boolean;
  testedModel: string | null;
  /** 判定の過程。doctor でそのまま見せる。 */
  notes: string[];
  error?: ProviderError;
};

export interface Provider {
  readonly endpointId: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent, void, void>;
  probe(model?: string, signal?: AbortSignal): Promise<EndpointProbeResult>;
}

import { SseParser, ToolCallBuffer } from './sse.js';
import { ThinkSplitter } from './think.js';
import {
  classifyHttp,
  classifyNetwork,
  excerpt,
  isRetriableBeforeFirstByte,
  providerError,
} from './errors.js';
import type {
  ChatEvent,
  ChatRequest,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderError,
  Usage,
} from './types.js';
import type { ResolvedEndpoint } from '../config/endpoints.js';
import type { Logger } from '../diagnostics/logger.js';

/** 接続確立（ヘッダ受信）までの上限。 */
const CONNECT_TIMEOUT_MS = 10_000;
/** トークン間の上限。これを超えたら壊れているとみなす。 */
const IDLE_TIMEOUT_MS = 120_000;

type AbortReason = { akari: 'connect-timeout' | 'first-token-timeout' | 'idle-timeout' };

export type ProviderOptions = {
  logger?: Logger;
  /** テスト用の差し替え。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
};

export function createProvider(endpoint: ResolvedEndpoint, opts: ProviderOptions = {}): Provider {
  return new OpenAiCompatibleProvider(endpoint, opts);
}

class OpenAiCompatibleProvider implements Provider {
  readonly endpointId: string;
  private readonly ep: ResolvedEndpoint;
  private readonly log?: Logger;
  private readonly doFetch: typeof fetch;

  constructor(endpoint: ResolvedEndpoint, opts: ProviderOptions) {
    this.ep = endpoint;
    this.endpointId = endpoint.id;
    this.log = opts.logger;
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...this.ep.headers,
    };
    // 追加ヘッダで Authorization を上書きさせない
    if (this.ep.apiKey) h['authorization'] = `Bearer ${this.ep.apiKey}`;
    return h;
  }

  private url(pathname: string): string {
    return `${this.ep.baseUrl}${pathname}`;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const url = this.url('/models');
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal: withTimeout(signal, this.ep.timeoutMs, { akari: 'connect-timeout' }).signal,
      });
    } catch (err) {
      throw toError(
        classifyNetwork(err, { endpointId: this.endpointId, baseUrl: this.ep.baseUrl }),
      );
    }
    const body = await res.text();
    if (!res.ok) {
      throw toError(
        classifyHttp(res.status, body, {
          endpointId: this.endpointId,
          retryAfter: res.headers.get('retry-after'),
        }),
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw toError(
        providerError(
          'incompatible',
          '/models の応答がJSONではありません。OpenAI互換のURLか確認してください。',
          {
            endpointId: this.endpointId,
            bodyExcerpt: excerpt(body),
          },
        ),
      );
    }
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw toError(
        providerError('incompatible', '/models の応答に data 配列がありません。', {
          endpointId: this.endpointId,
          bodyExcerpt: excerpt(body),
        }),
      );
    }
    return data
      .map((m): ModelInfo | null => {
        const rec = m as Record<string, unknown>;
        const id =
          typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : null;
        if (!id) return null;
        return {
          id,
          ownedBy: typeof rec.owned_by === 'string' ? rec.owned_by : undefined,
          created: typeof rec.created === 'number' ? rec.created : undefined,
          ...(readContextTokens(rec) !== null ? { contextTokens: readContextTokens(rec)! } : {}),
        };
      })
      .filter((m): m is ModelInfo => m !== null);
    // 並べ替えない。サーバの順序には意味があることが多く
    // （読み込み中のモデルが先頭など）、並べ替えると自動選択が的外れになる。
    // 表示のための並べ替えは呼び出し側で行う。
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent, void, void> {
    // 接続確立前の失敗だけ再試行する。トークンを受け取った後は再試行しない。
    const delays = [0, 1000, 3000];
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt]!;
      if (delay > 0) {
        this.log?.info('provider.retry', { attempt, delayMs: delay, endpointId: this.endpointId });
        await sleep(delay, signal);
      }
      let started = false;
      try {
        for await (const ev of this.chatOnce(req, signal)) {
          if (ev.type === 'error') {
            if (!started && isRetriableBeforeFirstByte(ev.error) && attempt < delays.length - 1) {
              lastError = ev.error;
              break; // 再試行へ
            }
            yield ev;
            return;
          }
          if (ev.type === 'text-delta' || ev.type === 'reasoning-delta' || ev.type === 'tool-call')
            started = true;
          yield ev;
          if (ev.type === 'finish') return;
        }
        if (started) return;
        // started でないまま終わった = 再試行の余地あり
        if (attempt >= delays.length - 1) return;
      } catch (err) {
        const pe = classifyNetwork(err, {
          endpointId: this.endpointId,
          model: req.model,
          baseUrl: this.ep.baseUrl,
        });
        if (started || !isRetriableBeforeFirstByte(pe) || attempt >= delays.length - 1) {
          yield { type: 'error', error: pe };
          return;
        }
        lastError = pe;
      }
    }
    if (lastError) yield { type: 'error', error: lastError };
  }

  /** 1回分の呼び出し。stream_options 非対応サーバへの再送はここで1度だけ行う。 */
  private async *chatOnce(
    req: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent, void, void> {
    let includeUsage = true;
    for (let pass = 0; pass < 2; pass++) {
      const body = buildRequestBody(req, includeUsage);
      const timer = withTimeout(signal, CONNECT_TIMEOUT_MS, { akari: 'connect-timeout' });
      let res: Response;
      try {
        res = await this.doFetch(this.url('/chat/completions'), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: timer.signal,
        });
      } catch (err) {
        timer.clear();
        yield { type: 'error', error: this.classifyAbort(err, timer.reason, req.model) };
        return;
      }

      if (!res.ok) {
        timer.clear();
        const text = await res.text().catch(() => '');
        // stream_options を理解しないサーバへの1回だけの再送
        if (
          includeUsage &&
          (res.status === 400 || res.status === 422) &&
          /stream_options/i.test(text)
        ) {
          this.log?.warn('provider.streamOptionsUnsupported', {
            endpointId: this.endpointId,
            status: res.status,
          });
          includeUsage = false;
          continue;
        }
        yield {
          type: 'error',
          error: classifyHttp(res.status, text, {
            endpointId: this.endpointId,
            model: req.model,
            retryAfter: res.headers.get('retry-after'),
          }),
        };
        return;
      }

      yield { type: 'start', model: req.model };
      yield* this.readStream(res, req, timer);
      return;
    }
  }

  private async *readStream(
    res: Response,
    req: ChatRequest,
    timer: TimeoutHandle,
  ): AsyncGenerator<ChatEvent, void, void> {
    const contentType = res.headers.get('content-type') ?? '';

    // stream:true を無視して1回で返すサーバがある。JSONならそれとして扱う。
    if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
      timer.clear();
      const text = await res.text();
      yield* this.emitNonStreamed(text, req);
      return;
    }

    if (!res.body) {
      timer.clear();
      yield {
        type: 'error',
        error: providerError('incompatible', '応答に本文がありません。', {
          endpointId: this.endpointId,
          model: req.model,
        }),
      };
      return;
    }

    timer.reset(this.ep.timeoutMs, { akari: 'first-token-timeout' });

    const parser = new SseParser();
    const tools = new ToolCallBuffer();
    // 本文に混ざる <think> は、受け取った時点で思考として分けておく
    const think = new ThinkSplitter();
    const decoder = new TextDecoder();
    let finishReason: FinishReason = 'unknown';
    let usage: Usage | undefined;
    let sawAnyDelta = false;
    let sawAnyEvent = false;
    let firstBytes = '';

    const reader = res.body.getReader();
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          timer.clear();
          yield { type: 'error', error: this.classifyAbort(err, timer.reason, req.model) };
          return;
        }
        if (chunk.done) break;

        const text = decoder.decode(chunk.value, { stream: true });
        if (firstBytes.length < 200) firstBytes += text.slice(0, 200 - firstBytes.length);

        for (const ev of parser.push(text)) {
          sawAnyEvent = true;
          if (ev.data === '[DONE]') {
            timer.clear();
            break;
          }
          let payload: OpenAiChunk;
          try {
            payload = JSON.parse(ev.data) as OpenAiChunk;
          } catch {
            continue; // 解釈できない行は飛ばす。壊れた1行で全体を落とさない。
          }
          if (payload.error) {
            timer.clear();
            yield {
              type: 'error',
              error: providerError('bad_request', describeUpstreamError(payload.error), {
                endpointId: this.endpointId,
                model: req.model,
                bodyExcerpt: excerpt(JSON.stringify(payload.error)),
              }),
            };
            return;
          }
          if (payload.usage) usage = toUsage(payload.usage);

          const choice = payload.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          if (typeof delta.content === 'string' && delta.content !== '') {
            if (!sawAnyDelta) timer.reset(IDLE_TIMEOUT_MS, { akari: 'idle-timeout' });
            else timer.bump();
            sawAnyDelta = true;
            const split = think.push(delta.content);
            if (split.reasoning !== '') yield { type: 'reasoning-delta', text: split.reasoning };
            if (split.text !== '') yield { type: 'text-delta', text: split.text };
          }
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning !== '') {
            if (!sawAnyDelta) timer.reset(IDLE_TIMEOUT_MS, { akari: 'idle-timeout' });
            else timer.bump();
            sawAnyDelta = true;
            yield { type: 'reasoning-delta', text: reasoning };
          }
          if (Array.isArray(delta.tool_calls)) {
            if (!sawAnyDelta) timer.reset(IDLE_TIMEOUT_MS, { akari: 'idle-timeout' });
            else timer.bump();
            sawAnyDelta = true;
            for (const tc of delta.tool_calls) tools.add(tc);
          }
          if (choice.finish_reason) finishReason = normalizeFinish(choice.finish_reason);
        }
      }
    } finally {
      timer.clear();
      reader.releaseLock?.();
    }

    const tail = think.flush();
    if (tail.reasoning !== '') yield { type: 'reasoning-delta', text: tail.reasoning };
    if (tail.text !== '') yield { type: 'text-delta', text: tail.text };
    if (think.unterminated) {
      this.log?.warn('provider.unterminatedThinkBlock', {
        endpointId: this.endpointId,
        model: req.model,
      });
    }

    for (const ev of parser.flush()) {
      if (ev.data && ev.data !== '[DONE]') {
        try {
          const payload = JSON.parse(ev.data) as OpenAiChunk;
          if (payload.usage) usage = toUsage(payload.usage);
        } catch {
          /* 末尾の壊れた行は無視 */
        }
      }
    }

    if (!sawAnyEvent) {
      yield {
        type: 'error',
        error: providerError(
          'incompatible',
          'SSEとして解釈できない応答が返りました。ベースURLがOpenAI互換のものか確認してください。',
          { endpointId: this.endpointId, model: req.model, bodyExcerpt: excerpt(firstBytes) },
        ),
      };
      return;
    }

    for (const call of tools.finish()) {
      yield { type: 'tool-call', id: call.id, name: call.name, argumentsRaw: call.argumentsRaw };
    }
    if (tools.size > 0 && finishReason === 'unknown') finishReason = 'tool_calls';
    yield { type: 'finish', reason: finishReason, ...(usage ? { usage } : {}) };
  }

  /** stream:true を無視して一括で返すサーバ向け。 */
  private async *emitNonStreamed(
    text: string,
    req: ChatRequest,
  ): AsyncGenerator<ChatEvent, void, void> {
    let payload: OpenAiChunk;
    try {
      payload = JSON.parse(text) as OpenAiChunk;
    } catch {
      yield {
        type: 'error',
        error: providerError('incompatible', '応答をJSONとして読めませんでした。', {
          endpointId: this.endpointId,
          model: req.model,
          bodyExcerpt: excerpt(text),
        }),
      };
      return;
    }
    if (payload.error) {
      yield {
        type: 'error',
        error: providerError('bad_request', describeUpstreamError(payload.error), {
          endpointId: this.endpointId,
          model: req.model,
          bodyExcerpt: excerpt(text),
        }),
      };
      return;
    }
    this.log?.warn('provider.nonStreamedResponse', {
      endpointId: this.endpointId,
      model: req.model,
    });
    const choice = payload.choices?.[0];
    const msg = choice?.message ?? choice?.delta;
    if (msg?.content) {
      const splitter = new ThinkSplitter();
      const a = splitter.push(msg.content);
      const b = splitter.flush();
      const reasoning = a.reasoning + b.reasoning;
      const body = a.text + b.text;
      if (reasoning !== '') yield { type: 'reasoning-delta', text: reasoning };
      if (body !== '') yield { type: 'text-delta', text: body };
    }
    const reasoning = msg?.reasoning_content ?? msg?.reasoning;
    if (typeof reasoning === 'string' && reasoning)
      yield { type: 'reasoning-delta', text: reasoning };
    if (Array.isArray(msg?.tool_calls)) {
      const buf = new ToolCallBuffer();
      msg.tool_calls.forEach((tc, i) => buf.add({ ...tc, index: tc.index ?? i }));
      for (const call of buf.finish()) {
        yield { type: 'tool-call', id: call.id, name: call.name, argumentsRaw: call.argumentsRaw };
      }
    }
    yield {
      type: 'finish',
      reason: choice?.finish_reason ? normalizeFinish(choice.finish_reason) : 'stop',
      ...(payload.usage ? { usage: toUsage(payload.usage) } : {}),
    };
  }

  private classifyAbort(err: unknown, reason: AbortReason | null, model: string): ProviderError {
    if ((err as { name?: string })?.name === 'AbortError' && reason) {
      const map: Record<AbortReason['akari'], string> = {
        'connect-timeout': `サーバが ${CONNECT_TIMEOUT_MS / 1000} 秒以内に応答しませんでした。`,
        'first-token-timeout': `最初の応答が ${Math.round(this.ep.timeoutMs / 1000)} 秒以内に来ませんでした。モデルの読み込みに時間がかかっている可能性があります。`,
        'idle-timeout': `応答が ${IDLE_TIMEOUT_MS / 1000} 秒途切れました。`,
      };
      const kind = reason.akari === 'idle-timeout' ? 'incompatible' : 'unreachable';
      return providerError(kind, map[reason.akari], { endpointId: this.endpointId, model });
    }
    return classifyNetwork(err, { endpointId: this.endpointId, model, baseUrl: this.ep.baseUrl });
  }

  async probe(model?: string, signal?: AbortSignal) {
    const { probeEndpoint } = await import('./probe.js');
    return probeEndpoint(this, this.endpointId, model, signal);
  }
}

// ---------- 補助 ----------

type OpenAiToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiMessageLike = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAiToolCallDelta[];
};

type OpenAiChunk = {
  choices?: Array<{
    delta?: OpenAiMessageLike;
    message?: OpenAiMessageLike;
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: unknown;
};

export function buildRequestBody(req: ChatRequest, includeUsage: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    messages: req.messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.argumentsRaw },
        }));
      }
      if (m.toolCallId) out.tool_call_id = m.toolCallId;
      if (m.name) out.name = m.name;
      return out;
    }),
  };
  if (includeUsage) body.stream_options = { include_usage: true };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.maxTokens !== undefined && req.maxTokens !== null) body.max_tokens = req.maxTokens;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;
  if (req.seed !== undefined) body.seed = req.seed;
  return body;
}

/**
 * サーバが文脈長を返していれば拾う。名前はサーバごとに違う。
 * vLLM は max_model_len、llama.cpp 系は n_ctx、LM Studio は max_context_length を使うことがある。
 * どれも無ければ null。推測しない。
 */
function readContextTokens(rec: Record<string, unknown>): number | null {
  for (const key of [
    'max_model_len',
    'max_context_length',
    'context_length',
    'n_ctx',
    'context_window',
  ]) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return null;
}

function normalizeFinish(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return reason;
    case 'function_call':
      return 'tool_calls';
    default:
      return 'unknown';
  }
}

function toUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): Usage {
  const prompt = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  return { prompt, completion, total: u.total_tokens ?? prompt + completion };
}

function describeUpstreamError(error: unknown): string {
  if (typeof error === 'string') return error;
  const rec = error as { message?: unknown };
  if (typeof rec?.message === 'string') return rec.message;
  return 'サーバがエラーを返しました。';
}

function toError(pe: ProviderError): Error & { providerError: ProviderError } {
  const e = new Error(pe.message) as Error & { providerError: ProviderError };
  e.providerError = pe;
  return e;
}

export function getProviderError(err: unknown): ProviderError | null {
  const e = err as { providerError?: ProviderError };
  return e?.providerError ?? null;
}

type TimeoutHandle = {
  signal: AbortSignal;
  reason: AbortReason | null;
  reset(ms: number, reason: AbortReason): void;
  bump(): void;
  clear(): void;
};

/**
 * 呼び出し側の signal と、段階ごとのタイムアウトを1つの signal にまとめる。
 * どの段階で切れたかを reason に残し、エラー文言を分けられるようにする。
 */
function withTimeout(
  outer: AbortSignal | undefined,
  ms: number,
  reason: AbortReason,
): TimeoutHandle {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let currentMs = ms;
  let currentReason: AbortReason = reason;
  const handle: TimeoutHandle = {
    signal: controller.signal,
    reason: null,
    reset(nextMs, nextReason) {
      currentMs = nextMs;
      currentReason = nextReason;
      this.bump();
    },
    bump() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        handle.reason = currentReason;
        controller.abort();
      }, currentMs);
      timer.unref?.();
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
  handle.bump();
  if (outer) {
    if (outer.aborted) controller.abort();
    else
      outer.addEventListener(
        'abort',
        () => {
          handle.clear();
          controller.abort();
        },
        { once: true },
      );
  }
  return handle;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}

import type { ModelRouteConfig, GatewayConfig } from '../model-gateway/config.js';
import { resolveApiKey } from '../model-gateway/config.js';
import { ModelGatewayError } from '../model-gateway/errors.js';
import {
  assertResponse,
  defaultFetch,
  type FetchLike,
  readJson,
  withRetries,
  type Sleep
} from '../model-gateway/http.js';
import type { ChatMessage } from '../model-gateway/prompts.js';

export interface ChatOptions {
  model: string;
  signal: AbortSignal;
  structured: boolean;
  maxResponseBytes?: number;
  onDelta?: (delta: string) => void;
  onUsage?: (usage: ProviderUsage) => void;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  content: string;
  model: string;
  usage: ProviderUsage;
  retries: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  usage: { inputTokens: number; retries: number };
}

export interface RerankProviderResult {
  results: Array<{ index: number; score: number }>;
  model: string;
  retries: number;
}

export interface ProviderOptions {
  fetchImpl?: FetchLike;
  sleep?: Sleep;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function usage(value: unknown): ProviderUsage {
  const item = object(value);
  return {
    inputTokens: number(item?.prompt_tokens),
    outputTokens: number(item?.completion_tokens)
  };
}

export class OpenAICompatibleProvider {
  private readonly fetchImpl: FetchLike;
  private readonly apiKey: string;

  constructor(
    private readonly route: ModelRouteConfig,
    private readonly gateway: GatewayConfig,
    options: ProviderOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.apiKey = resolveApiKey(route);
    this.sleep = options.sleep;
  }

  private readonly sleep?: Sleep;

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      temperature: 0.2,
      max_tokens: this.gateway.maxOutputTokens
    };
    if (options.structured) body.response_format = { type: 'json_object' };
    let emitted = false;
    const result = await withRetries(
      async () => {
        const response = await this.fetchImpl(`${this.route.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream'
          },
          body: JSON.stringify(body),
          signal: options.signal
        });
        await assertResponse(response, this.route);
        return this.consumeStream(response, options, () => {
          emitted = true;
        });
      },
      {
        maxRetries: this.gateway.maxRetries,
        baseDelayMs: this.gateway.retryBaseDelayMs,
        signal: options.signal,
        sleep: this.sleep,
        onRetry: () => {
          if (emitted) {
            throw new ModelGatewayError(
              'Model stream failed after output started',
              'PROVIDER',
              {},
              502
            );
          }
        }
      }
    );
    return { ...result.value, retries: result.retries };
  }

  async embed(inputs: string[], signal: AbortSignal): Promise<EmbeddingResult> {
    const result = await withRetries(
      async () => {
        const response = await this.fetchImpl(`${this.route.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({ model: this.route.model, input: inputs }),
          signal
        });
        await assertResponse(response, this.route);
        const payload = await readJson(response, this.gateway.maxResponseBytes);
        const data = payload.data;
        if (!Array.isArray(data) || data.length !== inputs.length) {
          throw new ModelGatewayError(
            'Embedding response shape is invalid',
            'INVALID_RESPONSE',
            {},
            502
          );
        }
        const vectors = data.map((item) => {
          const value = object(item)?.embedding;
          if (
            !Array.isArray(value) ||
            value.length === 0 ||
            value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
          ) {
            throw new ModelGatewayError('Embedding vector is invalid', 'INVALID_RESPONSE', {}, 502);
          }
          return value as number[];
        });
        return {
          vectors,
          model:
            typeof payload.model === 'string' && payload.model ? payload.model : this.route.model,
          usage: { inputTokens: usage(payload.usage).inputTokens }
        };
      },
      {
        maxRetries: this.gateway.maxRetries,
        baseDelayMs: this.gateway.retryBaseDelayMs,
        signal,
        sleep: this.sleep
      }
    );
    return { ...result.value, usage: { ...result.value.usage, retries: result.retries } };
  }

  async rerank(
    query: string,
    documents: string[],
    topK: number,
    signal: AbortSignal
  ): Promise<RerankProviderResult> {
    const result = await withRetries(
      async () => {
        const response = await this.fetchImpl(`${this.route.baseUrl}/rerank`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({ model: this.route.model, query, documents, top_n: topK }),
          signal
        });
        await assertResponse(response, this.route);
        const payload = await readJson(response, this.gateway.maxResponseBytes);
        if (!Array.isArray(payload.results) || payload.results.length === 0) {
          throw new ModelGatewayError('Rerank response is empty', 'INVALID_RESPONSE', {}, 502);
        }
        const results = payload.results.map((item) => {
          const value = object(item);
          if (
            typeof value?.index !== 'number' ||
            typeof value.relevance_score !== 'number' ||
            !Number.isFinite(value.relevance_score)
          ) {
            throw new ModelGatewayError(
              'Rerank response shape is invalid',
              'INVALID_RESPONSE',
              {},
              502
            );
          }
          return { index: value.index, score: value.relevance_score };
        });
        return {
          results,
          model:
            typeof payload.model === 'string' && payload.model ? payload.model : this.route.model
        };
      },
      {
        maxRetries: this.gateway.maxRetries,
        baseDelayMs: this.gateway.retryBaseDelayMs,
        signal,
        sleep: this.sleep
      }
    );
    return { ...result.value, retries: result.retries };
  }

  private async consumeStream(
    response: {
      body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
    },
    options: ChatOptions,
    markEmitted: () => void
  ): Promise<Omit<ChatResult, 'retries'>> {
    if (!response.body)
      throw new ModelGatewayError('Model stream has no response body', 'INVALID_RESPONSE', {}, 502);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    let responseBytes = 0;
    let buffer = '';
    let content = '';
    let model = options.model;
    let finalUsage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data);
        payload = object(parsed) ?? {};
      } catch {
        throw new ModelGatewayError(
          'Model stream contained invalid JSON',
          'INVALID_RESPONSE',
          {},
          502
        );
      }
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      const currentUsage = usage(payload.usage);
      if (currentUsage.inputTokens || currentUsage.outputTokens) {
        finalUsage = currentUsage;
        options.onUsage?.(currentUsage);
      }
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const delta = object(object(choices[0])?.delta)?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        const nextContent = content + delta;
        if (Buffer.byteLength(nextContent, 'utf8') > maxResponseBytes) {
          throw new ModelGatewayError(
            'Model content exceeded the configured size limit',
            'INVALID_RESPONSE',
            {
              maxResponseBytes
            },
            502
          );
        }
        content = nextContent;
        markEmitted();
        options.onDelta?.(delta);
      }
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      responseBytes += chunk.value?.byteLength ?? 0;
      if (responseBytes > maxResponseBytes) {
        throw new ModelGatewayError(
          'Model stream exceeded the configured size limit',
          'INVALID_RESPONSE',
          {
            maxResponseBytes
          },
          502
        );
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      lines.forEach(consumeLine);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
    if (!content)
      throw new ModelGatewayError(
        'Model stream returned empty content',
        'INVALID_RESPONSE',
        {},
        502
      );
    return { content, model, usage: finalUsage };
  }
}

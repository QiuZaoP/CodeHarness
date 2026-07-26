import type {
  DecisionRequest,
  DecisionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelGateway,
  ModelStreamHandler,
  ModelUsage,
  SummaryRequest,
  SummaryResponse
} from '../ports/model-gateway.ts';
import { loadGatewayConfig, type GatewayConfig } from '../model-gateway/config.ts';
import { CircuitBreaker } from '../model-gateway/circuit-breaker.ts';
import { ModelGatewayError } from '../model-gateway/errors.ts';
import { GatewayMetrics } from '../model-gateway/metrics.ts';
import { buildDecisionMessages, buildSummaryMessages } from '../model-gateway/prompts.ts';
import { parseModelDecision } from '../model-gateway/structured.ts';
import { withTimeout, type FetchLike, type Sleep } from '../model-gateway/http.ts';
import {
  OpenAICompatibleProvider,
  type ProviderUsage
} from './openai-compatible-provider.ts';

export interface RerankRequest {
  query: string;
  documents: string[];
  topK?: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface RerankResponse {
  results: RerankResult[];
  model: string;
  provider: string;
  durationMs: number;
}

export interface DeepSeekGatewayOptions {
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  metrics?: GatewayMetrics;
}

function toCost(route: { inputPricePerMillion: number; outputPricePerMillion: number }, usage: ProviderUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * route.inputPricePerMillion +
    (usage.outputTokens / 1_000_000) * route.outputPricePerMillion
  );
}

function modelUsage(
  route: { inputPricePerMillion: number; outputPricePerMillion: number },
  usage: ProviderUsage
): ModelUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: toCost(route, usage)
  };
}

function safeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown provider failure';
  return message.replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]');
}

export class DeepSeekModelGateway implements ModelGateway {
  readonly metrics: GatewayMetrics;
  private readonly chatProvider: OpenAICompatibleProvider;
  private readonly summaryProvider: OpenAICompatibleProvider;
  private readonly embeddingProvider?: OpenAICompatibleProvider;
  private readonly rerankProvider?: OpenAICompatibleProvider;
  private readonly chatCircuit: CircuitBreaker;
  private readonly summaryCircuit: CircuitBreaker;
  private readonly embeddingCircuit: CircuitBreaker;
  private readonly rerankCircuit: CircuitBreaker;

  constructor(
    private readonly config: GatewayConfig,
    options: DeepSeekGatewayOptions = {}
  ) {
    this.metrics = options.metrics ?? new GatewayMetrics();
    this.chatProvider = new OpenAICompatibleProvider(config.chat, config, options);
    this.summaryProvider = new OpenAICompatibleProvider(config.summary, config, options);
    this.embeddingProvider = config.embedding
      ? new OpenAICompatibleProvider(config.embedding, config, options)
      : undefined;
    this.rerankProvider = config.rerank
      ? new OpenAICompatibleProvider(config.rerank, config, options)
      : undefined;
    this.chatCircuit = new CircuitBreaker(config.circuitFailureThreshold, config.circuitCooldownMs);
    this.summaryCircuit = new CircuitBreaker(config.circuitFailureThreshold, config.circuitCooldownMs);
    this.embeddingCircuit = new CircuitBreaker(config.circuitFailureThreshold, config.circuitCooldownMs);
    this.rerankCircuit = new CircuitBreaker(config.circuitFailureThreshold, config.circuitCooldownMs);
  }

  static fromEnvironment(
    environment: Record<string, string | undefined> = process.env,
    options: DeepSeekGatewayOptions = {}
  ): DeepSeekModelGateway {
    return new DeepSeekModelGateway(loadGatewayConfig(environment), options);
  }

  async decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse> {
    const started = performance.now();
    let retries = 0;
    try {
      const result = await this.run('decide', this.chatCircuit, signal, async (controlledSignal) => {
        const response = await this.chatProvider.chat(buildDecisionMessages(request), {
          model: this.config.chat.model,
          signal: controlledSignal,
          structured: true,
          maxResponseBytes: this.config.maxResponseBytes,
          onDelta: (delta) => onStreamEvent?.({ type: 'STRUCTURED_DELTA', delta }),
          onUsage: (usage) => onStreamEvent?.({ type: 'USAGE', usage: modelUsage(this.config.chat, usage) })
        });
        retries = response.retries;
        return response;
      });
      const decision = parseModelDecision(result.content);
      const usage = modelUsage(this.config.chat, result.usage);
      const durationMs = performance.now() - started;
      this.metrics.record('decide', { ok: true, durationMs, usage, retries });
      return {
        decision,
        model: result.model,
        provider: this.config.chat.provider,
        usage,
        durationMs
      };
    } catch (error) {
      this.metrics.record('decide', { ok: false, durationMs: performance.now() - started, retries });
      throw this.normalizeError('decide', error, signal);
    }
  }

  async summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse> {
    const started = performance.now();
    let retries = 0;
    try {
      const result = await this.run('summarize', this.summaryCircuit, signal, async (controlledSignal) => {
        const response = await this.summaryProvider.chat(buildSummaryMessages(request), {
          model: this.config.summary.model,
          signal: controlledSignal,
          structured: false,
          maxResponseBytes: this.config.maxResponseBytes,
          onDelta: (delta) => onStreamEvent?.({ type: 'TEXT_DELTA', delta }),
          onUsage: (usage) => onStreamEvent?.({ type: 'USAGE', usage: modelUsage(this.config.summary, usage) })
        });
        retries = response.retries;
        return response;
      });
      const usage = modelUsage(this.config.summary, result.usage);
      const summary = result.content.trim();
      if (!summary) throw new ModelGatewayError('Model summary is empty', 'INVALID_RESPONSE', {}, 502);
      const durationMs = performance.now() - started;
      this.metrics.record('summarize', { ok: true, durationMs, usage, retries });
      return { summary, usage };
    } catch (error) {
      this.metrics.record('summarize', { ok: false, durationMs: performance.now() - started, retries });
      throw this.normalizeError('summarize', error, signal);
    }
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse> {
    const started = performance.now();
    if (request.inputs.some((input) => typeof input !== 'string') || request.inputs.length === 0) {
      throw new ModelGatewayError('Embedding inputs must contain at least one string', 'VALIDATION', {}, 400);
    }
    if (!this.embeddingProvider || !this.config.embedding) {
      this.metrics.record('embed', { ok: false, durationMs: performance.now() - started });
      throw new ModelGatewayError(
        'No embedding route is configured. DeepSeek chat models do not provide embeddings.',
        'NOT_SUPPORTED',
        { provider: this.config.chat.provider },
        501
      );
    }
    let retries = 0;
    try {
      const result = await this.run('embed', this.embeddingCircuit, signal, async (controlledSignal) => {
        const response = await this.embeddingProvider!.embed(request.inputs, controlledSignal);
        retries = response.usage.retries;
        return response;
      });
      const usage = {
        inputTokens: result.usage.inputTokens,
        cost: (result.usage.inputTokens / 1_000_000) * this.config.embedding.inputPricePerMillion
      };
      const durationMs = performance.now() - started;
      this.metrics.record('embed', { ok: true, durationMs, usage, retries });
      return {
        vectors: result.vectors,
        model: result.model,
        provider: this.config.embedding.provider,
        usage
      };
    } catch (error) {
      this.metrics.record('embed', { ok: false, durationMs: performance.now() - started, retries });
      throw this.normalizeError('embed', error, signal);
    }
  }

  async rerank(request: RerankRequest, signal: AbortSignal): Promise<RerankResponse> {
    const route = this.config.rerank;
    if (!route) {
      throw new ModelGatewayError('No rerank route is configured', 'NOT_SUPPORTED', {}, 501);
    }
    if (!request.query.trim() || request.documents.length === 0) {
      throw new ModelGatewayError('Rerank query and documents are required', 'VALIDATION', {}, 400);
    }
    const started = performance.now();
    try {
      const result = await this.run('rerank', this.rerankCircuit, signal, (controlledSignal) =>
        this.rerankProvider!.rerank(
          request.query,
          request.documents,
          request.topK ?? request.documents.length,
          controlledSignal
        )
      );
      const durationMs = performance.now() - started;
      this.metrics.record('rerank', { ok: true, durationMs, retries: result.retries });
      return {
        results: result.results,
        model: result.model,
        provider: route.provider,
        durationMs
      };
    } catch (error) {
      this.metrics.record('rerank', { ok: false, durationMs: performance.now() - started });
      throw this.normalizeError('rerank', error, signal);
    }
  }

  circuitStates() {
    return {
      chat: this.chatCircuit.snapshot(),
      summary: this.summaryCircuit.snapshot(),
      embedding: this.embeddingCircuit.snapshot(),
      rerank: this.rerankCircuit.snapshot()
    };
  }

  private async run<T>(
    operation: string,
    circuit: CircuitBreaker,
    signal: AbortSignal,
    action: (controlledSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return withTimeout(
      (controlledSignal) => circuit.execute(() => action(controlledSignal)),
      signal,
      this.config.timeoutMs
    ).catch((error) => {
      if (signal.aborted) throw signal.reason;
      throw this.normalizeError(operation, error);
    });
  }

  private normalizeError(operation: string, error: unknown, signal?: AbortSignal): ModelGatewayError | unknown {
    if (signal?.aborted) return signal.reason;
    if (error instanceof ModelGatewayError) return error;
    if (error instanceof Error && error.name === 'AbortError') return error;
    if (error === undefined || error === null) {
      return new ModelGatewayError(`Model ${operation} failed`, 'PROVIDER', {}, 502);
    }
    return new ModelGatewayError(`Model ${operation} failed`, 'PROVIDER', {
      cause: safeCause(error)
    }, 502);
  }
}

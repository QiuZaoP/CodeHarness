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
} from '../ports/model-gateway.js';
import { ModelGatewayError } from '../model-gateway/errors.js';
import { parseModelDecision } from '../model-gateway/structured.js';
import { withTimeout } from '../model-gateway/http.js';

export class GuardedModelGateway implements ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly timeoutMs: number
  ) {}

  decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse> {
    return this.invoke(
      'decide',
      signal,
      (controlledSignal) => this.inner.decide(request, controlledSignal, onStreamEvent),
      (response) => {
        parseModelDecision(JSON.stringify(response.decision));
        this.assertIdentity(response.model, response.provider);
        this.assertUsage(response.usage, true);
        if (!Number.isFinite(response.durationMs) || response.durationMs < 0) {
          throw new Error('Model duration is invalid');
        }
      }
    );
  }

  summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse> {
    return this.invoke(
      'summarize',
      signal,
      (controlledSignal) => this.inner.summarize(request, controlledSignal, onStreamEvent),
      (response) => {
        if (!response.summary.trim()) throw new Error('Model summary must not be empty');
        this.assertUsage(response.usage, true);
      }
    );
  }

  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse> {
    return this.invoke(
      'embed',
      signal,
      (controlledSignal) => this.inner.embed(request, controlledSignal),
      (response) => {
        this.assertIdentity(response.model, response.provider);
        this.assertUsage(response.usage, false);
        if (
          response.vectors.length !== request.inputs.length ||
          response.vectors.some(
            (vector) => vector.length === 0 || vector.some((value) => !Number.isFinite(value))
          )
        ) {
          throw new Error('Embedding response shape is invalid');
        }
      }
    );
  }

  private async invoke<T>(
    operation: string,
    externalSignal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
    validate: (result: T) => void
  ): Promise<T> {
    try {
      const result = await withTimeout(action, externalSignal, this.timeoutMs);
      try {
        validate(result);
      } catch (error) {
        throw new ModelGatewayError(
          `Model ${operation} returned an invalid response`,
          'INVALID_RESPONSE',
          {
            cause: error instanceof Error ? error.message : 'invalid response'
          },
          502
        );
      }
      return result;
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      if (externalSignal.aborted) throw externalSignal.reason;
      throw new ModelGatewayError(
        `Model ${operation} failed`,
        'PROVIDER',
        {
          cause: error instanceof Error ? error.message : 'unknown failure'
        },
        502
      );
    }
  }

  private assertIdentity(model: string, provider: string): void {
    if (!model.trim() || !provider.trim())
      throw new Error('Model and provider identifiers are required');
  }

  private assertUsage(usage: Partial<ModelUsage>, requireOutput: boolean): void {
    if (!Number.isFinite(usage.inputTokens) || usage.inputTokens! < 0)
      throw new Error('inputTokens is invalid');
    if (requireOutput && (!Number.isFinite(usage.outputTokens) || usage.outputTokens! < 0))
      throw new Error('outputTokens is invalid');
    if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0))
      throw new Error('cost is invalid');
  }
}

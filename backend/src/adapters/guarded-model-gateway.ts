import { AppError } from '../errors.js';
import { assertDomainContract } from '../event-contract.js';
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
        assertDomainContract('modelDecision', response.decision);
        this.assertIdentity(response.model, response.provider);
        this.assertUsage(response.usage, true);
        if (!Number.isFinite(response.durationMs) || response.durationMs < 0) {
          throw new Error('Model duration must be a non-negative finite number');
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
    if (externalSignal.aborted) throw externalSignal.reason;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(externalSignal.reason);
    externalSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new AppError(
          'MODEL_ERROR',
          `Model ${operation} timed out`,
          { category: 'TIMEOUT', timeoutMs: this.timeoutMs },
          504
        )
      );
    }, this.timeoutMs);
    try {
      const result = await Promise.race([
        action(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true
          });
        })
      ]);
      try {
        validate(result);
      } catch (error) {
        throw new AppError(
          'MODEL_ERROR',
          `Model ${operation} returned an invalid response`,
          {
            category: 'INVALID_RESPONSE',
            cause: error instanceof Error ? error.message : String(error)
          },
          502
        );
      }
      return result;
    } catch (error) {
      if (externalSignal.aborted) throw externalSignal.reason;
      if (timedOut) {
        throw new AppError(
          'MODEL_ERROR',
          `Model ${operation} timed out`,
          { category: 'TIMEOUT', timeoutMs: this.timeoutMs },
          504
        );
      }
      if (error instanceof AppError && error.code === 'MODEL_ERROR') throw error;
      throw new AppError(
        'MODEL_ERROR',
        `Model ${operation} failed`,
        {
          category: 'PROVIDER',
          cause: error instanceof Error ? error.message : String(error)
        },
        502
      );
    } finally {
      clearTimeout(timer);
      externalSignal.removeEventListener('abort', onAbort);
    }
  }

  private assertIdentity(model: string, provider: string): void {
    if (!model.trim() || !provider.trim()) {
      throw new Error('Model and provider identifiers must not be empty');
    }
  }

  private assertUsage(usage: Partial<ModelUsage>, requireOutput: boolean): void {
    if (!Number.isFinite(usage.inputTokens) || usage.inputTokens! < 0) {
      throw new Error('Model usage inputTokens must be a non-negative finite number');
    }
    if (requireOutput && (!Number.isFinite(usage.outputTokens) || usage.outputTokens! < 0)) {
      throw new Error('Model usage outputTokens must be a non-negative finite number');
    }
    for (const [name, value] of Object.entries(usage)) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`Model usage ${name} must be a non-negative finite number`);
      }
    }
  }
}

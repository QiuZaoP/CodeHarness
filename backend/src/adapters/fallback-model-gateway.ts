import type {
  DecisionRequest,
  DecisionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelGateway,
  ModelStreamHandler,
  SummaryRequest,
  SummaryResponse
} from '../ports/model-gateway.js';
import { isFallbackEligible } from '../model-gateway/errors.js';

export class FallbackModelGateway implements ModelGateway {
  constructor(
    private readonly primary: ModelGateway,
    private readonly fallback?: ModelGateway
  ) {}

  async decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse> {
    let primaryStreamed = false;
    const primaryHandler: ModelStreamHandler = (event) => {
      if (
        (event.type === 'TEXT_DELTA' || event.type === 'STRUCTURED_DELTA') &&
        event.delta.length > 0
      ) {
        primaryStreamed = true;
      }
      onStreamEvent?.(event);
    };
    try {
      return await this.primary.decide(request, signal, primaryHandler);
    } catch (error) {
      if (primaryStreamed || !this.fallback || !isFallbackEligible(error)) throw error;
      return this.fallback.decide(request, signal, onStreamEvent);
    }
  }

  async summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse> {
    let primaryStreamed = false;
    const primaryHandler: ModelStreamHandler = (event) => {
      if (
        (event.type === 'TEXT_DELTA' || event.type === 'STRUCTURED_DELTA') &&
        event.delta.length > 0
      ) {
        primaryStreamed = true;
      }
      onStreamEvent?.(event);
    };
    try {
      return await this.primary.summarize(request, signal, primaryHandler);
    } catch (error) {
      if (primaryStreamed || !this.fallback || !isFallbackEligible(error)) throw error;
      return this.fallback.summarize(request, signal, onStreamEvent);
    }
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse> {
    try {
      return await this.primary.embed(request, signal);
    } catch (error) {
      if (!this.fallback || !isFallbackEligible(error)) throw error;
      return this.fallback.embed(request, signal);
    }
  }
}

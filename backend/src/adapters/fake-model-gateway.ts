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
import type { ModelDecision } from '../types.js';

export class FakeModelGateway implements ModelGateway {
  private nextDecisionIndex = 0;

  constructor(private readonly decisions: readonly ModelDecision[]) {}

  async decide(
    _request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse> {
    signal.throwIfAborted();
    const decision = this.decisions[this.nextDecisionIndex];
    if (!decision) {
      throw new Error('FakeModelGateway has no queued decision');
    }
    this.nextDecisionIndex += 1;
    onStreamEvent?.({ type: 'STRUCTURED_DELTA', delta: JSON.stringify(decision) });
    return {
      decision,
      model: 'fake-model',
      provider: 'fake',
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      durationMs: 0
    };
  }

  async summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse> {
    signal.throwIfAborted();
    const summary = `${request.goal}: ${request.changedFiles.length} changed files`;
    onStreamEvent?.({ type: 'TEXT_DELTA', delta: summary });
    return {
      summary,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 }
    };
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse> {
    signal.throwIfAborted();
    return {
      vectors: request.inputs.map((input) => [input.length]),
      model: 'fake-embedding-model',
      provider: 'fake',
      usage: { inputTokens: 0, cost: 0 }
    };
  }
}

import { AppError } from '../errors.js';
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

export type FakeDecisionFactory = (request: DecisionRequest, index: number) => ModelDecision;

export class FakeModelGateway implements ModelGateway {
  private nextDecisionIndex = 0;

  constructor(
    private readonly decisions:
      readonly ModelDecision[] | FakeDecisionFactory = FakeModelGateway.planningDecision
  ) {}

  async decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse> {
    signal.throwIfAborted();
    const decision = Array.isArray(this.decisions)
      ? this.decisions[this.nextDecisionIndex]
      : (this.decisions as FakeDecisionFactory)(request, this.nextDecisionIndex);
    if (!decision) {
      throw new AppError(
        'MODEL_ERROR',
        'FakeModelGateway has no queued decision',
        { category: 'FIXTURE', decisionIndex: this.nextDecisionIndex },
        500
      );
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

  private static planningDecision(request: DecisionRequest): ModelDecision {
    const goal =
      request.context.find(({ reference }) => reference.source === 'user-goal')?.content ??
      'Complete the requested task';
    return {
      type: 'PLAN_UPDATE',
      reason: 'Deterministic mock planning',
      plan: {
        goal,
        assumptions: ['Use the replaceable model gateway and the available code index'],
        steps: [
          { id: 'inspect', title: 'Inspect project files', status: 'PENDING' },
          { id: 'verify', title: 'Run baseline verification', status: 'PENDING' }
        ],
        verification: ['node --version']
      }
    };
  }
}

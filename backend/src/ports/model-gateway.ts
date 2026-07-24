import type { ContextReference, ModelDecision, RunState, ToolDefinition } from '../types.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

export interface DecisionRequest {
  runState: RunState;
  context: ReadonlyArray<{
    reference: ContextReference;
    content: string;
  }>;
  availableTools: readonly ToolDefinition[];
}

export type ModelStreamEvent =
  | { type: 'TEXT_DELTA'; delta: string }
  | { type: 'STRUCTURED_DELTA'; delta: string }
  | { type: 'USAGE'; usage: Partial<ModelUsage> };

export type ModelStreamHandler = (event: ModelStreamEvent) => void;

export interface DecisionResponse {
  decision: ModelDecision;
  model: string;
  provider: string;
  usage: ModelUsage;
  durationMs: number;
}

export interface SummaryRequest {
  goal: string;
  observations: string[];
  changedFiles: string[];
}

export interface SummaryResponse {
  summary: string;
  usage: ModelUsage;
}

export interface EmbeddingRequest {
  inputs: string[];
}

export interface EmbeddingResponse {
  vectors: number[][];
  model: string;
  provider: string;
  usage: Pick<ModelUsage, 'inputTokens' | 'cost'>;
}

export interface ModelGateway {
  decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse>;
  summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse>;
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse>;
}

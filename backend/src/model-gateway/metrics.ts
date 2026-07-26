import type { ModelUsage } from '../ports/model-gateway.ts';

export interface OperationMetrics {
  calls: number;
  successes: number;
  failures: number;
  retries: number;
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface GatewayMetricsSnapshot {
  totalCalls: number;
  successes: number;
  failures: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  averageLatencyMs: number;
  operations: Record<string, OperationMetrics>;
}

function emptyMetrics(): OperationMetrics {
  return {
    calls: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    totalLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0
  };
}

export class GatewayMetrics {
  private readonly byOperation = new Map<string, OperationMetrics>();

  record(
    operation: string,
    result: { ok: boolean; durationMs: number; usage?: Partial<ModelUsage>; retries?: number }
  ): void {
    const current = this.byOperation.get(operation) ?? emptyMetrics();
    current.calls += 1;
    current.successes += result.ok ? 1 : 0;
    current.failures += result.ok ? 0 : 1;
    current.retries += result.retries ?? 0;
    current.totalLatencyMs += Math.max(0, result.durationMs);
    current.inputTokens += result.usage?.inputTokens ?? 0;
    current.outputTokens += result.usage?.outputTokens ?? 0;
    current.cost += result.usage?.cost ?? 0;
    this.byOperation.set(operation, current);
  }

  snapshot(): GatewayMetricsSnapshot {
    const operations: Record<string, OperationMetrics> = {};
    let totalCalls = 0;
    let successes = 0;
    let failures = 0;
    let retries = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let totalLatencyMs = 0;
    for (const [name, value] of this.byOperation) {
      operations[name] = { ...value };
      totalCalls += value.calls;
      successes += value.successes;
      failures += value.failures;
      retries += value.retries;
      inputTokens += value.inputTokens;
      outputTokens += value.outputTokens;
      cost += value.cost;
      totalLatencyMs += value.totalLatencyMs;
    }
    return {
      totalCalls,
      successes,
      failures,
      retries,
      inputTokens,
      outputTokens,
      cost,
      averageLatencyMs: totalCalls === 0 ? 0 : totalLatencyMs / totalCalls,
      operations
    };
  }
}

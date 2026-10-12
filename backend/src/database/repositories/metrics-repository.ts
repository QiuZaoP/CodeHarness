import type Database from 'better-sqlite3';
import { taskStatuses } from '../../contract-values.js';
import { assertDomainContract } from '../../event-contract.js';
import type { RunState, RuntimeMetrics, TaskStatus } from '../../types.js';
import { parseStoredJson } from '../stored-json.js';

interface CountRow {
  status: string;
  count: number;
}

interface TaskDurationRow {
  createdAt: string;
  updatedAt: string;
}

interface RunStateRow {
  taskId: string;
  stateJson: string;
}

export class MetricsRepository {
  constructor(private readonly database: Database.Database) {}

  snapshot(generatedAt: string): RuntimeMetrics {
    const taskCounts = this.database
      .prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status')
      .all() as CountRow[];
    const byStatus = Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<
      TaskStatus,
      number
    >;
    for (const row of taskCounts) byStatus[row.status as TaskStatus] = row.count;
    const successful = byStatus.READY_FOR_REVIEW + byStatus.APPLIED;
    const failed = byStatus.FAILED;
    const measured = successful + failed;
    const durations = (
      this.database
        .prepare(
          "SELECT created_at as createdAt, updated_at as updatedAt FROM tasks WHERE status IN ('READY_FOR_REVIEW', 'APPLIED', 'FAILED')"
        )
        .all() as TaskDurationRow[]
    ).map(({ createdAt, updatedAt }) => Math.max(0, Date.parse(updatedAt) - Date.parse(createdAt)));

    const toolCounts = this.counts('tool_calls');
    const verificationCounts = this.counts('verification_results');
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    for (const row of this.database
      .prepare('SELECT task_id as taskId, state_json as stateJson FROM task_run_checkpoints')
      .all() as RunStateRow[]) {
      const state = parseStoredJson<RunState>(
        row.stateJson,
        `task ${row.taskId} run state`,
        'runState'
      );
      inputTokens += state.budget.usedInputTokens ?? 0;
      outputTokens += state.budget.usedOutputTokens ?? 0;
      cost += state.budget.usedCost ?? 0;
    }

    const metrics: RuntimeMetrics = {
      generatedAt,
      tasks: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
        successful,
        failed,
        successRate: measured === 0 ? 0 : successful / measured,
        averageDurationMs:
          durations.length === 0
            ? 0
            : durations.reduce((sum, duration) => sum + duration, 0) / durations.length
      },
      tools: {
        total: this.total(toolCounts),
        failed: toolCounts.FAILED ?? 0,
        cancelled: toolCounts.CANCELLED ?? 0,
        failureRate:
          this.total(toolCounts) === 0 ? 0 : (toolCounts.FAILED ?? 0) / this.total(toolCounts)
      },
      verifications: {
        total: this.total(verificationCounts),
        failed: verificationCounts.FAILED ?? 0,
        errors: verificationCounts.ERROR ?? 0
      },
      modelUsage: { inputTokens, outputTokens, cost }
    };
    assertDomainContract('runtimeMetrics', metrics);
    return metrics;
  }

  private counts(table: 'tool_calls' | 'verification_results'): Record<string, number> {
    return Object.fromEntries(
      (
        this.database
          .prepare(`SELECT status, COUNT(*) as count FROM ${table} GROUP BY status`)
          .all() as CountRow[]
      ).map(({ status, count }) => [status, count])
    );
  }

  private total(counts: Record<string, number>): number {
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
  }
}

import type Database from 'better-sqlite3';
import { AppError } from '../../errors.js';
import { assertDomainContract } from '../../event-contract.js';
import type { TaskRunCheckpoint } from '../records.js';
import { parseStoredJson, stringifyStoredJson } from '../stored-json.js';

interface TaskRunRow {
  taskId: string;
  runId: string;
  stateJson: string;
  historySummary: string | null;
  summarizedMessageCount: number;
  startedAt: string;
  updatedAt: string;
  version: number;
}

export class TaskRunRepository {
  constructor(private readonly database: Database.Database) {}

  create(checkpoint: TaskRunCheckpoint): void {
    this.assertCheckpoint(checkpoint);
    this.database
      .prepare(
        'INSERT INTO task_run_checkpoints (task_id, run_id, state_json, history_summary, summarized_message_count, started_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        checkpoint.taskId,
        checkpoint.runId,
        stringifyStoredJson(checkpoint.state, `task ${checkpoint.taskId} run state`),
        checkpoint.historySummary ?? null,
        checkpoint.summarizedMessageCount,
        checkpoint.startedAt,
        checkpoint.updatedAt,
        checkpoint.version
      );
  }

  findByTask(taskId: string): TaskRunCheckpoint | undefined {
    const row = this.database
      .prepare(
        'SELECT task_id as taskId, run_id as runId, state_json as stateJson, history_summary as historySummary, summarized_message_count as summarizedMessageCount, started_at as startedAt, updated_at as updatedAt, version FROM task_run_checkpoints WHERE task_id = ?'
      )
      .get(taskId) as TaskRunRow | undefined;
    if (!row) return undefined;
    const checkpoint: TaskRunCheckpoint = {
      taskId: row.taskId,
      runId: row.runId,
      state: parseStoredJson(row.stateJson, `task ${row.taskId} run state`, 'runState'),
      historySummary: row.historySummary ?? undefined,
      summarizedMessageCount: row.summarizedMessageCount,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      version: row.version
    };
    this.assertCheckpoint(checkpoint);
    return checkpoint;
  }

  update(checkpoint: TaskRunCheckpoint, expectedVersion: number): TaskRunCheckpoint {
    this.assertCheckpoint(checkpoint);
    const result = this.database
      .prepare(
        'UPDATE task_run_checkpoints SET state_json = ?, history_summary = ?, summarized_message_count = ?, updated_at = ?, version = version + 1 WHERE task_id = ? AND run_id = ? AND version = ?'
      )
      .run(
        stringifyStoredJson(checkpoint.state, `task ${checkpoint.taskId} run state`),
        checkpoint.historySummary ?? null,
        checkpoint.summarizedMessageCount,
        checkpoint.updatedAt,
        checkpoint.taskId,
        checkpoint.runId,
        expectedVersion
      );
    if (result.changes !== 1) {
      throw new AppError(
        'CONFLICT',
        'Task run checkpoint was modified by another operation',
        { taskId: checkpoint.taskId, expectedVersion },
        409
      );
    }
    return this.findByTask(checkpoint.taskId)!;
  }

  private assertCheckpoint(checkpoint: TaskRunCheckpoint): void {
    if (
      checkpoint.taskId !== checkpoint.state.taskId ||
      checkpoint.runId !== checkpoint.state.runId ||
      !Number.isInteger(checkpoint.version) ||
      checkpoint.version < 1 ||
      !Number.isInteger(checkpoint.summarizedMessageCount) ||
      checkpoint.summarizedMessageCount < 0 ||
      !Number.isFinite(Date.parse(checkpoint.startedAt)) ||
      !Number.isFinite(Date.parse(checkpoint.updatedAt))
    ) {
      throw new AppError('INTERNAL_ERROR', 'Task run checkpoint identity is invalid', {
        taskId: checkpoint.taskId,
        runId: checkpoint.runId
      });
    }
    assertDomainContract('runState', checkpoint.state);
  }
}

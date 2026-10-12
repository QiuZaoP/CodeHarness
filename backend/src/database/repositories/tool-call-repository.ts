import type Database from 'better-sqlite3';
import { AppError } from '../../errors.js';
import { assertDomainContract } from '../../event-contract.js';
import type { ToolCall, ToolCallRecord, ToolCallStatus, ToolResult } from '../../types.js';
import { parseStoredJson, stringifyStoredJson } from '../stored-json.js';

interface ToolCallRow {
  id: string;
  taskId: string;
  stepId: string | null;
  name: ToolCall['name'];
  argumentsJson: string;
  status: ToolCallStatus;
  startedAt: string;
  finishedAt: string | null;
  resultJson: string | null;
}

export class ToolCallRepository {
  constructor(private readonly database: Database.Database) {}

  create(record: ToolCallRecord): void {
    assertDomainContract('toolCallRecord', record);
    this.database
      .prepare(
        'INSERT INTO tool_calls (id, task_id, step_id, name, arguments_json, status, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.taskId,
        record.stepId ?? null,
        record.tool.name,
        stringifyStoredJson(record.tool.arguments, `tool call ${record.id} arguments`),
        record.status,
        record.startedAt,
        record.finishedAt ?? null,
        record.result ? stringifyStoredJson(record.result, `tool call ${record.id} result`) : null
      );
  }

  complete(id: string, taskId: string, result: ToolResult, finishedAt: string): ToolCallRecord {
    assertDomainContract('toolResult', result);
    const update = this.database
      .prepare(
        "UPDATE tool_calls SET status = ?, finished_at = ?, result_json = ? WHERE id = ? AND task_id = ? AND status = 'RUNNING'"
      )
      .run(
        result.status,
        finishedAt,
        stringifyStoredJson(result, `tool call ${id} result`),
        id,
        taskId
      );
    if (update.changes !== 1) {
      const existing = this.findById(id);
      if (!existing) {
        throw new AppError('NOT_FOUND', 'Tool call not found', { toolCallId: id }, 404);
      }
      throw new AppError(
        'CONFLICT',
        'Tool call is no longer running',
        { toolCallId: id, status: existing.status },
        409
      );
    }
    return this.findById(id)!;
  }

  findById(id: string): ToolCallRecord | undefined {
    const row = this.database
      .prepare(
        'SELECT id, task_id as taskId, step_id as stepId, name, arguments_json as argumentsJson, status, started_at as startedAt, finished_at as finishedAt, result_json as resultJson FROM tool_calls WHERE id = ?'
      )
      .get(id) as ToolCallRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  listByTask(taskId: string): ToolCallRecord[] {
    const rows = this.database
      .prepare(
        'SELECT id, task_id as taskId, step_id as stepId, name, arguments_json as argumentsJson, status, started_at as startedAt, finished_at as finishedAt, result_json as resultJson FROM tool_calls WHERE task_id = ? ORDER BY started_at, id'
      )
      .all(taskId) as ToolCallRow[];
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: ToolCallRow): ToolCallRecord {
    const record: ToolCallRecord = {
      id: row.id,
      taskId: row.taskId,
      stepId: row.stepId ?? undefined,
      tool: {
        name: row.name,
        arguments: parseStoredJson(row.argumentsJson, `tool call ${row.id} arguments`)
      },
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? undefined,
      result: row.resultJson
        ? parseStoredJson<ToolResult>(row.resultJson, `tool call ${row.id} result`, 'toolResult')
        : undefined
    };
    assertDomainContract('toolCallRecord', record);
    return record;
  }
}

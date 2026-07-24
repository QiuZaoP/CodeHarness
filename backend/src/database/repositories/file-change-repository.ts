import type Database from 'better-sqlite3';
import { AppError } from '../../errors.js';
import { assertDomainContract } from '../../event-contract.js';
import type { ChangeDecision, FileChange, FileChangeStatus } from '../../types.js';

interface FileChangeRow {
  id: string;
  taskId: string;
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: string;
  decision: ChangeDecision;
  toolCallId: string | null;
  stepId: string | null;
  version: number;
}

export interface StoredFileChange extends FileChange {
  version: number;
}

export class FileChangeRepository {
  constructor(private readonly database: Database.Database) {}

  replaceForTask(taskId: string, changes: readonly FileChange[]): StoredFileChange[] {
    const previous = new Map(this.listByTask(taskId).map((change) => [change.path, change]));
    this.database.prepare('DELETE FROM file_changes WHERE task_id = ?').run(taskId);
    const insert = this.database.prepare(
      'INSERT INTO file_changes (id, task_id, path, status, additions, deletions, patch, decision, tool_call_id, step_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const change of changes) {
      assertDomainContract('fileChange', change);
      const existing = previous.get(change.path);
      const unchanged =
        existing?.status === change.status &&
        existing.patch === change.patch &&
        existing.additions === change.additions &&
        existing.deletions === change.deletions;
      insert.run(
        unchanged ? existing.id : change.id,
        taskId,
        change.path,
        change.status,
        change.additions,
        change.deletions,
        change.patch,
        unchanged ? existing.decision : 'PENDING',
        change.toolCallId ?? null,
        change.stepId ?? null,
        unchanged ? existing.version : 1
      );
    }
    return this.listByTask(taskId);
  }

  findById(id: string): StoredFileChange | undefined {
    const row = this.database
      .prepare(
        'SELECT id, task_id as taskId, path, status, additions, deletions, patch, decision, tool_call_id as toolCallId, step_id as stepId, version FROM file_changes WHERE id = ?'
      )
      .get(id) as FileChangeRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  listByTask(taskId: string): StoredFileChange[] {
    return (
      this.database
        .prepare(
          'SELECT id, task_id as taskId, path, status, additions, deletions, patch, decision, tool_call_id as toolCallId, step_id as stepId, version FROM file_changes WHERE task_id = ? ORDER BY path, id'
        )
        .all(taskId) as FileChangeRow[]
    ).map((row) => this.toRecord(row));
  }

  updateDecision(
    id: string,
    taskId: string,
    decision: Exclude<ChangeDecision, 'PENDING'>,
    expectedVersion: number
  ): StoredFileChange {
    const result = this.database
      .prepare(
        'UPDATE file_changes SET decision = ?, version = version + 1 WHERE id = ? AND task_id = ? AND version = ?'
      )
      .run(decision, id, taskId, expectedVersion);
    if (result.changes !== 1) {
      const existing = this.findById(id);
      if (!existing) {
        throw new AppError('NOT_FOUND', 'File change not found', { changeId: id }, 404);
      }
      throw new AppError(
        'CONFLICT',
        'File change was modified by another operation',
        { changeId: id, expectedVersion, actualVersion: existing.version },
        409
      );
    }
    return this.findById(id)!;
  }

  private toRecord(row: FileChangeRow): StoredFileChange {
    const change: StoredFileChange = {
      id: row.id,
      taskId: row.taskId,
      path: row.path,
      status: row.status,
      additions: row.additions,
      deletions: row.deletions,
      patch: row.patch,
      decision: row.decision,
      toolCallId: row.toolCallId ?? undefined,
      stepId: row.stepId ?? undefined,
      version: row.version
    };
    assertDomainContract('fileChange', change);
    return change;
  }
}

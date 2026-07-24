import type Database from 'better-sqlite3';
import { AppError } from '../../errors.js';
import type { StoredTask, TaskPlan, TaskStatus } from '../../types.js';
import { parseStoredJson, stringifyStoredJson } from '../stored-json.js';

export interface TaskPatch {
  status?: TaskStatus;
  plan?: TaskPlan | null;
  stopReason?: string | null;
  resumeStatus?: StoredTask['resumeStatus'] | null;
  controlRequest?: StoredTask['controlRequest'] | null;
}

interface TaskRow {
  id: string;
  sessionId: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  planJson: string | null;
  workspacePath: string;
  stopReason: string | null;
  resumeStatus: StoredTask['resumeStatus'] | null;
  controlRequest: StoredTask['controlRequest'] | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class TaskRepository {
  constructor(private readonly database: Database.Database) {}

  create(task: StoredTask): void {
    this.database
      .prepare(
        'INSERT INTO tasks (id, session_id, project_id, goal, status, plan_json, workspace_path, stop_reason, resume_status, control_request, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        task.id,
        task.sessionId,
        task.projectId,
        task.goal,
        task.status,
        task.plan ? stringifyStoredJson(task.plan, `task ${task.id} plan`) : null,
        task.workspacePath,
        task.stopReason ?? null,
        task.resumeStatus ?? null,
        task.controlRequest ?? null,
        task.version,
        task.createdAt,
        task.updatedAt
      );
  }

  findById(id: string): StoredTask | undefined {
    const row = this.database
      .prepare(
        'SELECT id, session_id as sessionId, project_id as projectId, goal, status, plan_json as planJson, workspace_path as workspacePath, stop_reason as stopReason, resume_status as resumeStatus, control_request as controlRequest, version, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE id = ?'
      )
      .get(id) as TaskRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.sessionId,
      projectId: row.projectId,
      goal: row.goal,
      status: row.status,
      plan: row.planJson
        ? parseStoredJson<TaskPlan>(row.planJson, `task ${row.id} plan`, 'plan')
        : undefined,
      workspacePath: row.workspacePath,
      stopReason: row.stopReason ?? undefined,
      resumeStatus: row.resumeStatus ?? undefined,
      controlRequest: row.controlRequest ?? undefined,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  update(id: string, expectedVersion: number, patch: TaskPatch, updatedAt: string): StoredTask {
    const current = this.findById(id);
    if (!current) throw new AppError('NOT_FOUND', 'Task not found', { taskId: id }, 404);
    const plan = Object.hasOwn(patch, 'plan') ? (patch.plan ?? undefined) : current.plan;
    const stopReason = Object.hasOwn(patch, 'stopReason')
      ? (patch.stopReason ?? undefined)
      : current.stopReason;
    const resumeStatus = Object.hasOwn(patch, 'resumeStatus')
      ? (patch.resumeStatus ?? undefined)
      : current.resumeStatus;
    const controlRequest = Object.hasOwn(patch, 'controlRequest')
      ? (patch.controlRequest ?? undefined)
      : current.controlRequest;
    const result = this.database
      .prepare(
        'UPDATE tasks SET status = ?, plan_json = ?, stop_reason = ?, resume_status = ?, control_request = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?'
      )
      .run(
        patch.status ?? current.status,
        plan ? stringifyStoredJson(plan, `task ${id} plan`) : null,
        stopReason ?? null,
        resumeStatus ?? null,
        controlRequest ?? null,
        updatedAt,
        id,
        expectedVersion
      );
    if (result.changes !== 1) {
      throw new AppError(
        'CONFLICT',
        'Task was modified by another operation',
        { taskId: id, expectedVersion, actualVersion: current.version },
        409
      );
    }
    return this.findById(id)!;
  }

  listByStatuses(statuses: readonly TaskStatus[]): StoredTask[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.database
      .prepare(`SELECT id FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as Array<{ id: string }>;
    return rows.map(({ id }) => this.findById(id)!);
  }
}

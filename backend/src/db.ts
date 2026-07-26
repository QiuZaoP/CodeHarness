import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type { StoredTask, TaskEvent, TaskPlan, TaskStatus } from './types.js';

export interface ProjectRecord {
  id: string;
  name: string;
  sourcePath: string;
  workspacePath: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

export class AppDatabase {
  readonly connection: Database.Database;

  constructor(databasePath = config.databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.connection = new Database(databasePath);
    this.connection.pragma('journal_mode = WAL');
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT,
        workspace_path TEXT NOT NULL,
        stop_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id, id);
    `);
  }

  close(): void {
    this.connection.close();
  }

  createProject(record: ProjectRecord): void {
    this.connection
      .prepare(
        'INSERT INTO projects (id, name, source_path, workspace_path, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(record.id, record.name, record.sourcePath, record.workspacePath, record.createdAt);
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.connection
      .prepare(
        'SELECT id, name, source_path as sourcePath, workspace_path as workspacePath, created_at as createdAt FROM projects WHERE id = ?'
      )
      .get(id) as ProjectRecord | undefined;
    return row;
  }

  createSession(record: SessionRecord): void {
    this.connection
      .prepare('INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)')
      .run(record.id, record.projectId, record.title, record.createdAt);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.connection
      .prepare(
        'SELECT id, project_id as projectId, title, created_at as createdAt FROM sessions WHERE id = ?'
      )
      .get(id) as SessionRecord | undefined;
  }

  createTask(task: StoredTask): void {
    this.connection
      .prepare(
        'INSERT INTO tasks (id, session_id, project_id, goal, status, plan_json, workspace_path, stop_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        task.id,
        task.sessionId,
        task.projectId,
        task.goal,
        task.status,
        task.plan ? JSON.stringify(task.plan) : null,
        task.workspacePath,
        task.stopReason ?? null,
        task.createdAt,
        task.updatedAt
      );
  }

  getTask(id: string): StoredTask | undefined {
    const row = this.connection
      .prepare(
        'SELECT id, session_id as sessionId, project_id as projectId, goal, status, plan_json as planJson, workspace_path as workspacePath, stop_reason as stopReason, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE id = ?'
      )
      .get(id) as
      (Omit<StoredTask, 'plan' | 'status'> & { planJson?: string; status: TaskStatus }) | undefined;
    if (!row) return undefined;
    const { planJson, ...task } = row;
    return { ...task, plan: planJson ? (JSON.parse(planJson) as TaskPlan) : undefined };
  }

  updateTask(
    id: string,
    patch: Partial<Pick<StoredTask, 'status' | 'plan' | 'stopReason'>>
  ): StoredTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.connection
      .prepare(
        'UPDATE tasks SET status = ?, plan_json = ?, stop_reason = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        next.status,
        next.plan ? JSON.stringify(next.plan) : null,
        next.stopReason ?? null,
        next.updatedAt,
        id
      );
    return next;
  }

  addEvent(event: Omit<TaskEvent, 'id'>): TaskEvent {
    const result = this.connection
      .prepare(
        'INSERT INTO task_events (task_id, type, timestamp, payload_json) VALUES (?, ?, ?, ?)'
      )
      .run(event.taskId, event.type, event.timestamp, JSON.stringify(event.payload));
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  getEvents(taskId: string, afterId = 0): TaskEvent[] {
    const rows = this.connection
      .prepare(
        'SELECT id, task_id as taskId, type, timestamp, payload_json as payloadJson FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC'
      )
      .all(taskId, afterId) as Array<Omit<TaskEvent, 'payload'> & { payloadJson: string }>;
    return rows.map(({ payloadJson, ...event }) => ({
      ...event,
      payload: JSON.parse(payloadJson)
    }));
  }
}

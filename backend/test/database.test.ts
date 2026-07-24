import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AppDatabase, type TaskEventDraft } from '../src/db.js';
import type { StoredTask, TaskPlan } from '../src/types.js';

const timestamp = '2026-07-24T00:00:00.000Z';

async function databasePath(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(directory, 'test.sqlite');
}

function seedTask(database: AppDatabase): StoredTask {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const taskId = randomUUID();
  database.createProject({
    id: projectId,
    name: 'fixture',
    sourcePath: 'C:/fixtures/source',
    workspacePath: 'C:/fixtures/workspace',
    createdAt: timestamp
  });
  database.createSession({
    id: sessionId,
    projectId,
    title: 'Fixture',
    createdAt: timestamp
  });
  const task: StoredTask = {
    id: taskId,
    projectId,
    sessionId,
    goal: 'Inspect fixture',
    status: 'CREATED',
    workspacePath: 'C:/fixtures/workspace',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  database.createTaskWithEvent(
    task,
    { type: 'task.created', timestamp, payload: { goal: task.goal } },
    randomUUID()
  );
  return task;
}

function stateEvent(from: StoredTask['status'], to: StoredTask['status']): TaskEventDraft {
  return {
    type: 'task.state_changed',
    timestamp,
    payload: { from, to }
  };
}

describe('database migrations and repositories', () => {
  it('creates the complete schema and enables foreign keys', async () => {
    const file = await databasePath('codeharness-schema-');
    const database = new AppDatabase(file);
    try {
      expect(database.getSchemaVersion()).toBe(2);
      expect(database.getAppliedMigrations().map(({ version }) => version)).toEqual([1, 2]);
      expect(database.connection.pragma('foreign_keys', { simple: true })).toBe(1);
      const tables = database.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual([
        'audit_records',
        'file_changes',
        'messages',
        'projects',
        'schema_migrations',
        'sessions',
        'task_events',
        'task_leases',
        'task_steps',
        'tasks',
        'tool_calls',
        'verification_results',
        'workspace_snapshots'
      ]);

      expect(() =>
        database.createSession({
          id: randomUUID(),
          projectId: randomUUID(),
          title: 'Orphan',
          createdAt: timestamp
        })
      ).toThrow(/FOREIGN KEY constraint failed/i);
    } finally {
      database.close();
    }
  });

  it('upgrades a phase-1 database without losing tasks or events', async () => {
    const file = await databasePath('codeharness-upgrade-');
    const legacy = new Database(file);
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const taskId = randomUUID();
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
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
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        'INSERT INTO projects (id, name, source_path, workspace_path, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(projectId, 'legacy', 'C:/legacy/source', 'C:/legacy/workspace', timestamp);
    legacy
      .prepare('INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, projectId, 'Legacy', timestamp);
    legacy
      .prepare(
        'INSERT INTO tasks (id, session_id, project_id, goal, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        taskId,
        sessionId,
        projectId,
        'Keep this task',
        'CREATED',
        'C:/legacy/workspace',
        timestamp,
        timestamp
      );
    legacy
      .prepare(
        'INSERT INTO task_events (task_id, type, timestamp, payload_json) VALUES (?, ?, ?, ?)'
      )
      .run(taskId, 'task.created', timestamp, JSON.stringify({ goal: 'Keep this task' }));
    legacy.close();

    const upgraded = new AppDatabase(file);
    try {
      expect(upgraded.getSchemaVersion()).toBe(2);
      expect(upgraded.getTask(taskId)).toMatchObject({
        id: taskId,
        goal: 'Keep this task',
        version: 1
      });
      expect(upgraded.getEvents(taskId)).toEqual([
        expect.objectContaining({
          schemaVersion: '1.0.0',
          type: 'task.created',
          payload: { goal: 'Keep this task' }
        })
      ]);
    } finally {
      upgraded.close();
    }
  });

  it('refuses to start when an applied migration signature has changed', async () => {
    const file = await databasePath('codeharness-migration-drift-');
    const database = new AppDatabase(file);
    database.connection
      .prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1")
      .run();
    database.close();

    expect(() => new AppDatabase(file)).toThrow(
      'Database migration 1 does not match the application'
    );
  });

  it('rolls back task, plan and event writes when the audit insert fails', async () => {
    const file = await databasePath('codeharness-transaction-');
    const database = new AppDatabase(file);
    try {
      const created = seedTask(database);
      const reusedAuditId = randomUUID();
      const first = database.transitionTask({
        taskId: created.id,
        expectedVersion: created.version,
        patch: { status: 'PRECHECKING' },
        events: [stateEvent('CREATED', 'PRECHECKING')],
        audit: { id: reusedAuditId, action: 'task.state_changed', timestamp }
      });
      const eventCount = database.getEvents(created.id).length;
      const auditCount = database.getAuditRecords('task', created.id).length;
      const plan: TaskPlan = {
        goal: created.goal,
        assumptions: [],
        steps: [
          { id: 'inspect', title: 'Inspect files', status: 'PENDING' },
          { id: 'verify', title: 'Run checks', status: 'PENDING' }
        ],
        verification: ['npm test']
      };

      expect(() =>
        database.transitionTask({
          taskId: created.id,
          expectedVersion: first.task.version,
          patch: { status: 'PLANNING', plan },
          events: [
            stateEvent('PRECHECKING', 'PLANNING'),
            { type: 'task.plan.updated', timestamp, payload: { plan } }
          ],
          audit: { id: reusedAuditId, action: 'task.state_changed', timestamp }
        })
      ).toThrow(/UNIQUE constraint failed/i);

      expect(database.getTask(created.id)).toMatchObject({
        status: 'PRECHECKING',
        version: first.task.version,
        plan: undefined
      });
      expect(database.getEvents(created.id)).toHaveLength(eventCount);
      expect(database.getAuditRecords('task', created.id)).toHaveLength(auditCount);
      expect(
        database.connection
          .prepare('SELECT COUNT(*) as count FROM task_steps WHERE task_id = ?')
          .get(created.id)
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rejects stale writes and diagnoses corrupted stored JSON after restart', async () => {
    const file = await databasePath('codeharness-restart-');
    let database = new AppDatabase(file);
    const created = seedTask(database);
    const transitioned = database.transitionTask({
      taskId: created.id,
      expectedVersion: 1,
      patch: { status: 'PRECHECKING' },
      events: [stateEvent('CREATED', 'PRECHECKING')],
      audit: { id: randomUUID(), action: 'task.state_changed', timestamp }
    });
    const eventCount = database.getEvents(created.id).length;
    expect(() =>
      database.transitionTask({
        taskId: created.id,
        expectedVersion: 1,
        patch: { status: 'PLANNING' },
        events: [stateEvent('PRECHECKING', 'PLANNING')],
        audit: { id: randomUUID(), action: 'task.state_changed', timestamp }
      })
    ).toThrow('Task was modified by another operation');
    expect(database.getTask(created.id)?.version).toBe(transitioned.task.version);
    expect(database.getEvents(created.id)).toHaveLength(eventCount);

    database.close();
    database = new AppDatabase(file);
    try {
      expect(database.getTask(created.id)).toMatchObject({
        status: 'PRECHECKING',
        version: 2
      });
      expect(database.getEvents(created.id)).toHaveLength(eventCount);
      database.connection
        .prepare("UPDATE tasks SET plan_json = '{not-json' WHERE id = ?")
        .run(created.id);
      expect(() => database.getTask(created.id)).toThrow('Stored JSON is invalid');
    } finally {
      database.close();
    }
  });

  it('keeps a tool call running when its completion event cannot be committed', async () => {
    const file = await databasePath('codeharness-tool-transaction-');
    const database = new AppDatabase(file);
    try {
      const task = seedTask(database);
      const toolCallId = randomUUID();
      database.startToolCall(
        {
          id: toolCallId,
          taskId: task.id,
          tool: { name: 'read_file', arguments: { path: 'README.md' } },
          status: 'RUNNING',
          startedAt: timestamp
        },
        {
          type: 'tool.started',
          timestamp,
          payload: { toolName: 'read_file', arguments: { path: 'README.md' } }
        }
      );
      const eventCount = database.getEvents(task.id).length;

      expect(() =>
        database.completeToolCall(
          toolCallId,
          task.id,
          {
            status: 'SUCCEEDED',
            output: 'fixture',
            affectedFiles: [],
            durationMs: 1
          },
          timestamp,
          {
            type: 'tool.completed',
            timestamp,
            payload: { unexpected: true }
          }
        )
      ).toThrow('Task event violates the public contract');

      expect(database.getToolCalls(task.id)).toEqual([
        expect.objectContaining({ id: toolCallId, status: 'RUNNING', result: undefined })
      ]);
      expect(database.getEvents(task.id)).toHaveLength(eventCount);
    } finally {
      database.close();
    }
  });
});

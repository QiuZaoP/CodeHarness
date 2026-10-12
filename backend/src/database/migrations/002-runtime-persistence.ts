import type Database from 'better-sqlite3';
import type { DatabaseMigration } from './migration.js';

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

export const runtimePersistenceMigration: DatabaseMigration = {
  version: 2,
  name: 'runtime-persistence-and-optimistic-locking',
  checksum: '002-runtime-persistence-v1',
  up(database) {
    if (!hasColumn(database, 'tasks', 'version')) {
      database.exec('ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(database, 'task_events', 'schema_version')) {
      database.exec(
        "ALTER TABLE task_events ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1.0.0'"
      );
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'DONE')),
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, id),
        UNIQUE (task_id, position)
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_id TEXT,
        name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
        ),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('BASELINE', 'CHECKPOINT', 'FINAL')),
        root_hash TEXT NOT NULL,
        source_revision TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ADDED', 'MODIFIED', 'DELETED', 'RENAMED')),
        additions INTEGER NOT NULL CHECK (additions >= 0),
        deletions INTEGER NOT NULL CHECK (deletions >= 0),
        patch TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('PENDING', 'ACCEPTED', 'REJECTED')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        UNIQUE (task_id, path)
      );

      CREATE TABLE IF NOT EXISTS verification_results (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'ERROR', 'SKIPPED')),
        exit_code INTEGER,
        output_summary TEXT NOT NULL,
        failure_category TEXT CHECK (
          failure_category IS NULL OR
          failure_category IN ('CODE', 'TEST', 'ENVIRONMENT', 'BASELINE')
        ),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id
        ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_steps_task_id
        ON task_steps(task_id, position);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_task_id
        ON tool_calls(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_task_id
        ON workspace_snapshots(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_file_changes_task_id
        ON file_changes(task_id, path);
      CREATE INDEX IF NOT EXISTS idx_verification_results_task_id
        ON verification_results(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_records_resource
        ON audit_records(resource_type, resource_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_records_task_id
        ON audit_records(task_id, timestamp);
    `);
  }
};

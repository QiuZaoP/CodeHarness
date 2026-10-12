import type { DatabaseMigration } from './migration.js';

export const initialMigration: DatabaseMigration = {
  version: 1,
  name: 'initial-project-session-task-events',
  checksum: '001-initial-v1',
  up(database) {
    database.exec(`
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
};

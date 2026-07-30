import type { DatabaseMigration } from './migration.js';

export const taskRunCheckpointsMigration: DatabaseMigration = {
  version: 5,
  name: 'task-run-checkpoints-and-budgets',
  checksum: '005-task-run-checkpoints-and-budgets-v1',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_run_checkpoints (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE,
        state_json TEXT NOT NULL,
        history_summary TEXT,
        summarized_message_count INTEGER NOT NULL DEFAULT 0
          CHECK (summarized_message_count >= 0),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      );
    `);
  }
};

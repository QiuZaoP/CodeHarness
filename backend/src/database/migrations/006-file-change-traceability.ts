import type { DatabaseMigration } from './migration.js';

export const fileChangeTraceabilityMigration: DatabaseMigration = {
  version: 6,
  name: 'file-change-traceability',
  checksum: '006-file-change-traceability-v1',
  up(database) {
    const columns = database.pragma('table_info(file_changes)') as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'tool_call_id')) {
      database.exec(
        'ALTER TABLE file_changes ADD COLUMN tool_call_id TEXT REFERENCES tool_calls(id)'
      );
    }
    if (!columns.some(({ name }) => name === 'step_id')) {
      database.exec('ALTER TABLE file_changes ADD COLUMN step_id TEXT');
    }
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_file_changes_tool_call_id ON file_changes(tool_call_id)'
    );
  }
};

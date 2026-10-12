import type { DatabaseMigration } from './migration.js';

export const taskLifecycleMigration: DatabaseMigration = {
  version: 4,
  name: 'resumable-task-lifecycle',
  checksum: '004-resumable-task-lifecycle-v1',
  up(database) {
    const columns = database.pragma('table_info(tasks)') as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'resume_status')) {
      database.exec(`
        ALTER TABLE tasks ADD COLUMN resume_status TEXT
          CHECK (resume_status IS NULL OR resume_status IN ('PLANNING', 'EXECUTING', 'VERIFYING'));
      `);
    }
    if (!columns.some(({ name }) => name === 'control_request')) {
      database.exec(`
        ALTER TABLE tasks ADD COLUMN control_request TEXT
          CHECK (control_request IS NULL OR control_request IN ('PAUSE', 'CANCEL'));
      `);
    }
  }
};

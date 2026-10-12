import type { DatabaseMigration } from './migration.js';

export const workspaceMetadataMigration: DatabaseMigration = {
  version: 3,
  name: 'project-source-metadata',
  checksum: '003-project-source-metadata-v1',
  up(database) {
    const columns = database.pragma('table_info(projects)') as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'source_metadata_json')) {
      database.exec('ALTER TABLE projects ADD COLUMN source_metadata_json TEXT');
    }
  }
};

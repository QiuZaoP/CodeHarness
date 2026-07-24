import { initialMigration } from './001-initial.js';
import { runtimePersistenceMigration } from './002-runtime-persistence.js';
import { workspaceMetadataMigration } from './003-workspace-metadata.js';

export const databaseMigrations = [
  initialMigration,
  runtimePersistenceMigration,
  workspaceMetadataMigration
] as const;
export const latestDatabaseVersion = databaseMigrations.at(-1)?.version ?? 0;

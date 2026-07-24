import { initialMigration } from './001-initial.js';
import { runtimePersistenceMigration } from './002-runtime-persistence.js';
import { workspaceMetadataMigration } from './003-workspace-metadata.js';
import { taskLifecycleMigration } from './004-task-lifecycle.js';
import { taskRunCheckpointsMigration } from './005-task-run-checkpoints.js';

export const databaseMigrations = [
  initialMigration,
  runtimePersistenceMigration,
  workspaceMetadataMigration,
  taskLifecycleMigration,
  taskRunCheckpointsMigration
] as const;
export const latestDatabaseVersion = databaseMigrations.at(-1)?.version ?? 0;

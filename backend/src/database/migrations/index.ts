import { initialMigration } from './001-initial.js';
import { runtimePersistenceMigration } from './002-runtime-persistence.js';
import { workspaceMetadataMigration } from './003-workspace-metadata.js';
import { taskLifecycleMigration } from './004-task-lifecycle.js';
import { taskRunCheckpointsMigration } from './005-task-run-checkpoints.js';
import { fileChangeTraceabilityMigration } from './006-file-change-traceability.js';

export const databaseMigrations = [
  initialMigration,
  runtimePersistenceMigration,
  workspaceMetadataMigration,
  taskLifecycleMigration,
  taskRunCheckpointsMigration,
  fileChangeTraceabilityMigration
] as const;
export const latestDatabaseVersion = databaseMigrations.at(-1)?.version ?? 0;

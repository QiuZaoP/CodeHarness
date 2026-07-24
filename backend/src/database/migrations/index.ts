import { initialMigration } from './001-initial.js';
import { runtimePersistenceMigration } from './002-runtime-persistence.js';

export const databaseMigrations = [initialMigration, runtimePersistenceMigration] as const;
export const latestDatabaseVersion = databaseMigrations.at(-1)?.version ?? 0;

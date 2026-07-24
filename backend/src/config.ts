import 'dotenv/config';
import path from 'node:path';

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: intEnv('PORT', 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databasePath: path.resolve(process.env.DATABASE_PATH ?? '.data/codeharness.sqlite'),
  workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? '.data/workspaces'),
  maxTaskSteps: intEnv('MAX_TASK_STEPS', 20),
  maxCommandTimeoutMs: intEnv('MAX_COMMAND_TIMEOUT_MS', 30_000),
  maxImportFiles: intEnv('MAX_IMPORT_FILES', 20_000),
  maxImportBytes: intEnv('MAX_IMPORT_BYTES', 512 * 1024 * 1024),
  maxFileBytes: intEnv('MAX_FILE_BYTES', 5 * 1024 * 1024),
  workspaceRetentionHours: intEnv('WORKSPACE_RETENTION_HOURS', 168),
  mockMode: (process.env.MOCK_MODE ?? 'true').toLowerCase() === 'true'
} as const;

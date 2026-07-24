import 'dotenv/config';
import path from 'node:path';

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  maxCommandOutputBytes: intEnv('MAX_COMMAND_OUTPUT_BYTES', 1024 * 1024),
  maxReadFileBytes: intEnv('MAX_READ_FILE_BYTES', 1024 * 1024),
  maxToolArgumentBytes: intEnv('MAX_TOOL_ARGUMENT_BYTES', 256 * 1024),
  maxToolOutputBytes: intEnv('MAX_TOOL_OUTPUT_BYTES', 1024 * 1024),
  taskLeaseTtlMs: intEnv('TASK_LEASE_TTL_MS', 15_000),
  taskControlPollMs: intEnv('TASK_CONTROL_POLL_MS', 250),
  maxModelTimeoutMs: intEnv('MAX_MODEL_TIMEOUT_MS', 30_000),
  maxTaskDurationMs: intEnv('MAX_TASK_DURATION_MS', 15 * 60_000),
  maxTaskToolCalls: intEnv('MAX_TASK_TOOL_CALLS', 80),
  maxTaskChangedFiles: intEnv('MAX_TASK_CHANGED_FILES', 100),
  maxModelInputTokens: intEnv('MAX_MODEL_INPUT_TOKENS', 120_000),
  maxModelOutputTokens: intEnv('MAX_MODEL_OUTPUT_TOKENS', 16_000),
  maxModelCost: numberEnv('MAX_MODEL_COST', 10),
  maxContextBytes: intEnv('MAX_CONTEXT_BYTES', 64 * 1024),
  maxContextEntryBytes: intEnv('MAX_CONTEXT_ENTRY_BYTES', 16 * 1024),
  maxContextEntries: intEnv('MAX_CONTEXT_ENTRIES', 32),
  maxContextHistoryMessages: intEnv('MAX_CONTEXT_HISTORY_MESSAGES', 8),
  maxContextReadBytes: intEnv('MAX_CONTEXT_READ_BYTES', 256 * 1024),
  maxVerificationRuns: intEnv('MAX_VERIFICATION_RUNS', 3),
  maxConsecutiveHarnessFailures: intEnv('MAX_CONSECUTIVE_HARNESS_FAILURES', 3),
  maxImportFiles: intEnv('MAX_IMPORT_FILES', 20_000),
  maxImportBytes: intEnv('MAX_IMPORT_BYTES', 512 * 1024 * 1024),
  maxFileBytes: intEnv('MAX_FILE_BYTES', 5 * 1024 * 1024),
  workspaceRetentionHours: intEnv('WORKSPACE_RETENTION_HOURS', 168),
  mockMode: (process.env.MOCK_MODE ?? 'true').toLowerCase() === 'true'
} as const;

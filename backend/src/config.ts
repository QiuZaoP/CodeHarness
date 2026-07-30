import 'dotenv/config';
import path from 'node:path';

type Environment = Record<string, string | undefined>;

function intEnv(environment: Environment, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function numberEnv(environment: Environment, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function booleanEnv(environment: Environment, name: string, fallback: boolean): boolean {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function listEnv(environment: Environment, name: string, fallback: readonly string[]): string[] {
  const raw = environment[name];
  if (raw === undefined) return [...fallback];
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one origin`);
  return values;
}

export function loadConfig(environment: Environment = process.env) {
  const nodeEnv = environment.NODE_ENV ?? 'development';
  const host = environment.HOST ?? '127.0.0.1';
  const mockMode = booleanEnv(environment, 'MOCK_MODE', true);
  const corsOrigins = listEnv(environment, 'CORS_ORIGINS', [
    'http://127.0.0.1:5173',
    'http://localhost:5173'
  ]);
  if (nodeEnv === 'production') {
    if (mockMode) throw new Error('MOCK_MODE must be false in production');
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error(
        'Production binding must remain loopback until authentication is implemented'
      );
    }
    if (corsOrigins.includes('*')) {
      throw new Error('CORS_ORIGINS cannot contain * in production');
    }
  }

  const modelTimeoutMs = intEnv(environment, 'MODEL_TIMEOUT_MS', 120_000);

  return {
    nodeEnv,
    host,
    port: intEnv(environment, 'PORT', 3000),
    logLevel: environment.LOG_LEVEL ?? 'info',
    databasePath: path.resolve(environment.DATABASE_PATH ?? '.data/codeharness.sqlite'),
    workspaceRoot: path.resolve(environment.WORKSPACE_ROOT ?? '.data/workspaces'),
    maxTaskSteps: intEnv(environment, 'MAX_TASK_STEPS', 40),
    maxCommandTimeoutMs: intEnv(environment, 'MAX_COMMAND_TIMEOUT_MS', 120_000),
    maxCommandOutputBytes: intEnv(environment, 'MAX_COMMAND_OUTPUT_BYTES', 1024 * 1024),
    maxReadFileBytes: intEnv(environment, 'MAX_READ_FILE_BYTES', 1024 * 1024),
    maxToolArgumentBytes: intEnv(environment, 'MAX_TOOL_ARGUMENT_BYTES', 256 * 1024),
    maxToolOutputBytes: intEnv(environment, 'MAX_TOOL_OUTPUT_BYTES', 1024 * 1024),
    taskLeaseTtlMs: intEnv(environment, 'TASK_LEASE_TTL_MS', 15_000),
    taskControlPollMs: intEnv(environment, 'TASK_CONTROL_POLL_MS', 250),
    maxModelTimeoutMs: intEnv(environment, 'MAX_MODEL_TIMEOUT_MS', modelTimeoutMs),
    maxIndexTimeoutMs: intEnv(environment, 'MAX_INDEX_TIMEOUT_MS', 30_000),
    maxTaskDurationMs: intEnv(environment, 'MAX_TASK_DURATION_MS', 45 * 60_000),
    maxTaskToolCalls: intEnv(environment, 'MAX_TASK_TOOL_CALLS', 120),
    maxTaskChangedFiles: intEnv(environment, 'MAX_TASK_CHANGED_FILES', 100),
    maxModelInputTokens: intEnv(environment, 'MAX_MODEL_INPUT_TOKENS', 600_000),
    maxModelOutputTokens: intEnv(environment, 'MAX_MODEL_OUTPUT_TOKENS', 16_000),
    maxModelCost: numberEnv(environment, 'MAX_MODEL_COST', 10),
    maxContextBytes: intEnv(environment, 'MAX_CONTEXT_BYTES', 64 * 1024),
    maxContextEntryBytes: intEnv(environment, 'MAX_CONTEXT_ENTRY_BYTES', 16 * 1024),
    maxContextEntries: intEnv(environment, 'MAX_CONTEXT_ENTRIES', 32),
    maxContextHistoryMessages: intEnv(environment, 'MAX_CONTEXT_HISTORY_MESSAGES', 8),
    maxContextReadBytes: intEnv(environment, 'MAX_CONTEXT_READ_BYTES', 256 * 1024),
    maxVerificationRuns: intEnv(environment, 'MAX_VERIFICATION_RUNS', 6),
    maxConsecutiveHarnessFailures: intEnv(environment, 'MAX_CONSECUTIVE_HARNESS_FAILURES', 3),
    maxImportFiles: intEnv(environment, 'MAX_IMPORT_FILES', 20_000),
    maxImportBytes: intEnv(environment, 'MAX_IMPORT_BYTES', 512 * 1024 * 1024),
    maxFileBytes: intEnv(environment, 'MAX_FILE_BYTES', 5 * 1024 * 1024),
    workspaceRetentionHours: intEnv(environment, 'WORKSPACE_RETENTION_HOURS', 168),
    workspacePruneIntervalMs: intEnv(environment, 'WORKSPACE_PRUNE_INTERVAL_MS', 60 * 60_000),
    corsOrigins,
    sseReplayIntervalMs: intEnv(environment, 'SSE_REPLAY_INTERVAL_MS', 1_000),
    sseMaxPendingEvents: intEnv(environment, 'SSE_MAX_PENDING_EVENTS', 1_000),
    mockMode
  } as const;
}

export const config = loadConfig();

export const contractSchemaVersion = '1.0.0' as const;

export const taskStatuses = [
  'CREATED',
  'PRECHECKING',
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
  'READY_FOR_REVIEW',
  'APPLIED',
  'WAITING_USER',
  'PAUSED',
  'CANCELLED',
  'FAILED'
] as const;

export const planStepStatuses = ['PENDING', 'RUNNING', 'DONE'] as const;

export const messageRoles = ['USER', 'ASSISTANT', 'SYSTEM'] as const;

export const decisionTypes = [
  'TOOL_CALL',
  'PLAN_UPDATE',
  'ASK_USER',
  'VERIFY',
  'COMPLETE'
] as const;

export const eventTypes = [
  'task.created',
  'task.state_changed',
  'task.plan.updated',
  'tool.started',
  'tool.completed',
  'task.completed',
  'task.failed',
  'task.waiting_user',
  'task.paused',
  'task.resumed',
  'task.cancelled',
  'task.applied',
  'verification.completed',
  'change.updated'
] as const;

export const toolNames = [
  'list_files',
  'search_text',
  'search_symbol',
  'read_file',
  'read_ast',
  'apply_patch',
  'write_file',
  'run_command',
  'git_diff',
  'git_status'
] as const;

export const toolCallStatuses = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

export const toolPermissions = ['READ', 'WRITE', 'COMMAND', 'DESTRUCTIVE', 'EXTERNAL'] as const;

export const fileChangeStatuses = ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED'] as const;

export const changeDecisions = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;

export const snapshotKinds = ['BASELINE', 'CHECKPOINT', 'FINAL'] as const;

export const contextKinds = [
  'PROJECT_OVERVIEW',
  'FILE',
  'SYMBOL',
  'SEARCH',
  'TOOL_RESULT',
  'LOG',
  'SUMMARY'
] as const;

export const verificationStatuses = ['PASSED', 'FAILED', 'ERROR', 'SKIPPED'] as const;

export const verificationFailureCategories = ['CODE', 'TEST', 'ENVIRONMENT', 'BASELINE'] as const;

export const errorCodes = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'WORKSPACE_ERROR',
  'COMMAND_NOT_ALLOWED',
  'MODEL_ERROR',
  'INDEX_ERROR',
  'BUDGET_EXCEEDED',
  'TASK_CANCELLED',
  'INTERNAL_ERROR'
] as const;

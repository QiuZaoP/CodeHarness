export const contractSchemaVersion = '1.0.0' as const;

export const decisionTypes = [
  'TOOL_CALL',
  'PLAN_UPDATE',
  'ASK_USER',
  'VERIFY',
  'COMPLETE'
] as const;

export const planStepStatuses = ['PENDING', 'RUNNING', 'DONE'] as const;

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

export const toolPermissions = ['READ', 'WRITE', 'EXECUTE'] as const;

export const contextKinds = [
  'SUMMARY',
  'PROJECT_OVERVIEW',
  'RULES',
  'GIT_STATUS',
  'FILE',
  'SYMBOL',
  'SEARCH_RESULT',
  'TOOL_RESULT',
  'TEST_RESULT',
  'ERROR_LOG',
  'HISTORY_SUMMARY'
] as const;

export const errorCodes = [
  'VALIDATION_ERROR',
  'MODEL_ERROR',
  'TASK_CANCELLED',
  'INTERNAL_ERROR'
] as const;

export type DecisionType = (typeof decisionTypes)[number];
export type PlanStepStatus = (typeof planStepStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type ToolName = (typeof toolNames)[number];
export type ToolPermission = (typeof toolPermissions)[number];
export type ContextKind = (typeof contextKinds)[number];
export type ErrorCode = (typeof errorCodes)[number];

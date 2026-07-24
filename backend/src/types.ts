import type {
  changeDecisions,
  contractSchemaVersion,
  contextKinds,
  decisionTypes,
  errorCodes,
  eventTypes,
  fileChangeStatuses,
  messageRoles,
  planStepStatuses,
  snapshotKinds,
  taskStatuses,
  toolCallStatuses,
  toolNames,
  toolPermissions,
  verificationFailureCategories,
  verificationStatuses
} from './contract-values.js';

export {
  changeDecisions,
  contractSchemaVersion,
  contextKinds,
  decisionTypes,
  errorCodes,
  eventTypes,
  fileChangeStatuses,
  messageRoles,
  planStepStatuses,
  snapshotKinds,
  taskStatuses,
  toolCallStatuses,
  toolNames,
  toolPermissions,
  verificationFailureCategories,
  verificationStatuses
} from './contract-values.js';

export type TaskStatus = (typeof taskStatuses)[number];
export type PlanStepStatus = (typeof planStepStatuses)[number];
export type MessageRole = (typeof messageRoles)[number];
export type DecisionType = (typeof decisionTypes)[number];
export type EventType = (typeof eventTypes)[number];
export type ToolName = (typeof toolNames)[number];
export type ToolCallStatus = (typeof toolCallStatuses)[number];
export type ToolPermission = (typeof toolPermissions)[number];
export type FileChangeStatus = (typeof fileChangeStatuses)[number];
export type ChangeDecision = (typeof changeDecisions)[number];
export type SnapshotKind = (typeof snapshotKinds)[number];
export type ContextKind = (typeof contextKinds)[number];
export type VerificationStatus = (typeof verificationStatuses)[number];
export type VerificationFailureCategory = (typeof verificationFailureCategories)[number];
export type ErrorCode = (typeof errorCodes)[number];

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface TaskPlan {
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
  verification: string[];
}

export interface StoredTask {
  id: string;
  sessionId: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  plan?: TaskPlan;
  workspacePath: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  stopReason?: string;
  resumeStatus?: Extract<TaskStatus, 'PLANNING' | 'EXECUTING' | 'VERIFYING'>;
  controlRequest?: 'PAUSE' | 'CANCEL';
}

export interface TaskLease {
  taskId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  version: number;
}

export interface TaskEvent {
  schemaVersion: typeof contractSchemaVersion;
  id: number;
  taskId: string;
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ToolCall {
  name: ToolName;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: ToolName;
  version: string;
  description: string;
  permission: ToolPermission;
  sideEffect: boolean;
  defaultTimeoutMs: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface ToolResult {
  status: Exclude<ToolCallStatus, 'PENDING' | 'RUNNING'>;
  output?: unknown;
  error?: { code: ErrorCode; message: string; details?: unknown; retryable?: boolean };
  affectedFiles: string[];
  durationMs: number;
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  stepId?: string;
  tool: ToolCall;
  status: ToolCallStatus;
  startedAt: string;
  finishedAt?: string;
  result?: ToolResult;
}

export interface ContextReference {
  ref: string;
  kind: ContextKind;
  source: string;
  contentHash?: string;
  startLine?: number;
  endLine?: number;
}

export interface WorkspaceSnapshot {
  id: string;
  taskId: string;
  kind: SnapshotKind;
  rootHash: string;
  sourceRevision?: string;
  createdAt: string;
}

export interface SourceGitMetadata {
  isRepository: boolean;
  root?: string;
  revision?: string;
  branch?: string;
  dirty: boolean;
}

export interface SourceMetadata {
  capturedAt: string;
  fileCount: number;
  totalBytes: number;
  manifestHash: string;
  git: SourceGitMetadata;
}

export interface RunBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxChangedFiles: number;
  usedSteps: number;
  usedToolCalls: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCost?: number;
  maxReadBytes?: number;
  maxVerificationRuns?: number;
  usedInputTokens?: number;
  usedOutputTokens?: number;
  usedCost?: number;
  usedReadBytes?: number;
  usedVerificationRuns?: number;
}

export interface HarnessObservation {
  status: 'SUCCEEDED' | 'FAILED';
  summary: string;
  toolCallId?: string;
  verificationResultIds?: string[];
  error?: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface HarnessTurn {
  sequence: number;
  decision: ModelDecision;
  status: 'DECIDED' | 'OBSERVED';
  startedAt: string;
  updatedAt: string;
  toolCallIds?: string[];
  observation?: HarnessObservation;
}

export interface RunState {
  schemaVersion: typeof contractSchemaVersion;
  runId: string;
  taskId: string;
  sessionId: string;
  phase: TaskStatus;
  currentStepId?: string;
  plan?: TaskPlan;
  contextRefs: ContextReference[];
  toolCallIds: string[];
  workspaceSnapshotId?: string;
  changedFiles: string[];
  verificationResultIds: string[];
  budget: RunBudget;
  turnCount?: number;
  consecutiveFailures?: number;
  lastVerificationPassed?: boolean;
  activeTurn?: HarnessTurn;
  stopReason?: string;
}

interface DecisionBase {
  type: DecisionType;
  reason: string;
  expectedObservation?: string;
}

export type ModelDecision =
  | (DecisionBase & { type: 'TOOL_CALL'; tool: ToolCall })
  | (DecisionBase & { type: 'PLAN_UPDATE'; plan: TaskPlan })
  | (DecisionBase & { type: 'ASK_USER'; question: string })
  | (DecisionBase & { type: 'VERIFY'; commands: string[] })
  | (DecisionBase & { type: 'COMPLETE'; summary: string });

export interface FileChange {
  id: string;
  taskId: string;
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: string;
  decision: ChangeDecision;
  toolCallId?: string;
  stepId?: string;
  version?: number;
}

export interface VerificationResult {
  id: string;
  taskId: string;
  command: string;
  status: VerificationStatus;
  exitCode?: number;
  outputSummary: string;
  failureCategory?: VerificationFailureCategory;
  createdAt: string;
}

export interface TaskReport {
  taskId: string;
  status: TaskStatus;
  summary: string;
  plan?: TaskPlan;
  changes: FileChange[];
  verifications: VerificationResult[];
  toolCalls: Array<{
    id: string;
    stepId?: string;
    name: ToolName;
    status: ToolCallStatus;
  }>;
  risks: string[];
  generatedAt: string;
}

export interface AuditRecord {
  id: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  timestamp: string;
}

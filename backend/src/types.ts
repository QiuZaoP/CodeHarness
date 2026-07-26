import type {
  ContextKind,
  DecisionType,
  PlanStepStatus,
  TaskStatus,
  ToolName,
  ToolPermission
} from './contract-values.ts';

export { contractSchemaVersion } from './contract-values.ts';

export interface ContextReference {
  ref: string;
  kind: ContextKind;
  source: string;
  contentHash?: string;
  startLine?: number;
  endLine?: number;
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
  usedInputTokens?: number;
  usedOutputTokens?: number;
  usedCost?: number;
}

export interface RunState {
  schemaVersion: '1.0.0';
  runId: string;
  taskId: string;
  sessionId: string;
  phase: TaskStatus;
  currentStepId?: string;
  plan?: TaskPlan;
  contextRefs: ContextReference[];
  toolCallIds: string[];
  changedFiles: string[];
  verificationResultIds: string[];
  budget: RunBudget;
  turnCount?: number;
  consecutiveFailures?: number;
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

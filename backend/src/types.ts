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

export type TaskStatus = (typeof taskStatuses)[number];

export type EventType =
  | 'task.created'
  | 'task.state_changed'
  | 'task.plan.updated'
  | 'tool.started'
  | 'tool.completed'
  | 'task.completed'
  | 'task.failed'
  | 'task.waiting_user'
  | 'task.paused';

export interface TaskPlan {
  goal: string;
  assumptions: string[];
  steps: Array<{ id: string; title: string; status: 'PENDING' | 'RUNNING' | 'DONE' }>;
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
  createdAt: string;
  updatedAt: string;
  stopReason?: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ToolCall {
  name:
    | 'list_files'
    | 'search_text'
    | 'read_file'
    | 'apply_patch'
    | 'run_command'
    | 'index_repository'
    | 'search_files'
    | 'search_symbols'
    | 'find_references'
    | 'find_callers'
    | 'find_callees'
    | 'search_semantic';
  arguments: Record<string, unknown>;
}

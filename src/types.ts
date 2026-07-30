export type Project = {
  id: string;
  name: string;
  path: string;
  branch: string;
  language: string;
  indexedFiles: number;
  lastOpened: string;
};

export type Session = {
  id: string;
  projectId?: string;
  title: string;
  preview: string;
  updatedAt: string;
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  unread?: boolean;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type ToolCallStatus = 'completed' | 'running' | 'failed' | 'waiting';

export type ToolCall = {
  id: string;
  name: string;
  summary: string;
  detail: string;
  duration?: string;
  status: ToolCallStatus;
};

export type TaskStep = {
  id: string;
  label: string;
  status: 'completed' | 'active' | 'pending';
};

export type TaskRun = {
  id: string;
  status:
    | 'CREATED'
    | 'PRECHECKING'
    | 'PLANNING'
    | 'EXECUTING'
    | 'VERIFYING'
    | 'READY_FOR_REVIEW'
    | 'APPLIED'
    | 'WAITING_USER'
    | 'PAUSED'
    | 'CANCELLED'
    | 'FAILED';
  startedAt: string;
  elapsed: string;
  model: string;
  stopReason?: string;
  steps: TaskStep[];
  toolCalls: ToolCall[];
};

export type FileNode = {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  language?: string;
  status?: 'modified' | 'added' | 'deleted';
  children?: FileNode[];
};

export type DiffLine = {
  kind: 'context' | 'add' | 'remove';
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

export type DiffHunk = {
  id: string;
  header: string;
  lines: DiffLine[];
};

export type FileChange = {
  id: string;
  taskId: string;
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  decision: 'pending' | 'accepted' | 'rejected';
  version: number;
};

export type CodeFile = {
  path: string;
  language: string;
  content: string;
};

export type SearchResult = {
  path: string;
  line: number;
  preview: string;
};

export type WorkspaceSnapshot = {
  projects: Project[];
  activeProjectId: string;
  sessions: Session[];
  activeSessionId: string;
  messages: Record<string, Message[]>;
  fileTree: FileNode[];
  files: Record<string, CodeFile>;
  activeFilePath: string;
  openFilePaths: string[];
  task: TaskRun;
  changes: FileChange[];
};

export type WorkspaceEvent = {
  schemaVersion: '1.0.0';
  id: number;
  taskId: string;
  type:
    | 'task.created'
    | 'task.state_changed'
    | 'task.plan.updated'
    | 'tool.started'
    | 'tool.completed'
    | 'task.completed'
    | 'task.failed'
    | 'task.waiting_user'
    | 'task.paused'
    | 'task.resumed'
    | 'task.cancelled'
    | 'task.applied'
    | 'verification.completed'
    | 'change.updated'
    | 'harness.decision';
  timestamp: string;
  payload: Record<string, unknown>;
};

export type BackendProject = {
  id: string;
  name: string;
  createdAt: string;
};

export type BackendSession = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
};

export type BackendPlan = {
  goal: string;
  assumptions: string[];
  steps: Array<{
    id: string;
    title: string;
    status: 'PENDING' | 'RUNNING' | 'DONE';
  }>;
  verification: string[];
};

export type BackendTask = {
  id: string;
  sessionId: string;
  projectId: string;
  goal: string;
  status: TaskRun['status'];
  plan?: BackendPlan;
  createdAt: string;
  updatedAt: string;
  stopReason?: string;
};

export type BackendMessage = {
  id: string;
  sessionId: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  createdAt: string;
};

export type BackendFileChange = {
  id: string;
  taskId: string;
  path: string;
  status: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
  additions: number;
  deletions: number;
  patch: string;
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  toolCallId?: string;
  stepId?: string;
  version?: number;
};

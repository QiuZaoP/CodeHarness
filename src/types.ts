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
  title: string;
  preview: string;
  updatedAt: string;
  status:
    | "idle"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled";
  unread?: boolean;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type ToolCallStatus = "completed" | "running" | "failed" | "waiting";

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
  status: "completed" | "active" | "pending";
};

export type TaskRun = {
  id: string;
  status:
    | "CREATED"
    | "PRECHECKING"
    | "PLANNING"
    | "EXECUTING"
    | "VERIFYING"
    | "READY_FOR_REVIEW"
    | "PAUSED"
    | "CANCELLED"
    | "FAILED";
  startedAt: string;
  elapsed: string;
  model: string;
  steps: TaskStep[];
  toolCalls: ToolCall[];
};

export type FileNode = {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder";
  language?: string;
  status?: "modified" | "added" | "deleted";
  children?: FileNode[];
};

export type DiffLine = {
  kind: "context" | "add" | "remove";
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
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  decision: "pending" | "accepted" | "rejected";
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

export type WorkspaceEvent =
  | {
      type: "task.status";
      taskId: string;
      status: TaskRun["status"];
    }
  | {
      type: "tool.updated";
      taskId: string;
      tool: ToolCall;
    }
  | {
      type: "message.created";
      sessionId: string;
      message: Message;
    }
  | {
      type: "change.updated";
      change: FileChange;
    };

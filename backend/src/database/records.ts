import type { RunState, SourceMetadata } from '../types.js';

export interface ProjectRecord {
  id: string;
  name: string;
  sourcePath: string;
  workspacePath: string;
  sourceMetadata?: SourceMetadata;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

export interface TaskRunCheckpoint {
  taskId: string;
  runId: string;
  state: RunState;
  historySummary?: string;
  summarizedMessageCount: number;
  startedAt: string;
  updatedAt: string;
  version: number;
}

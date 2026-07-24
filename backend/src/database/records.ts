export interface ProjectRecord {
  id: string;
  name: string;
  sourcePath: string;
  workspacePath: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

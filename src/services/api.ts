import { initialSnapshot } from '../data/mockData';
import type {
  BackendFileChange,
  BackendMessage,
  BackendProject,
  BackendSession,
  BackendTask,
  CodeFile,
  DiffHunk,
  FileChange,
  FileNode,
  Message,
  Project,
  SearchResult,
  WorkspaceSnapshot
} from '../types';

const configuredApiBaseUrl =
  import.meta.env.MODE === 'test' ? '' : import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '');
const delay = (milliseconds: number) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

function projectNameFromPath(projectPath: string) {
  return (
    projectPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || 'untitled-project'
  );
}

function formatTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function sessionStatusForTask(
  status?: BackendTask['status']
): WorkspaceSnapshot['sessions'][number]['status'] {
  if (status === 'APPLIED') {
    return 'completed';
  }
  if (status === 'CANCELLED') {
    return 'cancelled';
  }
  if (status === 'FAILED') {
    return 'failed';
  }
  if (status === 'PAUSED' || status === 'READY_FOR_REVIEW' || status === 'WAITING_USER') {
    return 'waiting';
  }
  if (!status || status === 'CREATED') {
    return 'idle';
  }
  return 'running';
}

function mapBackendProject(project: BackendProject, sourcePath?: string): Project {
  return {
    id: project.id,
    name: project.name,
    path: sourcePath || project.name,
    branch: 'workspace',
    language: '待识别',
    indexedFiles: 0,
    lastOpened: '刚刚'
  };
}

function languageForPath(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    yml: 'yaml',
    yaml: 'yaml'
  };
  return languages[extension || ''] || 'text';
}

function fileTreeFromPaths(filePaths: string[]): FileNode[] {
  const roots: FileNode[] = [];
  for (const filePath of filePaths) {
    let children = roots;
    let currentPath = '';
    const parts = filePath.split('/').filter(Boolean);
    for (const [index, name] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isFile = index === parts.length - 1;
      let node = children.find((candidate) => candidate.name === name);
      if (!node) {
        node = {
          id: currentPath,
          name,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          ...(isFile ? { language: languageForPath(currentPath) } : { children: [] })
        };
        children.push(node);
        children.sort((left, right) =>
          left.type !== right.type
            ? left.type === 'folder'
              ? -1
              : 1
            : left.name.localeCompare(right.name)
        );
      }
      if (!isFile) children = node.children!;
    }
  }
  return roots;
}

function mapBackendMessage(message: BackendMessage): Message {
  return {
    id: message.id,
    role: message.role === 'USER' ? 'user' : 'assistant',
    content: message.content,
    createdAt: formatTime(message.createdAt)
  };
}

function parseUnifiedPatch(patch: string, changeId: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      oldNumber = Number(match[1]);
      newNumber = Number(match[2]);
      current = {
        id: `${changeId}-hunk-${hunks.length + 1}`,
        header: line,
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', newNumber, text: line.slice(1) });
      newNumber += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'remove', oldNumber, text: line.slice(1) });
      oldNumber += 1;
    } else if (line.startsWith(' ') || line === '') {
      current.lines.push({
        kind: 'context',
        oldNumber,
        newNumber,
        text: line.startsWith(' ') ? line.slice(1) : ''
      });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  if (hunks.length === 0 && patch) {
    return [
      {
        id: `${changeId}-hunk-1`,
        header: '变更内容',
        lines: patch.split('\n').map((line) => ({
          kind: 'context' as const,
          text: line
        }))
      }
    ];
  }
  return hunks;
}

function mapBackendChange(change: BackendFileChange): FileChange {
  return {
    id: change.id,
    taskId: change.taskId,
    path: change.path,
    status: change.status.toLocaleLowerCase() as FileChange['status'],
    additions: change.additions,
    deletions: change.deletions,
    hunks: parseUnifiedPatch(change.patch, change.id),
    decision: change.decision.toLocaleLowerCase() as FileChange['decision'],
    version: change.version ?? 1
  };
}

function mapBackendTask(task: BackendTask): WorkspaceSnapshot['task'] {
  return {
    id: task.id,
    status: task.status,
    startedAt: task.createdAt,
    elapsed: '运行中',
    model: 'Harness runtime',
    steps:
      task.plan?.steps.map((step) => ({
        id: step.id,
        label: step.title,
        status:
          step.status === 'DONE'
            ? ('completed' as const)
            : step.status === 'RUNNING'
              ? ('active' as const)
              : ('pending' as const)
      })) || [],
    toolCalls: []
  };
}

export function createWorkspaceApi(apiBaseUrl = configuredApiBaseUrl) {
  const useMock = !apiBaseUrl;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    if (useMock) {
      throw new Error(`Mock request was not handled: ${path}`);
    }

    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      const message = body?.error?.message || `Request failed with status ${response.status}`;
      throw new Error(body?.error?.code ? `${body.error.code}: ${message}` : message);
    }

    return response.json() as Promise<T>;
  }

  return {
    async getSnapshot(preferredProjectId?: string): Promise<WorkspaceSnapshot> {
      if (useMock) {
        await delay(180);
        return structuredClone(initialSnapshot);
      }

      await request<{ status: string }>('/api/health');
      const backendProjects = await request<BackendProject[]>('/api/v1/projects');
      const projects = backendProjects.map((project) => mapBackendProject(project));
      const activeProject =
        projects.find((project) => project.id === preferredProjectId) ?? projects[0];
      const emptySnapshot = structuredClone(initialSnapshot);
      if (!activeProject) {
        return {
          ...emptySnapshot,
          projects: [],
          activeProjectId: '',
          sessions: [],
          activeSessionId: '',
          messages: {},
          fileTree: [],
          files: {},
          activeFilePath: '',
          openFilePaths: [],
          task: { ...emptySnapshot.task, id: '', status: 'CREATED', steps: [], toolCalls: [] },
          changes: []
        };
      }

      const projectFiles = await request<{ files: string[] }>(
        `/api/v1/projects/${encodeURIComponent(activeProject.id)}/files`
      );

      const backendSessions = await request<BackendSession[]>(
        `/api/v1/sessions?projectId=${encodeURIComponent(activeProject.id)}`
      );
      const allTasks = (
        await Promise.all(
          backendSessions.map((session) =>
            request<BackendTask[]>(`/api/v1/tasks?sessionId=${encodeURIComponent(session.id)}`)
          )
        )
      ).flat();
      const tasksBySession = new Map<string, BackendTask>();
      for (const task of allTasks.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      )) {
        if (!tasksBySession.has(task.sessionId)) {
          tasksBySession.set(task.sessionId, task);
        }
      }
      const activeSession = [...backendSessions].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )[0];
      const backendMessages = activeSession
        ? await request<BackendMessage[]>(
            `/api/v1/sessions/${encodeURIComponent(activeSession.id)}/messages`
          )
        : [];
      const activeTask = activeSession ? tasksBySession.get(activeSession.id) : undefined;
      const changes = activeTask
        ? (
            await request<BackendFileChange[]>(
              `/api/v1/tasks/${encodeURIComponent(activeTask.id)}/changes`
            )
          ).map(mapBackendChange)
        : [];

      return {
        ...emptySnapshot,
        projects: projects.map((project) =>
          project.id === activeProject.id
            ? { ...project, indexedFiles: projectFiles.files.length }
            : project
        ),
        activeProjectId: activeProject.id,
        sessions: backendSessions.map((session) => {
          const latestTask = tasksBySession.get(session.id);
          const latestMessage =
            session.id === activeSession?.id ? backendMessages.at(-1)?.content : undefined;
          return {
            id: session.id,
            projectId: session.projectId,
            title: session.title,
            preview: latestMessage || latestTask?.goal || '暂无消息',
            updatedAt: formatTime(latestTask?.updatedAt || session.createdAt),
            status: sessionStatusForTask(latestTask?.status)
          };
        }),
        activeSessionId: activeSession?.id || '',
        messages: activeSession
          ? { [activeSession.id]: backendMessages.map(mapBackendMessage) }
          : {},
        fileTree: fileTreeFromPaths(projectFiles.files),
        files: {},
        activeFilePath: '',
        openFilePaths: [],
        task: activeTask
          ? mapBackendTask(activeTask)
          : { ...emptySnapshot.task, id: '', status: 'CREATED', steps: [], toolCalls: [] },
        changes
      };
    },

    async importProject(path: string): Promise<Project> {
      if (useMock) {
        await delay(400);
        const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
        return {
          id: `project-${Date.now()}`,
          name: normalized.split('/').pop() || 'untitled-project',
          path: normalized,
          branch: 'main',
          language: '待识别',
          indexedFiles: 0,
          lastOpened: '刚刚'
        };
      }

      const project = await request<BackendProject>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: projectNameFromPath(path), sourcePath: path })
      });
      return mapBackendProject(project, path);
    },

    async getProjectFile(projectId: string, filePath: string): Promise<CodeFile> {
      if (useMock) {
        const file = initialSnapshot.files[filePath];
        if (!file) throw new Error('File not found');
        return structuredClone(file);
      }
      const file = await request<{ path: string; content: string }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(filePath)}`
      );
      return { path: file.path, content: file.content, language: languageForPath(file.path) };
    },

    async createSession(projectId: string, title = '新任务'): Promise<BackendSession> {
      if (useMock) {
        await delay(120);
        return {
          id: `session-${Date.now()}`,
          projectId,
          title,
          createdAt: new Date().toISOString()
        };
      }

      return request<BackendSession>('/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ projectId, title })
      });
    },

    async getSessionState(sessionId: string): Promise<{
      messages: Message[];
      task?: WorkspaceSnapshot['task'];
      changes: FileChange[];
    }> {
      if (useMock) {
        const snapshot = structuredClone(initialSnapshot);
        return {
          messages: snapshot.messages[sessionId] || [],
          task: snapshot.task,
          changes: snapshot.changes
        };
      }

      const [backendMessages, tasks] = await Promise.all([
        request<BackendMessage[]>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`),
        request<BackendTask[]>(`/api/v1/tasks?sessionId=${encodeURIComponent(sessionId)}`)
      ]);
      const latestTask = [...tasks].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      )[0];
      const changes = latestTask
        ? (
            await request<BackendFileChange[]>(
              `/api/v1/tasks/${encodeURIComponent(latestTask.id)}/changes`
            )
          ).map(mapBackendChange)
        : [];
      return {
        messages: backendMessages.map(mapBackendMessage),
        task: latestTask ? mapBackendTask(latestTask) : undefined,
        changes
      };
    },

    async sendMessage(
      sessionId: string,
      projectId: string,
      content: string
    ): Promise<{ message: Message; task?: BackendTask }> {
      if (useMock) {
        await delay(520);
        return {
          message: {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content:
              '收到。我已把目标加入当前任务，并会先核对工作区状态和相关文件，再进行受控修改。',
            createdAt: formatTime(new Date().toISOString())
          }
        };
      }

      await request<BackendMessage>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content })
      });
      const task = await request<BackendTask>('/api/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({ projectId, sessionId, goal: content })
      });
      return {
        task,
        message: {
          id: `assistant-${task.id}`,
          role: 'assistant',
          content: '已创建任务。Harness 正在执行前置检查和规划，请查看任务进度。',
          createdAt: formatTime(new Date().toISOString())
        }
      };
    },

    async runTask(taskId: string): Promise<BackendTask | undefined> {
      if (useMock) {
        return undefined;
      }
      return request<BackendTask>(`/api/v1/tasks/${encodeURIComponent(taskId)}/run`, {
        method: 'POST'
      });
    },

    async getChanges(taskId: string): Promise<FileChange[]> {
      if (useMock) {
        return structuredClone(initialSnapshot.changes);
      }
      const changes = await request<BackendFileChange[]>(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/changes`
      );
      return changes.map(mapBackendChange);
    },

    async searchFiles(snapshot: WorkspaceSnapshot, query: string): Promise<SearchResult[]> {
      const normalized = query.trim();
      if (!normalized) {
        return [];
      }
      if (!useMock && snapshot.activeProjectId) {
        return request<SearchResult[]>(
          `/api/v1/projects/${encodeURIComponent(snapshot.activeProjectId)}/search?q=${encodeURIComponent(normalized)}&limit=12`
        );
      }

      await delay(120);
      const lowered = normalized.toLocaleLowerCase();
      const results: SearchResult[] = [];
      Object.values(snapshot.files).forEach((file) => {
        file.content.split('\n').forEach((line, index) => {
          if (
            file.path.toLocaleLowerCase().includes(lowered) ||
            line.toLocaleLowerCase().includes(lowered)
          ) {
            results.push({
              path: file.path,
              line: index + 1,
              preview: line.trim() || file.path
            });
          }
        });
      });
      return results.slice(0, 12);
    },

    async controlTask(
      taskId: string,
      action: 'pause' | 'resume' | 'cancel'
    ): Promise<{ status: WorkspaceSnapshot['task']['status'] }> {
      if (useMock) {
        await delay(180);
        return {
          status: action === 'pause' ? 'PAUSED' : action === 'resume' ? 'EXECUTING' : 'CANCELLED'
        };
      }

      return request(`/api/v1/tasks/${encodeURIComponent(taskId)}/${action}`, {
        method: 'POST'
      });
    },

    async decideChange(
      taskId: string,
      changeId: string,
      decision: Exclude<FileChange['decision'], 'pending'>,
      expectedVersion: number
    ): Promise<FileChange> {
      if (useMock) {
        await delay(120);
        const change = initialSnapshot.changes.find((item) => item.id === changeId);
        if (!change) {
          throw new Error('Change not found');
        }
        return { ...structuredClone(change), decision, version: expectedVersion + 1 };
      }

      const updated = await request<BackendFileChange>(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/changes/${encodeURIComponent(changeId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            decision: decision.toLocaleUpperCase(),
            expectedVersion
          })
        }
      );
      return mapBackendChange(updated);
    },

    async rollbackTask(taskId: string): Promise<void> {
      if (useMock) {
        await delay(220);
        return;
      }
      await request(`/api/v1/tasks/${encodeURIComponent(taskId)}/rollback`, {
        method: 'POST'
      });
    },

    async applyTask(taskId: string): Promise<BackendTask | undefined> {
      if (useMock) {
        await delay(220);
        return undefined;
      }
      return request<BackendTask>(`/api/v1/tasks/${encodeURIComponent(taskId)}/apply`, {
        method: 'POST'
      });
    },

    mapBackendTask
  };
}

export const workspaceApi = createWorkspaceApi();

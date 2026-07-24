import { initialSnapshot } from "../data/mockData";
import type {
  BackendProject,
  BackendSession,
  BackendTask,
  FileChange,
  Message,
  Project,
  SearchResult,
  WorkspaceSnapshot,
} from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "");
const useMock = !API_BASE_URL;
const delay = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (useMock) {
    throw new Error(`Mock request was not handled: ${path}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    const message = body?.error?.message || `Request failed with status ${response.status}`;
    throw new Error(body?.error?.code ? `${body.error.code}: ${message}` : message);
  }

  return response.json() as Promise<T>;
}

function projectNameFromPath(projectPath: string) {
  return projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "untitled-project";
}

function mapBackendProject(project: BackendProject): Project {
  return {
    id: project.id,
    name: project.name,
    path: project.sourcePath,
    branch: "workspace",
    language: "待识别",
    indexedFiles: 0,
    lastOpened: "刚刚",
  };
}

function mapBackendTask(task: BackendTask) {
  return {
    id: task.id,
    status: task.status,
    startedAt: task.createdAt,
    elapsed: "运行中",
    model: "Harness runtime",
    steps:
      task.plan?.steps.map((step) => ({
        id: step.id,
        label: step.title,
        status:
          step.status === "DONE"
            ? ("completed" as const)
            : step.status === "RUNNING"
              ? ("active" as const)
              : ("pending" as const),
      })) || [],
    toolCalls: [],
  };
}

export const workspaceApi = {
  async getSnapshot(): Promise<WorkspaceSnapshot> {
    if (useMock) {
      await delay(180);
      return structuredClone(initialSnapshot);
    }

    await request<{ status: string }>("/api/health");
    const snapshot = structuredClone(initialSnapshot);
    return {
      ...snapshot,
      projects: [],
      activeProjectId: "",
      sessions: [],
      activeSessionId: "",
      messages: {},
      fileTree: [],
      files: {},
      activeFilePath: "",
      openFilePaths: [],
      task: {
        ...snapshot.task,
        id: "",
        status: "CREATED",
        steps: [],
        toolCalls: [],
      },
      changes: [],
    };
  },

  async importProject(path: string): Promise<Project> {
    if (useMock) {
      await delay(400);
      const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
      return {
        id: `project-${Date.now()}`,
        name: normalized.split("/").pop() || "untitled-project",
        path: normalized,
        branch: "main",
        language: "待识别",
        indexedFiles: 0,
        lastOpened: "刚刚",
      };
    }

    const project = await request<BackendProject>("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: projectNameFromPath(path), sourcePath: path }),
    });
    return mapBackendProject(project);
  },

  async createSession(
    projectId: string,
    title = "新任务",
  ): Promise<BackendSession> {
    if (useMock) {
      await delay(120);
      return {
        id: `session-${Date.now()}`,
        projectId,
        title,
        createdAt: new Date().toISOString(),
      };
    }

    return request<BackendSession>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, title }),
    });
  },

  async sendMessage(
    sessionId: string,
    projectId: string,
    content: string,
  ): Promise<{ message: Message; task?: BackendTask }> {
    if (useMock) {
      await delay(520);
      return {
        message: {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content:
            "收到。我已把目标加入当前任务，并会先核对工作区状态和相关文件，再进行受控修改。",
          createdAt: new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        },
      };
    }

    const task = await request<BackendTask>("/api/v1/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId, sessionId, goal: content }),
    });
    return {
      task,
      message: {
        id: `assistant-${task.id}`,
        role: "assistant",
        content: "已创建任务。Harness 正在执行前置检查和规划，请查看任务进度。",
        createdAt: new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      },
    };
  },

  async runTask(taskId: string): Promise<BackendTask | undefined> {
    if (useMock) {
      return undefined;
    }
    return request<BackendTask>(`/api/v1/tasks/${taskId}/run`, { method: "POST" });
  },

  async searchFiles(
    snapshot: WorkspaceSnapshot,
    query: string,
  ): Promise<SearchResult[]> {
    await delay(120);
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return [];
    }

    const results: SearchResult[] = [];
    Object.values(snapshot.files).forEach((file) => {
      const lines = file.content.split("\n");
      lines.forEach((line, index) => {
        if (
          file.path.toLocaleLowerCase().includes(normalized) ||
          line.toLocaleLowerCase().includes(normalized)
        ) {
          results.push({
            path: file.path,
            line: index + 1,
            preview: line.trim() || file.path,
          });
        }
      });
    });

    return results.slice(0, 12);
  },

  async controlTask(
    taskId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<{ status: WorkspaceSnapshot["task"]["status"] }> {
    if (useMock) {
      await delay(180);
      return {
        status:
          action === "pause"
            ? "PAUSED"
            : action === "resume"
              ? "EXECUTING"
              : "CANCELLED",
      };
    }

    const endpoint = action === "resume" ? "run" : action;
    return request(`/api/v1/tasks/${taskId}/${endpoint}`, { method: "POST" });
  },

  async decideChange(
    changeId: string,
    decision: FileChange["decision"],
  ): Promise<void> {
    // The develop contract does not expose a change-decision endpoint yet.
    // Keep review decisions local until that API is published.
    void changeId;
    void decision;
    await delay(120);
  },

  async rollbackTask(taskId: string): Promise<void> {
    if (useMock) {
      await delay(220);
      return;
    }

    await request(`/api/v1/tasks/${taskId}/rollback`, { method: "POST" });
  },

  mapBackendTask,
};

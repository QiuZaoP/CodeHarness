import { initialSnapshot } from "../data/mockData";
import type {
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
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const workspaceApi = {
  async getSnapshot(): Promise<WorkspaceSnapshot> {
    if (useMock) {
      await delay(180);
      return structuredClone(initialSnapshot);
    }
    return request<WorkspaceSnapshot>("/api/workspace");
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

    return request<Project>("/api/projects/import", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  },

  async sendMessage(sessionId: string, content: string): Promise<Message> {
    if (useMock) {
      await delay(520);
      return {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content:
          "收到。我已把目标加入当前任务，并会先核对工作区状态和相关文件，再进行受控修改。",
        createdAt: new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      };
    }

    return request<Message>(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  },

  async searchFiles(
    snapshot: WorkspaceSnapshot,
    query: string,
  ): Promise<SearchResult[]> {
    if (!useMock) {
      return request<SearchResult[]>(
        `/api/search?q=${encodeURIComponent(query)}`,
      );
    }

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

    return request(`/api/tasks/${taskId}/${action}`, { method: "POST" });
  },

  async decideChange(
    changeId: string,
    decision: FileChange["decision"],
  ): Promise<void> {
    if (useMock) {
      await delay(120);
      return;
    }

    await request(`/api/changes/${changeId}`, {
      method: "PATCH",
      body: JSON.stringify({ decision }),
    });
  },

  async rollbackTask(taskId: string): Promise<void> {
    if (useMock) {
      await delay(220);
      return;
    }

    await request(`/api/tasks/${taskId}/rollback`, { method: "POST" });
  },
};

import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { workspaceApi } from "../services/api";
import { workspaceEvents } from "../services/events";
import type {
  BackendTask,
  FileChange,
  Message,
  SearchResult,
  ToolCall,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from "../types";

type WorkspaceContextValue = {
  snapshot: WorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  activePanel: "code" | "changes";
  activeFileLine: number | null;
  searchOpen: boolean;
  searchQuery: string;
  searchResults: SearchResult[];
  importProject: (path: string) => Promise<void>;
  selectProject: (projectId: string) => void;
  selectSession: (sessionId: string) => void;
  createSession: () => void;
  sendMessage: (content: string) => Promise<void>;
  openFile: (path: string, line?: number) => void;
  closeFile: (path: string) => void;
  setActivePanel: (panel: "code" | "changes") => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  runSearch: (query: string) => Promise<void>;
  controlTask: (action: "pause" | "resume" | "cancel") => Promise<void>;
  decideChange: (
    changeId: string,
    decision: FileChange["decision"],
  ) => Promise<void>;
  rollbackTask: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const currentTime = () =>
  new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

function sessionStatusForTask(
  status: WorkspaceSnapshot["task"]["status"],
): WorkspaceSnapshot["sessions"][number]["status"] {
  if (status === "CANCELLED") {
    return "cancelled";
  }
  if (status === "FAILED") {
    return "failed";
  }
  if (status === "PAUSED" || status === "READY_FOR_REVIEW") {
    return "waiting";
  }
  if (status === "CREATED") {
    return "idle";
  }
  return "running";
}

function taskFromBackend(task: BackendTask): WorkspaceSnapshot["task"] {
  return workspaceApi.mapBackendTask(task);
}

function statusFromEvent(event: WorkspaceEvent): WorkspaceSnapshot["task"]["status"] | null {
  if (event.type === "task.state_changed") {
    return (event.payload.to as WorkspaceSnapshot["task"]["status"]) || null;
  }
  if (event.type === "task.completed") {
    return "READY_FOR_REVIEW";
  }
  if (event.type === "task.failed") {
    return "FAILED";
  }
  if (event.type === "task.paused") {
    return "PAUSED";
  }
  return null;
}

export function WorkspaceProvider({ children }: PropsWithChildren) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<"code" | "changes">("code");
  const [activeFileLine, setActiveFileLine] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    let alive = true;
    workspaceApi
      .getSnapshot()
      .then((nextSnapshot) => {
        if (alive) {
          setSnapshot(nextSnapshot);
        }
      })
      .catch((caught: unknown) => {
        if (alive) {
          setError(caught instanceof Error ? caught.message : "工作区加载失败");
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  const taskId = snapshot?.task.id;

  useEffect(() => {
    if (!taskId) {
      return;
    }

    return workspaceEvents.subscribe(taskId, (event) => {
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        const nextStatus = statusFromEvent(event);
        if (nextStatus) {
          return {
            ...current,
            task: { ...current.task, status: nextStatus },
            sessions: current.sessions.map((session) =>
              session.id === current.activeSessionId
                ? {
                    ...session,
                    status: sessionStatusForTask(nextStatus),
                  }
                : session,
            ),
          };
        }

        if (event.type === "task.plan.updated") {
          const plan = event.payload.plan as BackendTask["plan"];
          return {
            ...current,
            task: {
              ...current.task,
              steps:
                plan?.steps.map((step) => ({
                  id: step.id,
                  label: step.title,
                  status:
                    step.status === "DONE"
                      ? "completed"
                      : step.status === "RUNNING"
                        ? "active"
                        : "pending",
                })) || [],
            },
          };
        }

        if (event.type === "tool.started" || event.type === "tool.completed") {
          const toolName = String(event.payload.toolName || "tool");
          const toolId = `event-tool-${event.id}`;
          const tool: ToolCall = {
            id: toolId,
            name: toolName,
            summary:
              event.type === "tool.started" ? "开始执行工具" : "工具执行完成",
            detail: JSON.stringify(event.payload),
            status: event.type === "tool.started" ? "running" : event.payload.error ? "failed" : "completed",
          };
          return {
            ...current,
            task: {
              ...current.task,
              toolCalls: [...current.task.toolCalls, tool],
            },
          };
        }
        return current;
      });
    });
  }, [taskId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const importProject = useCallback(async (path: string) => {
    const project = await workspaceApi.importProject(path);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            projects: [project, ...current.projects],
            activeProjectId: project.id,
            activeSessionId: "",
            sessions: [],
            messages: {},
          }
        : current,
    );
  }, []);

  const selectProject = useCallback((projectId: string) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            activeProjectId: projectId,
            activeSessionId: "",
            sessions: [],
            messages: {},
            task: { ...current.task, id: "", steps: [], toolCalls: [] },
          }
        : current,
    );
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            activeSessionId: sessionId,
            sessions: current.sessions.map((session) =>
              session.id === sessionId
                ? { ...session, unread: false }
                : session,
            ),
          }
        : current,
    );
  }, []);

  const createSession = useCallback(async () => {
    const projectId = snapshot?.activeProjectId;
    if (!projectId) {
      return;
    }
    const backendSession = await workspaceApi.createSession(projectId);
    const id = backendSession.id;
    setSnapshot((current) =>
      current
          ? {
              ...current,
            activeSessionId: id,
            task: {
              ...current.task,
              id: "",
              status: "CREATED",
              steps: [],
              toolCalls: [],
            },
            sessions: [
              {
                id,
                title: "新任务",
                preview: "描述你希望在代码库中完成的工作。",
                updatedAt: "刚刚",
                status: "idle",
              },
              ...current.sessions,
            ],
            messages: {
              ...current.messages,
              [id]: [],
            },
          }
        : current,
    );
  }, [snapshot?.activeProjectId]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      const activeSessionId = snapshot?.activeSessionId;
      if (!trimmed || !activeSessionId) {
        return;
      }

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        createdAt: currentTime(),
      };

      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === activeSessionId
              ? {
                  ...session,
                  title:
                    session.title === "新任务"
                      ? trimmed.slice(0, 24)
                      : session.title,
                  preview: trimmed,
                  updatedAt: "刚刚",
                  status: "running",
                }
              : session,
          ),
          messages: {
            ...current.messages,
            [activeSessionId]: [
              ...(current.messages[activeSessionId] || []),
              userMessage,
            ],
          },
        };
      });

      const activeProjectId = snapshot?.activeProjectId;
      if (!activeProjectId) {
        return;
      }
      const result = await workspaceApi.sendMessage(
        activeSessionId,
        activeProjectId,
        trimmed,
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              task: result.task ? taskFromBackend(result.task) : current.task,
              messages: {
                ...current.messages,
                [activeSessionId]: [
                  ...(current.messages[activeSessionId] || []),
                  result.message,
                ],
              },
            }
          : current,
      );
      if (result.task) {
        void workspaceApi.runTask(result.task.id).catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : "任务启动失败");
        });
      }
    },
    [snapshot?.activeProjectId, snapshot?.activeSessionId],
  );

  const openFile = useCallback((path: string, line?: number) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            activeFilePath: path,
            openFilePaths: current.openFilePaths.includes(path)
              ? current.openFilePaths
              : [...current.openFilePaths, path],
          }
        : current,
    );
    setActiveFileLine(line ?? null);
    setActivePanel("code");
    setSearchOpen(false);
  }, []);

  const closeFile = useCallback((path: string) => {
    setSnapshot((current) => {
      if (!current || current.openFilePaths.length === 1) {
        return current;
      }
      const openFilePaths = current.openFilePaths.filter(
        (openPath) => openPath !== path,
      );
      return {
        ...current,
        openFilePaths,
        activeFilePath:
          current.activeFilePath === path
            ? openFilePaths[openFilePaths.length - 1]
            : current.activeFilePath,
      };
    });
  }, []);

  const runSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (!snapshot) {
        return;
      }
      const results = await workspaceApi.searchFiles(snapshot, query);
      setSearchResults(results);
    },
    [snapshot],
  );

  const controlTask = useCallback(
    async (action: "pause" | "resume" | "cancel") => {
      if (!snapshot) {
        return;
      }
      if (!snapshot.task.id) {
        return;
      }
      const result = await workspaceApi.controlTask(snapshot.task.id, action);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              task: { ...current.task, status: result.status },
              sessions: current.sessions.map((session) =>
                session.id === current.activeSessionId
                  ? {
                      ...session,
                      status: sessionStatusForTask(result.status),
                    }
                  : session,
              ),
            }
          : current,
      );
    },
    [snapshot],
  );

  const decideChange = useCallback(
    async (changeId: string, decision: FileChange["decision"]) => {
      await workspaceApi.decideChange(changeId, decision);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              changes: current.changes.map((change) =>
                change.id === changeId ? { ...change, decision } : change,
              ),
            }
          : current,
      );
    },
    [],
  );

  const rollbackTask = useCallback(async () => {
    if (!snapshot) {
      return;
    }

    await workspaceApi.rollbackTask(snapshot.task.id);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            task: { ...current.task, status: "CANCELLED" },
            sessions: current.sessions.map((session) =>
              session.id === current.activeSessionId
                ? { ...session, status: "cancelled" }
                : session,
            ),
            changes: current.changes.map((change) => ({
              ...change,
              decision: "rejected",
            })),
          }
        : current,
    );
  }, [snapshot]);

  const value = useMemo(
    () => ({
      snapshot,
      loading,
      error,
      activePanel,
      activeFileLine,
      searchOpen,
      searchQuery,
      searchResults,
      importProject,
      selectProject,
      selectSession,
      createSession,
      sendMessage,
      openFile,
      closeFile,
      setActivePanel,
      setSearchOpen,
      setSearchQuery,
      runSearch,
      controlTask,
      decideChange,
      rollbackTask,
    }),
    [
      snapshot,
      loading,
      error,
      activePanel,
      activeFileLine,
      searchOpen,
      searchQuery,
      searchResults,
      importProject,
      selectProject,
      selectSession,
      createSession,
      sendMessage,
      openFile,
      closeFile,
      runSearch,
      controlTask,
      decideChange,
      rollbackTask,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }
  return value;
}

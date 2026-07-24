import type { WorkspaceEvent } from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "");

export const workspaceEvents = {
  subscribe(
    taskId: string,
    onEvent: (event: WorkspaceEvent) => void,
    onError?: () => void,
  ) {
    if (!API_BASE_URL) {
      return () => undefined;
    }

    const source = new EventSource(
      `${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/events`,
    );

    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as WorkspaceEvent);
      } catch {
        onError?.();
      }
    };
    source.onerror = () => onError?.();

    return () => source.close();
  },
};

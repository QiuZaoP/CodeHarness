import type { WorkspaceEvent } from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "");
const eventTypes: WorkspaceEvent["type"][] = [
  "task.created",
  "task.state_changed",
  "task.plan.updated",
  "tool.started",
  "tool.completed",
  "task.completed",
  "task.failed",
  "task.waiting_user",
  "task.paused",
];

export const workspaceEvents = {
  subscribe(
    taskId: string,
    onEvent: (event: WorkspaceEvent) => void,
    onError?: () => void,
  ) {
    if (!API_BASE_URL) {
      return () => undefined;
    }

    let source: EventSource | null = null;
    let closed = false;
    let lastEventId = 0;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;

    const connect = () => {
      if (closed) {
        return;
      }

      const after = lastEventId ? `?after=${lastEventId}` : "";
      source = new EventSource(
        `${API_BASE_URL}/api/v1/tasks/${encodeURIComponent(taskId)}/events${after}`,
      );

      const handleEvent = (message: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(message.data) as Record<string, unknown>;
          const id = Number(message.lastEventId || payload.id || 0);
          if (id && id <= lastEventId) {
            return;
          }
          lastEventId = Math.max(lastEventId, id);
          const { taskId: eventTaskId, timestamp, ...eventPayload } = payload;
          onEvent({
            id,
            taskId: String(eventTaskId || taskId),
            type: message.type as WorkspaceEvent["type"],
            timestamp: String(timestamp || new Date().toISOString()),
            payload: eventPayload,
          });
          reconnectAttempt = 0;
        } catch {
          onError?.();
        }
      };

      eventTypes.forEach((type) => source?.addEventListener(type, handleEvent));
      source.onerror = () => {
        source?.close();
        onError?.();
        if (closed) {
          return;
        }
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  },
};

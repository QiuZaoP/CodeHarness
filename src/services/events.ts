import type { WorkspaceEvent } from '../types';

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '');
const eventTypes: WorkspaceEvent['type'][] = [
  'task.created',
  'task.state_changed',
  'task.plan.updated',
  'tool.started',
  'tool.completed',
  'task.completed',
  'task.failed',
  'task.waiting_user',
  'task.paused',
  'task.resumed',
  'task.cancelled',
  'task.applied',
  'verification.completed',
  'change.updated',
  'harness.decision'
];

export function createWorkspaceEvents(apiBaseUrl = configuredApiBaseUrl) {
  return {
    subscribe(taskId: string, onEvent: (event: WorkspaceEvent) => void, onError?: () => void) {
      if (!apiBaseUrl) {
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

        const after = lastEventId ? `?after=${lastEventId}` : '';
        source = new EventSource(
          `${apiBaseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/events${after}`
        );

        const handleEvent = (message: MessageEvent<string>) => {
          try {
            const envelope = JSON.parse(message.data) as Partial<WorkspaceEvent>;
            if (
              envelope.schemaVersion !== '1.0.0' ||
              !envelope.type ||
              !eventTypes.includes(envelope.type) ||
              typeof envelope.payload !== 'object' ||
              envelope.payload === null
            ) {
              throw new Error('Unsupported task event envelope');
            }
            const id = Number(message.lastEventId || envelope.id || 0);
            if (id && id <= lastEventId) {
              return;
            }
            lastEventId = Math.max(lastEventId, id);
            onEvent({
              schemaVersion: envelope.schemaVersion,
              id,
              taskId: String(envelope.taskId || taskId),
              type: envelope.type,
              timestamp: String(envelope.timestamp || new Date().toISOString()),
              payload: envelope.payload
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
          const timeout = Math.min(1000 * 2 ** reconnectAttempt, 10000);
          reconnectAttempt += 1;
          reconnectTimer = window.setTimeout(connect, timeout);
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
    }
  };
}

export const workspaceEvents = createWorkspaceEvents();

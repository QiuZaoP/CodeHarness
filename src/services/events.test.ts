import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceEvent } from '../types';
import { createWorkspaceEvents } from './events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, (message: MessageEvent<string>) => void>();
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }

  close() {}

  emit(type: string, event: WorkspaceEvent) {
    this.listeners.get(type)?.(
      new MessageEvent(type, {
        data: JSON.stringify(event),
        lastEventId: String(event.id)
      })
    );
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('workspaceEvents', () => {
  it('preserves the frozen SSE envelope and nested payload', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const received: WorkspaceEvent[] = [];
    const unsubscribe = createWorkspaceEvents('http://api.test').subscribe('task-1', (event) =>
      received.push(event)
    );
    const source = FakeEventSource.instances[0];
    const event: WorkspaceEvent = {
      schemaVersion: '1.0.0',
      id: 7,
      taskId: 'task-1',
      type: 'task.state_changed',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { from: 'PLANNING', to: 'EXECUTING' }
    };

    source?.emit(event.type, event);
    source?.emit(event.type, event);
    unsubscribe();

    expect(source?.url).toBe('http://api.test/api/v1/tasks/task-1/events');
    expect(received).toEqual([event]);
  });

  it('rejects unsupported schema versions', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const onError = vi.fn();
    createWorkspaceEvents('http://api.test').subscribe('task-1', onEvent, onError);
    const source = FakeEventSource.instances[0];
    const invalid = {
      schemaVersion: '2.0.0',
      id: 1,
      taskId: 'task-1',
      type: 'task.created',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {}
    };

    source?.listeners.get('task.created')?.(
      new MessageEvent('task.created', { data: JSON.stringify(invalid) })
    );

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
});

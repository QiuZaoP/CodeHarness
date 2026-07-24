import type { TaskEvent } from './types.js';

type Listener = (event: TaskEvent) => void;

export class EventBroker {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(taskId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(taskId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(taskId);
    };
  }

  publish(event: TaskEvent): void {
    this.listeners.get(event.taskId)?.forEach((listener) => listener(event));
  }
}

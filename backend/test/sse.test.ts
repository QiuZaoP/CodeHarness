import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { eventCursor, SseConnection, serializeEvent } from '../src/sse.js';
import type { TaskEvent } from '../src/types.js';

const event = (id: number): TaskEvent => ({
  schemaVersion: '1.0.0',
  id,
  taskId: '06bf418f-22f0-4e9e-902a-a2f5aca06160',
  type: 'task.created',
  timestamp: '2026-07-24T00:00:00.000Z',
  payload: { goal: 'Inspect fixture' }
});

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  readonly destroy = vi.fn();
  blockNextWrite = false;

  write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    if (!this.blockNextWrite) return true;
    this.blockNextWrite = false;
    return false;
  };
}

describe('SSE transport', () => {
  it('parses reconnect cursors and prefers the explicit query cursor', () => {
    expect(eventCursor(undefined, undefined)).toBe(0);
    expect(eventCursor(undefined, '42')).toBe(42);
    expect(eventCursor(7, '42')).toBe(7);
    expect(() => eventCursor(undefined, '-1')).toThrow(
      'Event cursor must be a non-negative integer'
    );
  });

  it('serializes envelopes, deduplicates IDs, sends heartbeats, and drains in order', () => {
    const response = new FakeResponse();
    response.blockNextWrite = true;
    const stream = new SseConnection(response, 0, 10);

    stream.sendEvent(event(1));
    stream.sendEvent(event(1));
    stream.sendEvent(event(2));
    stream.sendHeartbeat();
    expect(response.chunks).toEqual([serializeEvent(event(1))]);

    response.emit('drain');
    expect(response.chunks).toEqual([
      serializeEvent(event(1)),
      serializeEvent(event(2)),
      ': keep-alive\n\n'
    ]);
    expect(stream.cursor).toBe(2);
  });

  it('disconnects a slow client instead of growing an unbounded queue', () => {
    const response = new FakeResponse();
    response.blockNextWrite = true;
    const stream = new SseConnection(response, 0, 1);

    stream.sendEvent(event(1));
    stream.sendEvent(event(2));
    stream.sendEvent(event(3));

    expect(stream.isClosed).toBe(true);
    expect(response.destroy).toHaveBeenCalledOnce();
  });
});

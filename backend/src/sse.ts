import { AppError } from './errors.js';
import type { TaskEvent } from './types.js';

interface WritableResponse {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
  destroy(error?: Error): unknown;
}

export function eventCursor(queryAfter: number | undefined, lastEventId: unknown): number {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const raw = queryAfter ?? header ?? 0;
  const after = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Event cursor must be a non-negative integer',
      { after: raw },
      400
    );
  }
  return after;
}

export function serializeEvent(event: TaskEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseConnection {
  private readonly pending: string[] = [];
  private blocked = false;
  private closed = false;
  private cursorValue: number;

  constructor(
    private readonly response: WritableResponse,
    initialCursor: number,
    private readonly maxPendingEvents: number
  ) {
    this.cursorValue = initialCursor;
  }

  get cursor(): number {
    return this.cursorValue;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  sendEvent(event: TaskEvent): void {
    if (this.closed || event.id <= this.cursorValue) return;
    this.cursorValue = event.id;
    this.enqueue(serializeEvent(event));
  }

  sendHeartbeat(): void {
    if (!this.closed) this.enqueue(': keep-alive\n\n');
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
  }

  private enqueue(chunk: string): void {
    if (!this.blocked && this.pending.length === 0) {
      if (!this.response.write(chunk)) {
        this.blocked = true;
        this.response.once('drain', () => this.flush());
      }
      return;
    }
    this.pending.push(chunk);
    if (this.pending.length > this.maxPendingEvents) {
      this.close();
      this.response.destroy(new Error('SSE client exceeded the pending event limit'));
    }
  }

  private flush(): void {
    if (this.closed) return;
    this.blocked = false;
    while (this.pending.length > 0) {
      const chunk = this.pending.shift()!;
      if (!this.response.write(chunk)) {
        this.blocked = true;
        this.response.once('drain', () => this.flush());
        return;
      }
    }
  }
}

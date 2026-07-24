import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { AppDatabase } from './db.js';
import { AppError } from './errors.js';
import type { HarnessRunner } from './harness.js';
import type { StoredTask, TaskStatus } from './types.js';

interface ActiveRun {
  controller: AbortController;
  completion: Promise<void>;
}

export interface TaskSchedulerOptions {
  ownerId?: string;
  leaseTtlMs?: number;
  controlPollMs?: number;
  onBackgroundError?: (error: unknown) => void;
}

const runningStatuses: readonly TaskStatus[] = [
  'CREATED',
  'PRECHECKING',
  'PLANNING',
  'EXECUTING',
  'VERIFYING'
];

export class TaskScheduler {
  private readonly active = new Map<string, ActiveRun>();
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly controlPollMs: number;
  private readonly onBackgroundError: (error: unknown) => void;
  private recoveryTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly harness: HarnessRunner,
    options: TaskSchedulerOptions = {}
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? config.taskLeaseTtlMs;
    this.controlPollMs = Math.min(
      options.controlPollMs ?? config.taskControlPollMs,
      Math.max(1, Math.floor(this.leaseTtlMs / 3))
    );
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  recoverInterrupted(): StoredTask[] {
    const recovered: StoredTask[] = [];
    const now = new Date().toISOString();
    for (const task of this.database.getTasksByStatus(runningStatuses)) {
      if (this.active.has(task.id)) continue;
      const lease = this.database.getTaskLease(task.id);
      if (task.status === 'CREATED' && !lease) continue;
      if (lease && lease.expiresAt > now) continue;
      if (lease) this.database.releaseExpiredTaskLease(task.id, now);
      if (task.controlRequest === 'CANCEL') recovered.push(this.harness.cancel(task.id));
      else {
        recovered.push(
          this.harness.pauseInterrupted(task.id, 'Execution interrupted; resume is required')
        );
      }
    }
    return recovered;
  }

  startRecoveryMonitor(): void {
    if (this.recoveryTimer) return;
    const intervalMs = Math.min(this.leaseTtlMs, 1_000);
    this.recoveryTimer = setInterval(() => {
      if (this.closing) return;
      try {
        this.recoverInterrupted();
      } catch (error) {
        this.onBackgroundError(error);
      }
    }, intervalMs);
    this.recoveryTimer.unref();
  }

  start(taskId: string): StoredTask {
    this.assertOpen();
    const task = this.requireTask(taskId);
    if (task.status !== 'CREATED') {
      throw new AppError(
        'CONFLICT',
        'Only a newly created task can be started',
        { taskId, status: task.status },
        409
      );
    }
    this.acquire(taskId);
    this.launch(taskId);
    return task;
  }

  resume(taskId: string): StoredTask {
    this.assertOpen();
    const task = this.requireTask(taskId);
    if (!['PAUSED', 'WAITING_USER'].includes(task.status) || !task.resumeStatus) {
      throw new AppError(
        'CONFLICT',
        'Task does not have a resumable checkpoint',
        { taskId, status: task.status },
        409
      );
    }
    this.acquire(taskId);
    try {
      const resumed = this.harness.resume(taskId);
      this.launch(taskId);
      return resumed;
    } catch (error) {
      this.database.releaseTaskLease(taskId, this.ownerId);
      throw error;
    }
  }

  async pause(taskId: string): Promise<StoredTask> {
    return this.requestRunningControl(taskId, 'PAUSE');
  }

  async cancel(taskId: string): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    if (
      runningStatuses.includes(task.status) &&
      (this.active.has(taskId) || this.database.getTaskLease(taskId))
    ) {
      return this.requestRunningControl(taskId, 'CANCEL');
    }
    return this.harness.cancel(taskId);
  }

  async apply(taskId: string): Promise<StoredTask> {
    this.assertInactive(taskId);
    return this.harness.apply(taskId);
  }

  async rollback(taskId: string): Promise<StoredTask> {
    this.assertInactive(taskId);
    return this.harness.rollback(taskId);
  }

  async waitForIdle(taskId: string): Promise<void> {
    await this.active.get(taskId)?.completion;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    const active = [...this.active.values()];
    for (const { controller } of active) {
      if (!controller.signal.aborted)
        controller.abort(this.controlError('PAUSE', 'Service stopped'));
    }
    await Promise.all(active.map(({ completion }) => completion));
  }

  private launch(taskId: string): void {
    const controller = new AbortController();
    const active: ActiveRun = { controller, completion: Promise.resolve() };
    active.completion = Promise.resolve()
      .then(() => this.runWithLease(taskId, controller))
      .catch((error) => this.onBackgroundError(error))
      .finally(() => {
        if (this.active.get(taskId) === active) this.active.delete(taskId);
      });
    this.active.set(taskId, active);
  }

  private async runWithLease(taskId: string, controller: AbortController): Promise<void> {
    const pulse = () => {
      if (controller.signal.aborted) return;
      try {
        const task = this.database.getTask(taskId);
        if (task?.controlRequest) {
          controller.abort(this.controlError(task.controlRequest));
          return;
        }
        const now = Date.now();
        const renewed = this.database.renewTaskLease(
          taskId,
          this.ownerId,
          new Date(now).toISOString(),
          new Date(now + this.leaseTtlMs).toISOString()
        );
        if (!renewed) {
          controller.abort(this.controlError('PAUSE', 'Task lease was lost'));
        }
      } catch (error) {
        this.onBackgroundError(error);
        controller.abort(this.controlError('PAUSE', 'Task lease renewal failed'));
      }
    };
    const timer = setInterval(pulse, this.controlPollMs);
    timer.unref();
    try {
      await this.harness.run(taskId, controller.signal);
    } finally {
      clearInterval(timer);
      this.database.releaseTaskLease(taskId, this.ownerId);
    }
  }

  private async requestRunningControl(
    taskId: string,
    control: NonNullable<StoredTask['controlRequest']>
  ): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    if (
      !runningStatuses.includes(task.status) ||
      (!this.active.has(taskId) && !this.database.getTaskLease(taskId))
    ) {
      throw new AppError(
        'CONFLICT',
        `Task cannot be ${control === 'PAUSE' ? 'paused' : 'cancelled'} from ${task.status}`,
        { taskId, status: task.status },
        409
      );
    }
    this.database.requestTaskControl(taskId, control, new Date().toISOString());
    const active = this.active.get(taskId);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(this.controlError(control));
      await active.completion;
    }
    return this.requireTask(taskId);
  }

  private acquire(taskId: string): void {
    const now = Date.now();
    const lease = this.database.acquireTaskLease(
      taskId,
      this.ownerId,
      new Date(now).toISOString(),
      new Date(now + this.leaseTtlMs).toISOString()
    );
    if (!lease) {
      throw new AppError('CONFLICT', 'Task already has an active runner', { taskId }, 409);
    }
  }

  private assertInactive(taskId: string): void {
    const task = this.requireTask(taskId);
    if (
      (task.status !== 'CREATED' && runningStatuses.includes(task.status)) ||
      this.database.getTaskLease(taskId)
    ) {
      throw new AppError('CONFLICT', 'Task is still running', { taskId, status: task.status }, 409);
    }
  }

  private requireTask(taskId: string): StoredTask {
    const task = this.database.getTask(taskId);
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', { taskId }, 404);
    return task;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new AppError('CONFLICT', 'Task scheduler is shutting down', undefined, 409);
    }
  }

  private controlError(
    control: NonNullable<StoredTask['controlRequest']>,
    message = control === 'PAUSE' ? 'Pause requested' : 'Cancellation requested'
  ): AppError {
    return new AppError('TASK_CANCELLED', message, { control }, 409);
  }
}

export const taskSchedulerRunningStatuses = runningStatuses;

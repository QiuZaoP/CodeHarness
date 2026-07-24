import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { AppError } from './errors.js';
import {
  getAppliedMigrations,
  runDatabaseMigrations,
  type AppliedMigration
} from './database/migrator.js';
import type { ProjectRecord, SessionRecord, TaskRunCheckpoint } from './database/records.js';
import {
  AuditRepository,
  type StoredAuditRecord
} from './database/repositories/audit-repository.js';
import { EventRepository, type NewTaskEvent } from './database/repositories/event-repository.js';
import { ProjectRepository } from './database/repositories/project-repository.js';
import { SessionRepository } from './database/repositories/session-repository.js';
import { SnapshotRepository } from './database/repositories/snapshot-repository.js';
import { TaskRepository, type TaskPatch } from './database/repositories/task-repository.js';
import { TaskLeaseRepository } from './database/repositories/task-lease-repository.js';
import { TaskRunRepository } from './database/repositories/task-run-repository.js';
import { TaskStepRepository } from './database/repositories/task-step-repository.js';
import { ToolCallRepository } from './database/repositories/tool-call-repository.js';
import { VerificationRepository } from './database/repositories/verification-repository.js';
import type {
  Message,
  StoredTask,
  TaskLease,
  TaskStatus,
  TaskEvent,
  ToolCallRecord,
  ToolResult,
  VerificationResult,
  WorkspaceSnapshot
} from './types.js';

export type { ProjectRecord, SessionRecord, TaskRunCheckpoint } from './database/records.js';

export type TaskEventDraft = Omit<NewTaskEvent, 'taskId'>;

export interface TaskTransitionInput {
  taskId: string;
  expectedVersion: number;
  patch: TaskPatch;
  events: TaskEventDraft[];
  audit: {
    id: string;
    action: string;
    actorId?: string;
    timestamp: string;
  };
}

export interface TaskTransitionResult {
  task: StoredTask;
  events: TaskEvent[];
}

export class AppDatabase {
  readonly connection: Database.Database;
  private readonly projects: ProjectRepository;
  private readonly sessions: SessionRepository;
  private readonly tasks: TaskRepository;
  private readonly events: EventRepository;
  private readonly audits: AuditRepository;
  private readonly taskSteps: TaskStepRepository;
  private readonly taskLeases: TaskLeaseRepository;
  private readonly taskRuns: TaskRunRepository;
  private readonly toolCalls: ToolCallRepository;
  private readonly verifications: VerificationRepository;
  private readonly snapshots: SnapshotRepository;

  constructor(databasePath = config.databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.connection = new Database(databasePath);
    try {
      this.connection.pragma('foreign_keys = ON');
      this.connection.pragma('journal_mode = WAL');
      this.connection.pragma('busy_timeout = 5000');
      runDatabaseMigrations(this.connection);
    } catch (error) {
      this.connection.close();
      throw error;
    }
    this.projects = new ProjectRepository(this.connection);
    this.sessions = new SessionRepository(this.connection);
    this.tasks = new TaskRepository(this.connection);
    this.events = new EventRepository(this.connection);
    this.audits = new AuditRepository(this.connection);
    this.taskSteps = new TaskStepRepository(this.connection);
    this.taskLeases = new TaskLeaseRepository(this.connection);
    this.taskRuns = new TaskRunRepository(this.connection);
    this.toolCalls = new ToolCallRepository(this.connection);
    this.verifications = new VerificationRepository(this.connection);
    this.snapshots = new SnapshotRepository(this.connection);
  }

  close(): void {
    this.connection.close();
  }

  getSchemaVersion(): number {
    return this.connection.pragma('user_version', { simple: true }) as number;
  }

  getAppliedMigrations(): AppliedMigration[] {
    return getAppliedMigrations(this.connection);
  }

  createProject(record: ProjectRecord): void {
    this.projects.create(record);
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.projects.findById(id);
  }

  createSession(record: SessionRecord): void {
    this.sessions.create(record);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.sessions.findById(id);
  }

  createMessage(message: Message): void {
    this.sessions.createMessage(message);
  }

  getMessages(sessionId: string): Message[] {
    return this.sessions.listMessages(sessionId);
  }

  createTaskWithEvent(
    task: StoredTask,
    event: TaskEventDraft,
    auditId: string,
    baseline?: WorkspaceSnapshot
  ): TaskTransitionResult {
    if (task.version !== 1) {
      throw new AppError('VALIDATION_ERROR', 'A new task must start at version 1', {
        version: task.version
      });
    }
    return this.writeTransaction(() => {
      this.tasks.create(task);
      if (baseline) this.snapshots.create(baseline);
      if (task.plan) this.taskSteps.replaceForTask(task.id, task.plan.steps, task.createdAt);
      const storedEvent = this.events.create({ ...event, taskId: task.id });
      this.audits.create({
        id: auditId,
        taskId: task.id,
        action: 'task.created',
        resourceType: 'task',
        resourceId: task.id,
        after: { status: task.status, version: task.version },
        timestamp: event.timestamp
      });
      return { task, events: [storedEvent] };
    });
  }

  getTask(id: string): StoredTask | undefined {
    return this.tasks.findById(id);
  }

  getTasksByStatus(statuses: readonly TaskStatus[]): StoredTask[] {
    return this.tasks.listByStatuses(statuses);
  }

  acquireTaskLease(
    taskId: string,
    ownerId: string,
    acquiredAt: string,
    expiresAt: string
  ): TaskLease | undefined {
    return this.writeTransaction(() => {
      if (!this.tasks.findById(taskId)) {
        throw new AppError('NOT_FOUND', 'Task not found', { taskId }, 404);
      }
      return this.taskLeases.acquire(taskId, ownerId, acquiredAt, expiresAt);
    });
  }

  renewTaskLease(
    taskId: string,
    ownerId: string,
    renewedAt: string,
    expiresAt: string
  ): TaskLease | undefined {
    return this.writeTransaction(() =>
      this.taskLeases.renew(taskId, ownerId, renewedAt, expiresAt)
    );
  }

  getTaskLease(taskId: string): TaskLease | undefined {
    return this.taskLeases.find(taskId);
  }

  createTaskRun(checkpoint: TaskRunCheckpoint): void {
    this.writeTransaction(() => {
      if (!this.tasks.findById(checkpoint.taskId)) {
        throw new AppError('NOT_FOUND', 'Task not found', { taskId: checkpoint.taskId }, 404);
      }
      if (checkpoint.version !== 1) {
        throw new AppError('VALIDATION_ERROR', 'A new task run must start at version 1', {
          version: checkpoint.version
        });
      }
      this.taskRuns.create(checkpoint);
    });
  }

  getTaskRun(taskId: string): TaskRunCheckpoint | undefined {
    return this.taskRuns.findByTask(taskId);
  }

  updateTaskRun(checkpoint: TaskRunCheckpoint, expectedVersion: number): TaskRunCheckpoint {
    return this.writeTransaction(() => this.taskRuns.update(checkpoint, expectedVersion));
  }

  requestTaskControl(
    taskId: string,
    controlRequest: NonNullable<StoredTask['controlRequest']>,
    timestamp: string
  ): StoredTask {
    const task = this.tasks.findById(taskId);
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', { taskId }, 404);
    return this.transitionTask({
      taskId,
      expectedVersion: task.version,
      patch: { controlRequest },
      events: [],
      audit: {
        id: randomUUID(),
        action: 'task.control_requested',
        timestamp
      }
    }).task;
  }

  releaseTaskLease(taskId: string, ownerId: string): boolean {
    return this.writeTransaction(() => this.taskLeases.release(taskId, ownerId));
  }

  releaseExpiredTaskLease(taskId: string, now: string): boolean {
    return this.writeTransaction(() => this.taskLeases.releaseExpired(taskId, now));
  }

  getWorkspaceSnapshots(taskId: string): WorkspaceSnapshot[] {
    return this.snapshots.listByTask(taskId);
  }

  recordWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
    this.writeTransaction(() => this.snapshots.create(snapshot));
  }

  transitionTask(input: TaskTransitionInput): TaskTransitionResult {
    return this.writeTransaction(() => {
      const before = this.tasks.findById(input.taskId);
      if (!before) {
        throw new AppError('NOT_FOUND', 'Task not found', { taskId: input.taskId }, 404);
      }
      const task = this.tasks.update(
        input.taskId,
        input.expectedVersion,
        input.patch,
        input.audit.timestamp
      );
      if (Object.hasOwn(input.patch, 'plan')) {
        this.taskSteps.replaceForTask(
          task.id,
          input.patch.plan?.steps ?? [],
          input.audit.timestamp
        );
      }
      const events = input.events.map((event) =>
        this.events.create({ ...event, taskId: input.taskId })
      );
      this.audits.create({
        id: input.audit.id,
        taskId: task.id,
        actorId: input.audit.actorId,
        action: input.audit.action,
        resourceType: 'task',
        resourceId: task.id,
        before: {
          status: before.status,
          version: before.version,
          plan: before.plan,
          stopReason: before.stopReason,
          resumeStatus: before.resumeStatus,
          controlRequest: before.controlRequest
        },
        after: {
          status: task.status,
          version: task.version,
          plan: task.plan,
          stopReason: task.stopReason,
          resumeStatus: task.resumeStatus,
          controlRequest: task.controlRequest
        },
        timestamp: input.audit.timestamp
      });
      return { task, events };
    });
  }

  addEvent(event: NewTaskEvent): TaskEvent {
    return this.writeTransaction(() => this.events.create(event));
  }

  getEvents(taskId: string, afterId = 0): TaskEvent[] {
    return this.events.listByTask(taskId, afterId);
  }

  getAuditRecords(resourceType: string, resourceId: string): StoredAuditRecord[] {
    return this.audits.listForResource(resourceType, resourceId);
  }

  startToolCall(record: ToolCallRecord, event: TaskEventDraft): TaskEvent {
    return this.writeTransaction(() => {
      this.toolCalls.create(record);
      this.audits.create({
        id: randomUUID(),
        taskId: record.taskId,
        action: 'tool.started',
        resourceType: 'tool_call',
        resourceId: record.id,
        after: { name: record.tool.name, status: record.status },
        timestamp: record.startedAt
      });
      return this.events.create({ ...event, taskId: record.taskId });
    });
  }

  completeToolCall(
    toolCallId: string,
    taskId: string,
    result: ToolResult,
    finishedAt: string,
    event: TaskEventDraft
  ): TaskEvent {
    return this.writeTransaction(() => {
      this.toolCalls.complete(toolCallId, taskId, result, finishedAt);
      this.audits.create({
        id: randomUUID(),
        taskId,
        action: 'tool.completed',
        resourceType: 'tool_call',
        resourceId: toolCallId,
        before: { status: 'RUNNING' },
        after: {
          status: result.status,
          affectedFiles: result.affectedFiles,
          durationMs: result.durationMs,
          errorCode: result.error?.code
        },
        timestamp: finishedAt
      });
      return this.events.create({ ...event, taskId });
    });
  }

  getToolCalls(taskId: string): ToolCallRecord[] {
    return this.toolCalls.listByTask(taskId);
  }

  recordVerification(result: VerificationResult, event: TaskEventDraft): TaskEvent {
    return this.writeTransaction(() => {
      this.verifications.create(result);
      return this.events.create({ ...event, taskId: result.taskId });
    });
  }

  getVerificationResults(taskId: string): VerificationResult[] {
    return this.verifications.listByTask(taskId);
  }

  private writeTransaction<T>(operation: () => T): T {
    return this.connection.transaction(operation).immediate();
  }
}

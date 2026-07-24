import { randomUUID } from 'node:crypto';
import type { EventBroker } from './broker.js';
import type { CommandOutput } from './command-runner.js';
import { config } from './config.js';
import type { AppDatabase, TaskEventDraft } from './db.js';
import { AppError } from './errors.js';
import type { ToolRegistrationPort } from './ports/tool-registry.js';
import { taskStateMachine } from './state-machine.js';
import type {
  StoredTask,
  TaskPlan,
  TaskStatus,
  ToolCall,
  VerificationResult,
  WorkspaceSnapshot
} from './types.js';
import type { WorkspaceManager } from './workspace.js';

export interface HarnessDependencies {
  database: AppDatabase;
  broker: EventBroker;
  workspaceManager: WorkspaceManager;
  tools: ToolRegistrationPort;
}

interface LifecyclePatch {
  plan?: TaskPlan | null;
  stopReason?: string | null;
  resumeStatus?: StoredTask['resumeStatus'] | null;
  controlRequest?: StoredTask['controlRequest'] | null;
}

export class HarnessRunner {
  constructor(private readonly dependencies: HarnessDependencies) {}

  async createTask(projectId: string, sessionId: string, goal: string): Promise<StoredTask> {
    const { database } = this.dependencies;
    const project = database.getProject(projectId);
    const session = database.getSession(sessionId);
    if (!project || !session || session.projectId !== projectId) {
      throw new AppError(
        'NOT_FOUND',
        'Project or session not found',
        { projectId, sessionId },
        404
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const createdWorkspace = await this.dependencies.workspaceManager.createTaskWorkspace(
      projectId,
      id,
      project.sourcePath
    );
    const task: StoredTask = {
      id,
      projectId,
      sessionId,
      goal,
      status: 'CREATED',
      workspacePath: createdWorkspace.workspacePath,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    let result;
    try {
      result = database.createTaskWithEvent(
        task,
        { type: 'task.created', timestamp: now, payload: { goal } },
        randomUUID(),
        createdWorkspace.baseline
      );
    } catch (error) {
      await this.dependencies.workspaceManager.removeTask(id);
      throw error;
    }
    this.publishEvents(result.events);
    return result.task;
  }

  async run(taskId: string, signal?: AbortSignal): Promise<StoredTask> {
    let task = this.requireTask(taskId);
    try {
      if (task.status === 'CREATED') {
        this.throwIfStopped(task.id, signal);
        task = this.transition(task, 'PRECHECKING');
      }
      if (task.status === 'PRECHECKING') {
        this.throwIfStopped(task.id, signal);
        const plan = this.makeMockPlan(task.goal);
        task = this.transition(task, 'PLANNING', { plan }, [
          { type: 'task.plan.updated', payload: { plan } }
        ]);
      }
      if (task.status === 'PLANNING') {
        this.throwIfStopped(task.id, signal);
        const plan = task.plan ?? this.makeMockPlan(task.goal);
        task = this.transition(
          task,
          'EXECUTING',
          task.plan ? {} : { plan },
          task.plan ? [] : [{ type: 'task.plan.updated', payload: { plan } }]
        );
      }
      if (task.status === 'EXECUTING') {
        this.throwIfStopped(task.id, signal);
        const files = await this.callTool<string[]>(
          task,
          { name: 'list_files', arguments: { path: '.' } },
          signal
        );
        this.throwIfStopped(task.id, signal);
        const readme = files.find((file) => file.toLowerCase().endsWith('readme.md'));
        if (readme) {
          await this.callTool(task, { name: 'read_file', arguments: { path: readme } }, signal);
        }
        this.throwIfStopped(task.id, signal);
        task = this.transition(this.requireTask(task.id), 'VERIFYING');
      }
      if (task.status === 'VERIFYING') {
        this.throwIfStopped(task.id, signal);
        task = await this.verify(task, signal);
      }
      if (task.status !== 'READY_FOR_REVIEW') {
        throw new AppError(
          'CONFLICT',
          `Task cannot run from ${task.status}`,
          { taskId, status: task.status },
          409
        );
      }
      return task;
    } catch (error) {
      const current = this.requireTask(taskId);
      const control = this.abortedControl(signal) ?? current.controlRequest;
      if (control === 'PAUSE' && !taskStateMachine.isTerminal(current.status)) {
        return this.pauseInterrupted(taskId, 'Paused by user');
      }
      if (control === 'CANCEL' && !taskStateMachine.isTerminal(current.status)) {
        return this.cancel(taskId);
      }
      if (
        !taskStateMachine.isTerminal(current.status) &&
        current.status !== 'PAUSED' &&
        current.status !== 'WAITING_USER'
      ) {
        const stopReason = error instanceof Error ? error.message : String(error);
        this.transition(
          current,
          'FAILED',
          { stopReason, resumeStatus: null, controlRequest: null },
          [{ type: 'task.failed', payload: { message: stopReason } }]
        );
      }
      throw error;
    }
  }

  getTask(taskId: string): StoredTask {
    return this.requireTask(taskId);
  }

  pauseInterrupted(taskId: string, reason: string): StoredTask {
    const task = this.requireTask(taskId);
    const resumeStatus = taskStateMachine.pauseResumeTarget(task.status);
    return this.transition(
      task,
      'PAUSED',
      { stopReason: reason, resumeStatus, controlRequest: null },
      [{ type: 'task.paused', payload: { status: 'PAUSED' } }]
    );
  }

  resume(taskId: string): StoredTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'PAUSED' || !task.resumeStatus) {
      throw new AppError(
        'CONFLICT',
        'Task does not have a resumable checkpoint',
        { taskId, status: task.status },
        409
      );
    }
    const status = task.resumeStatus;
    return this.transition(
      task,
      status,
      { stopReason: null, resumeStatus: null, controlRequest: null },
      [{ type: 'task.resumed', payload: { status } }]
    );
  }

  cancel(taskId: string, reason = 'Cancelled by user'): StoredTask {
    const task = this.requireTask(taskId);
    return this.transition(
      task,
      'CANCELLED',
      { stopReason: reason, resumeStatus: null, controlRequest: null },
      [{ type: 'task.cancelled', payload: { reason } }]
    );
  }

  apply(taskId: string): StoredTask {
    const task = this.requireTask(taskId);
    return this.transition(
      task,
      'APPLIED',
      { stopReason: null, resumeStatus: null, controlRequest: null },
      [{ type: 'task.applied', payload: { changeCount: 0 } }]
    );
  }

  async rollback(taskId: string): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    const baseline = this.dependencies.database
      .getWorkspaceSnapshots(task.id)
      .find((snapshot) => snapshot.kind === 'BASELINE');
    if (!baseline) throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot does not exist');
    await this.dependencies.workspaceManager.rollback(task.id, task.workspacePath, baseline);
    return this.cancel(taskId, 'Workspace rolled back by user');
  }

  async checkpoint(
    taskId: string,
    kind: Exclude<WorkspaceSnapshot['kind'], 'BASELINE'> = 'CHECKPOINT'
  ): Promise<WorkspaceSnapshot> {
    const task = this.requireTask(taskId);
    const snapshot = await this.dependencies.workspaceManager.createCheckpoint(
      task.id,
      task.workspacePath,
      kind
    );
    try {
      this.dependencies.database.recordWorkspaceSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      await this.dependencies.workspaceManager.removeSnapshot(task.id, snapshot.id);
      throw error;
    }
  }

  private transition(
    task: StoredTask,
    status: TaskStatus,
    patch: LifecyclePatch = {},
    additionalEvents: Array<Omit<TaskEventDraft, 'timestamp'>> = []
  ): StoredTask {
    taskStateMachine.assertTransition(task.status, status);
    const timestamp = new Date().toISOString();
    const taskPatch: Parameters<AppDatabase['transitionTask']>[0]['patch'] = { status };
    if (Object.hasOwn(patch, 'plan')) taskPatch.plan = patch.plan;
    if (Object.hasOwn(patch, 'stopReason')) taskPatch.stopReason = patch.stopReason;
    if (Object.hasOwn(patch, 'resumeStatus')) taskPatch.resumeStatus = patch.resumeStatus;
    if (Object.hasOwn(patch, 'controlRequest')) taskPatch.controlRequest = patch.controlRequest;
    const result = this.dependencies.database.transitionTask({
      taskId: task.id,
      expectedVersion: task.version,
      patch: taskPatch,
      events: [
        {
          type: 'task.state_changed',
          timestamp,
          payload: { from: task.status, to: status }
        },
        ...additionalEvents.map((event) => ({ ...event, timestamp }))
      ],
      audit: {
        id: randomUUID(),
        action: 'task.state_changed',
        timestamp
      }
    });
    this.publishEvents(result.events);
    return result.task;
  }

  private async callTool<T>(task: StoredTask, tool: ToolCall, signal?: AbortSignal): Promise<T> {
    const permissions = ['READ', 'WRITE', 'COMMAND'] as const;
    this.dependencies.tools.validate(tool, permissions);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const startedEvent = this.dependencies.database.startToolCall(
      {
        id,
        taskId: task.id,
        tool,
        status: 'RUNNING',
        startedAt
      },
      {
        type: 'tool.started',
        timestamp: startedAt,
        payload: { toolName: tool.name, arguments: this.safeArguments(tool.arguments) }
      }
    );
    this.dependencies.broker.publish(startedEvent);
    const result = await this.dependencies.tools.execute(tool, {
      workspacePath: task.workspacePath,
      permissions,
      signal
    });
    const finishedAt = new Date().toISOString();
    const completedEvent = this.dependencies.database.completeToolCall(
      id,
      task.id,
      result,
      finishedAt,
      {
        type: 'tool.completed',
        timestamp: finishedAt,
        payload:
          result.status === 'SUCCEEDED'
            ? { toolName: tool.name, result: this.summary(result.output) }
            : { toolName: tool.name, error: result.error?.message ?? result.status }
      }
    );
    this.dependencies.broker.publish(completedEvent);
    if (result.status !== 'SUCCEEDED') {
      throw new AppError(
        result.error?.code ?? 'WORKSPACE_ERROR',
        result.error?.message ?? 'Tool execution failed',
        result.error?.details,
        result.status === 'CANCELLED' ? 409 : 400
      );
    }
    return result.output as T;
  }

  private async verify(task: StoredTask, signal?: AbortSignal): Promise<StoredTask> {
    const verification = await this.callTool<CommandOutput>(
      task,
      {
        name: 'run_command',
        arguments: { executable: 'node', args: ['--version'] }
      },
      signal
    );
    this.throwIfStopped(task.id, signal);
    const verificationResult: VerificationResult = {
      id: randomUUID(),
      taskId: task.id,
      command: 'node --version',
      status: verification.code === 0 ? 'PASSED' : 'FAILED',
      exitCode: verification.code,
      outputSummary: `${verification.stdout}\n${verification.stderr}`.trim().slice(0, 4000),
      failureCategory: verification.code === 0 ? undefined : 'ENVIRONMENT',
      createdAt: new Date().toISOString()
    };
    const verificationEvent = this.dependencies.database.recordVerification(verificationResult, {
      type: 'verification.completed',
      timestamp: verificationResult.createdAt,
      payload: { verification: verificationResult }
    });
    this.dependencies.broker.publish(verificationEvent);
    if (verification.code !== 0) {
      throw new AppError('WORKSPACE_ERROR', 'Verification command failed', verification);
    }
    return this.transition(this.requireTask(task.id), 'READY_FOR_REVIEW', {}, [
      {
        type: 'task.completed',
        payload: { verification: { command: 'node --version', code: verification.code } }
      }
    ]);
  }

  private makeMockPlan(goal: string): TaskPlan {
    return {
      goal,
      assumptions: ['首期使用 Mock 模型与文本索引'],
      steps: [
        { id: 'inspect', title: '检查项目文件', status: 'PENDING' },
        { id: 'verify', title: '执行基础验证', status: 'PENDING' }
      ],
      verification: ['node --version']
    };
  }

  private requireTask(taskId: string): StoredTask {
    const task = this.dependencies.database.getTask(taskId);
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', { taskId }, 404);
    return task;
  }

  private publishEvents(events: readonly Parameters<EventBroker['publish']>[0][]): void {
    events.forEach((event) => this.dependencies.broker.publish(event));
  }

  private throwIfStopped(taskId: string, signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw (
        signal.reason ??
        new AppError('TASK_CANCELLED', 'Task execution was cancelled', undefined, 409)
      );
    }
    const control = this.dependencies.database.getTask(taskId)?.controlRequest;
    if (control) {
      throw new AppError('TASK_CANCELLED', 'Task control was requested', { control }, 409);
    }
  }

  private abortedControl(signal?: AbortSignal): StoredTask['controlRequest'] | undefined {
    if (!signal?.aborted || !(signal.reason instanceof AppError)) return undefined;
    const details =
      typeof signal.reason.details === 'object' && signal.reason.details !== null
        ? signal.reason.details
        : undefined;
    if (!details || !('control' in details)) return undefined;
    const control = (details as { control?: unknown }).control;
    return control === 'PAUSE' || control === 'CANCEL' ? control : undefined;
  }

  private summary(value: unknown): unknown {
    if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 20) };
    if (typeof value === 'string') return value.slice(0, 1000);
    return value;
  }

  private safeArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(arguments_).map(([key, value]) => {
        if (key === 'content') {
          return [
            key,
            {
              omitted: true,
              bytes: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : undefined
            }
          ];
        }
        if (key === 'edits' && Array.isArray(value)) return [key, { count: value.length }];
        return [key, value];
      })
    );
  }
}

export const defaultHarnessLimits = { maxSteps: config.maxTaskSteps };

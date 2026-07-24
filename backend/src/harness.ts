import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import type { EventBroker } from './broker.js';
import type { AppDatabase } from './db.js';
import { assertTransition } from './state-machine.js';
import type { TaskPlan, StoredTask, TaskStatus } from './types.js';
import type { ToolExecutor } from './tools.js';
import type { WorkspaceManager } from './workspace.js';
import { config } from './config.js';

export interface HarnessDependencies {
  database: AppDatabase;
  broker: EventBroker;
  workspaceManager: WorkspaceManager;
  tools: ToolExecutor;
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
    const task: StoredTask = {
      id,
      projectId,
      sessionId,
      goal,
      status: 'CREATED',
      workspacePath: project.workspacePath,
      createdAt: now,
      updatedAt: now
    };
    database.createTask(task);
    this.publish(task, 'task.created', { goal });
    return task;
  }

  async run(taskId: string): Promise<StoredTask> {
    const { tools } = this.dependencies;
    let task = this.requireTask(taskId);
    try {
      task = this.transition(task, 'PRECHECKING');
      const plan = this.makeMockPlan(task.goal);
      task = this.transition(task, 'PLANNING', { plan });
      this.publish(task, 'task.plan.updated', { plan });
      task = this.transition(task, 'EXECUTING');

      const files = await this.callTool(task, 'list_files', () =>
        tools.listFiles(task.workspacePath)
      );
      const readme = files.find((file) => file.toLowerCase().endsWith('readme.md'));
      if (readme)
        await this.callTool(task, 'read_file', () => tools.readFile(task.workspacePath, readme));

      task = this.transition(task, 'VERIFYING');
      const verification = await this.callTool(task, 'run_command', () =>
        tools.runCommand(task.workspacePath, 'node --version')
      );
      if (verification.code !== 0)
        throw new AppError('WORKSPACE_ERROR', 'Verification command failed', verification);
      task = this.transition(task, 'READY_FOR_REVIEW');
      this.publish(task, 'task.completed', {
        verification: { command: 'node --version', code: verification.code }
      });
      return task;
    } catch (error) {
      const current = this.requireTask(taskId);
      if (current.status !== 'FAILED' && current.status !== 'CANCELLED') {
        task = this.transition(current, 'FAILED', {
          stopReason: error instanceof Error ? error.message : String(error)
        });
        this.publish(task, 'task.failed', { message: task.stopReason });
      }
      throw error;
    }
  }

  getTask(taskId: string): StoredTask {
    return this.requireTask(taskId);
  }

  pause(taskId: string): StoredTask {
    return this.changeStatus(taskId, 'PAUSED');
  }

  cancel(taskId: string): StoredTask {
    return this.changeStatus(taskId, 'CANCELLED', 'Cancelled by user');
  }

  async rollback(taskId: string): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    await this.dependencies.workspaceManager.rollback(task.projectId, task.workspacePath);
    return this.changeStatus(taskId, 'CANCELLED', 'Workspace rolled back by user');
  }

  private changeStatus(taskId: string, status: TaskStatus, stopReason?: string): StoredTask {
    const task = this.requireTask(taskId);
    const next = this.transition(task, status, { stopReason });
    if (status === 'PAUSED') this.publish(next, 'task.paused', { status });
    if (status === 'CANCELLED') {
      this.publish(next, 'task.cancelled', {
        reason: stopReason ?? 'Cancelled by user'
      });
    }
    return next;
  }

  private transition(
    task: StoredTask,
    status: TaskStatus,
    patch: Partial<StoredTask> = {}
  ): StoredTask {
    assertTransition(task.status, status);
    const next = this.dependencies.database.updateTask(task.id, {
      status,
      plan: patch.plan,
      stopReason: patch.stopReason
    });
    this.publish(next, 'task.state_changed', { from: task.status, to: status });
    return next;
  }

  private async callTool<T>(
    task: StoredTask,
    toolName: string,
    action: () => Promise<T>
  ): Promise<T> {
    this.publish(task, 'tool.started', { toolName });
    try {
      const result = await action();
      this.publish(task, 'tool.completed', { toolName, result: this.summary(result) });
      return result;
    } catch (error) {
      this.publish(task, 'tool.completed', {
        toolName,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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

  private publish(
    task: StoredTask,
    type: Parameters<AppDatabase['addEvent']>[0]['type'],
    payload: Record<string, unknown>
  ): void {
    const event = this.dependencies.database.addEvent({
      taskId: task.id,
      type,
      timestamp: new Date().toISOString(),
      payload
    });
    this.dependencies.broker.publish(event);
  }

  private summary(value: unknown): unknown {
    if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 20) };
    if (typeof value === 'string') return value.slice(0, 1000);
    return value;
  }
}

export const defaultHarnessLimits = { maxSteps: config.maxTaskSteps };

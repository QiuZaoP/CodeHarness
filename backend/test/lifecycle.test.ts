import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBroker } from '../src/broker.js';
import { FakeCodeIndex } from '../src/adapters/fake-code-index.js';
import { FakeModelGateway } from '../src/adapters/fake-model-gateway.js';
import { AppDatabase, type TaskEventDraft } from '../src/db.js';
import { HarnessRunner } from '../src/harness.js';
import type { ToolExecutionContext, ToolRegistrationPort } from '../src/ports/tool-registry.js';
import type { ModelGateway } from '../src/ports/model-gateway.js';
import { TaskScheduler } from '../src/task-scheduler.js';
import type { StoredTask, TaskPlan, ToolCall, ToolDefinition, ToolResult } from '../src/types.js';
import { WorkspaceManager } from '../src/workspace.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

class BlockingTools implements ToolRegistrationPort {
  readonly calls: ToolCall[] = [];
  readonly firstCallStarted: Promise<void>;
  private resolveFirstCall!: () => void;
  private blockNextList = true;

  constructor() {
    this.firstCallStarted = new Promise((resolve) => {
      this.resolveFirstCall = resolve;
    });
  }

  register(): void {}

  definitions(): ToolDefinition[] {
    return [];
  }

  validate(): void {}

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push(structuredClone(call));
    const startedAt = Date.now();
    if (call.name === 'list_files' && this.blockNextList) {
      this.blockNextList = false;
      this.resolveFirstCall();
      await new Promise<void>((resolve) => {
        if (context.signal?.aborted) resolve();
        else context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        status: 'CANCELLED',
        error: {
          code: 'TASK_CANCELLED',
          message: 'Fixture tool cancelled',
          retryable: false
        },
        affectedFiles: [],
        durationMs: Date.now() - startedAt
      };
    }
    const output =
      call.name === 'list_files'
        ? ['README.md']
        : call.name === 'run_command'
          ? {
              code: 0,
              stdout: 'v22.0.0\n',
              stderr: '',
              stdoutBytes: 9,
              stderrBytes: 0,
              truncated: false
            }
          : { path: 'README.md', content: '# Fixture\n' };
    return {
      status: 'SUCCEEDED',
      output,
      affectedFiles: [],
      durationMs: Date.now() - startedAt
    };
  }
}

interface Fixture {
  database: AppDatabase;
  harness: HarnessRunner;
  scheduler: TaskScheduler;
  task: StoredTask;
  tools: BlockingTools;
}

async function fixture(modelGateway: ModelGateway = new FakeModelGateway()): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-lifecycle-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'README.md'), '# Fixture\n');
  const database = new AppDatabase(path.join(root, 'test.sqlite'));
  const workspaceManager = new WorkspaceManager({ root: path.join(root, 'workspaces') });
  const projectId = randomUUID();
  const imported = await workspaceManager.importProject(source, projectId);
  database.createProject({
    id: projectId,
    name: 'fixture',
    sourcePath: imported.sourcePath,
    workspacePath: imported.projectPath,
    sourceMetadata: imported.metadata,
    createdAt: new Date().toISOString()
  });
  const sessionId = randomUUID();
  database.createSession({
    id: sessionId,
    projectId,
    title: 'Fixture',
    createdAt: new Date().toISOString()
  });
  const tools = new BlockingTools();
  const harness = new HarnessRunner({
    database,
    broker: new EventBroker(),
    workspaceManager,
    tools,
    modelGateway,
    codeIndex: new FakeCodeIndex({
      overview: {
        projectId,
        languages: ['Markdown'],
        entryFiles: [],
        testFiles: [],
        buildCommands: [],
        indexedFiles: 1,
        degraded: true
      }
    })
  });
  const scheduler = new TaskScheduler(database, harness, {
    ownerId: randomUUID(),
    leaseTtlMs: 2_000,
    controlPollMs: 25
  });
  const task = await harness.createTask(projectId, sessionId, 'Inspect fixture');
  cleanup.push(async () => {
    await scheduler.shutdown();
    database.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { database, harness, scheduler, task, tools };
}

function stateEvent(
  from: StoredTask['status'],
  to: StoredTask['status'],
  timestamp: string
): TaskEventDraft {
  return {
    type: 'task.state_changed',
    timestamp,
    payload: { from, to }
  };
}

describe('task lifecycle scheduler', () => {
  it('prevents duplicate runners, pauses cooperatively, and resumes from a checkpoint', async () => {
    const { database, scheduler, task, tools } = await fixture();
    expect(scheduler.start(task.id).status).toBe('CREATED');
    expect(() => scheduler.start(task.id)).toThrow('active runner');
    await tools.firstCallStarted;

    const paused = await scheduler.pause(task.id);
    expect(paused).toMatchObject({
      status: 'PAUSED',
      resumeStatus: 'EXECUTING',
      controlRequest: undefined
    });
    expect(database.getTaskLease(task.id)).toBeUndefined();
    expect(database.getToolCalls(task.id)).toEqual([
      expect.objectContaining({
        status: 'CANCELLED',
        result: expect.objectContaining({ status: 'CANCELLED' })
      })
    ]);

    expect(scheduler.resume(task.id)).toMatchObject({
      status: 'EXECUTING',
      resumeStatus: undefined
    });
    await scheduler.waitForIdle(task.id);
    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getTaskLease(task.id)).toBeUndefined();
    expect(database.getEvents(task.id).map(({ type }) => type)).toEqual(
      expect.arrayContaining(['task.paused', 'task.resumed', 'task.completed'])
    );
    expect(scheduler.apply(task.id).status).toBe('APPLIED');
    expect(database.getEvents(task.id).at(-1)?.type).toBe('task.applied');
  });

  it('cancels the active tool and preserves completion and audit records', async () => {
    const { database, scheduler, task, tools } = await fixture();
    scheduler.start(task.id);
    await tools.firstCallStarted;

    const cancelled = await scheduler.cancel(task.id);
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      stopReason: 'Cancelled by user',
      controlRequest: undefined
    });
    const [toolCall] = database.getToolCalls(task.id);
    expect(toolCall).toMatchObject({ status: 'CANCELLED' });
    expect(database.getAuditRecords('tool_call', toolCall!.id).map(({ action }) => action)).toEqual(
      ['tool.started', 'tool.completed']
    );
    expect(database.getTaskLease(task.id)).toBeUndefined();
  });

  it('recovers a lease that expires after startup into a resumable pause', async () => {
    const { database, harness, task } = await fixture();
    const plan: TaskPlan = {
      goal: task.goal,
      assumptions: [],
      steps: [{ id: 'inspect', title: 'Inspect', status: 'PENDING' }],
      verification: ['node --version']
    };
    let current = task;
    for (const [status, patch] of [
      ['PRECHECKING', {}],
      ['PLANNING', { plan }],
      ['EXECUTING', {}]
    ] as const) {
      const next = status as StoredTask['status'];
      const timestamp = new Date().toISOString();
      current = database.transitionTask({
        taskId: task.id,
        expectedVersion: current.version,
        patch: { status: next, ...patch },
        events: [stateEvent(current.status, next, timestamp)],
        audit: { id: randomUUID(), action: 'fixture.transition', timestamp }
      }).task;
    }
    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + 100);
    database.acquireTaskLease(
      task.id,
      randomUUID(),
      acquiredAt.toISOString(),
      expiresAt.toISOString()
    );
    const recoveringScheduler = new TaskScheduler(database, harness, {
      ownerId: randomUUID(),
      leaseTtlMs: 100,
      controlPollMs: 20
    });
    expect(recoveringScheduler.recoverInterrupted()).toEqual([]);
    recoveringScheduler.startRecoveryMonitor();
    const deadline = Date.now() + 1_000;
    while (database.getTask(task.id)?.status !== 'PAUSED' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await recoveringScheduler.shutdown();

    expect(database.getTask(task.id)).toMatchObject({
      id: task.id,
      status: 'PAUSED',
      resumeStatus: 'EXECUTING'
    });
    expect(database.getTaskLease(task.id)).toBeUndefined();
    expect(database.getEvents(task.id).at(-1)).toMatchObject({
      type: 'task.paused',
      payload: { status: 'PAUSED' }
    });
  });

  it('degrades a model planning failure into an inspectable waiting state', async () => {
    const { database, scheduler, task, tools } = await fixture(new FakeModelGateway([]));

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'PLANNING',
      stopReason: 'FakeModelGateway has no queued decision'
    });
    expect(database.getEvents(task.id).at(-1)).toMatchObject({
      type: 'task.waiting_user',
      payload: { message: 'FakeModelGateway has no queued decision' }
    });
    expect(database.getTaskLease(task.id)).toBeUndefined();
    expect(tools.calls).toEqual([]);
  });
});

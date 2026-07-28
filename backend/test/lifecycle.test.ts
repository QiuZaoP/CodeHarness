import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBroker } from '../src/broker.js';
import { BudgetManager } from '../src/budget-manager.js';
import { ContextManager } from '../src/context-manager.js';
import { FakeCodeIndex } from '../src/adapters/fake-code-index.js';
import { FakeModelGateway } from '../src/adapters/fake-model-gateway.js';
import { AppDatabase, type TaskEventDraft } from '../src/db.js';
import { AppError } from '../src/errors.js';
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
  private blockNextList: boolean;

  constructor(blockNextList = true) {
    this.blockNextList = blockNextList;
    this.firstCallStarted = new Promise((resolve) => {
      this.resolveFirstCall = resolve;
    });
  }

  register(): void {}

  definitions(): ToolDefinition[] {
    return [];
  }

  validate(call: ToolCall): void {
    if (call.name === 'search_symbol') {
      throw new AppError('VALIDATION_ERROR', 'Fixture tool is not registered');
    }
  }

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
              code:
                Array.isArray(call.arguments.args) && call.arguments.args.includes('--fail')
                  ? 1
                  : 0,
              stdout: 'v22.0.0\n',
              stderr:
                Array.isArray(call.arguments.args) && call.arguments.args.includes('--fail')
                  ? 'fixture failure'
                  : '',
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

class WritingTools extends BlockingTools {
  constructor() {
    super(false);
  }

  override async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name !== 'write_file') return super.execute(call, context);
    this.calls.push(structuredClone(call));
    const filePath = path.join(context.workspacePath, String(call.arguments.path));
    const content = String(call.arguments.content);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return {
      status: 'SUCCEEDED',
      output: { path: call.arguments.path, bytes: Buffer.byteLength(content) },
      affectedFiles: [String(call.arguments.path)],
      durationMs: 0
    };
  }
}

interface Fixture {
  database: AppDatabase;
  harness: HarnessRunner;
  scheduler: TaskScheduler;
  task: StoredTask;
  tools: BlockingTools;
  source: string;
}

interface FixtureOptions {
  modelGateway?: ModelGateway;
  budgetManager?: BudgetManager;
  blockFirstList?: boolean;
  tools?: BlockingTools;
}

function defaultBudgetManager(): BudgetManager {
  return new BudgetManager({
    maxSteps: 20,
    maxToolCalls: 80,
    maxDurationMs: 60_000,
    maxChangedFiles: 100,
    maxInputTokens: 120_000,
    maxOutputTokens: 16_000,
    maxCost: 10,
    maxReadBytes: 256 * 1024,
    maxVerificationRuns: 3
  });
}

function meteredModelGateway(): ModelGateway {
  const fake = new FakeModelGateway();
  return {
    decide: async (request, signal, onStreamEvent) => {
      const response = await fake.decide(request, signal, onStreamEvent);
      return {
        ...response,
        usage: { inputTokens: 7, outputTokens: 3, cost: 0.25 }
      };
    },
    summarize: async (request, signal, onStreamEvent) => {
      const response = await fake.summarize(request, signal, onStreamEvent);
      return {
        ...response,
        usage: { inputTokens: 2, outputTokens: 1, cost: 0.05 }
      };
    },
    embed: fake.embed.bind(fake)
  };
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
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
  const tools = options.tools ?? new BlockingTools(options.blockFirstList ?? true);
  const harness = new HarnessRunner({
    database,
    broker: new EventBroker(),
    workspaceManager,
    tools,
    modelGateway: options.modelGateway ?? new FakeModelGateway(),
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
    }),
    budgetManager: options.budgetManager ?? defaultBudgetManager(),
    contextManager: new ContextManager({
      maxEntries: 32,
      maxTotalBytes: 64 * 1024,
      maxEntryBytes: 16 * 1024
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
  return { database, harness, scheduler, task, tools, source };
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

const plannedTask: TaskPlan = {
  goal: 'Inspect fixture',
  assumptions: [],
  steps: [{ id: 'inspect', title: 'Inspect fixture', status: 'PENDING' }],
  verification: ['node --version']
};

function changeDecisions(filePath = 'generated.txt') {
  return [
    { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
    {
      type: 'TOOL_CALL' as const,
      reason: 'Create a reviewed file',
      tool: {
        name: 'write_file' as const,
        arguments: { path: filePath, content: 'generated\n' }
      }
    },
    { type: 'VERIFY' as const, reason: 'Verify', commands: ['node --version'] },
    { type: 'COMPLETE' as const, reason: 'Done', summary: 'Generated a file' }
  ];
}

describe('task lifecycle scheduler', () => {
  it('starts a persisted created task during recovery', async () => {
    const { database, harness, task } = await fixture({ blockFirstList: false });
    const recoveringScheduler = new TaskScheduler(database, harness, {
      ownerId: randomUUID()
    });

    expect(recoveringScheduler.recoverInterrupted()).toEqual([
      expect.objectContaining({ id: task.id, status: 'CREATED' })
    ]);
    await recoveringScheduler.waitForIdle(task.id);
    await recoveringScheduler.shutdown();

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
  });

  it('stops at precheck when the isolated workspace already contains user changes', async () => {
    const { database, scheduler, task, tools } = await fixture({ blockFirstList: false });
    await fs.writeFile(path.join(task.workspacePath, 'README.md'), '# User change\n');

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'PLANNING',
      stopReason: 'Task workspace contains changes before execution'
    });
    expect(tools.calls).toEqual([]);
  });

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
    expect((await scheduler.apply(task.id)).status).toBe('APPLIED');
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

  it('does not replay an interrupted tool with an uncertain outcome', async () => {
    const { database, scheduler, task, tools } = await fixture();
    scheduler.start(task.id);
    await tools.firstCallStarted;
    await scheduler.pause(task.id);

    const [interrupted] = database.getToolCalls(task.id);
    database.connection
      .prepare(
        "UPDATE tool_calls SET status = 'RUNNING', finished_at = NULL, result_json = NULL WHERE id = ?"
      )
      .run(interrupted!.id);

    scheduler.resume(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'list_files')).toHaveLength(1);
    expect(database.getToolCall(interrupted!.id)).toMatchObject({
      status: 'CANCELLED',
      result: {
        error: {
          message: 'Interrupted tool outcome is unknown; the call was not replayed',
          retryable: false
        }
      }
    });
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
    const { database, scheduler, task, tools } = await fixture({
      modelGateway: new FakeModelGateway([])
    });

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

  it('summarizes older history in persisted batches and reloads bounded context', async () => {
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: meteredModelGateway()
    });
    for (let index = 0; index < 14; index += 1) {
      database.createMessage({
        id: randomUUID(),
        sessionId: task.sessionId,
        role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
        content: `Unique session message ${index}`,
        createdAt: new Date(Date.now() + index).toISOString()
      });
    }

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    const checkpoint = database.getTaskRun(task.id);
    expect(checkpoint).toMatchObject({
      summarizedMessageCount: 6,
      state: {
        phase: 'READY_FOR_REVIEW',
        budget: {
          usedSteps: 6,
          usedToolCalls: 4,
          usedInputTokens: 48,
          usedOutputTokens: 21,
          usedCost: 1.65,
          usedVerificationRuns: 1
        }
      }
    });
    expect(checkpoint?.historySummary).toContain(task.goal);
    expect(checkpoint?.state.contextRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'model-summary', contentHash: expect.any(String) }),
        expect.objectContaining({
          source: 'session-message:assistant',
          contentHash: expect.any(String)
        })
      ])
    );
  });

  it('pauses before exceeding a persisted tool-call budget', async () => {
    const budgetManager = new BudgetManager({
      maxSteps: 20,
      maxToolCalls: 1,
      maxDurationMs: 60_000,
      maxChangedFiles: 100,
      maxInputTokens: 120_000,
      maxOutputTokens: 16_000,
      maxCost: 10,
      maxReadBytes: 256 * 1024,
      maxVerificationRuns: 3
    });
    const { database, scheduler, task, tools } = await fixture({
      budgetManager,
      blockFirstList: false
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'PAUSED',
      resumeStatus: 'EXECUTING',
      stopReason: 'Task budget exceeded: MAX_TOOL_CALLS'
    });
    expect(database.getTaskRun(task.id)).toMatchObject({
      state: {
        phase: 'PAUSED',
        budget: { usedToolCalls: 1, maxToolCalls: 1 }
      }
    });
    expect(tools.calls).toHaveLength(1);
    expect(database.getEvents(task.id).at(-1)).toMatchObject({
      type: 'task.paused',
      payload: { status: 'PAUSED' }
    });
    expect(database.getTaskLease(task.id)).toBeUndefined();
  });

  it('persists every decision and observation across a multi-turn run', async () => {
    const { database, scheduler, task } = await fixture({ blockFirstList: false });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    const run = database.getTaskRun(task.id);
    expect(run?.state).toMatchObject({
      phase: 'READY_FOR_REVIEW',
      turnCount: 5,
      consecutiveFailures: 0,
      activeTurn: {
        sequence: 5,
        status: 'OBSERVED',
        decision: { type: 'COMPLETE' },
        observation: { status: 'SUCCEEDED' }
      }
    });
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      expect(
        database
          .getAuditRecords('harness_turn', `${run!.runId}:${sequence}`)
          .map(({ action }) => action)
      ).toEqual(['harness.decision', 'harness.observation']);
    }
    expect(
      database
        .getEvents(task.id)
        .filter(({ type }) => type === 'harness.decision')
        .map(({ payload }) => payload.sequence)
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      database.getToolCalls(task.id).filter(({ stepId }) => stepId === 'inspect')
    ).toHaveLength(4);
  });

  it('waits for an ASK_USER decision and resumes the persisted loop', async () => {
    const modelGateway = new FakeModelGateway([
      { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
      { type: 'ASK_USER', reason: 'Need confirmation', question: 'Continue inspection?' },
      {
        type: 'TOOL_CALL',
        reason: 'Inspect files',
        tool: { name: 'list_files', arguments: { path: '.' } }
      },
      {
        type: 'TOOL_CALL',
        reason: 'Read overview',
        tool: { name: 'read_file', arguments: { path: 'README.md' } }
      },
      {
        type: 'TOOL_CALL',
        reason: 'Check status',
        tool: { name: 'git_status', arguments: {} }
      },
      { type: 'VERIFY', reason: 'Verify', commands: ['node --version'] },
      { type: 'COMPLETE', reason: 'Done', summary: 'Inspection complete' }
    ]);
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);
    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'EXECUTING',
      stopReason: 'Continue inspection?'
    });

    scheduler.resume(task.id);
    await scheduler.waitForIdle(task.id);
    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getEvents(task.id).map(({ type }) => type)).toEqual(
      expect.arrayContaining(['task.waiting_user', 'task.resumed', 'task.completed'])
    );
  });

  it('records rejected tools and stops after bounded consecutive failures', async () => {
    const rejected = {
      type: 'TOOL_CALL' as const,
      reason: 'Try unavailable tool',
      tool: { name: 'search_symbol' as const, arguments: { query: 'fixture' } }
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        rejected,
        rejected,
        rejected
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'EXECUTING',
      stopReason: 'Harness stopped after 3 consecutive failures'
    });
    expect(database.getToolCalls(task.id)).toHaveLength(3);
    expect(database.getToolCalls(task.id).every(({ status }) => status === 'FAILED')).toBe(true);
    expect(database.getTaskRun(task.id)?.state).toMatchObject({
      turnCount: 3,
      consecutiveFailures: 3,
      activeTurn: {
        status: 'OBSERVED',
        observation: {
          status: 'FAILED',
          error: { code: 'VALIDATION_ERROR', retryable: false }
        }
      }
    });
  });

  it('rejects model completion until the plan has passed verification', async () => {
    const premature = {
      type: 'COMPLETE' as const,
      reason: 'Claim completion early',
      summary: 'Done'
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        premature,
        premature,
        premature
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('WAITING_USER');
    expect(database.getVerificationResults(task.id)).toEqual([]);
    expect(database.getEvents(task.id).map(({ type }) => type)).not.toContain('task.completed');
  });

  it('rejects completion when the latest verification supersedes an earlier pass', async () => {
    const premature = {
      type: 'COMPLETE' as const,
      reason: 'Claim completion after a failure',
      summary: 'Done'
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        { type: 'VERIFY', reason: 'Initial pass', commands: ['node --version'] },
        { type: 'VERIFY', reason: 'Latest failure', commands: ['node --fail'] },
        premature,
        premature,
        premature
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('WAITING_USER');
    expect(database.getTaskRun(task.id)?.state.lastVerificationPassed).toBe(false);
    expect(database.getVerificationResults(task.id).map(({ status }) => status)).toEqual([
      'PASSED',
      'FAILED'
    ]);
    expect(database.getEvents(task.id).map(({ type }) => type)).not.toContain('task.completed');
  });

  it('persists a final Diff, reviews it, and applies accepted files safely', async () => {
    const tools = new WritingTools();
    const { database, harness, scheduler, task, source } = await fixture({
      tools,
      modelGateway: new FakeModelGateway(changeDecisions())
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getWorkspaceSnapshots(task.id).at(-1)?.kind).toBe('FINAL');
    const [change] = harness.getFileChanges(task.id);
    expect(change).toMatchObject({
      path: 'generated.txt',
      status: 'ADDED',
      additions: 1,
      deletions: 0,
      decision: 'PENDING',
      toolCallId: expect.any(String),
      stepId: 'inspect',
      version: 1
    });
    await expect(scheduler.apply(task.id)).rejects.toThrow(
      'Every file change must be accepted or rejected'
    );

    expect(
      harness.decideFileChange(task.id, change!.id, 'ACCEPTED', change!.version!)
    ).toMatchObject({
      decision: 'ACCEPTED',
      version: 2
    });
    expect(harness.getReport(task.id)).toMatchObject({
      taskId: task.id,
      changes: [expect.objectContaining({ decision: 'ACCEPTED' })],
      verifications: [expect.objectContaining({ status: 'PASSED' })],
      risks: []
    });
    expect((await scheduler.apply(task.id)).status).toBe('APPLIED');
    expect(await fs.readFile(path.join(source, 'generated.txt'), 'utf8')).toBe('generated\n');
    expect(database.getEvents(task.id).map(({ type }) => type)).toEqual(
      expect.arrayContaining(['change.updated', 'task.applied'])
    );
  });

  it('does not overwrite a source path created after the task baseline', async () => {
    const tools = new WritingTools();
    const { database, harness, scheduler, task, source } = await fixture({
      tools,
      modelGateway: new FakeModelGateway(changeDecisions('conflict.txt'))
    });
    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);
    const [change] = harness.getFileChanges(task.id);
    harness.decideFileChange(task.id, change!.id, 'ACCEPTED', change!.version!);
    await fs.writeFile(path.join(source, 'conflict.txt'), 'user content\n');

    await expect(scheduler.apply(task.id)).rejects.toThrow(
      'Added file no longer has a safe source baseline'
    );
    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(await fs.readFile(path.join(source, 'conflict.txt'), 'utf8')).toBe('user content\n');
  });
});

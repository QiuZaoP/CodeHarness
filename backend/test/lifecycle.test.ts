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
import type { DecisionRequest, ModelGateway } from '../src/ports/model-gateway.js';
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
                Array.isArray(call.arguments.args) &&
                (call.arguments.args.includes('--fail') ||
                  call.arguments.args.includes('missing.js'))
                  ? 1
                  : 0,
              stdout: 'v22.0.0\n',
              stderr:
                Array.isArray(call.arguments.args) &&
                (call.arguments.args.includes('--fail') ||
                  call.arguments.args.includes('missing.js'))
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

class ReusingReadTools extends BlockingTools {
  constructor() {
    super(false);
  }

  override definitions(): ToolDefinition[] {
    return [
      {
        name: 'read_file',
        version: '1.0.0',
        description: 'Read a file',
        permission: 'READ',
        sideEffect: false,
        defaultTimeoutMs: 5_000,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }
      }
    ];
  }
}

class PagedReadTools extends ReusingReadTools {
  override async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name !== 'read_file') return super.execute(call, context);
    this.calls.push(structuredClone(call));
    const startLine = Number(call.arguments.startLine ?? 1);
    const endLine = Math.min(350, startLine + 199);
    return {
      status: 'SUCCEEDED',
      output: {
        path: call.arguments.path,
        content: `lines ${startLine}-${endLine}`,
        lineCount: 350,
        startLine,
        endLine,
        hasMore: endLine < 350,
        numberedContent: `${startLine} | first line in range`,
        hash: 'a'.repeat(64),
        bytes: 3_500
      },
      affectedFiles: [],
      durationMs: 0
    };
  }
}

class CommandExposingTools extends BlockingTools {
  constructor() {
    super(false);
  }

  override definitions(): ToolDefinition[] {
    return [
      {
        name: 'run_command',
        version: '1.0.0',
        description: 'Run an allowlisted command',
        permission: 'COMMAND',
        sideEffect: true,
        defaultTimeoutMs: 5_000,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }
      }
    ];
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

class FailedWriteThenRecoveredTools extends BlockingTools {
  private failedOnce = false;

  override async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name !== 'write_file') return super.execute(call, context);
    this.calls.push(structuredClone(call));
    if (!this.failedOnce) {
      this.failedOnce = true;
      return {
        status: 'FAILED',
        error: {
          code: 'CONFLICT',
          message: 'Replacing an existing file requires expectedHash',
          details: { category: 'CONFLICT' },
          retryable: true
        },
        affectedFiles: [],
        durationMs: 0
      };
    }
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

class ReadingAndWritingTools extends WritingTools {
  override definitions(): ToolDefinition[] {
    return [
      {
        name: 'read_file',
        version: '1.0.0',
        description: 'Read a file',
        permission: 'READ',
        sideEffect: false,
        defaultTimeoutMs: 5_000,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }
      },
      {
        name: 'write_file',
        version: '1.0.0',
        description: 'Write a file',
        permission: 'WRITE',
        sideEffect: true,
        defaultTimeoutMs: 5_000,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }
      }
    ];
  }

  override async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name !== 'read_file') return super.execute(call, context);
    this.calls.push(structuredClone(call));
    const filePath = path.join(context.workspacePath, String(call.arguments.path));
    const content = await fs.readFile(filePath, 'utf8');
    return {
      status: 'SUCCEEDED',
      output: {
        path: call.arguments.path,
        content,
        lineCount: content.endsWith('\n')
          ? content.split('\n').length - 1
          : content.split('\n').length,
        numberedContent: content
          .split(/\r\n|\r|\n/)
          .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
          .map((line, index) => `${index + 1} | ${line}`)
          .join('\n'),
        hash: 'a'.repeat(64),
        bytes: Buffer.byteLength(content)
      },
      affectedFiles: [],
      durationMs: 0
    };
  }
}

class FailedPatchThenVerifiedTools extends BlockingTools {
  override async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name === 'apply_patch') {
      this.calls.push(structuredClone(call));
      return {
        status: 'FAILED',
        error: {
          code: 'CONFLICT',
          message: 'Patch context did not match',
          retryable: true
        },
        affectedFiles: [],
        durationMs: 0
      };
    }
    if (call.name === 'write_file') {
      this.calls.push(structuredClone(call));
      const filePath = path.join(context.workspacePath, String(call.arguments.path));
      await fs.writeFile(filePath, String(call.arguments.content));
      return {
        status: 'SUCCEEDED',
        output: { path: call.arguments.path },
        affectedFiles: [String(call.arguments.path)],
        durationMs: 0
      };
    }
    return super.execute(call, context);
  }
}

class InvalidPatchThenRecoveredTools extends BlockingTools {
  override async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name === 'read_file') {
      this.calls.push(structuredClone(call));
      return {
        status: 'SUCCEEDED',
        output: { path: call.arguments.path, content: 'original\n', hash: 'a'.repeat(64) },
        affectedFiles: [],
        durationMs: 0
      };
    }
    if (call.name === 'apply_patch') {
      this.calls.push(structuredClone(call));
      return {
        status: 'FAILED',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Patch edits overlap or address lines outside the current file',
          details: { category: 'INVALID_PATCH_EDITS' },
          retryable: false
        },
        affectedFiles: [],
        durationMs: 0
      };
    }
    if (call.name === 'write_file') {
      this.calls.push(structuredClone(call));
      const filePath = path.join(context.workspacePath, String(call.arguments.path));
      await fs.writeFile(filePath, String(call.arguments.content));
      return {
        status: 'SUCCEEDED',
        output: { path: call.arguments.path, hash: 'b'.repeat(64), bytes: 10 },
        affectedFiles: [String(call.arguments.path)],
        durationMs: 0
      };
    }
    return super.execute(call, context);
  }
}

interface Fixture {
  database: AppDatabase;
  harness: HarnessRunner;
  scheduler: TaskScheduler;
  task: StoredTask;
  tools: BlockingTools;
  source: string;
  workspaceManager: WorkspaceManager;
}

interface FixtureOptions {
  modelGateway?: ModelGateway;
  budgetManager?: BudgetManager;
  blockFirstList?: boolean;
  tools?: BlockingTools;
  goal?: string;
  emptySource?: boolean;
  indexedFiles?: number;
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
  if (!options.emptySource) await fs.writeFile(path.join(source, 'README.md'), '# Fixture\n');
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
        languages: options.emptySource ? [] : ['Markdown'],
        entryFiles: [],
        testFiles: [],
        buildCommands: [],
        indexedFiles: options.indexedFiles ?? (options.emptySource ? 0 : 1),
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
  const task = await harness.createTask(projectId, sessionId, options.goal ?? 'Inspect fixture');
  cleanup.push(async () => {
    await scheduler.shutdown();
    database.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { database, harness, scheduler, task, tools, source, workspaceManager };
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

const campusEatsGoal =
  'Create a runnable CampusEats campus food delivery MVP in an empty workspace. Implement student and merchant authentication, store and menu browsing, a single-store cart, server-side price calculation, order creation and ownership checks, legal order state transitions, menu availability, seed accounts and data, a frontend student and merchant workflow, backend API tests, and README setup instructions. Keep the project small and dependency-light.';

const campusEatsGeneratedFiles = [
  ['README.md', '# CampusEats\n\nRun the API and frontend with the documented seed accounts.\n'],
  [
    'package.json',
    '{"name":"campus-eats","private":true,"scripts":{"dev":"node backend/server.js","test":"node --test backend/test/campus-eats.test.js"}}\n'
  ],
  [
    'backend/server.js',
    "import http from 'node:http';\nimport { createApp } from './routes.js';\n\nhttp.createServer(createApp()).listen(3000);\n"
  ],
  [
    'backend/auth.js',
    'export function authenticate(user) {\n  return user?.id && user.role ? { id: user.id, role: user.role } : null;\n}\n'
  ],
  [
    'backend/database.js',
    'export const users = new Map();\nexport const stores = new Map();\nexport const orders = new Map();\n'
  ],
  [
    'backend/stores.js',
    'export function listOpenStores(stores) {\n  return [...stores.values()].filter((store) => store.isOpen);\n}\n'
  ],
  [
    'backend/orders.js',
    "export const transitions = { pending: ['accepted', 'rejected', 'cancelled'], accepted: ['preparing'], preparing: ['delivering'], delivering: ['completed'] };\n\nexport function calculateTotal(items, menu) {\n  return items.reduce((total, item) => total + menu.get(item.menuItemId).price * item.quantity, 0);\n}\n"
  ],
  [
    'backend/seed.js',
    "export const seedAccounts = [{ username: 'student@example.com', role: 'student' }, { username: 'merchant@example.com', role: 'merchant' }];\n"
  ],
  [
    'backend/routes.js',
    "export function createApp() {\n  return (_request, response) => {\n    response.writeHead(200, { 'content-type': 'application/json' });\n    response.end(JSON.stringify({ service: 'CampusEats' }));\n  };\n}\n"
  ],
  [
    'backend/test/campus-eats.test.js',
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('CampusEats acceptance scaffold is available', () => {\n  assert.equal(typeof 'student@example.com', 'string');\n});\n"
  ],
  [
    'frontend/index.html',
    '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n'
  ],
  [
    'frontend/src/main.js',
    "import { loadStores } from './api.js';\n\nloadStores().then((stores) => {\n  document.querySelector('#root').textContent = `${stores.length} stores`;\n});\n"
  ],
  [
    'frontend/src/api.js',
    "export async function loadStores() {\n  const response = await fetch('/api/stores');\n  if (!response.ok) throw new Error('Unable to load stores');\n  return response.json();\n}\n"
  ],
  [
    'frontend/src/state.js',
    'export const cart = { storeId: null, items: [] };\nexport function clearCart() { cart.storeId = null; cart.items = []; }\n'
  ],
  [
    'frontend/src/student.js',
    "export function canCancel(order) {\n  return order.status === 'pending';\n}\n"
  ],
  [
    'frontend/src/merchant.js',
    "export function nextStatuses(status) {\n  return { pending: ['accepted', 'rejected'], accepted: ['preparing'], preparing: ['delivering'], delivering: ['completed'] }[status] ?? [];\n}\n"
  ]
] as const;

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

  it('treats ASK_USER during empty-project planning as a normal waiting state', async () => {
    const question = {
      type: 'ASK_USER' as const,
      reason: 'The project requirements are underspecified',
      question: 'Which frontend framework and backend runtime should be used?'
    };
    const { database, scheduler, task, tools } = await fixture({
      emptySource: true,
      goal: '你好',
      modelGateway: new FakeModelGateway([question])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'PLANNING',
      stopReason: question.question
    });
    expect(tools.calls).toEqual([]);
  });

  it('bootstraps an empty project without repository inspection loops', async () => {
    const requests: DecisionRequest[] = [];
    const plan: TaskPlan = {
      goal: 'Create a frontend/backend project',
      assumptions: ['Use a minimal dependency-light scaffold'],
      steps: [
        { id: 'scaffold', title: 'Create the separated application scaffold', status: 'PENDING' }
      ],
      verification: ['git diff --check']
    };
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan the scaffold', plan },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Inspect before creating',
        tool: { name: 'list_files' as const, arguments: { path: '.' } }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Create the package manifest',
        tool: {
          name: 'write_file' as const,
          arguments: {
            path: 'package.json',
            content: '{"scripts":{"dev":"npm run dev:backend"}}\n'
          }
        }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Create the frontend entry',
        tool: {
          name: 'write_file' as const,
          arguments: { path: 'frontend/src/main.ts', content: 'export const app = {}\n' }
        }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Create the backend entry',
        tool: {
          name: 'write_file' as const,
          arguments: { path: 'backend/src/server.ts', content: 'export const server = {}\n' }
        }
      },
      {
        type: 'VERIFY' as const,
        reason: 'Check the generated diff',
        commands: ['git diff --check']
      },
      {
        type: 'COMPLETE' as const,
        reason: 'Scaffold is ready',
        summary: 'Created the frontend/backend scaffold'
      }
    ];
    const modelGateway = new FakeModelGateway((request, index) => {
      requests.push(structuredClone(request));
      const decision = decisions[index];
      if (!decision) throw new Error(`Unexpected model request ${index}`);
      return decision;
    });
    const tools = new ReadingAndWritingTools();
    const { database, scheduler, task } = await fixture({
      emptySource: true,
      goal: 'Create a frontend/backend project',
      tools,
      modelGateway
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getFileChanges(task.id).map(({ path: filePath }) => filePath)).toEqual(
      expect.arrayContaining(['package.json', 'frontend/src/main.ts', 'backend/src/server.ts'])
    );
    expect(tools.calls.some(({ name }) => name === 'list_files' || name === 'read_file')).toBe(
      false
    );
    expect(requests[0]?.availableTools.map(({ name }) => name)).toEqual(['write_file']);
    expect(requests[2]?.availableTools.map(({ name }) => name)).toEqual(['write_file']);
  });

  it('pauses after one correction when an empty project keeps requesting inspection', async () => {
    const plan: TaskPlan = {
      goal: 'Build a frontend/backend project',
      assumptions: [],
      steps: [{ id: 'scaffold', title: 'Create the scaffold', status: 'PENDING' }],
      verification: ['git diff --check']
    };
    const { database, scheduler, task, tools } = await fixture({
      emptySource: true,
      goal: 'Build a frontend/backend project',
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan the scaffold', plan },
        {
          type: 'TOOL_CALL',
          reason: 'Inspect the empty project',
          tool: { name: 'list_files', arguments: { path: '.' } }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Try inspection again',
          tool: { name: 'read_file', arguments: { path: 'README.md' } }
        }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'EXECUTING',
      stopReason:
        'Empty project bootstrap paused because the model repeatedly selected a tool unavailable before the first file is created'
    });
    expect(tools.calls).toEqual([]);
    expect(database.getTaskRun(task.id)?.state.budget.usedToolCalls).toBe(0);
  });

  it('does not use stale zero-file metadata when the live index already contains files', async () => {
    const requests: DecisionRequest[] = [];
    const plan: TaskPlan = {
      goal: 'Continue editing the generated project',
      assumptions: [],
      steps: [{ id: 'inspect', title: 'Inspect generated files', status: 'PENDING' }],
      verification: ['git diff --check']
    };
    const modelGateway = new FakeModelGateway((request, index) => {
      requests.push(structuredClone(request));
      return index === 0
        ? { type: 'PLAN_UPDATE', reason: 'Plan the next iteration', plan }
        : {
            type: 'ASK_USER',
            reason: 'Stop after proving normal tool availability',
            question: 'Which generated file should be changed next?'
          };
    });
    const tools = new ReadingAndWritingTools();
    const { database, scheduler, task } = await fixture({
      emptySource: true,
      indexedFiles: 1,
      tools,
      modelGateway
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getProject(task.projectId)?.sourceMetadata?.fileCount).toBe(0);
    expect(database.getTask(task.id)?.status).toBe('WAITING_USER');
    expect(requests[0]?.availableTools.map(({ name }) => name)).toEqual([
      'read_file',
      'write_file'
    ]);
    expect(requests[0]?.harnessInstruction).toBeUndefined();
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

  it('continues with recent history when optional summarization fails', async () => {
    const modelGateway = meteredModelGateway();
    modelGateway.summarize = async () => {
      throw new AppError('MODEL_ERROR', 'Model summarize failed', { category: 'PROVIDER' }, 502);
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway
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

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getTaskRun(task.id)?.historySummary).toBeUndefined();
    expect(database.getTaskRun(task.id)?.summarizedMessageCount).toBeGreaterThan(0);
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

    const checkpoint = database.getTaskRun(task.id)!;
    database.updateTaskRun(
      {
        ...checkpoint,
        startedAt: new Date(Date.now() - 2_000_000).toISOString(),
        updatedAt: new Date().toISOString()
      },
      checkpoint.version
    );
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

  it('recovers from repeated successful inspections without user intervention', async () => {
    const repeated = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the same file again',
      tool: { name: 'list_files' as const, arguments: { path: '.' } }
    };
    const requests: DecisionRequest[] = [];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        return [
          { type: 'PLAN_UPDATE' as const, reason: 'Inspect files', plan: plannedTask },
          repeated,
          repeated,
          repeated,
          repeated,
          {
            type: 'VERIFY' as const,
            reason: 'Use the cached inspection and verify',
            commands: ['node --version']
          },
          { type: 'COMPLETE' as const, reason: 'Done', summary: 'Inspection complete' }
        ][index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(
      database.getToolCalls(task.id).filter(({ tool }) => tool.name === 'list_files')
    ).toHaveLength(1);
    const firstRecovery = requests.find(({ harnessInstruction }) =>
      harnessInstruction?.includes('Automatic recovery 1')
    );
    expect(
      firstRecovery?.context.some(
        ({ reference, content }) =>
          reference.kind === 'TOOL_RESULT' &&
          reference.source === 'list_files' &&
          content.includes('Completed tool call: list_files')
      )
    ).toBe(true);
  });

  it('recovers a repeated read after a reused result without exhausting read budget', async () => {
    const read = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the parser again',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const patch = {
      type: 'TOOL_CALL' as const,
      reason: 'Apply the parser fix',
      tool: { name: 'apply_patch' as const, arguments: { path: 'README.md' } }
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Inspect files', plan: plannedTask },
        read,
        patch,
        read,
        read,
        read,
        { type: 'VERIFY', reason: 'Verify the workspace diff', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done', summary: 'Inspection complete' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(
      database.getToolCalls(task.id).filter(({ tool }) => tool.name === 'read_file')
    ).toHaveLength(1);
    expect(database.getToolCalls(task.id).some(({ tool }) => tool.name === 'git_diff')).toBe(false);
  });

  it('corrects one repeated read and continues without user intervention', async () => {
    const read = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the parser',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Inspect files', plan: plannedTask },
        read,
        read,
        {
          type: 'VERIFY',
          reason: 'Use the existing read and verify',
          commands: ['node --version']
        },
        { type: 'COMPLETE', reason: 'Done', summary: 'Inspection complete' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(
      database.getToolCalls(task.id).filter(({ tool }) => tool.name === 'read_file')
    ).toHaveLength(1);
    const runState = database.getTaskRun(task.id)?.state;
    expect(runState?.budget.usedReadBytes).toBeLessThan(1_000);
    expect(runState?.budget.usedSteps).toBe((runState?.turnCount ?? 0) + 1);
  });

  it('keeps read_file available when correcting only one repeated argument set', async () => {
    const requests: DecisionRequest[] = [];
    const firstRead = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the first file',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return [
          { type: 'PLAN_UPDATE' as const, reason: 'Inspect files', plan: plannedTask },
          firstRead,
          firstRead,
          {
            type: 'TOOL_CALL' as const,
            reason: 'Read a different project file',
            tool: { name: 'read_file' as const, arguments: { path: 'package.json' } }
          },
          {
            type: 'VERIFY' as const,
            reason: 'Verify after both reads',
            commands: ['node --version']
          },
          { type: 'COMPLETE' as const, reason: 'Done', summary: 'Inspection complete' }
        ][index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    const correctionRequest = requests.find(({ harnessInstruction }) =>
      harnessInstruction?.includes('Automatic recovery 1')
    );
    expect(correctionRequest?.availableTools.some(({ name }) => name === 'read_file')).toBe(true);
    expect(
      database
        .getToolCalls(task.id)
        .filter(({ tool }) => tool.name === 'read_file')
        .map(({ tool }) => tool.arguments)
    ).toEqual([{ path: 'README.md' }, { path: 'package.json' }]);
  });

  it('treats implicit and explicit default read ranges as the same successful call', async () => {
    const requests: DecisionRequest[] = [];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        return [
          { type: 'PLAN_UPDATE' as const, reason: 'Inspect files', plan: plannedTask },
          {
            type: 'TOOL_CALL' as const,
            reason: 'Read the fixture',
            tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
          },
          {
            type: 'TOOL_CALL' as const,
            reason: 'Read the same default range explicitly',
            tool: {
              name: 'read_file' as const,
              arguments: { path: 'README.md', startLine: 1, maxLines: 200 }
            }
          },
          {
            type: 'VERIFY' as const,
            reason: 'Use the cached default range',
            commands: ['node --version']
          },
          { type: 'COMPLETE' as const, reason: 'Done', summary: 'Inspection complete' }
        ][index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(
      database.getToolCalls(task.id).filter(({ tool }) => tool.name === 'read_file')
    ).toHaveLength(1);
    expect(
      requests.some(({ harnessInstruction }) =>
        harnessInstruction?.includes('Automatic recovery 1')
      )
    ).toBe(true);
  });

  it('restores an evicted matching tool result during repeated-read recovery', async () => {
    const requests: DecisionRequest[] = [];
    const paths = ['README.md', 'package.json', 'src/a.ts', 'src/b.ts', 'src/c.ts'];
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Inspect files', plan: plannedTask },
      ...paths.map((filePath) => ({
        type: 'TOOL_CALL' as const,
        reason: `Read ${filePath}`,
        tool: { name: 'read_file' as const, arguments: { path: filePath } }
      })),
      {
        type: 'TOOL_CALL' as const,
        reason: 'Read the first file again',
        tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
      },
      {
        type: 'VERIFY' as const,
        reason: 'Use the restored cached result',
        commands: ['node --version']
      },
      { type: 'COMPLETE' as const, reason: 'Done', summary: 'Inspection complete' }
    ];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    const recovery = requests.find(({ harnessInstruction }) =>
      harnessInstruction?.includes('Automatic recovery 1')
    );
    expect(
      recovery?.context.some(
        ({ reference, content }) =>
          reference.kind === 'TOOL_RESULT' &&
          reference.source === 'read_file' &&
          content.includes('"path":"README.md"')
      )
    ).toBe(true);
  });

  it('bounds historical tool identifiers sent to the decision model', async () => {
    const requests: DecisionRequest[] = [];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        if (index === 0) {
          return { type: 'PLAN_UPDATE', reason: 'Inspect files', plan: plannedTask };
        }
        if (index <= 14) {
          return {
            type: 'TOOL_CALL',
            reason: `Read fixture ${index}`,
            tool: { name: 'read_file', arguments: { path: `fixture-${index}.txt` } }
          };
        }
        return {
          type: 'ASK_USER',
          reason: 'Stop after inspecting the bounded request state',
          question: 'Continue?'
        };
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getToolCalls(task.id)).toHaveLength(14);
    expect(database.getTaskRun(task.id)?.state.toolCallIds).toHaveLength(14);
    expect(requests.at(-1)?.runState.toolCallIds).toHaveLength(12);
  });

  it('continues a paged file read when the model repeats the original request', async () => {
    const read = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the project file',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const tools = new PagedReadTools();
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Inspect files', plan: plannedTask },
        read,
        read,
        {
          type: 'VERIFY',
          reason: 'Verify after reading both ranges',
          commands: ['node --version']
        },
        { type: 'COMPLETE', reason: 'Done', summary: 'Inspection complete' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'read_file')).toEqual([
      { name: 'read_file', arguments: { path: 'README.md' } },
      { name: 'read_file', arguments: { path: 'README.md', startLine: 201 } }
    ]);
    expect(
      database
        .getEvents(task.id)
        .filter(({ type }) => type === 'harness.decision')
        .map(({ payload }) => payload.reason)
    ).toContain('Harness continuation: read the next unread section of the requested file');
  });

  it('bounds repeated reads without falling into a git diff loop', async () => {
    const read = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the same project file',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Inspect files', plan: plannedTask },
        read,
        read,
        read,
        read,
        {
          type: 'VERIFY',
          reason: 'Verify after the harness stopped reusing the same inspection',
          commands: ['node --version']
        },
        { type: 'COMPLETE', reason: 'Done', summary: 'Inspection complete' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'read_file')).toHaveLength(1);
    expect(tools.calls.filter(({ name }) => name === 'git_diff')).toHaveLength(0);
    expect(database.getVerificationResults(task.id)).toMatchObject([
      { command: 'node --version', status: 'PASSED' }
    ]);
  });

  it('allows a read from a previous run to rebuild context after resume', async () => {
    const read = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the parser',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      tools: new ReusingReadTools(),
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Inspect files', plan: plannedTask },
        read,
        { type: 'ASK_USER', reason: 'Pause for confirmation', question: 'Continue?' },
        read,
        { type: 'VERIFY', reason: 'Verify the resumed run', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done', summary: 'Inspection complete' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);
    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      resumeStatus: 'EXECUTING'
    });

    scheduler.resume(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'read_file')).toHaveLength(2);
    expect(database.getTask(task.id)?.stopReason).toBeUndefined();
  });

  it('breaks a rotating inspection cycle after exact read recovery is exhausted', async () => {
    const readDecisions = Array.from({ length: 5 }, (_, index) => ({
      type: 'TOOL_CALL' as const,
      reason: `Inspect range ${index + 1}`,
      tool: {
        name: 'read_file' as const,
        arguments: { path: 'README.md', startLine: index + 1 }
      }
    }));
    const completedPlan: TaskPlan = {
      ...structuredClone(plannedTask),
      steps: plannedTask.steps.map((step) => ({ ...step, status: 'DONE' as const }))
    };
    const requests: DecisionRequest[] = [];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReadingAndWritingTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        return [
          { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
          ...readDecisions,
          readDecisions[0],
          readDecisions[1],
          readDecisions[2],
          readDecisions[3],
          { type: 'PLAN_UPDATE' as const, reason: 'Inspection is complete', plan: completedPlan },
          { type: 'COMPLETE' as const, reason: 'Done', summary: 'Inspection complete' }
        ][index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(
      database.getToolCalls(task.id).filter(({ tool }) => tool.name === 'read_file')
    ).toHaveLength(5);
    const guardRequest = requests.find(({ harnessInstruction }) =>
      harnessInstruction?.includes('Automatic progress guard')
    );
    expect(guardRequest?.availableTools.some(({ name }) => name === 'read_file')).toBe(false);
    expect(guardRequest?.availableTools.some(({ name }) => name === 'write_file')).toBe(true);
  });

  it('completes a requirement-sized CampusEats generation flow in an empty project', async () => {
    const requests: DecisionRequest[] = [];
    const plan: TaskPlan = {
      goal: campusEatsGoal,
      assumptions: ['Use a compact JavaScript frontend/backend split suitable for an MVP'],
      steps: [
        {
          id: 'generate-campus-eats',
          title: 'Generate the CampusEats backend, frontend, tests, seed data, and documentation',
          status: 'PENDING'
        }
      ],
      verification: [
        'Backend and frontend entry files are syntactically valid',
        'The generated backend test passes'
      ]
    };
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan the CampusEats MVP', plan },
      ...campusEatsGeneratedFiles.slice(0, 8).map(([filePath, content]) => ({
        type: 'TOOL_CALL' as const,
        reason: `Create ${filePath}`,
        tool: { name: 'write_file' as const, arguments: { path: filePath, content } }
      })),
      {
        type: 'TOOL_CALL' as const,
        reason: 'Confirm the generated package scripts before finishing the remaining modules',
        tool: { name: 'read_file' as const, arguments: { path: 'package.json' } }
      },
      ...campusEatsGeneratedFiles.slice(8).map(([filePath, content]) => ({
        type: 'TOOL_CALL' as const,
        reason: `Create ${filePath}`,
        tool: { name: 'write_file' as const, arguments: { path: filePath, content } }
      })),
      {
        type: 'VERIFY' as const,
        reason: 'Validate the generated CampusEats entry files and test',
        commands: [
          'node --check backend/server.js',
          'node --check frontend/src/main.js',
          'node --test backend/test/campus-eats.test.js'
        ]
      },
      {
        type: 'COMPLETE' as const,
        reason: 'CampusEats scaffold and acceptance checks are complete',
        summary: 'Generated and verified the CampusEats MVP scaffold'
      }
    ];
    const tools = new ReadingAndWritingTools();
    const { database, scheduler, task } = await fixture({
      goal: campusEatsGoal,
      emptySource: true,
      blockFirstList: false,
      tools,
      budgetManager: new BudgetManager({
        maxSteps: 32,
        maxToolCalls: 80,
        maxDurationMs: 60_000,
        maxChangedFiles: 100,
        maxInputTokens: 120_000,
        maxOutputTokens: 16_000,
        maxCost: 10,
        maxReadBytes: 256 * 1024,
        maxVerificationRuns: 4
      }),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'READY_FOR_REVIEW',
      stopReason: undefined
    });
    expect(tools.calls.filter(({ name }) => name === 'write_file')).toHaveLength(
      campusEatsGeneratedFiles.length
    );
    expect(tools.calls.filter(({ name }) => name === 'read_file')).toEqual([
      expect.objectContaining({ arguments: { path: 'package.json' } })
    ]);
    expect(
      database
        .getFileChanges(task.id)
        .map(({ path: filePath }) => filePath)
        .sort()
    ).toEqual(campusEatsGeneratedFiles.map(([filePath]) => filePath).sort());
    expect(database.getVerificationResults(task.id)).toMatchObject([
      { command: 'node --check backend/server.js', status: 'PASSED' },
      { command: 'node --check frontend/src/main.js', status: 'PASSED' },
      { command: 'node --test backend/test/campus-eats.test.js', status: 'PASSED' }
    ]);
    expect(
      requests.some(({ harnessInstruction }) =>
        harnessInstruction?.includes('Automatic progress guard')
      )
    ).toBe(false);
  });

  it('invalidates a reusable read after a successful workspace write', async () => {
    const tools = new ReadingAndWritingTools();
    const read = {
      type: 'TOOL_CALL' as const,
      reason: 'Read the current file',
      tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
    };
    const { database, scheduler, task } = await fixture({
      goal: 'Update README.md',
      blockFirstList: false,
      tools,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan the update', plan: plannedTask },
        read,
        {
          type: 'TOOL_CALL',
          reason: 'Update the file',
          tool: {
            name: 'write_file',
            arguments: { path: 'README.md', content: '# Updated\n' }
          }
        },
        read,
        { type: 'VERIFY', reason: 'Verify', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done', summary: 'README updated' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'read_file')).toHaveLength(2);
    const readResults = database
      .getToolCalls(task.id)
      .filter(({ tool }) => tool.name === 'read_file')
      .map(({ result }) => result?.output);
    expect(readResults).toEqual([
      expect.objectContaining({ content: '# Fixture\n' }),
      expect.objectContaining({ content: '# Updated\n' })
    ]);
  });

  it('lets repeated patch decisions reach the patch conflict check', async () => {
    const repeatedPatch = {
      type: 'TOOL_CALL' as const,
      reason: 'Apply the same patch again',
      tool: {
        name: 'apply_patch' as const,
        arguments: {
          path: 'README.md',
          expectedHash: 'fixture-hash',
          edits: [{ startLine: 1, deleteCount: 0, lines: ['# Changed'] }]
        }
      }
    };
    const premature = { type: 'COMPLETE' as const, reason: 'Finish', summary: 'Done' };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        repeatedPatch,
        repeatedPatch,
        premature,
        premature,
        premature
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      stopReason: 'Harness stopped after 3 consecutive failures'
    });
    expect(
      database.getToolCalls(task.id).filter(({ tool }) => tool.name === 'apply_patch')
    ).toHaveLength(2);
  });

  it('falls back to a safe verification command after repeated invalid commands', async () => {
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        { type: 'VERIFY', reason: 'Read the changed file', commands: ['cat tests/conftest.py'] },
        { type: 'VERIFY', reason: 'Read the changed file', commands: ['cat tests/conftest.py'] },
        { type: 'COMPLETE', reason: 'Fallback verification passed', summary: 'Done' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toEqual([
      expect.objectContaining({ command: 'node --version', status: 'PASSED' })
    ]);
    expect(tools.calls.filter(({ name }) => name === 'run_command')).toHaveLength(1);
  });

  it('retries a rejected verification command with policy feedback', async () => {
    const completedPlan: TaskPlan = {
      ...plannedTask,
      steps: [{ id: 'inspect', title: 'Inspect fixture', status: 'DONE' }]
    };
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: completedPlan },
        { type: 'VERIFY', reason: 'Read a file', commands: ['cat tests/conftest.py'] },
        { type: 'VERIFY', reason: 'Run the test suite', commands: ['python -m pytest -v'] },
        { type: 'COMPLETE', reason: 'Verification passed', summary: 'Done' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({ status: 'READY_FOR_REVIEW' });
    expect(database.getVerificationResults(task.id)).toHaveLength(1);
  });

  it('resets the failure window when a user resumes a bounded failure pause', async () => {
    const rejected = {
      type: 'TOOL_CALL' as const,
      reason: 'Try unavailable tool',
      tool: { name: 'search_symbol' as const, arguments: { query: 'fixture' } }
    };
    const { database, harness, scheduler, task } = await fixture({
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
    expect(database.getTaskRun(task.id)?.state.consecutiveFailures).toBe(3);

    const checkpoint = database.getTaskRun(task.id)!;
    database.updateTaskRun(
      {
        ...checkpoint,
        state: {
          ...checkpoint.state,
          budget: { ...checkpoint.state.budget, usedVerificationRuns: 3 }
        },
        updatedAt: new Date().toISOString()
      },
      checkpoint.version
    );

    expect(harness.resume(task.id)).toMatchObject({ status: 'EXECUTING' });
    expect(database.getTaskRun(task.id)?.state.consecutiveFailures).toBe(0);
    expect(database.getTaskRun(task.id)?.state.budget).toMatchObject({
      usedSteps: 0,
      usedToolCalls: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      usedCost: 0,
      usedReadBytes: 0,
      usedVerificationRuns: 0
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

  it('completes a read-only task after its plan is done without a shell verification', async () => {
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        {
          type: 'PLAN_UPDATE',
          reason: 'Plan the repository report',
          plan: {
            ...plannedTask,
            steps: [{ id: 'report', title: 'Prepare the report', status: 'DONE' }],
            verification: ['Check the collected repository context']
          }
        },
        { type: 'COMPLETE', reason: 'Report is ready', summary: 'Repository report complete' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getMessages(task.sessionId).at(-1)).toMatchObject({
      role: 'ASSISTANT',
      content: 'Repository report complete'
    });
    expect(database.getEvents(task.id).at(-1)).toMatchObject({
      type: 'task.completed',
      payload: {
        verification: { command: 'read-only task: no verification command', code: 0 }
      }
    });
  });

  it.each(['Create a frontend/backend project', '创建一个前后端分离项目'])(
    'rejects a creation task completion when no workspace changes were produced: %s',
    async (goal) => {
      const premature = {
        type: 'COMPLETE' as const,
        reason: 'Claim completion without creating files',
        summary: 'The project is complete'
      };
      const { database, scheduler, task } = await fixture({
        goal,
        blockFirstList: false,
        modelGateway: new FakeModelGateway([
          {
            type: 'PLAN_UPDATE',
            reason: 'Plan the refactor',
            plan: {
              ...plannedTask,
              steps: [{ id: 'create', title: 'Create the project', status: 'DONE' }]
            }
          },
          premature,
          premature,
          premature
        ])
      });

      scheduler.start(task.id);
      await scheduler.waitForIdle(task.id);

      expect(database.getTask(task.id)?.status).toBe('WAITING_USER');
      expect(database.getEvents(task.id).map(({ type }) => type)).not.toContain('task.completed');
      expect(database.getFileChanges(task.id)).toEqual([]);
    }
  );

  it('completes a changed task after a failed patch when a later command verifies the real diff', async () => {
    const tools = new FailedPatchThenVerifiedTools(false);
    const { database, scheduler, task } = await fixture({
      goal: '在test_qa.py最前面加注释，解释文件的作用',
      blockFirstList: false,
      tools,
      modelGateway: new FakeModelGateway([
        {
          type: 'PLAN_UPDATE',
          reason: 'Plan the comment update',
          plan: {
            ...plannedTask,
            steps: [{ id: 'comment', title: 'Add the file comment', status: 'PENDING' }]
          }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Inspect the target file',
          tool: { name: 'read_file', arguments: { path: 'test_qa.py' } }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Apply the requested comment',
          tool: { name: 'apply_patch', arguments: { path: 'test_qa.py' } }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Write the corrected file after the patch conflict',
          tool: { name: 'write_file', arguments: { path: 'test_qa.py', content: '# comment\n' } }
        },
        {
          type: 'PLAN_UPDATE',
          reason: 'The requested file change is now applied; mark the edit step complete',
          plan: {
            ...plannedTask,
            steps: [{ id: 'comment', title: 'Add the file comment', status: 'DONE' }]
          }
        },
        {
          type: 'VERIFY',
          reason: 'Verify the changed workspace',
          commands: ['git diff --check']
        },
        { type: 'COMPLETE', reason: 'The change is verified', summary: 'Comment added' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toMatchObject([
      { command: 'git diff --check', status: 'PASSED', exitCode: 0 }
    ]);
    expect(database.getFileChanges(task.id)).toEqual([
      expect.objectContaining({ path: 'test_qa.py', decision: 'PENDING' })
    ]);
    expect(tools.calls.map(({ name }) => name)).toEqual([
      'read_file',
      'apply_patch',
      'write_file',
      'run_command'
    ]);
  });

  it('normalizes model command tool calls into tracked verification', async () => {
    const requests: DecisionRequest[] = [];
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Run an informational command',
        tool: {
          name: 'run_command' as const,
          arguments: { executable: 'node', args: ['--version'] }
        }
      },
      { type: 'COMPLETE' as const, reason: 'Complete after verification', summary: 'Done' }
    ];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new CommandExposingTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toEqual([
      expect.objectContaining({ command: 'node --version', status: 'PASSED' })
    ]);
    expect(
      requests.every(({ availableTools }) =>
        availableTools.every(({ name }) => name !== 'run_command')
      )
    ).toBe(true);
  });

  it('stops repeating an identical write after a write conflict and recovers with new content', async () => {
    const requests: DecisionRequest[] = [];
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Create the project file',
        tool: { name: 'write_file' as const, arguments: { path: 'package.json', content: '{}' } }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Retry the project file write',
        tool: { name: 'write_file' as const, arguments: { path: 'package.json', content: '{}' } }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Write the corrected project file',
        tool: {
          name: 'write_file' as const,
          arguments: { path: 'package.json', content: '{"name":"fixture"}\n' }
        }
      },
      { type: 'PLAN_UPDATE' as const, reason: 'Mark the write complete', plan: plannedTask },
      {
        type: 'VERIFY' as const,
        reason: 'Verify the changed workspace',
        commands: ['node --version']
      },
      {
        type: 'COMPLETE' as const,
        reason: 'Done',
        summary: 'The project file was recovered and verified'
      }
    ];
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      tools: new FailedWriteThenRecoveredTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'write_file')).toHaveLength(2);
    expect(tools.calls.map(({ name }) => name)).toEqual([
      'write_file',
      'write_file',
      'run_command'
    ]);
    expect(database.getToolCalls(task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: expect.objectContaining({ name: 'write_file' }),
          status: 'FAILED',
          result: expect.objectContaining({ error: expect.objectContaining({ code: 'CONFLICT' }) })
        })
      ])
    );
    expect(
      requests.some(({ harnessInstruction }) =>
        harnessInstruction?.includes('previous write_file for package.json failed')
      )
    ).toBe(true);
  });

  it('routes a disallowed model command through verification correction', async () => {
    const requests: DecisionRequest[] = [];
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Use an unsupported package command',
        tool: {
          name: 'run_command' as const,
          arguments: { executable: 'npm', args: ['exec'] }
        }
      },
      {
        type: 'VERIFY' as const,
        reason: 'Use the allowed runtime check',
        commands: ['node --version']
      },
      { type: 'COMPLETE' as const, reason: 'Complete after verification', summary: 'Done' }
    ];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new CommandExposingTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toEqual([
      expect.objectContaining({ command: 'node --version', status: 'PASSED' })
    ]);
    expect(
      requests.some(({ harnessInstruction }) =>
        harnessInstruction?.includes('previous VERIFY decision was rejected by the command policy')
      )
    ).toBe(true);
  });

  it('advances only the current plan step after an interim verification', async () => {
    const stagedPlan: TaskPlan = {
      ...plannedTask,
      steps: [
        { id: 'baseline', title: 'Run the baseline tests', status: 'PENDING' },
        { id: 'implement', title: 'Implement the requested change', status: 'PENDING' },
        { id: 'final', title: 'Run final verification', status: 'PENDING' }
      ]
    };
    const { database, scheduler, task } = await fixture({
      goal: 'Modify the parser after establishing a baseline',
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: stagedPlan },
        { type: 'VERIFY', reason: 'Run the requested baseline', commands: ['node --version'] },
        { type: 'ASK_USER', reason: 'Inspect state', question: 'Continue?' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)).toMatchObject({
      status: 'WAITING_USER',
      plan: {
        steps: [
          { id: 'baseline', status: 'DONE' },
          { id: 'implement', status: 'RUNNING' },
          { id: 'final', status: 'PENDING' }
        ]
      }
    });
  });

  it('reuses a passed verification when the workspace has not changed', async () => {
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        { type: 'VERIFY', reason: 'Verify the task', commands: ['node --version'] },
        { type: 'VERIFY', reason: 'Repeat the same verification', commands: ['node --version'] },
        { type: 'VERIFY', reason: 'Repeat it again', commands: ['node --version'] },
        { type: 'VERIFY', reason: 'Repeat it once more', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done', summary: 'Verified' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toHaveLength(1);
    expect(tools.calls.filter(({ name }) => name === 'run_command')).toHaveLength(1);
  });

  it('keeps raw read content out of persisted model state while retaining line numbers', async () => {
    const requests: DecisionRequest[] = [];
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Read the fixture',
        tool: { name: 'read_file' as const, arguments: { path: 'README.md' } }
      },
      { type: 'COMPLETE' as const, reason: 'Claim completion', summary: 'Done' },
      { type: 'COMPLETE' as const, reason: 'Claim completion again', summary: 'Done' },
      { type: 'COMPLETE' as const, reason: 'Claim completion again', summary: 'Done' }
    ];
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new ReadingAndWritingTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    const compactContextRequest = requests.find(({ context }) =>
      context.some(({ content }) => content.includes('numberedContent'))
    );
    const observedReadRequest = requests.find(
      ({ runState }) =>
        runState.activeTurn?.status === 'OBSERVED' &&
        runState.activeTurn.decision.type === 'TOOL_CALL' &&
        runState.activeTurn.decision.tool.name === 'read_file'
    );
    expect(compactContextRequest).toBeDefined();
    expect(
      compactContextRequest?.context.some(({ content }) => content.includes('"content":'))
    ).toBe(false);
    expect(observedReadRequest?.runState.activeTurn?.observation?.summary).toContain(
      'contentOmitted'
    );
    expect(observedReadRequest?.runState.activeTurn?.observation?.summary).not.toContain(
      'numberedContent'
    );
    expect(database.getTask(task.id)?.status).toBe('WAITING_USER');
  });

  it('reruns a passed verification after a later file write', async () => {
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      tools: new WritingTools(),
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        { type: 'VERIFY', reason: 'Verify the initial workspace', commands: ['node --version'] },
        {
          type: 'TOOL_CALL',
          reason: 'Make a later file change',
          tool: { name: 'write_file', arguments: { path: 'generated.txt', content: 'changed\n' } }
        },
        { type: 'VERIFY', reason: 'Verify after the write', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done', summary: 'Verified after the write' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toHaveLength(2);
    expect(tools.calls.filter(({ name }) => name === 'run_command')).toHaveLength(2);
  });

  it('does not execute an identical successful write twice', async () => {
    const requests: DecisionRequest[] = [];
    const decisions = [
      { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Create the generated file',
        tool: {
          name: 'write_file' as const,
          arguments: { path: 'generated.txt', content: 'changed\n' }
        }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Repeat the generated file write',
        tool: {
          name: 'write_file' as const,
          arguments: { path: 'generated.txt', content: 'changed\n' }
        }
      },
      {
        type: 'VERIFY' as const,
        reason: 'Verify the generated file',
        commands: ['node --version']
      },
      { type: 'COMPLETE' as const, reason: 'Done', summary: 'Generated file verified' }
    ];
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      tools: new WritingTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'write_file')).toHaveLength(1);
    expect(tools.calls.map(({ name }) => name)).toEqual(['write_file', 'run_command']);
    expect(
      requests.some(({ harnessInstruction }) =>
        harnessInstruction?.includes('Automatic write recovery 1')
      )
    ).toBe(true);
  });

  it('recovers from multiple identical successful writes without a git diff loop', async () => {
    const requests: DecisionRequest[] = [];
    const write = {
      type: 'TOOL_CALL' as const,
      reason: 'Create the generated file',
      tool: {
        name: 'write_file' as const,
        arguments: { path: 'generated.txt', content: 'changed\n' }
      }
    };
    const { database, scheduler, task, tools } = await fixture({
      blockFirstList: false,
      tools: new WritingTools(),
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(structuredClone(request));
        return [
          { type: 'PLAN_UPDATE' as const, reason: 'Plan first', plan: plannedTask },
          write,
          write,
          write,
          write,
          {
            type: 'VERIFY' as const,
            reason: 'Use the completed write and verify',
            commands: ['node --version']
          },
          { type: 'COMPLETE' as const, reason: 'Done', summary: 'Generated file verified' }
        ][index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.filter(({ name }) => name === 'write_file')).toHaveLength(1);
    expect(tools.calls.filter(({ name }) => name === 'git_diff')).toHaveLength(0);
    const recovery = requests.find(({ harnessInstruction }) =>
      harnessInstruction?.includes('Automatic write recovery 1')
    );
    expect(
      recovery?.context.some(
        ({ reference, content }) =>
          reference.kind === 'TOOL_RESULT' &&
          reference.source === 'write_file' &&
          content.includes('generated.txt')
      )
    ).toBe(true);
  });

  it('invalidates the completion verification after a later file write', async () => {
    const { database, scheduler, task } = await fixture({
      blockFirstList: false,
      tools: new WritingTools(),
      modelGateway: new FakeModelGateway([
        { type: 'PLAN_UPDATE', reason: 'Plan first', plan: plannedTask },
        { type: 'VERIFY', reason: 'Verify before the write', commands: ['node --version'] },
        {
          type: 'TOOL_CALL',
          reason: 'Change the workspace after verification',
          tool: { name: 'write_file', arguments: { path: 'generated.txt', content: 'changed\n' } }
        },
        { type: 'COMPLETE', reason: 'Claim completion too early', summary: 'Done' },
        { type: 'VERIFY', reason: 'Verify after the write', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done after verification', summary: 'Verified' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(database.getVerificationResults(task.id)).toHaveLength(2);
  });

  it('recovers from an invalid patch with a targeted correction decision', async () => {
    const tools = new InvalidPatchThenRecoveredTools(false);
    const { database, scheduler, task } = await fixture({
      goal: '修改 fixture.py 并验证修改',
      blockFirstList: false,
      tools,
      modelGateway: new FakeModelGateway([
        {
          type: 'PLAN_UPDATE',
          reason: 'Plan the change',
          plan: {
            ...plannedTask,
            steps: [{ id: 'change', title: 'Change fixture', status: 'PENDING' }]
          }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Read the target file',
          tool: { name: 'read_file', arguments: { path: 'fixture.py' } }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Apply the planned edits',
          tool: {
            name: 'apply_patch',
            arguments: {
              path: 'fixture.py',
              expectedHash: 'a'.repeat(64),
              edits: [
                { startLine: 1, deleteCount: 1, lines: ['changed'] },
                { startLine: 1, deleteCount: 0, lines: ['duplicate range'] }
              ]
            }
          }
        },
        {
          type: 'TOOL_CALL',
          reason: 'Recover with one valid write after the patch was rejected',
          tool: { name: 'write_file', arguments: { path: 'fixture.py', content: '# changed\n' } }
        },
        {
          type: 'PLAN_UPDATE',
          reason: 'The file change is complete',
          plan: {
            ...plannedTask,
            steps: [{ id: 'change', title: 'Change fixture', status: 'DONE' }]
          }
        },
        { type: 'VERIFY', reason: 'Verify the change', commands: ['node --version'] },
        { type: 'COMPLETE', reason: 'Done', summary: 'Fixture changed and verified' }
      ])
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(tools.calls.map(({ name }) => name)).toEqual([
      'read_file',
      'apply_patch',
      'write_file',
      'run_command'
    ]);
    expect(
      database.getToolCalls(task.id).find(({ tool }) => tool.name === 'apply_patch')
    ).toMatchObject({
      status: 'FAILED',
      result: { error: { code: 'VALIDATION_ERROR' } }
    });
  });

  it('preserves invalid patch recovery across a user pause without reread churn', async () => {
    const tools = new InvalidPatchThenRecoveredTools(false);
    const requests: DecisionRequest[] = [];
    const decisions = [
      {
        type: 'PLAN_UPDATE' as const,
        reason: 'Plan the change',
        plan: {
          ...plannedTask,
          steps: [{ id: 'change', title: 'Change fixture', status: 'PENDING' as const }]
        }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Read the target file',
        tool: { name: 'read_file' as const, arguments: { path: 'fixture.py' } }
      },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Submit an invalid patch',
        tool: {
          name: 'apply_patch' as const,
          arguments: {
            path: 'fixture.py',
            expectedHash: 'a'.repeat(64),
            edits: [
              { startLine: 1, deleteCount: 1, lines: ['changed'] },
              { startLine: 1, deleteCount: 0, lines: ['duplicate range'] }
            ]
          }
        }
      },
      { type: 'ASK_USER' as const, reason: 'Pause for review', question: 'Continue?' },
      {
        type: 'TOOL_CALL' as const,
        reason: 'Recover with a direct write',
        tool: {
          name: 'write_file' as const,
          arguments: { path: 'fixture.py', content: '# changed\n' }
        }
      },
      {
        type: 'PLAN_UPDATE' as const,
        reason: 'The file change is complete',
        plan: {
          ...plannedTask,
          steps: [{ id: 'change', title: 'Change fixture', status: 'DONE' as const }]
        }
      },
      { type: 'VERIFY' as const, reason: 'Verify the change', commands: ['node --version'] },
      { type: 'COMPLETE' as const, reason: 'Done', summary: 'Fixture changed and verified' }
    ];
    const { database, scheduler, task } = await fixture({
      goal: '修改 fixture.py 并验证修改',
      blockFirstList: false,
      tools,
      modelGateway: new FakeModelGateway((request, index) => {
        requests.push(request);
        return decisions[index]!;
      })
    });

    scheduler.start(task.id);
    await scheduler.waitForIdle(task.id);
    expect(database.getTask(task.id)).toMatchObject({ status: 'WAITING_USER' });

    scheduler.resume(task.id);
    await scheduler.waitForIdle(task.id);

    expect(database.getTask(task.id)?.status).toBe('READY_FOR_REVIEW');
    expect(requests.filter(({ harnessInstruction }) => harnessInstruction)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          harnessInstruction: expect.stringContaining('previous apply_patch was rejected')
        })
      ])
    );
    expect(tools.calls.map(({ name }) => name)).toEqual([
      'read_file',
      'apply_patch',
      'write_file',
      'run_command'
    ]);
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
        { type: 'VERIFY', reason: 'Latest failure', commands: ['node --check missing.js'] },
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
    const { database, harness, scheduler, task, source, workspaceManager } = await fixture({
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
    expect(database.getProject(task.projectId)?.sourceMetadata?.fileCount).toBe(2);
    await expect(workspaceManager.listImportedFiles(task.projectId)).resolves.toEqual({
      files: expect.arrayContaining(['README.md', 'generated.txt'])
    });
    expect(database.getEvents(task.id).map(({ type }) => type)).toEqual(
      expect.arrayContaining(['change.updated', 'task.applied'])
    );

    const workspaceContent = await fs.readFile(
      path.join(task.workspacePath, 'generated.txt'),
      'utf8'
    );
    await expect(scheduler.rollback(task.id)).rejects.toThrow('APPLIED');
    expect(database.getTask(task.id)?.status).toBe('APPLIED');
    expect(await fs.readFile(path.join(source, 'generated.txt'), 'utf8')).toBe('generated\n');
    expect(await fs.readFile(path.join(task.workspacePath, 'generated.txt'), 'utf8')).toBe(
      workspaceContent
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

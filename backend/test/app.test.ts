import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { FakeModelGateway } from '../src/adapters/fake-model-gateway.js';
import { WorkspaceManager } from '../src/workspace.js';

const resources: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
});

async function waitForTask(
  database: AppDatabase,
  taskId: string,
  status: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (database.getTask(taskId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Task ${taskId} did not reach ${status}`);
}

describe('backend API', () => {
  it('serves health and runs a task through the mock harness', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-'));
    const source = path.join(directory, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'README.md'), '# Fixture\n');
    await fs.writeFile(path.join(source, 'AGENTS.md'), '# Repository rules\nKeep changes small.\n');
    await fs.writeFile(path.join(source, '.env'), 'MODEL_API_KEY=secret\n');
    await fs.mkdir(path.join(source, '.pytest_cache'));
    await fs.writeFile(path.join(source, '.pytest_cache', 'state'), 'generated\n');
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    resources.push(db);
    const workspaceManager = new WorkspaceManager({ root: path.join(directory, 'workspaces') });
    const app = buildApp({
      database: db,
      workspaceManager,
      modelGateway: new FakeModelGateway()
    });
    resources.push(app);

    const health = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'api-test-1', origin: 'http://localhost:5173' }
    });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-request-id']).toBe('api-test-1');
    expect(health.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'fixture', sourcePath: source }
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<{
      id: string;
      sourcePath?: string;
      workspacePath?: string;
    }>();
    expect(project.sourcePath).toBeUndefined();
    expect(project.workspacePath).toBeUndefined();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/projects'
        })
      ).json<Array<{ id: string }>>()
    ).toEqual([expect.objectContaining({ id: project.id })]);
    const search = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/search?q=Fixture`
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual([
      expect.objectContaining({ path: 'README.md', line: 1, preview: '# Fixture' })
    ]);
    const filesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/files`
    });
    expect(filesResponse.statusCode).toBe(200);
    expect(filesResponse.json()).toEqual({ files: ['AGENTS.md', 'README.md'] });
    const fileResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/files/README.md`
    });
    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.json()).toMatchObject({ path: 'README.md', content: '# Fixture\n' });
    const excludedFile = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/files/.env`
    });
    expect(excludedFile.statusCode).toBe(403);

    const sessionResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { projectId: project.id }
    });
    const session = sessionResponse.json<{ id: string }>();
    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: 'Please inspect the fixture' }
    });
    expect(messageResponse.statusCode).toBe(201);
    expect(messageResponse.json()).toMatchObject({
      sessionId: session.id,
      role: 'USER',
      content: 'Please inspect the fixture'
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${session.id}/messages`
        })
      ).json()
    ).toEqual([expect.objectContaining({ role: 'USER' })]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/sessions?projectId=${project.id}`
        })
      ).json()
    ).toEqual([expect.objectContaining({ id: session.id })]);
    const taskResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { projectId: project.id, sessionId: session.id, goal: 'Inspect fixture' }
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json<{ id: string; workspacePath?: string }>();
    expect(task.workspacePath).toBeUndefined();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/tasks?sessionId=${session.id}`
        })
      ).json()
    ).toEqual([expect.objectContaining({ id: task.id })]);

    const runResponse = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/run` });
    expect(runResponse.statusCode).toBe(202);
    expect(runResponse.json<{ status: string }>().status).toBe('CREATED');
    await waitForTask(db, task.id, 'READY_FOR_REVIEW');
    expect(db.getEvents(task.id).map((event) => event.type)).toContain('tool.completed');
    expect(db.getEvents(task.id).every((event) => event.schemaVersion === '1.0.0')).toBe(true);
    expect(db.getTask(task.id)?.plan?.steps).toHaveLength(2);
    expect(db.getTaskRun(task.id)).toMatchObject({
      taskId: task.id,
      state: {
        phase: 'READY_FOR_REVIEW',
        budget: {
          usedSteps: 6,
          usedToolCalls: 4,
          usedVerificationRuns: 1
        }
      }
    });
    expect(db.getTaskRun(task.id)?.state.contextRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'user-goal', contentHash: expect.any(String) }),
        expect.objectContaining({ source: 'text-code-index', contentHash: expect.any(String) }),
        expect.objectContaining({ source: 'repository-rule', contentHash: expect.any(String) })
      ])
    );
    expect(db.getWorkspaceSnapshots(task.id)).toEqual([
      expect.objectContaining({ taskId: task.id, kind: 'BASELINE' }),
      expect.objectContaining({ taskId: task.id, kind: 'FINAL' })
    ]);
    expect(db.getToolCalls(task.id)).toHaveLength(4);
    expect(db.getToolCalls(task.id).every((call) => call.status === 'SUCCEEDED')).toBe(true);
    for (const call of db.getToolCalls(task.id)) {
      expect(db.getAuditRecords('tool_call', call.id).map(({ action }) => action)).toEqual([
        'tool.started',
        'tool.completed'
      ]);
    }
    expect(db.getVerificationResults(task.id)).toEqual([
      expect.objectContaining({ command: 'node --version', status: 'PASSED' })
    ]);
    const verificationsResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/verifications`
    });
    expect(verificationsResponse.statusCode).toBe(200);
    expect(verificationsResponse.json()).toEqual([
      expect.objectContaining({ command: 'node --version', status: 'PASSED' })
    ]);
    const changeId = randomUUID();
    db.replaceFileChanges(task.id, [
      {
        id: changeId,
        taskId: task.id,
        path: 'README.md',
        status: 'MODIFIED',
        additions: 1,
        deletions: 1,
        patch: 'fixture patch',
        decision: 'PENDING'
      }
    ]);
    const changesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/changes`
    });
    expect(changesResponse.json()).toEqual([
      expect.objectContaining({ id: changeId, decision: 'PENDING', version: 1 })
    ]);
    const decisionResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}/changes/${changeId}`,
      payload: { decision: 'REJECTED', expectedVersion: 1 }
    });
    expect(decisionResponse.statusCode).toBe(200);
    expect(decisionResponse.json()).toMatchObject({ decision: 'REJECTED', version: 2 });
    const reportResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/report`
    });
    expect(reportResponse.statusCode).toBe(200);
    expect(reportResponse.json()).toMatchObject({
      taskId: task.id,
      status: 'READY_FOR_REVIEW',
      changes: [expect.objectContaining({ id: changeId, decision: 'REJECTED' })],
      verifications: [expect.objectContaining({ status: 'PASSED' })],
      risks: []
    });
    const metricsResponse = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.json()).toMatchObject({
      tasks: {
        total: 1,
        byStatus: { READY_FOR_REVIEW: 1 },
        successful: 1,
        failed: 0,
        successRate: 1
      },
      tools: { total: 4, failed: 0, cancelled: 0, failureRate: 0 },
      verifications: { total: 1, failed: 0, errors: 0 },
      modelUsage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        cost: expect.any(Number)
      }
    });
    const persistedEvents = db.getEvents(task.id);
    const reconnectAfter = persistedEvents.at(-2)!.id;
    const expectedReplay = persistedEvents.at(-1)!;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address is missing');
    const streamAbort = new AbortController();
    const eventResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/tasks/${task.id}/events`,
      {
        headers: { 'Last-Event-ID': String(reconnectAfter) },
        signal: streamAbort.signal
      }
    );
    expect(eventResponse.status).toBe(200);
    const eventReader = eventResponse.body!.getReader();
    const replayChunk = await eventReader.read();
    const replayText = new TextDecoder().decode(replayChunk.value);
    expect(replayText).toContain(`id: ${expectedReplay.id}\n`);
    expect(replayText).not.toContain(`id: ${reconnectAfter}\n`);
    await eventReader.cancel();
    streamAbort.abort();
    expect(db.getAuditRecords('task', task.id).length).toBeGreaterThan(1);

    const storedTask = db.getTask(task.id);
    expect(storedTask).toBeDefined();
    await fs.writeFile(path.join(storedTask!.workspacePath, 'README.md'), '# Changed\n');
    const rollbackResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/rollback`
    });
    expect(rollbackResponse.statusCode).toBe(200);
    expect(rollbackResponse.json<{ status: string }>().status).toBe('CANCELLED');
    expect(await fs.readFile(path.join(storedTask!.workspacePath, 'README.md'), 'utf8')).toBe(
      '# Fixture\n'
    );
    expect(db.getEvents(task.id).at(-1)).toMatchObject({
      type: 'task.cancelled',
      payload: { reason: 'Workspace rolled back by user' }
    });

    const cancelledTaskResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { projectId: project.id, sessionId: session.id, goal: 'Cancel fixture task' }
    });
    const cancelledTask = cancelledTaskResponse.json<{ id: string }>();
    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${cancelledTask.id}/cancel`
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json<{ status: string }>().status).toBe('CANCELLED');
    expect(db.getEvents(cancelledTask.id).at(-1)).toMatchObject({
      type: 'task.cancelled',
      payload: { reason: 'Cancelled by user' }
    });

    expect(() =>
      db.addEvent({
        taskId: task.id,
        type: 'task.state_changed',
        timestamp: new Date().toISOString(),
        payload: { status: 'FAILED' }
      })
    ).toThrow('Task event violates the public contract');
  }, 15_000);

  it('rejects requests that violate the public contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-contract-'));
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    resources.push(db);
    const app = buildApp({
      database: db,
      workspaceManager: new WorkspaceManager({ root: path.join(directory, 'workspaces') }),
      modelGateway: new FakeModelGateway()
    });
    resources.push(app);

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'missing-source-path' }
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

    const emptyJsonBody = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { 'content-type': 'application/json' },
      payload: ''
    });
    expect(emptyJsonBody.statusCode).toBe(400);
    expect(emptyJsonBody.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

    const invalidParams = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid'
    });
    expect(invalidParams.statusCode).toBe(400);
    expect(invalidParams.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

    const invalidRequestId = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'contains spaces' }
    });
    expect(invalidRequestId.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const openapi = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    for (const [apiPath, operations] of Object.entries(openapi.paths)) {
      const routePath = apiPath.replaceAll(/\{([^}]+)\}/g, ':$1');
      for (const method of Object.keys(operations)) {
        expect(
          app.hasRoute({ method: method.toUpperCase(), url: routePath }),
          `${method.toUpperCase()} ${routePath}`
        ).toBe(true);
      }
    }
  });
});

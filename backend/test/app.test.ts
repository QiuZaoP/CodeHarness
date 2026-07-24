import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { WorkspaceManager } from '../src/workspace.js';

const resources: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
});

describe('backend API', () => {
  it('serves health and runs a task through the mock harness', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-'));
    const source = path.join(directory, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'README.md'), '# Fixture\n');
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    resources.push(db);
    const workspaceManager = new WorkspaceManager({ root: path.join(directory, 'workspaces') });
    const app = buildApp({ database: db, workspaceManager });
    resources.push(app);

    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
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

    const sessionResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { projectId: project.id }
    });
    const session = sessionResponse.json<{ id: string }>();
    const taskResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { projectId: project.id, sessionId: session.id, goal: 'Inspect fixture' }
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json<{ id: string; workspacePath?: string }>();
    expect(task.workspacePath).toBeUndefined();

    const runResponse = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/run` });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json<{ status: string }>().status).toBe('READY_FOR_REVIEW');
    expect(db.getEvents(task.id).map((event) => event.type)).toContain('tool.completed');
    expect(db.getEvents(task.id).every((event) => event.schemaVersion === '1.0.0')).toBe(true);
    expect(db.getTask(task.id)?.plan?.steps).toHaveLength(2);
    expect(db.getWorkspaceSnapshots(task.id)).toEqual([
      expect.objectContaining({ taskId: task.id, kind: 'BASELINE' })
    ]);
    expect(db.getToolCalls(task.id)).toHaveLength(3);
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
      workspaceManager: new WorkspaceManager({ root: path.join(directory, 'workspaces') })
    });
    resources.push(app);

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'missing-source-path' }
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

    const invalidParams = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid'
    });
    expect(invalidParams.statusCode).toBe(400);
    expect(invalidParams.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';

const resources: Array<{ close: () => void }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) resource.close();
});

describe('backend API', () => {
  it('serves health and runs a task through the mock harness', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-'));
    await fs.writeFile(path.join(directory, 'README.md'), '# Fixture\n');
    await fs.writeFile(path.join(directory, 'fixture.py'), 'def fixture_symbol():\n    return 1\n');
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    resources.push(db);
    const app = buildApp({ database: db });

    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'fixture', sourcePath: directory }
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<{ id: string }>();
    expect(
      db.connection.prepare('SELECT name FROM code_symbols WHERE project_id = ?').all(project.id)
    ).toContainEqual({ name: 'fixture_symbol' });

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
    const task = taskResponse.json<{ id: string }>();

    const runResponse = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/run` });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json<{ status: string }>().status).toBe('READY_FOR_REVIEW');
    expect(db.getEvents(task.id).map((event) => event.type)).toContain('tool.completed');
    expect(
      db.getEvents(task.id).some((event) => event.payload.toolName === 'index_repository')
    ).toBe(true);
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { AppDatabase } from './db.js';
import { config } from './config.js';
import { errorBody, AppError } from './errors.js';
import { EventBroker } from './broker.js';
import { HarnessRunner } from './harness.js';
import { ToolExecutor } from './tools.js';
import { WorkspaceManager } from './workspace.js';
import { CodeIndexService } from './code-index.js';

interface ProjectBody {
  name: string;
  sourcePath: string;
}
interface SessionBody {
  projectId: string;
  title?: string;
}
interface TaskBody {
  projectId: string;
  sessionId: string;
  goal: string;
}

export interface AppDependencies {
  database?: AppDatabase;
  workspaceManager?: WorkspaceManager;
}

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const database = dependencies.database ?? new AppDatabase();
  const workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager();
  const broker = new EventBroker();
  const index = new CodeIndexService(database);
  const tools = new ToolExecutor(workspaceManager, index);
  const harness = new HarnessRunner({ database, broker, workspaceManager, tools });
  const app = Fastify({ logger: { level: config.logLevel } });

  app.register(cors, { origin: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send(errorBody(error));
    app.log.error(error);
    return reply.code(500).send(errorBody(error));
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'codeharness-backend',
    version: 'v1'
  }));

  app.post<{ Body: ProjectBody }>('/api/v1/projects', async (request, reply) => {
    const { name, sourcePath } = request.body ?? {};
    if (!name || !sourcePath)
      throw new AppError('VALIDATION_ERROR', 'name and sourcePath are required');
    const id = randomUUID();
    const workspacePath = await workspaceManager.create(sourcePath, id);
    database.createProject({
      id,
      name,
      sourcePath: path.resolve(sourcePath),
      workspacePath,
      createdAt: new Date().toISOString()
    });
    await index.build(id, workspacePath);
    return reply.code(201).send(database.getProject(id));
  });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', async (request) => {
    const project = database.getProject(request.params.projectId);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found', request.params, 404);
    return project;
  });

  app.post<{ Body: SessionBody }>('/api/v1/sessions', async (request, reply) => {
    const { projectId, title = 'New session' } = request.body ?? {};
    if (!projectId) throw new AppError('VALIDATION_ERROR', 'projectId is required');
    if (!database.getProject(projectId))
      throw new AppError('NOT_FOUND', 'Project not found', { projectId }, 404);
    const session = { id: randomUUID(), projectId, title, createdAt: new Date().toISOString() };
    database.createSession(session);
    return reply.code(201).send(session);
  });

  app.post<{ Body: TaskBody }>('/api/v1/tasks', async (request, reply) => {
    const { projectId, sessionId, goal } = request.body ?? {};
    if (!projectId || !sessionId || !goal)
      throw new AppError('VALIDATION_ERROR', 'projectId, sessionId and goal are required');
    const task = await harness.createTask(projectId, sessionId, goal);
    return reply.code(201).send(task);
  });

  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId', async (request) =>
    harness.getTask(request.params.taskId)
  );

  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/run', async (request, reply) => {
    const task = await harness.run(request.params.taskId);
    return reply.send(task);
  });

  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/pause', async (request) =>
    harness.pause(request.params.taskId)
  );
  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/cancel', async (request) =>
    harness.cancel(request.params.taskId)
  );
  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/rollback', async (request) =>
    harness.rollback(request.params.taskId)
  );

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>(
    '/api/v1/tasks/:taskId/events',
    async (request, reply) => {
      const task = harness.getTask(request.params.taskId);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const write = (event: {
        id: number;
        taskId: string;
        type: string;
        timestamp: string;
        payload: Record<string, unknown>;
      }) => {
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ taskId: event.taskId, timestamp: event.timestamp, ...event.payload })}\n\n`
        );
      };
      const lastEventId = request.headers['last-event-id'];
      const after =
        request.query.after ?? (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      database.getEvents(task.id, Number(after ?? 0)).forEach(write);
      const unsubscribe = broker.subscribe(task.id, write);
      const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    }
  );

  app.get('/api/v1/openapi.json', async () =>
    JSON.parse(await fs.readFile(path.resolve('schemas/openapi.json'), 'utf8'))
  );
  return app;
}

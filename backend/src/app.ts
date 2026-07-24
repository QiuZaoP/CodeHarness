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
import type { ToolRegistrationPort } from './ports/tool-registry.js';
import { TaskScheduler } from './task-scheduler.js';
import { WorkspaceManager } from './workspace.js';
import { domainRef, domainSchema, errorResponses } from './api/contract-schemas.js';
import type { TaskEvent } from './types.js';

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

function isValidationError(error: unknown): error is { validation: unknown } {
  return typeof error === 'object' && error !== null && 'validation' in error;
}

export interface AppDependencies {
  database?: AppDatabase;
  workspaceManager?: WorkspaceManager;
  toolExecutor?: ToolRegistrationPort;
}

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const ownsDatabase = !dependencies.database;
  const database = dependencies.database ?? new AppDatabase();
  const workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager();
  const broker = new EventBroker();
  const tools = dependencies.toolExecutor ?? new ToolExecutor(workspaceManager);
  const harness = new HarnessRunner({ database, broker, workspaceManager, tools });
  const app = Fastify({ logger: { level: config.logLevel } });
  const scheduler = new TaskScheduler(database, harness, {
    onBackgroundError: (error) => app.log.error(error)
  });
  scheduler.recoverInterrupted();
  scheduler.startRecoveryMonitor();

  app.addHook('onClose', async () => {
    await scheduler.shutdown();
    if (ownsDatabase) database.close();
  });

  app.addSchema(domainSchema);
  app.register(cors, { origin: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send(errorBody(error));
    if (isValidationError(error)) {
      return reply
        .code(400)
        .send(
          errorBody(new AppError('VALIDATION_ERROR', 'Request validation failed', error.validation))
        );
    }
    app.log.error(error);
    return reply.code(500).send(errorBody(error));
  });

  app.get('/api/health', { schema: { response: { 200: domainRef('health') } } }, async () => ({
    status: 'ok',
    service: 'codeharness-backend',
    version: 'v1'
  }));

  app.post<{ Body: ProjectBody }>(
    '/api/v1/projects',
    {
      schema: {
        body: domainRef('projectCreate'),
        response: { 201: domainRef('projectSummary'), ...errorResponses }
      }
    },
    async (request, reply) => {
      const { name, sourcePath } = request.body;
      const id = randomUUID();
      const imported = await workspaceManager.importProject(sourcePath, id);
      try {
        database.createProject({
          id,
          name,
          sourcePath: imported.sourcePath,
          workspacePath: imported.projectPath,
          sourceMetadata: imported.metadata,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        await workspaceManager.removeProject(id);
        throw error;
      }
      return reply.code(201).send(database.getProject(id));
    }
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    {
      schema: {
        params: domainRef('projectParams'),
        response: { 200: domainRef('projectSummary'), ...errorResponses }
      }
    },
    async (request) => {
      const project = database.getProject(request.params.projectId);
      if (!project) throw new AppError('NOT_FOUND', 'Project not found', request.params, 404);
      return project;
    }
  );

  app.post<{ Body: SessionBody }>(
    '/api/v1/sessions',
    {
      schema: {
        body: domainRef('sessionCreate'),
        response: { 201: domainRef('session'), ...errorResponses }
      }
    },
    async (request, reply) => {
      const { projectId, title = 'New session' } = request.body;
      if (!database.getProject(projectId))
        throw new AppError('NOT_FOUND', 'Project not found', { projectId }, 404);
      const session = {
        id: randomUUID(),
        projectId,
        title,
        createdAt: new Date().toISOString()
      };
      database.createSession(session);
      return reply.code(201).send(session);
    }
  );

  app.post<{ Body: TaskBody }>(
    '/api/v1/tasks',
    {
      schema: {
        body: domainRef('taskCreate'),
        response: { 201: domainRef('task'), ...errorResponses }
      }
    },
    async (request, reply) => {
      const { projectId, sessionId, goal } = request.body;
      const task = await harness.createTask(projectId, sessionId, goal);
      return reply.code(201).send(task);
    }
  );

  app.get<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: domainRef('task'), ...errorResponses }
      }
    },
    async (request) => harness.getTask(request.params.taskId)
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/run',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 202: domainRef('task'), ...errorResponses }
      }
    },
    async (request, reply) => {
      const task = scheduler.start(request.params.taskId);
      return reply.code(202).send(task);
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/pause',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: domainRef('task'), ...errorResponses }
      }
    },
    async (request) => scheduler.pause(request.params.taskId)
  );
  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/resume',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 202: domainRef('task'), ...errorResponses }
      }
    },
    async (request, reply) => {
      const task = scheduler.resume(request.params.taskId);
      return reply.code(202).send(task);
    }
  );
  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/cancel',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: domainRef('task'), ...errorResponses }
      }
    },
    async (request) => scheduler.cancel(request.params.taskId)
  );
  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/apply',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: domainRef('task'), ...errorResponses }
      }
    },
    async (request) => scheduler.apply(request.params.taskId)
  );
  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/rollback',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: domainRef('task'), ...errorResponses }
      }
    },
    async (request) => scheduler.rollback(request.params.taskId)
  );

  app.get<{ Params: { taskId: string }; Querystring: { after?: number } }>(
    '/api/v1/tasks/:taskId/events',
    {
      schema: {
        params: domainRef('taskParams'),
        querystring: domainRef('eventCursorQuery'),
        response: { 400: domainRef('errorResponse'), 404: domainRef('errorResponse') }
      }
    },
    async (request, reply) => {
      const task = harness.getTask(request.params.taskId);
      const lastEventId = request.headers['last-event-id'];
      const rawAfter =
        request.query.after ?? (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? 0;
      const after = Number(rawAfter);
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new AppError('VALIDATION_ERROR', 'Event cursor must be a non-negative integer', {
          after: rawAfter
        });
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const write = (event: TaskEvent) => {
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
      };
      database.getEvents(task.id, after).forEach(write);
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

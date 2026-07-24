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
import { FakeModelGateway } from './adapters/fake-model-gateway.js';
import { GuardedModelGateway } from './adapters/guarded-model-gateway.js';
import { TextCodeIndex } from './adapters/text-code-index.js';
import { FallbackCodeIndex } from './adapters/fallback-code-index.js';
import type { ModelGateway } from './ports/model-gateway.js';
import type { CodeIndex } from './ports/code-index.js';
import { BudgetManager } from './budget-manager.js';
import { ContextManager } from './context-manager.js';
import { WorkspaceManager } from './workspace.js';
import { domainRef, domainSchema, errorResponses } from './api/contract-schemas.js';
import { eventCursor, SseConnection } from './sse.js';
import type { ChangeDecision } from './types.js';

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
interface MessageBody {
  content: string;
}
interface ChangeDecisionBody {
  decision: Exclude<ChangeDecision, 'PENDING'>;
  expectedVersion: number;
}

const arrayOf = (definition: string) => ({
  type: 'array',
  items: domainRef(definition)
});

function isValidationError(error: unknown): error is { validation: unknown } {
  return typeof error === 'object' && error !== null && 'validation' in error;
}

export interface AppDependencies {
  database?: AppDatabase;
  workspaceManager?: WorkspaceManager;
  toolExecutor?: ToolRegistrationPort;
  modelGateway?: ModelGateway;
  codeIndex?: CodeIndex;
}

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const configuredModelGateway =
    dependencies.modelGateway ?? (config.mockMode ? new FakeModelGateway() : undefined);
  if (!configuredModelGateway) {
    throw new AppError(
      'MODEL_ERROR',
      'A ModelGateway dependency is required when MOCK_MODE is disabled',
      { category: 'CONFIGURATION' },
      500
    );
  }
  const ownsDatabase = !dependencies.database;
  const database = dependencies.database ?? new AppDatabase();
  const workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager();
  const broker = new EventBroker();
  const tools = dependencies.toolExecutor ?? new ToolExecutor(workspaceManager);
  const modelGateway = new GuardedModelGateway(configuredModelGateway, config.maxModelTimeoutMs);
  const textCodeIndex = new TextCodeIndex(
    (projectId) => database.getProject(projectId)?.sourcePath,
    {
      maxFiles: config.maxImportFiles,
      maxFileBytes: config.maxReadFileBytes
    }
  );
  const codeIndex = dependencies.codeIndex
    ? new FallbackCodeIndex(dependencies.codeIndex, textCodeIndex)
    : textCodeIndex;
  const budgetManager = new BudgetManager({
    maxSteps: config.maxTaskSteps,
    maxToolCalls: config.maxTaskToolCalls,
    maxDurationMs: config.maxTaskDurationMs,
    maxChangedFiles: config.maxTaskChangedFiles,
    maxInputTokens: config.maxModelInputTokens,
    maxOutputTokens: config.maxModelOutputTokens,
    maxCost: config.maxModelCost,
    maxReadBytes: config.maxContextReadBytes,
    maxVerificationRuns: config.maxVerificationRuns
  });
  const contextManager = new ContextManager({
    maxEntries: config.maxContextEntries,
    maxTotalBytes: config.maxContextBytes,
    maxEntryBytes: config.maxContextEntryBytes
  });
  const harness = new HarnessRunner({
    database,
    broker,
    workspaceManager,
    tools,
    modelGateway,
    codeIndex,
    budgetManager,
    contextManager
  });
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      const value = Array.isArray(supplied) ? supplied[0] : supplied;
      return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
        ? value
        : randomUUID();
    }
  });
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
  app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    exposedHeaders: ['x-request-id']
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

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

  app.get(
    '/api/v1/projects',
    {
      schema: {
        response: { 200: arrayOf('projectSummary'), ...errorResponses }
      }
    },
    async () => database.getProjects()
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

  app.get<{
    Params: { projectId: string };
    Querystring: { q: string; limit?: number };
  }>(
    '/api/v1/projects/:projectId/search',
    {
      schema: {
        params: domainRef('projectParams'),
        querystring: domainRef('projectSearchQuery'),
        response: { 200: arrayOf('searchResult'), ...errorResponses }
      }
    },
    async (request) => {
      if (!database.getProject(request.params.projectId)) {
        throw new AppError('NOT_FOUND', 'Project not found', request.params, 404);
      }
      const results = await codeIndex.searchText(
        request.params.projectId,
        request.query.q,
        AbortSignal.timeout(config.maxIndexTimeoutMs)
      );
      return results
        .slice(0, request.query.limit ?? 50)
        .map(({ path: filePath, line, preview }) => ({ path: filePath, line, preview }));
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

  app.get<{ Querystring: { projectId?: string } }>(
    '/api/v1/sessions',
    {
      schema: {
        querystring: domainRef('sessionListQuery'),
        response: { 200: arrayOf('session'), ...errorResponses }
      }
    },
    async (request) => {
      if (request.query.projectId && !database.getProject(request.query.projectId)) {
        throw new AppError('NOT_FOUND', 'Project not found', request.query, 404);
      }
      return database.getSessions(request.query.projectId);
    }
  );

  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId',
    {
      schema: {
        params: domainRef('sessionParams'),
        response: { 200: domainRef('session'), ...errorResponses }
      }
    },
    async (request) => {
      const session = database.getSession(request.params.sessionId);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', request.params, 404);
      return session;
    }
  );

  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/messages',
    {
      schema: {
        params: domainRef('sessionParams'),
        response: { 200: arrayOf('message'), ...errorResponses }
      }
    },
    async (request) => {
      if (!database.getSession(request.params.sessionId)) {
        throw new AppError('NOT_FOUND', 'Session not found', request.params, 404);
      }
      return database.getMessages(request.params.sessionId);
    }
  );

  app.post<{ Params: { sessionId: string }; Body: MessageBody }>(
    '/api/v1/sessions/:sessionId/messages',
    {
      schema: {
        params: domainRef('sessionParams'),
        body: domainRef('messageCreate'),
        response: { 201: domainRef('message'), ...errorResponses }
      }
    },
    async (request, reply) => {
      if (!database.getSession(request.params.sessionId)) {
        throw new AppError('NOT_FOUND', 'Session not found', request.params, 404);
      }
      const message = {
        id: randomUUID(),
        sessionId: request.params.sessionId,
        role: 'USER' as const,
        content: request.body.content,
        createdAt: new Date().toISOString()
      };
      database.createMessage(message);
      return reply.code(201).send(message);
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

  app.get<{ Querystring: { projectId?: string; sessionId?: string } }>(
    '/api/v1/tasks',
    {
      schema: {
        querystring: domainRef('taskListQuery'),
        response: { 200: arrayOf('task'), ...errorResponses }
      }
    },
    async (request) => {
      if (request.query.projectId && !database.getProject(request.query.projectId)) {
        throw new AppError('NOT_FOUND', 'Project not found', request.query, 404);
      }
      if (request.query.sessionId && !database.getSession(request.query.sessionId)) {
        throw new AppError('NOT_FOUND', 'Session not found', request.query, 404);
      }
      return database.getTasks(request.query);
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

  app.get<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/changes',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: arrayOf('fileChange'), ...errorResponses }
      }
    },
    async (request) => harness.getFileChanges(request.params.taskId)
  );

  app.patch<{
    Params: { taskId: string; changeId: string };
    Body: ChangeDecisionBody;
  }>(
    '/api/v1/tasks/:taskId/changes/:changeId',
    {
      schema: {
        params: domainRef('changeParams'),
        body: domainRef('changeDecisionUpdate'),
        response: { 200: domainRef('fileChange'), ...errorResponses }
      }
    },
    async (request) =>
      harness.decideFileChange(
        request.params.taskId,
        request.params.changeId,
        request.body.decision,
        request.body.expectedVersion
      )
  );

  app.get<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/verifications',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: arrayOf('verificationResult'), ...errorResponses }
      }
    },
    async (request) => harness.getVerifications(request.params.taskId)
  );

  app.get<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/report',
    {
      schema: {
        params: domainRef('taskParams'),
        response: { 200: domainRef('taskReport'), ...errorResponses }
      }
    },
    async (request) => harness.getReport(request.params.taskId)
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
      const after = eventCursor(request.query.after, request.headers['last-event-id']);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'x-request-id': request.id
      });
      const stream = new SseConnection(reply.raw, after, config.sseMaxPendingEvents);
      let replaying = false;
      let replayRequested = false;
      const replay = () => {
        if (stream.isClosed) return;
        if (replaying) {
          replayRequested = true;
          return;
        }
        do {
          replayRequested = false;
          replaying = true;
          try {
            database.getEvents(task.id, stream.cursor).forEach((event) => stream.sendEvent(event));
          } finally {
            replaying = false;
          }
        } while (replayRequested && !stream.isClosed);
      };
      const unsubscribe = broker.subscribe(task.id, replay);
      replay();
      const persistedReplay = setInterval(replay, config.sseReplayIntervalMs);
      const heartbeat = setInterval(() => stream.sendHeartbeat(), 15_000);
      request.raw.on('close', () => {
        stream.close();
        clearInterval(persistedReplay);
        clearInterval(heartbeat);
        unsubscribe();
      });
    }
  );

  app.get(
    '/api/v1/openapi.json',
    { schema: { response: { 200: { type: 'object', additionalProperties: true } } } },
    async () => JSON.parse(await fs.readFile(path.resolve('schemas/openapi.json'), 'utf8'))
  );
  return app;
}

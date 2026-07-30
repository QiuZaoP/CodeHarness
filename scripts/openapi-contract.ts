import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contractSchemaVersion } from '../backend/src/contract-values.js';

type JsonObject = Record<string, unknown>;

const publicSchemaRoots = [
  'health',
  'projectCreate',
  'projectSummary',
  'projectFiles',
  'projectFileContent',
  'searchResult',
  'sessionCreate',
  'session',
  'messageCreate',
  'message',
  'taskCreate',
  'task',
  'fileChange',
  'changeDecisionUpdate',
  'verificationResult',
  'taskReport',
  'runtimeMetrics',
  'errorResponse',
  'toolCall',
  'ToolCall',
  'indexQueryResult',
  'SemanticSearchResult'
] as const;

const schema = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const array = (name: string): JsonObject => ({ type: 'array', items: schema(name) });
const content = (value: JsonObject): JsonObject => ({
  'application/json': { schema: value }
});
const response = (description: string, value: JsonObject): JsonObject => ({
  description,
  content: content(value)
});
const error = (): JsonObject => ({ $ref: '#/components/responses/Error' });
const errors = (...codes: number[]): JsonObject =>
  Object.fromEntries(codes.map((code) => [String(code), error()]));
const parameter = (name: string, location: 'path' | 'query' | 'header', value: JsonObject) => ({
  name,
  in: location,
  required: location === 'path',
  schema: value
});
const idParameter = (name: string) => parameter(name, 'path', schema('id'));
const body = (name: string): JsonObject => ({
  required: true,
  content: content(schema(name))
});

function rewriteDomainRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteDomainRefs);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === '$ref' && typeof entry === 'string'
        ? entry.replace('#/$defs/', '#/components/schemas/')
        : rewriteDomainRefs(entry)
    ])
  );
}

function selectPublicDefinitions(definitions: JsonObject): JsonObject {
  const selected = new Set<string>();
  const visit = (name: string): void => {
    if (selected.has(name)) return;
    const definition = definitions[name];
    if (definition === undefined) throw new Error(`Domain definition ${name} is missing`);
    selected.add(name);
    const visitValue = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visitValue);
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')) {
            visit(entry.slice('#/$defs/'.length));
          } else {
            visitValue(entry);
          }
        }
      }
    };
    visitValue(definition);
  };
  publicSchemaRoots.forEach(visit);
  return Object.fromEntries([...selected].map((name) => [name, definitions[name]]));
}

export function createOpenApiDocument(): JsonObject {
  const domain = JSON.parse(
    fs.readFileSync(path.resolve('schemas/domain.schema.json'), 'utf8')
  ) as JsonObject;
  const domainDefinitions = rewriteDomainRefs(
    selectPublicDefinitions(domain.$defs as JsonObject)
  ) as JsonObject;
  return {
    openapi: '3.1.0',
    info: {
      title: 'CodeHarness Backend API',
      version: '0.1.0'
    },
    'x-contract-schema-version': contractSchemaVersion,
    servers: [{ url: 'http://127.0.0.1:3000' }],
    paths: {
      '/api/health': {
        get: {
          operationId: 'getHealth',
          responses: { 200: response('Service health', schema('health')) }
        }
      },
      '/api/v1/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          responses: { 200: response('OpenAPI 3.1 document', { type: 'object' }) }
        }
      },
      '/api/v1/metrics': {
        get: {
          operationId: 'getRuntimeMetrics',
          responses: {
            200: response('Runtime quality metrics', schema('runtimeMetrics')),
            ...errors(500)
          }
        }
      },
      '/api/v1/projects': {
        get: {
          operationId: 'listProjects',
          responses: { 200: response('Projects', array('projectSummary')), ...errors(500) }
        },
        post: {
          operationId: 'createProject',
          requestBody: body('projectCreate'),
          responses: {
            201: response('Project created', schema('projectSummary')),
            ...errors(400, 403, 409, 500)
          }
        }
      },
      '/api/v1/projects/{projectId}': {
        get: {
          operationId: 'getProject',
          parameters: [idParameter('projectId')],
          responses: {
            200: response('Project summary', schema('projectSummary')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/projects/{projectId}/search': {
        get: {
          operationId: 'searchProject',
          parameters: [
            idParameter('projectId'),
            { ...parameter('q', 'query', { type: 'string', minLength: 1 }), required: true },
            parameter('limit', 'query', {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 50
            })
          ],
          responses: {
            200: response('Text search results', array('searchResult')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/projects/{projectId}/files': {
        get: {
          operationId: 'listProjectFiles',
          parameters: [idParameter('projectId')],
          responses: {
            200: response('Imported project file paths', schema('projectFiles')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/projects/{projectId}/files/{filePath}': {
        get: {
          operationId: 'getProjectFile',
          parameters: [
            idParameter('projectId'),
            { ...parameter('filePath', 'path', { type: 'string', minLength: 1 }), required: true }
          ],
          responses: {
            200: response('Imported project text file', schema('projectFileContent')),
            ...errors(400, 403, 404, 500)
          }
        }
      },
      '/api/v1/sessions': {
        get: {
          operationId: 'listSessions',
          parameters: [parameter('projectId', 'query', schema('id'))],
          responses: { 200: response('Sessions', array('session')), ...errors(400, 404, 500) }
        },
        post: {
          operationId: 'createSession',
          requestBody: body('sessionCreate'),
          responses: {
            201: response('Session created', schema('session')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/sessions/{sessionId}': {
        get: {
          operationId: 'getSession',
          parameters: [idParameter('sessionId')],
          responses: {
            200: response('Session', schema('session')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/sessions/{sessionId}/messages': {
        get: {
          operationId: 'listMessages',
          parameters: [idParameter('sessionId')],
          responses: {
            200: response('Session messages', array('message')),
            ...errors(400, 404, 500)
          }
        },
        post: {
          operationId: 'createMessage',
          parameters: [idParameter('sessionId')],
          requestBody: body('messageCreate'),
          responses: {
            201: response('Message created', schema('message')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/tasks': {
        get: {
          operationId: 'listTasks',
          parameters: [
            parameter('projectId', 'query', schema('id')),
            parameter('sessionId', 'query', schema('id'))
          ],
          responses: { 200: response('Tasks', array('task')), ...errors(400, 404, 500) }
        },
        post: {
          operationId: 'createTask',
          requestBody: body('taskCreate'),
          responses: {
            201: response('Task created', schema('task')),
            ...errors(400, 404, 409, 500)
          }
        }
      },
      '/api/v1/tasks/{taskId}': {
        get: {
          operationId: 'getTask',
          parameters: [idParameter('taskId')],
          responses: { 200: response('Task', schema('task')), ...errors(400, 404, 500) }
        }
      },
      '/api/v1/tasks/{taskId}/changes': {
        get: {
          operationId: 'listTaskChanges',
          parameters: [idParameter('taskId')],
          responses: {
            200: response('File changes', array('fileChange')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/tasks/{taskId}/changes/{changeId}': {
        patch: {
          operationId: 'decideTaskChange',
          parameters: [idParameter('taskId'), idParameter('changeId')],
          requestBody: body('changeDecisionUpdate'),
          responses: {
            200: response('Updated file change', schema('fileChange')),
            ...errors(400, 404, 409, 500)
          }
        }
      },
      '/api/v1/tasks/{taskId}/verifications': {
        get: {
          operationId: 'listTaskVerifications',
          parameters: [idParameter('taskId')],
          responses: {
            200: response('Verification results', array('verificationResult')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/tasks/{taskId}/report': {
        get: {
          operationId: 'getTaskReport',
          parameters: [idParameter('taskId')],
          responses: {
            200: response('Structured task report', schema('taskReport')),
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/tasks/{taskId}/run': controlOperation(
        'runTask',
        202,
        'Task accepted for background execution'
      ),
      '/api/v1/tasks/{taskId}/events': {
        get: {
          operationId: 'subscribeTaskEvents',
          parameters: [
            idParameter('taskId'),
            parameter('after', 'query', { type: 'integer', minimum: 0 }),
            parameter('Last-Event-ID', 'header', { type: 'integer', minimum: 0 })
          ],
          responses: {
            200: {
              description: 'Server-sent event stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } }
            },
            ...errors(400, 404, 500)
          }
        }
      },
      '/api/v1/tasks/{taskId}/pause': controlOperation('pauseTask', 200, 'Task paused'),
      '/api/v1/tasks/{taskId}/resume': controlOperation(
        'resumeTask',
        202,
        'Task accepted for resumed execution'
      ),
      '/api/v1/tasks/{taskId}/cancel': controlOperation('cancelTask', 200, 'Task cancelled'),
      '/api/v1/tasks/{taskId}/apply': controlOperation('applyTask', 200, 'Task changes applied'),
      '/api/v1/tasks/{taskId}/rollback': controlOperation(
        'rollbackTask',
        200,
        'Task workspace rolled back'
      )
    },
    components: {
      schemas: domainDefinitions,
      responses: {
        Error: {
          description: 'Structured error',
          content: content(schema('errorResponse'))
        }
      }
    }
  };
}

function controlOperation(operationId: string, status: number, description: string): JsonObject {
  return {
    post: {
      operationId,
      parameters: [idParameter('taskId')],
      responses: {
        [status]: response(description, schema('task')),
        ...errors(400, 404, 409, 500)
      }
    }
  };
}

function writeOpenApi(): void {
  const target = path.resolve('schemas/openapi.json');
  fs.writeFileSync(target, `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeOpenApi();
}

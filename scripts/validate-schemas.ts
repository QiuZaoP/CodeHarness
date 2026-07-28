import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import {
  changeDecisions,
  contractSchemaVersion,
  contextKinds,
  decisionTypes,
  errorCodes,
  eventTypes,
  fileChangeStatuses,
  messageRoles,
  planStepStatuses,
  snapshotKinds,
  taskStatuses,
  toolCallStatuses,
  toolNames,
  toolPermissions,
  verificationFailureCategories,
  verificationStatuses
} from '../backend/src/contract-values.js';
import type { ModelDecision, RunState } from '../backend/src/types.js';
import { createOpenApiDocument } from './openapi-contract.js';

type JsonObject = Record<string, unknown>;

const root = path.resolve('schemas');

function readJson(fileName: string): JsonObject {
  return JSON.parse(fs.readFileSync(path.join(root, fileName), 'utf8')) as JsonObject;
}

function arrayAt(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function objectAt(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function assertSameValues(label: string, actual: unknown, expected: readonly string[]): void {
  const actualValues = arrayAt(actual, label);
  if (JSON.stringify(actualValues) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} drifted from contract-values.ts\nactual=${JSON.stringify(actualValues)}\nexpected=${JSON.stringify(expected)}`
    );
  }
}

const status = readJson('task-status.schema.json');
const event = readJson('event.schema.json');
const domain = readJson('domain.schema.json');
const openapi = readJson('openapi.json');
if (JSON.stringify(openapi) !== JSON.stringify(createOpenApiDocument())) {
  throw new Error('OpenAPI document is stale; run npm run openapi:generate');
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema(domain);
ajv.addSchema(status);
ajv.compile(event);

const domainDefs = objectAt(domain.$defs, 'domain.$defs');
const enumFromDef = (name: string): unknown =>
  objectAt(domainDefs[name], `domain.$defs.${name}`).enum;

assertSameValues('task-status.schema enum', status.enum, taskStatuses);
assertSameValues('domain taskStatus enum', enumFromDef('taskStatus'), taskStatuses);
assertSameValues('domain planStepStatus enum', enumFromDef('planStepStatus'), planStepStatuses);
assertSameValues('domain messageRole enum', enumFromDef('messageRole'), messageRoles);
assertSameValues('domain decisionType enum', enumFromDef('decisionType'), decisionTypes);
assertSameValues('domain toolName enum', enumFromDef('toolName'), toolNames);
assertSameValues('domain toolCallStatus enum', enumFromDef('toolCallStatus'), toolCallStatuses);
assertSameValues('domain toolPermission enum', enumFromDef('toolPermission'), toolPermissions);
assertSameValues(
  'domain fileChangeStatus enum',
  enumFromDef('fileChangeStatus'),
  fileChangeStatuses
);
assertSameValues('domain changeDecision enum', enumFromDef('changeDecision'), changeDecisions);
assertSameValues('domain snapshotKind enum', enumFromDef('snapshotKind'), snapshotKinds);
assertSameValues('domain contextKind enum', enumFromDef('contextKind'), contextKinds);
assertSameValues(
  'domain verificationStatus enum',
  enumFromDef('verificationStatus'),
  verificationStatuses
);
assertSameValues(
  'domain verificationFailureCategory enum',
  enumFromDef('verificationFailureCategory'),
  verificationFailureCategories
);
assertSameValues('domain errorCode enum', enumFromDef('errorCode'), errorCodes);
assertSameValues(
  'event type enum',
  objectAt(event.properties, 'event.properties').type &&
    objectAt(objectAt(event.properties, 'event.properties').type, 'event.properties.type').enum,
  eventTypes
);

const openapiComponents = objectAt(openapi.components, 'openapi.components');
const openapiSchemas = objectAt(openapiComponents.schemas, 'openapi.components.schemas');
const openapiTaskStatus = objectAt(openapiSchemas.taskStatus, 'openapi taskStatus');
const openapiErrorCode = objectAt(openapiSchemas.errorCode, 'openapi errorCode');

assertSameValues('openapi TaskStatus enum', openapiTaskStatus.enum, taskStatuses);
assertSameValues('openapi Error code enum', openapiErrorCode.enum, errorCodes);

if (openapi.openapi !== '3.1.0') {
  throw new Error('OpenAPI version must be 3.1.0');
}
if (openapi['x-contract-schema-version'] !== contractSchemaVersion) {
  throw new Error('OpenAPI contract schema version drifted from contract-values.ts');
}

const expectedPaths = [
  '/api/health',
  '/api/v1/openapi.json',
  '/api/v1/metrics',
  '/api/v1/projects',
  '/api/v1/projects/{projectId}',
  '/api/v1/projects/{projectId}/search',
  '/api/v1/projects/{projectId}/files',
  '/api/v1/projects/{projectId}/files/{filePath}',
  '/api/v1/sessions',
  '/api/v1/sessions/{sessionId}',
  '/api/v1/sessions/{sessionId}/messages',
  '/api/v1/tasks',
  '/api/v1/tasks/{taskId}',
  '/api/v1/tasks/{taskId}/changes',
  '/api/v1/tasks/{taskId}/changes/{changeId}',
  '/api/v1/tasks/{taskId}/verifications',
  '/api/v1/tasks/{taskId}/report',
  '/api/v1/tasks/{taskId}/run',
  '/api/v1/tasks/{taskId}/events',
  '/api/v1/tasks/{taskId}/pause',
  '/api/v1/tasks/{taskId}/resume',
  '/api/v1/tasks/{taskId}/cancel',
  '/api/v1/tasks/{taskId}/apply',
  '/api/v1/tasks/{taskId}/rollback'
];
const actualPaths = Object.keys(objectAt(openapi.paths, 'openapi.paths'));
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error(
    `OpenAPI paths do not match the implemented API\nactual=${JSON.stringify(actualPaths)}`
  );
}

const expectedMethods: Record<string, readonly string[]> = {
  '/api/health': ['get'],
  '/api/v1/openapi.json': ['get'],
  '/api/v1/metrics': ['get'],
  '/api/v1/projects': ['get', 'post'],
  '/api/v1/projects/{projectId}': ['get'],
  '/api/v1/projects/{projectId}/search': ['get'],
  '/api/v1/projects/{projectId}/files': ['get'],
  '/api/v1/projects/{projectId}/files/{filePath}': ['get'],
  '/api/v1/sessions': ['get', 'post'],
  '/api/v1/sessions/{sessionId}': ['get'],
  '/api/v1/sessions/{sessionId}/messages': ['get', 'post'],
  '/api/v1/tasks': ['get', 'post'],
  '/api/v1/tasks/{taskId}': ['get'],
  '/api/v1/tasks/{taskId}/changes': ['get'],
  '/api/v1/tasks/{taskId}/changes/{changeId}': ['patch'],
  '/api/v1/tasks/{taskId}/verifications': ['get'],
  '/api/v1/tasks/{taskId}/report': ['get'],
  '/api/v1/tasks/{taskId}/run': ['post'],
  '/api/v1/tasks/{taskId}/events': ['get'],
  '/api/v1/tasks/{taskId}/pause': ['post'],
  '/api/v1/tasks/{taskId}/resume': ['post'],
  '/api/v1/tasks/{taskId}/cancel': ['post'],
  '/api/v1/tasks/{taskId}/apply': ['post'],
  '/api/v1/tasks/{taskId}/rollback': ['post']
};
const openapiPaths = objectAt(openapi.paths, 'openapi.paths');
for (const [apiPath, methods] of Object.entries(expectedMethods)) {
  const actualMethods = Object.keys(objectAt(openapiPaths[apiPath], `openapi path ${apiPath}`));
  if (JSON.stringify(actualMethods) !== JSON.stringify(methods)) {
    throw new Error(
      `OpenAPI methods for ${apiPath} drifted from current routes: ${JSON.stringify(actualMethods)}`
    );
  }
}

function rewriteOpenApiRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteOpenApiRefs);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === '$ref' && typeof entry === 'string'
        ? entry.replace('#/components/schemas/', '#/$defs/')
        : rewriteOpenApiRefs(entry)
    ])
  );
}

const openapiSchemaId = 'https://codeharness.local/schemas/openapi-components.schema.json';
ajv.addSchema(
  rewriteOpenApiRefs({
    $id: openapiSchemaId,
    $defs: openapiSchemas
  }) as JsonObject
);

function assertContractSamples(
  label: string,
  domainDefinition: string,
  openapiDefinition: string,
  samples: ReadonlyArray<{ value: unknown; valid: boolean }>
): void {
  const validateDomain = ajv.compile({
    $ref: `https://codeharness.local/schemas/domain.schema.json#/$defs/${domainDefinition}`
  });
  const validateOpenApi = ajv.compile({
    $ref: `${openapiSchemaId}#/$defs/${openapiDefinition}`
  });
  for (const sample of samples) {
    const domainValid = validateDomain(sample.value);
    const openapiValid = validateOpenApi(sample.value);
    if (domainValid !== sample.valid || openapiValid !== sample.valid) {
      throw new Error(
        `${label} drifted between domain/OpenAPI schemas for ${JSON.stringify(sample.value)}`
      );
    }
  }
}

const projectId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const timestamp = '2026-07-24T00:00:00.000Z';
assertContractSamples('ProjectCreate', 'projectCreate', 'projectCreate', [
  { value: { name: 'fixture', sourcePath: 'C:/fixture' }, valid: true },
  { value: { name: '', sourcePath: 'C:/fixture' }, valid: false },
  { value: { name: 'fixture' }, valid: false }
]);
assertContractSamples('ProjectSummary', 'projectSummary', 'projectSummary', [
  { value: { id: projectId, name: 'fixture', createdAt: timestamp }, valid: true },
  {
    value: { id: projectId, name: 'fixture', sourcePath: 'C:/fixture', createdAt: timestamp },
    valid: false
  }
]);
assertContractSamples('SessionCreate', 'sessionCreate', 'sessionCreate', [
  { value: { projectId }, valid: true },
  { value: { projectId, title: '' }, valid: false }
]);
assertContractSamples('Session', 'session', 'session', [
  {
    value: { id: sessionId, projectId, title: 'New session', createdAt: timestamp },
    valid: true
  },
  { value: { id: sessionId, projectId, title: '', createdAt: timestamp }, valid: false }
]);
assertContractSamples('TaskCreate', 'taskCreate', 'taskCreate', [
  { value: { projectId, sessionId, goal: 'Inspect fixture' }, valid: true },
  { value: { projectId, sessionId, goal: '' }, valid: false }
]);
assertContractSamples('Task', 'task', 'task', [
  {
    value: {
      id: taskId,
      projectId,
      sessionId,
      goal: 'Inspect fixture',
      status: 'CREATED',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    valid: true
  },
  {
    value: {
      id: taskId,
      projectId,
      sessionId,
      goal: 'Inspect fixture',
      status: 'CREATED',
      workspacePath: 'C:/internal',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    valid: false
  }
]);

const validateDecision = ajv.compile({
  $ref: 'https://codeharness.local/schemas/domain.schema.json#/$defs/modelDecision'
});
const decisionSample = {
  type: 'TOOL_CALL',
  reason: 'Inspect the repository',
  expectedObservation: 'Repository files',
  tool: { name: 'list_files', arguments: { path: '.' } }
} satisfies ModelDecision;
if (!validateDecision(decisionSample)) {
  throw new Error(
    `ModelDecision sample failed validation: ${ajv.errorsText(validateDecision.errors)}`
  );
}

const validateRunState = ajv.compile({
  $ref: 'https://codeharness.local/schemas/domain.schema.json#/$defs/runState'
});
const runStateSample = {
  schemaVersion: contractSchemaVersion,
  runId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  phase: 'EXECUTING',
  contextRefs: [],
  toolCallIds: [],
  changedFiles: [],
  verificationResultIds: [],
  budget: {
    maxSteps: 20,
    maxToolCalls: 40,
    maxDurationMs: 300_000,
    maxChangedFiles: 20,
    maxInputTokens: 120_000,
    maxOutputTokens: 16_000,
    maxCost: 10,
    maxReadBytes: 262_144,
    maxVerificationRuns: 3,
    usedSteps: 0,
    usedToolCalls: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    usedCost: 0,
    usedReadBytes: 0,
    usedVerificationRuns: 0
  }
} satisfies RunState;
if (!validateRunState(runStateSample)) {
  throw new Error(`RunState sample failed validation: ${ajv.errorsText(validateRunState.errors)}`);
}

const validateEvent = ajv.compile(event);
if (
  !validateEvent({
    schemaVersion: contractSchemaVersion,
    id: 1,
    taskId: '00000000-0000-4000-8000-000000000001',
    type: 'task.state_changed',
    timestamp: '2026-07-24T00:00:00.000Z',
    payload: { from: 'CREATED', to: 'PRECHECKING' }
  })
) {
  throw new Error(`TaskEvent sample failed validation: ${ajv.errorsText(validateEvent.errors)}`);
}

const handoffRoot = path.resolve('docs', 'harness-runtime');
const handoffOverview = fs.readFileSync(path.join(handoffRoot, 'README.md'), 'utf8');
const apiReference = fs.readFileSync(path.join(handoffRoot, 'API_REFERENCE.md'), 'utf8');
const mergeGuide = fs.readFileSync(path.join(handoffRoot, 'MERGE_GUIDE.md'), 'utf8');
const repositoryReadme = fs.readFileSync(path.resolve('README.md'), 'utf8');

function assertDocumented(label: string, document: string, values: readonly string[]): void {
  const missing = values.filter((value) => !document.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} is missing from the handoff documentation: ${missing.join(', ')}`);
  }
}

assertDocumented('OpenAPI paths', apiReference, actualPaths);
assertDocumented('Task statuses', apiReference, taskStatuses);
assertDocumented('Event types', apiReference, eventTypes);
assertDocumented('Error codes', apiReference, errorCodes);
assertDocumented('Decision types', mergeGuide, decisionTypes);
assertDocumented('Tool names', `${handoffOverview}\n${mergeGuide}`, toolNames);

const environmentVariables = fs
  .readFileSync(path.resolve('.env.example'), 'utf8')
  .split(/\r?\n/)
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter((name): name is string => name !== undefined);
assertDocumented('Environment variables', mergeGuide, environmentVariables);

assertDocumented('Repository handoff links', repositoryReadme, [
  'docs/harness-runtime/README.md',
  'docs/harness-runtime/API_REFERENCE.md',
  'docs/harness-runtime/MERGE_GUIDE.md'
]);

console.log('Schema and contract consistency validation passed');

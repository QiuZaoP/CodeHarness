import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FallbackCodeIndex } from '../src/adapters/fallback-code-index.js';
import { FakeCodeIndex } from '../src/adapters/fake-code-index.js';
import { FakeModelGateway } from '../src/adapters/fake-model-gateway.js';
import { GuardedModelGateway } from '../src/adapters/guarded-model-gateway.js';
import { TextCodeIndex } from '../src/adapters/text-code-index.js';
import { AppError } from '../src/errors.js';
import type { CodeIndex } from '../src/ports/code-index.js';
import type { ModelGateway } from '../src/ports/model-gateway.js';
import { contractSchemaVersion, type RunState, type ToolDefinition } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const runState: RunState = {
  schemaVersion: contractSchemaVersion,
  runId: '97ab46e5-10cb-48b8-9e2e-a7b4d64becb7',
  taskId: '06bf418f-22f0-4e9e-902a-a2f5aca06160',
  sessionId: '3c2b6d9f-3c88-40bd-9ef6-2bf6ed61e7e1',
  phase: 'EXECUTING',
  contextRefs: [],
  toolCallIds: [],
  changedFiles: [],
  verificationResultIds: [],
  budget: {
    maxSteps: 10,
    maxToolCalls: 20,
    maxDurationMs: 60_000,
    maxChangedFiles: 10,
    usedSteps: 0,
    usedToolCalls: 0
  }
};

const readFileTool: ToolDefinition = {
  name: 'read_file',
  version: '1.0.0',
  description: 'Read a file',
  permission: 'READ',
  sideEffect: false,
  defaultTimeoutMs: 1_000,
  inputSchema: {},
  outputSchema: {}
};

function failingCodeIndex(message = 'primary unavailable'): CodeIndex {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    getProjectOverview: fail,
    searchFiles: fail,
    searchText: fail,
    searchSymbols: fail,
    findReferences: fail,
    findCallHierarchy: fail,
    searchSemantic: fail
  };
}

function modelGateway(overrides: Partial<ModelGateway> = {}): ModelGateway {
  const fake = new FakeModelGateway();
  return {
    decide: fake.decide.bind(fake),
    summarize: fake.summarize.bind(fake),
    embed: fake.embed.bind(fake),
    ...overrides
  };
}

describe('replaceable runtime ports', () => {
  it('provides a deterministic model gateway fake', async () => {
    const gateway = new FakeModelGateway([
      { type: 'COMPLETE', reason: 'All checks passed', summary: 'Done' }
    ]);
    const signal = new AbortController().signal;
    const deltas: string[] = [];

    const response = await gateway.decide(
      { runState, context: [], availableTools: [readFileTool] },
      signal,
      (event) => {
        if ('delta' in event) deltas.push(event.delta);
      }
    );
    expect(response.decision).toEqual({
      type: 'COMPLETE',
      reason: 'All checks passed',
      summary: 'Done'
    });
    expect(response.provider).toBe('fake');
    expect(deltas).toHaveLength(1);
    expect((await gateway.embed({ inputs: ['abc'] }, signal)).vectors).toEqual([[3]]);
    await expect(
      gateway.decide({ runState, context: [], availableTools: [] }, signal)
    ).rejects.toThrow('no queued decision');
  });

  it('provides deterministic index queries and honours cancellation', async () => {
    const index = new FakeCodeIndex({
      overview: {
        projectId: 'ddc71664-cad2-4680-bf32-11b348bbd711',
        languages: ['TypeScript'],
        entryFiles: ['backend/src/index.ts'],
        testFiles: ['backend/test/app.test.ts'],
        buildCommands: ['npm run build'],
        indexedFiles: 2,
        degraded: false
      },
      files: [{ path: 'backend/src/index.ts', language: 'TypeScript' }],
      symbols: [{ name: 'buildApp', kind: 'function', path: 'backend/src/app.ts', line: 18 }],
      callHierarchy: [
        {
          symbol: 'buildApp',
          path: 'backend/src/server.ts',
          line: 5,
          direction: 'CALLER',
          depth: 1
        }
      ],
      semantic: [
        {
          path: 'backend/src/app.ts',
          startLine: 18,
          endLine: 24,
          score: 0.9,
          preview: 'build application'
        }
      ]
    });
    const signal = new AbortController().signal;
    const projectId = 'ddc71664-cad2-4680-bf32-11b348bbd711';

    expect(await index.searchFiles(projectId, 'index', signal)).toHaveLength(1);
    expect(await index.searchSymbols(projectId, 'build', signal)).toHaveLength(1);
    expect(await index.findCallHierarchy(projectId, 'buildApp', 1, signal)).toHaveLength(1);
    expect(await index.searchSemantic(projectId, 'application', 5, signal)).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    await expect(index.getProjectOverview(projectId, controller.signal)).rejects.toThrow();
  });

  it('guards model responses, provider failures, timeouts, and cancellation', async () => {
    const request = { runState, context: [], availableTools: [readFileTool] };
    const signal = new AbortController().signal;

    const valid = new GuardedModelGateway(new FakeModelGateway(), 1_000);
    await expect(valid.decide(request, signal)).resolves.toMatchObject({
      decision: { type: 'PLAN_UPDATE' },
      provider: 'fake'
    });

    const invalid = new GuardedModelGateway(
      modelGateway({
        decide: async () => ({
          decision: { type: 'PLAN_UPDATE' } as never,
          model: '',
          provider: 'broken',
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: 0
        })
      }),
      1_000
    );
    await expect(invalid.decide(request, signal)).rejects.toMatchObject({
      code: 'MODEL_ERROR',
      details: { category: 'INVALID_RESPONSE' }
    });

    const missingUsage = new GuardedModelGateway(
      modelGateway({
        decide: async () => ({
          decision: { type: 'COMPLETE', reason: 'fixture', summary: 'done' },
          model: 'fixture',
          provider: 'fixture',
          usage: {} as never,
          durationMs: 1
        })
      }),
      1_000
    );
    await expect(missingUsage.decide(request, signal)).rejects.toMatchObject({
      code: 'MODEL_ERROR',
      details: { category: 'INVALID_RESPONSE' }
    });

    const providerFailure = new GuardedModelGateway(
      modelGateway({
        decide: async () => {
          throw new Error('provider offline');
        }
      }),
      1_000
    );
    await expect(providerFailure.decide(request, signal)).rejects.toMatchObject({
      code: 'MODEL_ERROR',
      details: { category: 'PROVIDER', cause: 'provider offline' }
    });

    const timeout = new GuardedModelGateway(
      modelGateway({
        decide: () => new Promise(() => {})
      }),
      10
    );
    await expect(timeout.decide(request, signal)).rejects.toMatchObject({
      code: 'MODEL_ERROR',
      details: { category: 'TIMEOUT', timeoutMs: 10 }
    });

    const controller = new AbortController();
    const cancellation = new AppError('TASK_CANCELLED', 'cancelled by fixture');
    controller.abort(cancellation);
    await expect(valid.decide(request, controller.signal)).rejects.toBe(cancellation);
  });

  it('indexes a real project deterministically within text fallback limits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-index-'));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' } })
    );
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;\nneedle();\n');
    await fs.writeFile(path.join(root, 'src', 'helper.ts'), 'export function needle() {}\n');
    await fs.writeFile(path.join(root, 'tests', 'app.test.ts'), 'test("needle", () => {});\n');
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'index.ts'), 'needle();\n');

    const projectId = 'text-project';
    const index = new TextCodeIndex((id) => (id === projectId ? root : undefined), {
      maxFiles: 20,
      maxFileBytes: 10_000,
      maxResults: 10
    });
    const signal = new AbortController().signal;

    await expect(index.getProjectOverview(projectId, signal)).resolves.toMatchObject({
      projectId,
      languages: expect.arrayContaining(['JSON', 'TypeScript']),
      entryFiles: ['src/index.ts'],
      testFiles: ['tests/app.test.ts'],
      buildCommands: ['npm test', 'npm run build'],
      indexedFiles: 5,
      degraded: true
    });
    await expect(index.searchFiles(projectId, 'index', signal)).resolves.toEqual([
      { path: 'src/index.ts', language: 'TypeScript' }
    ]);
    await expect(index.searchText(projectId, 'needle', signal)).resolves.toEqual([
      { path: 'src/helper.ts', line: 1, column: 17, preview: 'export function needle() {}' },
      { path: 'src/index.ts', line: 2, column: 1, preview: 'needle();' },
      { path: 'tests/app.test.ts', line: 1, column: 7, preview: 'test("needle", () => {});' }
    ]);
    await expect(index.searchSymbols(projectId, 'needle', signal)).resolves.toEqual([]);
    await expect(index.searchSemantic(projectId, 'needle', 5, signal)).resolves.toEqual([]);
    await expect(index.getProjectOverview('missing', signal)).rejects.toMatchObject({
      code: 'INDEX_ERROR',
      details: { category: 'NOT_FOUND' }
    });
  });

  it('falls back to text search and preserves cancellation and dual failures', async () => {
    const projectId = 'fallback-project';
    const fallback = new FakeCodeIndex({
      overview: {
        projectId,
        languages: ['TypeScript'],
        entryFiles: ['src/index.ts'],
        testFiles: [],
        buildCommands: [],
        indexedFiles: 1,
        degraded: false
      },
      files: [{ path: 'src/index.ts', language: 'TypeScript' }]
    });
    const index = new FallbackCodeIndex(failingCodeIndex(), fallback);
    const signal = new AbortController().signal;

    await expect(index.getProjectOverview(projectId, signal)).resolves.toMatchObject({
      projectId,
      degraded: true
    });
    await expect(index.searchFiles(projectId, 'index', signal)).resolves.toHaveLength(1);

    const unavailable = new FallbackCodeIndex(
      failingCodeIndex('primary failed'),
      failingCodeIndex('fallback failed')
    );
    await expect(unavailable.searchText(projectId, 'needle', signal)).rejects.toMatchObject({
      code: 'INDEX_ERROR',
      details: {
        category: 'UNAVAILABLE',
        primary: 'primary failed',
        fallback: 'fallback failed'
      }
    });

    const controller = new AbortController();
    const cancellation = new AppError('TASK_CANCELLED', 'stop fallback');
    controller.abort(cancellation);
    await expect(index.searchFiles(projectId, 'index', controller.signal)).rejects.toBe(
      cancellation
    );
  });
});

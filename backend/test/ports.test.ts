import { describe, expect, it } from 'vitest';
import { FakeCodeIndex } from '../src/adapters/fake-code-index.js';
import { FakeModelGateway } from '../src/adapters/fake-model-gateway.js';
import { contractSchemaVersion, type RunState, type ToolDefinition } from '../src/types.js';

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
});

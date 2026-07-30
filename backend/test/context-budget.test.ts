import { describe, expect, it } from 'vitest';
import { BudgetManager } from '../src/budget-manager.js';
import { ContextManager } from '../src/context-manager.js';
import { contractSchemaVersion, type RunState } from '../src/types.js';

function runState(manager: BudgetManager): RunState {
  return {
    schemaVersion: contractSchemaVersion,
    runId: '97ab46e5-10cb-48b8-9e2e-a7b4d64becb7',
    taskId: '06bf418f-22f0-4e9e-902a-a2f5aca06160',
    sessionId: '3c2b6d9f-3c88-40bd-9ef6-2bf6ed61e7e1',
    phase: 'PLANNING',
    contextRefs: [],
    toolCallIds: [],
    changedFiles: [],
    verificationResultIds: [],
    budget: manager.create()
  };
}

describe('context and budget management', () => {
  it('selects context by priority with stable hashes, deduplication, and UTF-8 limits', () => {
    const manager = new ContextManager({
      maxEntries: 3,
      maxTotalBytes: 30,
      maxEntryBytes: 18
    });
    const selection = manager.select([
      {
        reference: { ref: 'duplicate-low', kind: 'SUMMARY', source: 'fixture' },
        content: 'same',
        priority: 1
      },
      {
        reference: { ref: 'duplicate-high', kind: 'SUMMARY', source: 'fixture' },
        content: 'same',
        priority: 10
      },
      {
        reference: { ref: 'unicode', kind: 'FILE', source: 'fixture' },
        content: '界'.repeat(20),
        priority: 9
      },
      {
        reference: { ref: 'tail', kind: 'LOG', source: 'fixture' },
        content: 'tail',
        priority: 8
      }
    ]);

    expect(selection.entries.map(({ reference }) => reference.ref)).toEqual([
      'duplicate-high',
      'unicode',
      'tail'
    ]);
    expect(selection.entries.every(({ reference }) => reference.contentHash?.length === 64)).toBe(
      true
    );
    expect(selection.entries.some(({ content }) => content.includes('\uFFFD'))).toBe(false);
    expect(selection.totalBytes).toBeLessThanOrEqual(30);
    expect(selection).toMatchObject({ omittedEntries: 1, truncatedEntries: 1 });
  });

  it('accounts every budget dimension and emits stable exhaustion details', () => {
    const manager = new BudgetManager({
      maxSteps: 1,
      maxToolCalls: 1,
      maxDurationMs: 100,
      maxChangedFiles: 1,
      maxInputTokens: 5,
      maxOutputTokens: 5,
      maxCost: 1,
      maxReadBytes: 10,
      maxVerificationRuns: 1
    });
    let state = runState(manager);
    state = manager.reserveStep(state);
    expect(() => manager.reserveStep(state)).toThrowError(
      expect.objectContaining({
        code: 'BUDGET_EXCEEDED',
        details: { category: 'MAX_STEPS', limit: 1, used: 1 }
      })
    );
    state = manager.reserveToolCall(state);
    state = manager.reserveVerification(state);
    state = manager.recordModelUsage(state, { inputTokens: 5, outputTokens: 5, cost: 1 });
    state = manager.recordReadBytes(state, 10);
    state = manager.recordChangedFiles(state, ['src/index.ts']);
    expect(() => manager.assertWithin(state)).not.toThrow();

    const overTokens = manager.recordModelUsage(state, {
      inputTokens: 1,
      outputTokens: 0,
      cost: 0
    });
    expect(() => manager.assertWithin(overTokens)).toThrowError(
      expect.objectContaining({
        code: 'BUDGET_EXCEEDED',
        details: { category: 'MAX_INPUT_TOKENS', limit: 5, used: 6 }
      })
    );
    expect(() =>
      manager.assertDuration(new Date(Date.now() - 101).toISOString(), state.budget)
    ).toThrowError(
      expect.objectContaining({
        code: 'BUDGET_EXCEEDED',
        details: expect.objectContaining({ category: 'MAX_DURATION', limit: 100 })
      })
    );
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekModelGateway } from '../src/adapters/deepseek-model-gateway.js';
import type { DecisionRequest } from '../src/ports/model-gateway.js';
import { contractSchemaVersion } from '../src/types.js';

const enabled = process.env.RUN_DEEPSEEK_LIVE === '1';

const request: DecisionRequest = {
  runState: {
    schemaVersion: contractSchemaVersion,
    runId: 'live-run',
    taskId: 'live-task',
    sessionId: 'live-session',
    phase: 'PLANNING',
    contextRefs: [],
    toolCallIds: [],
    changedFiles: [],
    verificationResultIds: [],
    budget: {
      maxSteps: 3,
      maxToolCalls: 3,
      maxDurationMs: 30_000,
      maxChangedFiles: 3,
      usedSteps: 0,
      usedToolCalls: 0
    }
  },
  context: [
    {
      reference: { ref: 'goal', kind: 'SUMMARY', source: 'user-goal' },
      content: 'Return a COMPLETE decision for a smoke test.'
    }
  ],
  availableTools: []
};

test('DeepSeek live smoke test', { skip: !enabled }, async () => {
  assert.ok(
    process.env.DEEPSEEK_API_KEY_FILE || process.env.DEEPSEEK_API_KEY,
    'Set DEEPSEEK_API_KEY_FILE or DEEPSEEK_API_KEY before running the live test'
  );
  const gateway = DeepSeekModelGateway.fromEnvironment();
  const response = await gateway.decide(request, AbortSignal.timeout(30_000));
  assert.ok(response.provider);
  assert.ok(response.model);
  assert.ok(response.usage.inputTokens >= 0);
  assert.ok(response.usage.outputTokens >= 0);
  assert.ok(
    ['TOOL_CALL', 'PLAN_UPDATE', 'ASK_USER', 'VERIFY', 'COMPLETE'].includes(response.decision.type)
  );

  const summary = await gateway.summarize(
    {
      goal: 'Smoke-test the model gateway',
      observations: ['The decision request completed successfully'],
      changedFiles: []
    },
    AbortSignal.timeout(30_000)
  );
  assert.ok(summary.summary.trim());
  assert.ok(summary.usage.inputTokens >= 0);
  assert.ok(summary.usage.outputTokens >= 0);
});

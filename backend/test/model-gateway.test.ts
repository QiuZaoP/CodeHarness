import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayConfig } from '../src/model-gateway/config.js';
import { loadGatewayConfig, resolveApiKey } from '../src/model-gateway/config.js';
import { loadConfig } from '../src/config.js';
import { ModelGatewayError } from '../src/model-gateway/errors.js';
import type { FetchLike, HttpResponse } from '../src/model-gateway/http.js';
import { GatewayMetrics } from '../src/model-gateway/metrics.js';
import { buildDecisionMessages } from '../src/model-gateway/prompts.js';
import { parseModelDecision } from '../src/model-gateway/structured.js';
import { DeepSeekModelGateway } from '../src/adapters/deepseek-model-gateway.js';
import { FakeModelGateway } from '../src/adapters/fake-model-gateway.js';
import { FallbackModelGateway } from '../src/adapters/fallback-model-gateway.js';
import { GuardedModelGateway } from '../src/adapters/guarded-model-gateway.js';
import type {
  DecisionRequest,
  DecisionResponse,
  EmbeddingResponse,
  ModelGateway,
  SummaryResponse
} from '../src/ports/model-gateway.js';
import { contractSchemaVersion, type RunState } from '../src/types.js';

function headers(values: Record<string, string> = {}) {
  return {
    get(name: string) {
      const key = Object.keys(values).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase()
      );
      return key ? values[key] : null;
    }
  };
}

function response(
  body: string,
  status = 200,
  headerValues: Record<string, string> = {}
): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers(headerValues),
    async text() {
      return body;
    }
  };
}

function streamResponse(
  content: string,
  usage = { prompt_tokens: 12, completion_tokens: 8 }
): HttpResponse {
  const sse = [
    `data: ${JSON.stringify({ model: 'deepseek-chat', choices: [{ delta: { content: content.slice(0, Math.ceil(content.length / 2)) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(Math.ceil(content.length / 2)) } }], usage })}\n\n`,
    'data: [DONE]\n\n'
  ];
  let index = 0;
  return {
    ...response('', 200),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= sse.length) return { done: true };
            return { done: false, value: new TextEncoder().encode(sse[index++]) };
          }
        };
      }
    }
  };
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const route = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://provider.test',
    apiKey: 'test-key-not-a-real-secret',
    inputPricePerMillion: 1,
    outputPricePerMillion: 2
  };
  return {
    chat: route,
    summary: { ...route },
    timeoutMs: 1_000,
    maxRetries: 1,
    retryBaseDelayMs: 0,
    circuitFailureThreshold: 3,
    circuitCooldownMs: 100,
    maxResponseBytes: 1024 * 1024,
    maxOutputTokens: 8_000,
    ...overrides
  };
}

const runState: RunState = {
  schemaVersion: contractSchemaVersion,
  runId: 'run-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  phase: 'PLANNING',
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

const decisionRequest: DecisionRequest = {
  runState,
  context: [
    {
      reference: { ref: 'goal', kind: 'SUMMARY', source: 'user-goal' },
      content: 'Inspect the repository'
    }
  ],
  availableTools: [
    {
      name: 'read_file',
      version: '1.0.0',
      description: 'Read a file',
      permission: 'READ',
      sideEffect: false,
      defaultTimeoutMs: 1_000,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' }
    }
  ]
};

test('loads an API key from the configured file without storing it in config output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codeharness-key-'));
  const keyPath = path.join(root, 'deepseek.key');
  await writeFile(keyPath, '\uFEFFfile-secret\n', 'utf8');
  try {
    const loaded = loadGatewayConfig({ DEEPSEEK_API_KEY_FILE: keyPath });
    assert.equal(loaded.chat.apiKey, undefined);
    assert.equal(resolveApiKey(loaded.chat), 'file-secret');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inherits chat cost prices for summary unless summary prices are explicitly configured', () => {
  const inherited = loadGatewayConfig({
    DEEPSEEK_API_KEY: 'fixture-key',
    DEEPSEEK_INPUT_PRICE_PER_MILLION: '1',
    DEEPSEEK_OUTPUT_PRICE_PER_MILLION: '2'
  });
  assert.equal(inherited.chat.inputPricePerMillion, 1);
  assert.equal(inherited.chat.outputPricePerMillion, 2);
  assert.equal(inherited.summary.inputPricePerMillion, 1);
  assert.equal(inherited.summary.outputPricePerMillion, 2);

  const overridden = loadGatewayConfig({
    DEEPSEEK_API_KEY: 'fixture-key',
    DEEPSEEK_INPUT_PRICE_PER_MILLION: '1',
    DEEPSEEK_OUTPUT_PRICE_PER_MILLION: '2',
    DEEPSEEK_SUMMARY_INPUT_PRICE_PER_MILLION: '3'
  });
  assert.equal(overridden.summary.inputPricePerMillion, 3);
  assert.equal(overridden.summary.outputPricePerMillion, 2);
});

test('keeps the outer model timeout aligned with the request timeout by default', () => {
  const gateway = loadGatewayConfig({ DEEPSEEK_API_KEY: 'fixture-key' });
  assert.equal(gateway.timeoutMs, 120_000);

  const configured = loadConfig({ MODEL_TIMEOUT_MS: '90000' });
  assert.equal(configured.maxModelTimeoutMs, 90_000);
});

test('validates every supported structured decision type and rejects invalid JSON', () => {
  assert.equal(
    parseModelDecision('{"type":"COMPLETE","reason":"done","summary":"ok"}').type,
    'COMPLETE'
  );
  assert.equal(
    parseModelDecision(
      '{"type":"COMPLETE","reason":"done","expectedObservation":null,"summary":"ok"}'
    ).type,
    'COMPLETE'
  );
  assert.equal(
    parseModelDecision('{"type":"VERIFY","reason":"check","commands":["npm test"]}').type,
    'VERIFY'
  );
  assert.equal(
    parseModelDecision('{"type":"ASK_USER","reason":"need input","question":"Continue?"}').type,
    'ASK_USER'
  );
  assert.equal(
    parseModelDecision(
      '{"type":"TOOL_CALL","reason":"inspect","tool":{"name":"read_file","arguments":{}}}'
    ).type,
    'TOOL_CALL'
  );
  assert.throws(
    () =>
      parseModelDecision(
        '{"type":"TOOL_CALL","reason":"inspect","tool":{"name":"unknown_tool","arguments":{}}}'
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category?: unknown } | undefined)?.category === 'INVALID_RESPONSE'
  );
  assert.equal(
    parseModelDecision(
      '{"type":"PLAN_UPDATE","reason":"plan","plan":{"goal":"g","assumptions":[],"steps":[{"id":"one","title":"Inspect","status":"PENDING"}],"verification":[]}}'
    ).type,
    'PLAN_UPDATE'
  );
  assert.throws(
    () => parseModelDecision('not-json'),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      const details = (error as ModelGatewayError).details as { category?: unknown } | undefined;
      assert.equal(details?.category, 'INVALID_RESPONSE');
      assert.equal(String(error).includes('not-json'), false);
      return true;
    }
  );
});

test('documents the boundary between file tools and allowlisted verification commands', () => {
  const systemPrompt = buildDecisionMessages(decisionRequest)[0]?.content ?? '';
  assert.match(systemPrompt, /read_file to read file contents/);
  assert.match(systemPrompt, /returns a context-bounded range of at most 200 lines by default/);
  assert.match(systemPrompt, /git_diff to inspect a complete diff/);
  assert.match(systemPrompt, /git diff or git diff --check as the final verification command/);
  assert.match(systemPrompt, /Never put cat/);
  assert.match(systemPrompt, /plan\.verification array contains acceptance criteria/);
  assert.match(systemPrompt, /not to a shell/);
  assert.match(systemPrompt, /run_command is an internal verification implementation/);
  assert.match(systemPrompt, /npm ci when package-lock\.json exists, otherwise npm install/);
  assert.match(systemPrompt, /3 to 5 outcome-oriented steps/);
  assert.match(systemPrompt, /avoid rerunning the same suite after every small patch/);
  assert.match(systemPrompt, /When the outcomes of the current RUNNING plan step are complete/);
  assert.match(systemPrompt, /After write_file succeeds or returns a CONFLICT\/NO_OP_WRITE result/);
});

test('places harness correction feedback in the trusted system instruction', () => {
  const instruction = 'Do not repeat read_file; apply the repair now.';
  const messages = buildDecisionMessages({ ...decisionRequest, harnessInstruction: instruction });
  assert.match(messages[0]?.content ?? '', /Trusted harness instruction/);
  assert.match(
    messages[0]?.content ?? '',
    new RegExp(instruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  assert.doesNotMatch(messages[1]?.content ?? '', /harness-validation/);
});

test('fake gateway summarizes project entry and stack questions from overview context', async () => {
  const gateway = new FakeModelGateway();
  const response = await gateway.decide(
    {
      ...decisionRequest,
      runState: {
        ...runState,
        phase: 'EXECUTING',
        plan: {
          goal: '项目入口在哪里，主要用了哪些技术栈',
          assumptions: [],
          steps: [
            { id: 'inspect', title: 'Inspect project files', status: 'DONE' },
            { id: 'verify', title: 'Run baseline verification', status: 'DONE' }
          ],
          verification: ['node --version']
        },
        toolCallIds: ['tool-1', 'tool-2', 'tool-3'],
        verificationResultIds: ['verification-1'],
        lastVerificationPassed: true
      },
      context: [
        {
          reference: { ref: 'goal', kind: 'SUMMARY', source: 'user-goal' },
          content: '项目入口在哪里，主要用了哪些技术栈'
        },
        {
          reference: { ref: 'overview', kind: 'PROJECT_OVERVIEW', source: 'code-index' },
          content: JSON.stringify({
            entryFiles: ['src/main.tsx', 'backend/src/server.ts'],
            languages: ['TypeScript', 'TSX'],
            buildCommands: ['npm run build']
          })
        }
      ]
    },
    new AbortController().signal
  );

  assert.equal(response.decision.type, 'COMPLETE');
  assert.match(response.decision.summary, /项目入口：src\/main\.tsx、backend\/src\/server\.ts/);
  assert.match(response.decision.summary, /主要技术栈：TypeScript、TSX/);
});

test('calls DeepSeek-compatible chat, validates the decision, emits stream events, and records metrics', async () => {
  const events: string[] = [];
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    requestBody = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    return streamResponse('{"type":"COMPLETE","reason":"verified","summary":"All good"}');
  };
  const gateway = new DeepSeekModelGateway(config(), { fetchImpl, sleep: async () => undefined });
  const result = await gateway.decide(decisionRequest, new AbortController().signal, (event) =>
    events.push(event.type)
  );
  assert.equal(result.decision.type, 'COMPLETE');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 8);
  assert.equal(result.usage.cost, 0.000028);
  assert.ok(events.includes('STRUCTURED_DELTA'));
  assert.ok(events.includes('USAGE'));
  assert.equal((requestBody?.response_format as { type: string }).type, 'json_object');
  assert.equal((requestBody?.thinking as { type: string }).type, 'disabled');
  assert.equal((requestBody?.messages as Array<{ role: string }>)[0].role, 'system');
  assert.equal(gateway.metrics.snapshot().successes, 1);
});

test('retries rate limits, honors retry-after, and does not leak the API key', async () => {
  let calls = 0;
  const secret = 'test-key-not-a-real-secret';
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) return response(`provider said ${secret}`, 429, { 'retry-after': '0' });
    return streamResponse('hello');
  };
  const gateway = new DeepSeekModelGateway(config({ maxRetries: 1 }), {
    fetchImpl,
    sleep: async () => undefined
  });
  await gateway.summarize(
    { goal: 'g', observations: [], changedFiles: [] },
    new AbortController().signal
  );
  assert.equal(calls, 2);
  assert.equal(gateway.metrics.snapshot().retries, 1);
  await assert.rejects(
    async () => {
      const broken = new DeepSeekModelGateway(config({ maxRetries: 0 }), {
        fetchImpl: async () => response(`failure ${secret}`, 500),
        sleep: async () => undefined
      });
      await broken.summarize(
        { goal: 'g', observations: [], changedFiles: [] },
        new AbortController().signal
      );
    },
    (error: unknown) => {
      assert.equal(String(error).includes(secret), false);
      return true;
    }
  );
});

test('times out an unresponsive provider and propagates caller cancellation', async () => {
  const fetchImpl: FetchLike = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  const gateway = new DeepSeekModelGateway(config({ timeoutMs: 10, maxRetries: 0 }), { fetchImpl });
  await assert.rejects(
    () =>
      gateway.summarize(
        { goal: 'g', observations: [], changedFiles: [] },
        new AbortController().signal
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category: string }).category === 'TIMEOUT'
  );
  const controller = new AbortController();
  const cancellation = new Error('caller stopped');
  controller.abort(cancellation);
  await assert.rejects(
    () => gateway.summarize({ goal: 'g', observations: [], changedFiles: [] }, controller.signal),
    (error: unknown) => error === cancellation
  );
});

test('timeout interrupts Retry-After backoff instead of waiting for the full delay', async () => {
  const gateway = new DeepSeekModelGateway(config({ timeoutMs: 20, maxRetries: 1 }), {
    fetchImpl: async () => response('', 429, { 'retry-after': '10' })
  });
  const started = performance.now();
  await assert.rejects(
    () =>
      gateway.summarize(
        { goal: 'g', observations: [], changedFiles: [] },
        new AbortController().signal
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category: string }).category === 'TIMEOUT'
  );
  assert.ok(performance.now() - started < 500);
});

test('limits streamed response bytes and records malformed decisions as failures', async () => {
  const tooLarge = new DeepSeekModelGateway(config({ maxResponseBytes: 100 }), {
    fetchImpl: async () => streamResponse('x'.repeat(500))
  });
  await assert.rejects(
    () =>
      tooLarge.summarize(
        { goal: 'g', observations: [], changedFiles: [] },
        new AbortController().signal
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category: string }).category === 'INVALID_RESPONSE'
  );

  const malformed = new DeepSeekModelGateway(config(), {
    fetchImpl: async () => streamResponse('{"type":"COMPLETE","reason":"","summary":"bad"}')
  });
  await assert.rejects(() => malformed.decide(decisionRequest, new AbortController().signal));
  const decideMetrics = malformed.metrics.snapshot().operations.decide;
  assert.equal(decideMetrics.successes, 0);
  assert.equal(decideMetrics.failures, 1);
});

test('does not open the provider circuit for non-retryable model response errors', async () => {
  let calls = 0;
  const gateway = new DeepSeekModelGateway(config({ circuitFailureThreshold: 1 }), {
    fetchImpl: async () => {
      calls += 1;
      return streamResponse('{"type":"COMPLETE","reason":"","summary":"bad"}');
    }
  });
  await assert.rejects(() => gateway.decide(decisionRequest, new AbortController().signal));
  await assert.rejects(() => gateway.decide(decisionRequest, new AbortController().signal));
  assert.equal(calls, 2);
  assert.equal(gateway.circuitStates().chat.state, 'CLOSED');
});

test('opens a circuit after repeated provider failures', async () => {
  const gateway = new DeepSeekModelGateway(config({ maxRetries: 0, circuitFailureThreshold: 1 }), {
    fetchImpl: async () => response('', 503)
  });
  const summary = { goal: 'g', observations: [], changedFiles: [] };
  await assert.rejects(() => gateway.summarize(summary, new AbortController().signal));
  await assert.rejects(
    () => gateway.summarize(summary, new AbortController().signal),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category: string }).category === 'CIRCUIT_OPEN'
  );
});

test('reports that embeddings need a separately configured embedding route', async () => {
  const gateway = new DeepSeekModelGateway(config(), {
    fetchImpl: async () => streamResponse('unused')
  });
  await assert.rejects(
    () => gateway.embed({ inputs: ['hello'] }, new AbortController().signal),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category: string }).category === 'NOT_SUPPORTED'
  );
});

test('uses configurable OpenAI-compatible embedding and rerank routes', async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.endsWith('/embeddings')) {
      return response(
        JSON.stringify({
          model: 'embedding-fixture',
          data: [{ embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 4 }
        })
      );
    }
    return response(
      JSON.stringify({
        model: 'rerank-fixture',
        results: [{ index: 1, relevance_score: 0.9 }]
      })
    );
  };
  const gateway = new DeepSeekModelGateway(
    config({
      embedding: {
        provider: 'embedding-fixture',
        model: 'embedding-fixture',
        baseUrl: 'https://embedding.test',
        apiKey: 'embedding-key',
        inputPricePerMillion: 0.1,
        outputPricePerMillion: 0
      },
      rerank: {
        provider: 'rerank-fixture',
        model: 'rerank-fixture',
        baseUrl: 'https://rerank.test',
        apiKey: 'rerank-key',
        inputPricePerMillion: 0,
        outputPricePerMillion: 0
      }
    }),
    { fetchImpl, sleep: async () => undefined }
  );
  const embedding = await gateway.embed({ inputs: ['hello'] }, new AbortController().signal);
  const rerank = await gateway.rerank(
    { query: 'hello', documents: ['one', 'two'] },
    new AbortController().signal
  );
  assert.deepEqual(embedding.vectors, [[0.1, 0.2]]);
  assert.equal(embedding.provider, 'embedding-fixture');
  assert.deepEqual(rerank.results, [{ index: 1, score: 0.9 }]);
  assert.equal(rerank.provider, 'rerank-fixture');
  assert.deepEqual(calls, ['https://embedding.test/embeddings', 'https://rerank.test/rerank']);
});

function gatewayFixture(response: DecisionResponse): ModelGateway {
  return {
    async decide() {
      return response;
    },
    async summarize(): Promise<SummaryResponse> {
      return { summary: 'fallback', usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async embed(): Promise<EmbeddingResponse> {
      return { vectors: [[1]], model: 'fallback', provider: 'fallback', usage: { inputTokens: 0 } };
    }
  };
}

test('falls back to the secondary gateway for provider failures', async () => {
  const primary: ModelGateway = {
    async decide(): Promise<DecisionResponse> {
      throw new ModelGatewayError('primary down', 'PROVIDER');
    },
    async summarize(): Promise<SummaryResponse> {
      throw new ModelGatewayError('primary down', 'PROVIDER');
    },
    async embed(): Promise<EmbeddingResponse> {
      throw new ModelGatewayError('primary down', 'PROVIDER');
    }
  };
  const fallback = gatewayFixture({
    decision: { type: 'COMPLETE', reason: 'fallback', summary: 'ok' },
    model: 'backup',
    provider: 'backup',
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1
  });
  const gateway = new FallbackModelGateway(primary, fallback);
  assert.equal(
    (await gateway.decide(decisionRequest, new AbortController().signal)).provider,
    'backup'
  );
});

test('does not fall back after a primary stream has already emitted content', async () => {
  let fallbackCalls = 0;
  const primary: ModelGateway = {
    async decide(_request, _signal, onStreamEvent) {
      onStreamEvent?.({ type: 'STRUCTURED_DELTA', delta: '{"type":"' });
      throw new ModelGatewayError('stream interrupted', 'PROVIDER');
    },
    async summarize() {
      throw new ModelGatewayError('stream interrupted', 'PROVIDER');
    },
    async embed() {
      throw new ModelGatewayError('primary down', 'PROVIDER');
    }
  };
  const fallback: ModelGateway = {
    async decide() {
      fallbackCalls += 1;
      throw new Error('should not run');
    },
    async summarize(): Promise<SummaryResponse> {
      return { summary: 'fallback', usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async embed(): Promise<EmbeddingResponse> {
      return { vectors: [[1]], model: 'fallback', provider: 'fallback', usage: { inputTokens: 0 } };
    }
  };
  const gateway = new FallbackModelGateway(primary, fallback);
  await assert.rejects(() => gateway.decide(decisionRequest, new AbortController().signal));
  assert.equal(fallbackCalls, 0);
});

test('GuardedModelGateway rejects malformed adapter responses', async () => {
  const malformed = gatewayFixture({
    decision: { type: 'COMPLETE', reason: '', summary: '' } as never,
    model: '',
    provider: '',
    usage: { inputTokens: -1, outputTokens: 0 },
    durationMs: -1
  });
  const guarded = new GuardedModelGateway(malformed, 100);
  await assert.rejects(
    () => guarded.decide(decisionRequest, new AbortController().signal),
    (error: unknown) =>
      error instanceof ModelGatewayError &&
      (error.details as { category: string }).category === 'INVALID_RESPONSE'
  );
});

test('exposes stable zero-valued metrics before any call', () => {
  const metrics = new GatewayMetrics();
  assert.deepEqual(metrics.snapshot(), {
    totalCalls: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    averageLatencyMs: 0,
    operations: {}
  });
});

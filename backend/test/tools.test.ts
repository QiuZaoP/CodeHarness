import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import type { ToolExecutionContext } from '../src/ports/tool-registry.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ToolExecutor } from '../src/tools.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../src/types.js';
import { WorkspaceManager } from '../src/workspace.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(): Promise<{
  root: string;
  workspace: string;
  tools: ToolExecutor;
  context: ToolExecutionContext;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-tools-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'README.md'), 'first\nsecond\nthird\n');
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'tool-fixture',
      private: true,
      scripts: {
        noisy: `node -e "process.stdout.write('x'.repeat(${config.maxCommandOutputBytes + 100_000}))"`,
        slow: 'node -e "setTimeout(() => {}, 5000)"'
      }
    })
  );
  const manager = new WorkspaceManager({ root: path.join(root, 'managed') });
  const task = await manager.createTaskWorkspace(randomUUID(), randomUUID(), source);
  const registry = new ToolRegistry(config.maxToolArgumentBytes, config.maxCommandOutputBytes * 2);
  return {
    root,
    workspace: task.workspacePath,
    tools: new ToolExecutor(manager, registry),
    context: {
      workspacePath: task.workspacePath,
      permissions: ['READ', 'WRITE', 'COMMAND']
    }
  };
}

function output<T>(result: ToolResult): T {
  expect(result.status, JSON.stringify(result)).toBe('SUCCEEDED');
  return result.output as T;
}

describe('registered tool runtime', () => {
  it('validates registration, arguments, output and permissions before execution', async () => {
    const { tools, context } = await fixture();
    expect(tools.definitions().map(({ name }) => name)).toEqual([
      'list_files',
      'search_text',
      'read_file',
      'write_file',
      'apply_patch',
      'git_status',
      'git_diff',
      'run_command'
    ]);

    let calls = 0;
    const definition: ToolDefinition = {
      name: 'search_symbol',
      version: '1.0.0',
      description: 'Fixture role-three tool',
      permission: 'READ',
      sideEffect: false,
      defaultTimeoutMs: 1_000,
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string', minLength: 1 } },
        additionalProperties: false
      },
      outputSchema: {
        type: 'array',
        items: { type: 'string' }
      }
    };
    tools.register(definition, async (arguments_) => {
      calls += 1;
      return { output: [arguments_.query] };
    });

    const invalid = await tools.execute(
      { name: 'search_symbol', arguments: { unexpected: true } },
      context
    );
    expect(invalid).toMatchObject({
      status: 'FAILED',
      error: { code: 'VALIDATION_ERROR', retryable: false }
    });
    expect(calls).toBe(0);

    const forbidden = await tools.execute(
      { name: 'search_symbol', arguments: { query: 'Task' } },
      { ...context, permissions: [] }
    );
    expect(forbidden).toMatchObject({
      status: 'FAILED',
      error: { code: 'FORBIDDEN', retryable: false }
    });
    expect(calls).toBe(0);

    expect(
      output<string[]>(
        await tools.execute({ name: 'search_symbol', arguments: { query: 'Task' } }, context)
      )
    ).toEqual(['Task']);
    expect(calls).toBe(1);
    expect(() => tools.register(definition, async () => ({ output: [] }))).toThrow(
      'already registered'
    );

    tools.register(
      { ...definition, name: 'read_ast', description: 'Invalid output fixture' },
      async () => ({ output: { not: 'an array' } })
    );
    expect(
      await tools.execute({ name: 'read_ast', arguments: { query: 'Task' } }, context)
    ).toMatchObject({
      status: 'FAILED',
      error: { code: 'INTERNAL_ERROR', retryable: false }
    });

    expect(
      await tools.execute(
        {
          name: 'search_symbol',
          arguments: { query: 'x'.repeat(config.maxToolArgumentBytes) }
        },
        context
      )
    ).toMatchObject({
      status: 'FAILED',
      error: { code: 'VALIDATION_ERROR', retryable: false }
    });
    expect(calls).toBe(1);

    const boundedRegistry = new ToolRegistry(config.maxToolArgumentBytes, 32);
    boundedRegistry.register(definition, async () => ({ output: ['x'.repeat(64)] }));
    expect(
      await boundedRegistry.execute(
        { name: 'search_symbol', arguments: { query: 'Task' } },
        context
      )
    ).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'WORKSPACE_ERROR',
        details: { category: 'OUTPUT_LIMIT' },
        retryable: false
      }
    });
  }, 15_000);

  it('applies hash-checked structured edits and reports complete file changes', async () => {
    const { workspace, tools, context } = await fixture();
    const read = output<{ hash: string; content: string }>(
      await tools.execute({ name: 'read_file', arguments: { path: 'README.md' } }, context)
    );
    expect(read.content).toBe('first\nsecond\nthird\n');

    const patched = output<{ hash: string; previousHash: string }>(
      await tools.execute(
        {
          name: 'apply_patch',
          arguments: {
            path: 'README.md',
            expectedHash: read.hash,
            edits: [{ startLine: 2, deleteCount: 1, lines: ['changed', 'inserted'] }]
          }
        },
        context
      )
    );
    expect(patched.previousHash).toBe(read.hash);
    expect(await fs.readFile(path.join(workspace, 'README.md'), 'utf8')).toBe(
      'first\nchanged\ninserted\nthird\n'
    );

    const stale = await tools.execute(
      {
        name: 'apply_patch',
        arguments: {
          path: 'README.md',
          expectedHash: read.hash,
          edits: [{ startLine: 1, deleteCount: 1, lines: ['stale'] }]
        }
      },
      context
    );
    expect(stale).toMatchObject({
      status: 'FAILED',
      error: { code: 'CONFLICT', retryable: false }
    });

    const created = await tools.execute(
      { name: 'write_file', arguments: { path: 'new.txt', content: 'created\n' } },
      context
    );
    expect(created).toMatchObject({
      status: 'SUCCEEDED',
      affectedFiles: ['new.txt']
    });
    const blindOverwrite = await tools.execute(
      { name: 'write_file', arguments: { path: 'new.txt', content: 'overwrite\n' } },
      context
    );
    expect(blindOverwrite).toMatchObject({
      status: 'FAILED',
      error: { code: 'CONFLICT' }
    });

    const diff = output<string>(await tools.execute({ name: 'git_diff', arguments: {} }, context));
    expect(diff).toContain('diff --git a/README.md b/README.md');
    expect(diff).toContain('diff --git a/new.txt b/new.txt');
    expect(
      await tools.execute({ name: 'read_file', arguments: { path: '../outside.txt' } }, context)
    ).toMatchObject({ status: 'FAILED', error: { code: 'FORBIDDEN' } });

    await fs.writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    expect(
      await tools.execute({ name: 'read_file', arguments: { path: 'binary.bin' } }, context)
    ).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'WORKSPACE_ERROR',
        details: { category: 'BINARY_FILE' },
        retryable: false
      }
    });
  }, 15_000);

  it('enforces command policy, truncates output, times out, and honours cancellation', async () => {
    const { tools, context } = await fixture();
    const version = output<{ code: number; stdout: string }>(
      await tools.execute(
        {
          name: 'run_command',
          arguments: { executable: 'node', args: ['--version'] }
        },
        context
      )
    );
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^v\d+/);

    for (const call of [
      {
        name: 'run_command',
        arguments: { executable: 'node', args: ['--version;whoami'] }
      },
      {
        name: 'run_command',
        arguments: { executable: 'npm', args: ['install'] }
      }
    ] satisfies ToolCall[]) {
      expect(await tools.execute(call, context)).toMatchObject({
        status: 'FAILED',
        error: { code: 'COMMAND_NOT_ALLOWED', retryable: false }
      });
    }

    const noisy = output<{
      code: number;
      stdout: string;
      stdoutBytes: number;
      truncated: boolean;
    }>(
      await tools.execute(
        {
          name: 'run_command',
          arguments: { executable: 'npm', args: ['run', 'noisy'] }
        },
        context
      )
    );
    expect(noisy.code).toBe(0);
    expect(noisy.stdoutBytes).toBeGreaterThan(config.maxCommandOutputBytes);
    expect(Buffer.byteLength(noisy.stdout, 'utf8')).toBeLessThanOrEqual(
      config.maxCommandOutputBytes
    );
    expect(noisy.truncated).toBe(true);

    const timedOut = await tools.execute(
      {
        name: 'run_command',
        arguments: { executable: 'npm', args: ['run', 'slow'], timeoutMs: 100 }
      },
      context
    );
    expect(timedOut).toMatchObject({
      status: 'FAILED',
      error: { code: 'WORKSPACE_ERROR', retryable: true }
    });
    expect(timedOut.durationMs).toBeLessThan(4_000);

    const controller = new AbortController();
    const cancelledPromise = tools.execute(
      {
        name: 'run_command',
        arguments: { executable: 'npm', args: ['run', 'slow'] }
      },
      { ...context, signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 100);
    expect(await cancelledPromise).toMatchObject({
      status: 'CANCELLED',
      error: { code: 'TASK_CANCELLED', retryable: false }
    });
  }, 20_000);

  it('serializes side-effect tools for the same workspace', async () => {
    const { tools, context } = await fixture();
    let active = 0;
    let maximumActive = 0;
    const definition: ToolDefinition = {
      name: 'search_symbol',
      version: '1.0.0',
      description: 'Serialized fixture',
      permission: 'WRITE',
      sideEffect: true,
      defaultTimeoutMs: 2_000,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'boolean' }
    };
    tools.register(definition, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      return { output: true };
    });
    const call: ToolCall = { name: 'search_symbol', arguments: {} };
    const [first, second] = await Promise.all([
      tools.execute(call, context),
      tools.execute(call, context)
    ]);
    expect(first.status).toBe('SUCCEEDED');
    expect(second.status).toBe('SUCCEEDED');
    expect(maximumActive).toBe(1);

    let cleanupComplete = false;
    tools.register(
      {
        ...definition,
        name: 'read_ast',
        description: 'Cancellation cleanup fixture',
        defaultTimeoutMs: 1_000
      },
      async (_arguments, executionContext) => {
        await new Promise<void>((resolve) => {
          const cleanup = () => setTimeout(resolve, 50);
          if (executionContext.signal?.aborted) cleanup();
          else executionContext.signal?.addEventListener('abort', cleanup, { once: true });
        });
        cleanupComplete = true;
        throw executionContext.signal?.reason;
      }
    );
    const controller = new AbortController();
    const cancelled = tools.execute(
      { name: 'read_ast', arguments: {} },
      { ...context, signal: controller.signal }
    );
    controller.abort();
    expect(await cancelled).toMatchObject({ status: 'CANCELLED' });
    expect(cleanupComplete).toBe(true);
  }, 15_000);
});

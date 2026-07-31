import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { parseAllowedCommand } from '../src/command-runner.js';
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
  it('parses verification commands using the same command policy as run_command', () => {
    expect(parseAllowedCommand('git diff')).toEqual({ executable: 'git', args: ['diff'] });
    expect(parseAllowedCommand('git diff --check')).toEqual({
      executable: 'git',
      args: ['diff', '--check']
    });
    expect(parseAllowedCommand('node --check src/main.mjs')).toEqual({
      executable: 'node',
      args: ['--check', 'src/main.mjs']
    });
    expect(parseAllowedCommand('node --test backend/test/campus-eats.test.js')).toEqual({
      executable: 'node',
      args: ['--test', 'backend/test/campus-eats.test.js']
    });
    expect(() => parseAllowedCommand('node --test ../outside.test.js')).toThrow(
      'Executable or subcommand is not allowed by policy'
    );
    expect(parseAllowedCommand('python -m pytest tests/test_parser.py -x --timeout=20')).toEqual({
      executable: 'python',
      args: ['-m', 'pytest', 'tests/test_parser.py', '-x', '--timeout=20']
    });
    expect(parseAllowedCommand('pytest tests/test_parser.py')).toEqual({
      executable: 'pytest',
      args: ['tests/test_parser.py']
    });
    expect(parseAllowedCommand('npm install')).toEqual({ executable: 'npm', args: ['install'] });
    expect(parseAllowedCommand('npm ci')).toEqual({ executable: 'npm', args: ['ci'] });
    expect(() => parseAllowedCommand('npm install some-package')).toThrow(
      'Executable or subcommand is not allowed by policy'
    );
    expect(() => parseAllowedCommand('python scripts/check.py')).toThrow(
      'Executable or subcommand is not allowed by policy'
    );
    expect(() => parseAllowedCommand('python -m pytest ../outside.py')).toThrow(
      'Executable or subcommand is not allowed by policy'
    );
    expect(() => parseAllowedCommand('cat tests/conftest.py')).toThrow(
      'Verification command is not allowed by policy'
    );
    expect(() => parseAllowedCommand('git diff -- tests/conftest.py')).toThrow(
      'Executable or subcommand is not allowed by policy'
    );
  });

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
    const read = output<{
      hash: string;
      content: string;
      lineCount: number;
      numberedContent: string;
    }>(await tools.execute({ name: 'read_file', arguments: { path: 'README.md' } }, context));
    expect(read.content).toBe('first\nsecond\nthird\n');
    expect(read.lineCount).toBe(3);
    expect(read.numberedContent).toBe('1 | first\n2 | second\n3 | third');

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

    const invalidPatch = await tools.execute(
      {
        name: 'apply_patch',
        arguments: {
          path: 'README.md',
          expectedHash: patched.hash,
          edits: [
            { startLine: 1, deleteCount: 1, lines: ['first'] },
            { startLine: 1, deleteCount: 0, lines: ['duplicate range'] }
          ]
        }
      },
      context
    );
    expect(invalidPatch).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'VALIDATION_ERROR',
        details: {
          category: 'INVALID_PATCH_EDITS',
          lineCount: expect.any(Number),
          hint: expect.stringContaining('one edit')
        }
      }
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
      }
    ] satisfies ToolCall[]) {
      expect(await tools.execute(call, context)).toMatchObject({
        status: 'FAILED',
        error: { code: 'COMMAND_NOT_ALLOWED', retryable: false }
      });
    }

    const inheritedNpmExecPath = process.env.npm_execpath;
    delete process.env.npm_execpath;
    let install: ToolResult;
    try {
      install = await tools.execute(
        { name: 'run_command', arguments: { executable: 'npm', args: ['install'] } },
        context
      );
    } finally {
      if (inheritedNpmExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = inheritedNpmExecPath;
    }
    const installOutput = output<{ code: number }>(install);
    expect(installOutput.code).toBe(0);
    expect(
      await tools.execute(
        {
          name: 'run_command',
          arguments: { executable: 'npm', args: ['install', 'unapproved-package'] }
        },
        context
      )
    ).toMatchObject({
      status: 'FAILED',
      error: { code: 'COMMAND_NOT_ALLOWED', retryable: false }
    });

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

  it('accepts CRLF as a line ending in diff whitespace verification', async () => {
    const { workspace, tools, context } = await fixture();
    await fs.writeFile(path.join(workspace, 'README.md'), 'first\r\nsecond\r\nthird\r\n', 'utf8');

    const result = output<{ code: number; stdout: string; stderr: string }>(
      await tools.execute(
        { name: 'run_command', arguments: { executable: 'git', args: ['diff', '--check'] } },
        context
      )
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');

    await fs.writeFile(path.join(workspace, 'README.md'), 'first\r\nsecond \r\nthird\r\n', 'utf8');
    const whitespaceError = output<{ code: number; stdout: string }>(
      await tools.execute(
        { name: 'run_command', arguments: { executable: 'git', args: ['diff', '--check'] } },
        context
      )
    );
    expect(whitespaceError.code).toBe(2);
    expect(whitespaceError.stdout).toContain('trailing whitespace');
  });

  it('reads large files in stable line ranges without losing original line numbers', async () => {
    const { workspace, tools, context } = await fixture();
    const content = Array.from({ length: 205 }, (_, index) => `line ${index + 1}`).join('\n');
    await fs.writeFile(path.join(workspace, 'long.txt'), `${content}\n`);

    const first = output<{
      content: string;
      lineCount: number;
      startLine: number;
      endLine: number;
      hasMore: boolean;
      numberedContent: string;
      hash: string;
    }>(await tools.execute({ name: 'read_file', arguments: { path: 'long.txt' } }, context));
    const second = output<typeof first>(
      await tools.execute(
        { name: 'read_file', arguments: { path: 'long.txt', startLine: 201 } },
        context
      )
    );

    expect(first).toMatchObject({ lineCount: 205, startLine: 1, endLine: 200, hasMore: true });
    expect(first.numberedContent).toContain('  1 | line 1');
    expect(first.numberedContent).toContain('200 | line 200');
    expect(second).toMatchObject({ lineCount: 205, startLine: 201, endLine: 205, hasMore: false });
    expect(second.numberedContent).toBe(
      [
        '201 | line 201',
        '202 | line 202',
        '203 | line 203',
        '204 | line 204',
        '205 | line 205'
      ].join('\n')
    );
    expect(second.hash).toBe(first.hash);
  });

  it('bounds read ranges by serialized context size as well as line count', async () => {
    const { workspace, tools, context } = await fixture();
    const content = Array.from(
      { length: 30 },
      (_, index) => `${index + 1}:${'x'.repeat(1_000)}`
    ).join('\n');
    await fs.writeFile(path.join(workspace, 'wide.txt'), `${content}\n`);

    const read = output<{
      lineCount: number;
      startLine: number;
      endLine: number;
      hasMore: boolean;
      numberedContent: string;
    }>(await tools.execute({ name: 'read_file', arguments: { path: 'wide.txt' } }, context));

    expect(read).toMatchObject({ lineCount: 30, startLine: 1, hasMore: true });
    expect(read.endLine).toBeLessThan(30);
    expect(Buffer.byteLength(JSON.stringify(read.numberedContent))).toBeLessThanOrEqual(
      Math.floor(config.maxContextEntryBytes * 0.75) + 2
    );
  });

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

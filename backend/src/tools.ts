import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  assertCommandAllowed,
  ControlledCommandRunner,
  type CommandOutput,
  type CommandRequest
} from './command-runner.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import type {
  ToolExecutionContext,
  ToolHandler,
  ToolRegistrationPort
} from './ports/tool-registry.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolCall, ToolDefinition, ToolPermission, ToolResult } from './types.js';
import type { WorkspaceManager } from './workspace.js';
import type { CodeIndexService } from './code-index.js';

interface ReadFileOutput {
  path: string;
  content: string;
  lineCount: number;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  numberedContent: string;
  hash: string;
  bytes: number;
}

interface FileWriteOutput {
  path: string;
  previousHash?: string;
  hash: string;
  bytes: number;
}

interface PatchEdit {
  startLine: number;
  deleteCount: number;
  lines: string[];
}

const sha256Pattern = '^[0-9a-f]{64}$';
const relativePathSchema = { type: 'string', minLength: 1, maxLength: 4_096 } as const;
const defaultReadFileLines = 200;

const definitions: ToolDefinition[] = [
  {
    name: 'list_files',
    version: '1.0.0',
    description: 'List direct children of a task workspace directory',
    permission: 'READ',
    sideEffect: false,
    defaultTimeoutMs: 5_000,
    inputSchema: {
      type: 'object',
      properties: { path: relativePathSchema },
      additionalProperties: false
    },
    outputSchema: {
      type: 'array',
      maxItems: 20_000,
      items: { type: 'string' }
    }
  },
  {
    name: 'search_text',
    version: '1.0.0',
    description: 'Search bounded text files in a task workspace',
    permission: 'READ',
    sideEffect: false,
    defaultTimeoutMs: 10_000,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1_000 },
        path: relativePathSchema,
        maxResults: { type: 'integer', minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    },
    outputSchema: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['path', 'line', 'text'],
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          text: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    name: 'read_file',
    version: '1.1.0',
    description: 'Read a bounded line range from a UTF-8 text file with its full-file content hash',
    permission: 'READ',
    sideEffect: false,
    defaultTimeoutMs: 5_000,
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: relativePathSchema,
        startLine: { type: 'integer', minimum: 1 },
        maxLines: { type: 'integer', minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      required: [
        'path',
        'content',
        'lineCount',
        'startLine',
        'endLine',
        'hasMore',
        'numberedContent',
        'hash',
        'bytes'
      ],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        lineCount: { type: 'integer', minimum: 0 },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 0 },
        hasMore: { type: 'boolean' },
        numberedContent: { type: 'string' },
        hash: { type: 'string', pattern: sha256Pattern },
        bytes: { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'write_file',
    version: '1.0.0',
    description: 'Create a file or replace a hash-matched file atomically',
    permission: 'WRITE',
    sideEffect: true,
    defaultTimeoutMs: 5_000,
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: relativePathSchema,
        content: { type: 'string' },
        expectedHash: { type: 'string', pattern: sha256Pattern }
      },
      additionalProperties: false
    },
    outputSchema: fileWriteOutputSchema()
  },
  {
    name: 'apply_patch',
    version: '1.0.0',
    description: 'Apply non-overlapping line edits to a hash-matched text file',
    permission: 'WRITE',
    sideEffect: true,
    defaultTimeoutMs: 5_000,
    inputSchema: {
      type: 'object',
      required: ['path', 'expectedHash', 'edits'],
      properties: {
        path: relativePathSchema,
        expectedHash: { type: 'string', pattern: sha256Pattern },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 1_000,
          items: {
            type: 'object',
            required: ['startLine', 'deleteCount', 'lines'],
            properties: {
              startLine: { type: 'integer', minimum: 1 },
              deleteCount: { type: 'integer', minimum: 0 },
              lines: {
                type: 'array',
                maxItems: 10_000,
                items: { type: 'string', pattern: '^[^\\r\\n]*$' }
              }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    outputSchema: fileWriteOutputSchema()
  },
  {
    name: 'git_status',
    version: '1.0.0',
    description: 'Read the isolated task repository status',
    permission: 'READ',
    sideEffect: false,
    defaultTimeoutMs: 5_000,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      required: ['clean', 'entries'],
      properties: {
        clean: { type: 'boolean' },
        entries: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    }
  },
  {
    name: 'git_diff',
    version: '1.0.0',
    description: 'Read a complete diff without mutating the task repository index',
    permission: 'READ',
    sideEffect: false,
    defaultTimeoutMs: 10_000,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'string' }
  },
  {
    name: 'run_command',
    version: '1.0.0',
    description: 'Run an allowlisted executable and subcommand without a shell',
    permission: 'COMMAND',
    sideEffect: true,
    defaultTimeoutMs: config.maxCommandTimeoutMs + 1_000,
    inputSchema: {
      type: 'object',
      required: ['executable', 'args'],
      properties: {
        executable: { type: 'string', enum: ['node', 'npm', 'python', 'pytest', 'git'] },
        args: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', maxLength: 1_000 }
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: config.maxCommandTimeoutMs
        }
      },
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      required: ['code', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes', 'truncated'],
      properties: {
        code: { type: 'integer' },
        signal: { type: 'string' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        stdoutBytes: { type: 'integer', minimum: 0 },
        stderrBytes: { type: 'integer', minimum: 0 },
        truncated: { type: 'boolean' }
      },
      additionalProperties: false
    }
  }
];

function fileWriteOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['path', 'hash', 'bytes'],
    properties: {
      path: { type: 'string' },
      previousHash: { type: 'string', pattern: sha256Pattern },
      hash: { type: 'string', pattern: sha256Pattern },
      bytes: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  };
}

function contentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizedRelative(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export class ToolExecutor implements ToolRegistrationPort {
  private readonly registry: ToolRegistry;
  private readonly index?: CodeIndexService;
  private readonly commandRunner = new ControlledCommandRunner(
    config.maxCommandTimeoutMs,
    config.maxCommandOutputBytes
  );

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    registryOrIndex: ToolRegistry | CodeIndexService = new ToolRegistry(
      config.maxToolArgumentBytes,
      config.maxToolOutputBytes
    ),
    index?: CodeIndexService
  ) {
    if (registryOrIndex instanceof ToolRegistry) {
      this.registry = registryOrIndex;
      this.index = index;
    } else {
      this.registry = new ToolRegistry(config.maxToolArgumentBytes, config.maxToolOutputBytes);
      this.index = registryOrIndex;
    }
    this.registerBuiltins();
  }

  async indexRepository(projectId: string, workspace: string): Promise<void> {
    await this.index?.build(projectId, workspace);
  }

  searchSymbols(projectId: string, query: string) {
    return this.index?.searchSymbols(projectId, query) ?? [];
  }

  searchFiles(projectId: string, query: string) {
    return this.index?.searchFiles(projectId, query) ?? [];
  }

  findReferences(projectId: string, name: string) {
    return this.index?.findReferences(projectId, name) ?? [];
  }

  findCallers(projectId: string, callee: string) {
    return this.index?.findCallers(projectId, callee) ?? [];
  }

  findCallees(projectId: string, caller: string) {
    return this.index?.findCallees(projectId, caller) ?? [];
  }

  async searchSemantic(projectId: string, query: string) {
    return this.index?.searchSemantic(projectId, query) ?? { mode: 'lexical' as const, items: [] };
  }

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.registry.register(definition, handler);
  }

  definitions(): ToolDefinition[] {
    return this.registry.definitions();
  }

  validate(call: ToolCall, permissions: readonly ToolPermission[]): void {
    this.registry.validate(call, permissions);
  }

  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    return this.registry.execute(call, context);
  }

  private registerBuiltins(): void {
    const handlers: Partial<Record<ToolCall['name'], ToolHandler>> = {
      list_files: (arguments_, context) => this.listFiles(arguments_, context),
      search_text: (arguments_, context) => this.searchText(arguments_, context),
      read_file: (arguments_, context) => this.readFile(arguments_, context),
      write_file: (arguments_, context) => this.writeFile(arguments_, context),
      apply_patch: (arguments_, context) => this.applyPatch(arguments_, context),
      git_status: (_arguments, context) => this.gitStatus(context),
      git_diff: (_arguments, context) => this.gitDiff(context),
      run_command: (arguments_, context) => this.runCommand(arguments_, context)
    };
    for (const definition of definitions) {
      const handler = handlers[definition.name];
      if (!handler) {
        throw new AppError('INTERNAL_ERROR', 'Built-in tool handler is missing', {
          toolName: definition.name
        });
      }
      this.registry.register(definition, handler);
    }
  }

  private async listFiles(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ output: string[] }> {
    this.throwIfAborted(context.signal);
    const requestedPath = (arguments_.path as string | undefined) ?? '.';
    const directory = await this.workspaceManager.resolve(context.workspacePath, requestedPath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return {
      output: entries
        .filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink())
        .map((entry) => normalizedRelative(path.join(requestedPath, entry.name)))
        .sort()
    };
  }

  private async readFile(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ output: ReadFileOutput }> {
    const requestedPath = arguments_.path as string;
    const startLine = (arguments_.startLine as number | undefined) ?? 1;
    const maxLines = (arguments_.maxLines as number | undefined) ?? defaultReadFileLines;
    const file = await this.readTextFile(context.workspacePath, requestedPath, context.signal);
    if (startLine > Math.max(1, file.lineCount)) {
      throw new AppError('VALIDATION_ERROR', 'Requested line range starts beyond the file', {
        path: requestedPath,
        startLine,
        lineCount: file.lineCount
      });
    }
    const lines = this.fileLines(file.content);
    const selectedLines = this.boundedReadLines(lines, startLine, maxLines);
    const endLine = selectedLines.length === 0 ? 0 : startLine + selectedLines.length - 1;
    const wholeFile = startLine === 1 && selectedLines.length === lines.length;
    const eol = file.content.includes('\r\n') ? '\r\n' : file.content.includes('\r') ? '\r' : '\n';
    return {
      output: {
        ...file,
        content: wholeFile ? file.content : selectedLines.join(eol),
        startLine,
        endLine,
        hasMore: endLine < file.lineCount,
        numberedContent: this.numberedLines(selectedLines, startLine, file.lineCount)
      }
    };
  }

  private async searchText(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ output: Array<{ path: string; line: number; text: string }> }> {
    const query = arguments_.query as string;
    const requestedRoot = (arguments_.path as string | undefined) ?? '.';
    const maxResults = (arguments_.maxResults as number | undefined) ?? 200;
    const results: Array<{ path: string; line: number; text: string }> = [];

    const walk = async (relativeDirectory: string): Promise<void> => {
      this.throwIfAborted(context.signal);
      const directory = await this.workspaceManager.resolve(
        context.workspacePath,
        relativeDirectory
      );
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (
          results.length >= maxResults ||
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.isSymbolicLink()
        ) {
          continue;
        }
        const relative = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          await walk(relative);
          continue;
        }
        let file: ReadFileOutput;
        try {
          file = await this.readTextFile(context.workspacePath, relative, context.signal);
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === 'WORKSPACE_ERROR' &&
            typeof error.details === 'object' &&
            error.details !== null &&
            'category' in error.details &&
            ['BINARY_FILE', 'FILE_TOO_LARGE'].includes(
              String((error.details as { category: unknown }).category)
            )
          ) {
            continue;
          }
          throw error;
        }
        for (const [index, text] of file.content.split(/\r?\n/).entries()) {
          if (text.includes(query)) {
            results.push({
              path: normalizedRelative(relative),
              line: index + 1,
              text: text.slice(0, 2_000)
            });
            if (results.length >= maxResults) break;
          }
        }
      }
    };

    await walk(requestedRoot);
    return { output: results };
  }

  private async writeFile(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ output: FileWriteOutput; affectedFiles: string[] }> {
    const requestedPath = arguments_.path as string;
    const content = arguments_.content as string;
    const expectedHash = arguments_.expectedHash as string | undefined;
    const output = await this.replaceFile(
      context.workspacePath,
      requestedPath,
      Buffer.from(content, 'utf8'),
      expectedHash,
      context.signal
    );
    return { output, affectedFiles: [output.path] };
  }

  private async applyPatch(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ output: FileWriteOutput; affectedFiles: string[] }> {
    const requestedPath = arguments_.path as string;
    const expectedHash = arguments_.expectedHash as string;
    const edits = arguments_.edits as PatchEdit[];
    const current = await this.readTextFile(context.workspacePath, requestedPath, context.signal);
    if (current.hash !== expectedHash) {
      throw new AppError(
        'CONFLICT',
        'File changed since the patch baseline was read',
        { path: requestedPath, expectedHash, actualHash: current.hash },
        409
      );
    }
    const eol = current.content.includes('\r\n')
      ? '\r\n'
      : current.content.includes('\r')
        ? '\r'
        : '\n';
    const hasFinalEol = /(?:\r\n|\r|\n)$/.test(current.content);
    const lines =
      current.content.length === 0
        ? []
        : current.content.split(/\r\n|\r|\n/).slice(0, hasFinalEol ? -1 : undefined);
    const normalizedEdits = edits
      .map((edit) => ({ ...edit, startIndex: edit.startLine - 1 }))
      .sort((left, right) => left.startIndex - right.startIndex);
    let previousEnd = -1;
    const starts = new Set<number>();
    for (const edit of normalizedEdits) {
      const end = edit.startIndex + edit.deleteCount;
      if (
        edit.startIndex > lines.length ||
        end > lines.length ||
        edit.startIndex < previousEnd ||
        starts.has(edit.startIndex) ||
        (edit.startIndex === previousEnd && edit.deleteCount === 0)
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Patch edits overlap or address lines outside the current file. Each edit must describe one non-overlapping range in the original file; combine replacement lines into one edit instead of using separate delete and insert edits at the same startLine.',
          {
            category: 'INVALID_PATCH_EDITS',
            path: requestedPath,
            lineCount: lines.length,
            edit,
            hint: 'Use one edit per range. For a replacement, set deleteCount to the number of original lines and put the replacement lines in that same edit.'
          }
        );
      }
      starts.add(edit.startIndex);
      previousEnd = end;
    }
    for (const edit of normalizedEdits.reverse()) {
      lines.splice(edit.startIndex, edit.deleteCount, ...edit.lines);
    }
    const updated = `${lines.join(eol)}${hasFinalEol ? eol : ''}`;
    const output = await this.replaceFile(
      context.workspacePath,
      requestedPath,
      Buffer.from(updated, 'utf8'),
      expectedHash,
      context.signal
    );
    return { output, affectedFiles: [output.path] };
  }

  private async gitStatus(
    context: ToolExecutionContext
  ): Promise<{ output: Awaited<ReturnType<WorkspaceManager['getStatus']>> }> {
    this.throwIfAborted(context.signal);
    return { output: await this.workspaceManager.getStatus(context.workspacePath) };
  }

  private async gitDiff(context: ToolExecutionContext): Promise<{ output: string }> {
    this.throwIfAborted(context.signal);
    return { output: await this.workspaceManager.getDiff(context.workspacePath) };
  }

  private async runCommand(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ output: CommandOutput }> {
    const request = arguments_ as unknown as CommandRequest;
    assertCommandAllowed(request);
    if (request.executable === 'node' && request.args[0] === '--check') {
      await this.workspaceManager.resolve(context.workspacePath, request.args[1]!);
    }
    const workspace = await this.workspaceManager.resolve(context.workspacePath, '.');
    return {
      output: await this.commandRunner.run(
        workspace,
        request,
        context.signal,
        context.projectSourcePath
      )
    };
  }

  private async readTextFile(
    workspace: string,
    requestedPath: string,
    signal?: AbortSignal
  ): Promise<ReadFileOutput> {
    this.throwIfAborted(signal);
    const file = await this.workspaceManager.resolve(workspace, requestedPath);
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new AppError('WORKSPACE_ERROR', 'Requested path is not a regular file', {
          path: requestedPath
        });
      }
      if (stat.size > config.maxReadFileBytes) {
        throw new AppError('WORKSPACE_ERROR', 'File exceeds the read size limit', {
          category: 'FILE_TOO_LARGE',
          path: requestedPath,
          size: stat.size,
          maxReadFileBytes: config.maxReadFileBytes
        });
      }
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      this.throwIfAborted(signal);
      if (offset !== stat.size || after.size !== stat.size) {
        throw new AppError('CONFLICT', 'File changed while it was being read', {
          path: requestedPath
        });
      }
      const content = buffer.subarray(0, offset);
      if (content.subarray(0, 8_000).includes(0)) {
        throw new AppError('WORKSPACE_ERROR', 'Binary files cannot be read as text', {
          category: 'BINARY_FILE',
          path: requestedPath
        });
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        throw new AppError('WORKSPACE_ERROR', 'File is not valid UTF-8 text', {
          category: 'BINARY_FILE',
          path: requestedPath
        });
      }
      return {
        path: normalizedRelative(requestedPath),
        content: text,
        lineCount: this.fileLines(text).length,
        startLine: 1,
        endLine: this.fileLines(text).length,
        hasMore: false,
        numberedContent: this.numberedContent(text),
        hash: contentHash(content),
        bytes: content.length
      };
    } finally {
      await handle.close();
    }
  }

  private numberedContent(text: string): string {
    const lines = this.fileLines(text);
    return this.numberedLines(lines, 1, lines.length);
  }

  private numberedLines(lines: readonly string[], startLine: number, totalLines: number): string {
    const width = Math.max(1, String(totalLines).length);
    return lines
      .map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`)
      .join('\n');
  }

  private boundedReadLines(
    lines: readonly string[],
    startLine: number,
    maxLines: number
  ): string[] {
    const selected: string[] = [];
    const width = Math.max(1, String(lines.length).length);
    const contextBudget = Math.max(1, Math.floor(config.maxContextEntryBytes * 0.75));
    let encodedBytes = 0;
    for (const [offset, line] of lines.slice(startLine - 1, startLine - 1 + maxLines).entries()) {
      const numberedLine = `${String(startLine + offset).padStart(width, ' ')} | ${line}`;
      const lineBytes = Buffer.byteLength(JSON.stringify(numberedLine)) - 2;
      const separatorBytes = selected.length === 0 ? 0 : 2;
      if (selected.length > 0 && encodedBytes + separatorBytes + lineBytes > contextBudget) break;
      selected.push(line);
      encodedBytes += separatorBytes + lineBytes;
    }
    return selected;
  }

  private fileLines(text: string): string[] {
    const lines = text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines.at(-1) === '' && /(?:\r\n|\r|\n)$/.test(text)) {
      lines.pop();
    }
    return lines;
  }

  private async replaceFile(
    workspace: string,
    requestedPath: string,
    content: Buffer,
    expectedHash: string | undefined,
    signal?: AbortSignal
  ): Promise<FileWriteOutput> {
    this.throwIfAborted(signal);
    const file = await this.workspaceManager.resolve(workspace, requestedPath, 'write');
    const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    let previousHash: string | undefined;
    let mode = 0o666;
    if (existing) {
      if (!existing.isFile()) {
        throw new AppError('WORKSPACE_ERROR', 'Write target is not a regular file', {
          path: requestedPath
        });
      }
      if (!expectedHash) {
        throw new AppError(
          'CONFLICT',
          'Replacing an existing file requires expectedHash',
          { path: requestedPath },
          409
        );
      }
      const current = await this.readTextFile(workspace, requestedPath, signal);
      previousHash = current.hash;
      mode = existing.mode & 0o777;
      if (previousHash !== expectedHash) {
        throw new AppError(
          'CONFLICT',
          'File changed since it was read',
          { path: requestedPath, expectedHash, actualHash: previousHash },
          409
        );
      }
    } else if (expectedHash) {
      throw new AppError(
        'CONFLICT',
        'Expected file does not exist',
        { path: requestedPath, expectedHash },
        409
      );
    }

    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.codeharness-write-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode });
      this.throwIfAborted(signal);
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const actual = await fs.readFile(file);
    const hash = contentHash(actual);
    if (hash !== contentHash(content)) {
      throw new AppError('WORKSPACE_ERROR', 'Written file failed integrity verification', {
        path: requestedPath
      });
    }
    return {
      path: normalizedRelative(requestedPath),
      previousHash,
      hash,
      bytes: actual.length
    };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw (
      signal.reason ??
      new AppError('TASK_CANCELLED', 'Tool execution was cancelled', undefined, 409)
    );
  }
}

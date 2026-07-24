import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { AppError } from './errors.js';
import { assertDomainContract } from './event-contract.js';
import type {
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerResult,
  ToolRegistrationPort
} from './ports/tool-registry.js';
import type { ErrorCode, ToolCall, ToolDefinition, ToolName, ToolResult } from './types.js';

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

interface NormalizedToolError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  retryable: boolean;
}

export class ToolRegistry implements ToolRegistrationPort {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly tools = new Map<ToolName, RegisteredTool>();
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly maxArgumentBytes: number,
    private readonly maxOutputBytes: number
  ) {}

  register(definition: ToolDefinition, handler: ToolHandler): void {
    assertDomainContract('toolDefinition', definition);
    if (this.tools.has(definition.name)) {
      throw new AppError('CONFLICT', 'Tool is already registered', {
        toolName: definition.name
      });
    }
    try {
      this.tools.set(definition.name, {
        definition: structuredClone(definition),
        handler,
        validateInput: this.ajv.compile(definition.inputSchema),
        validateOutput: this.ajv.compile(definition.outputSchema)
      });
    } catch (error) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Tool definition contains an invalid JSON Schema',
        {
          toolName: definition.name,
          cause: error instanceof Error ? error.message : String(error)
        },
        500
      );
    }
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ definition }) => structuredClone(definition));
  }

  validate(call: ToolCall, permissions: ToolExecutionContext['permissions']): void {
    this.assertCall(call, permissions);
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const startedAt = Date.now();
    let registered: RegisteredTool;
    try {
      registered = this.assertCall(call, context.permissions);
    } catch (error) {
      return this.failure(startedAt, this.normalizeError(error, false, false));
    }

    const run = () => this.runRegistered(registered, call, context, startedAt);
    if (!registered.definition.sideEffect) return run();
    return this.withWriteLock(context.workspacePath, run);
  }

  private async runRegistered(
    registered: RegisteredTool,
    call: ToolCall,
    context: ToolExecutionContext,
    startedAt: number
  ): Promise<ToolResult> {
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () =>
      controller.abort(
        context.signal?.reason ??
          new AppError('TASK_CANCELLED', 'Tool execution was cancelled', undefined, 409)
      );
    if (context.signal?.aborted) onExternalAbort();
    else context.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new AppError(
          'WORKSPACE_ERROR',
          'Tool execution timed out',
          { category: 'TIMEOUT', toolName: call.name },
          408
        )
      );
    }, registered.definition.defaultTimeoutMs);

    try {
      const handler = registered.handler(call.arguments, {
        ...context,
        signal: controller.signal
      });
      const result = await (registered.definition.sideEffect
        ? handler
        : Promise.race([handler, this.abortPromise(controller.signal)]));
      let outputBytes: number;
      try {
        outputBytes = this.jsonBytes(result.output);
      } catch (error) {
        throw new AppError(
          'INTERNAL_ERROR',
          'Tool output must be JSON serializable',
          { cause: error instanceof Error ? error.message : String(error) },
          500
        );
      }
      if (outputBytes > this.maxOutputBytes) {
        throw new AppError('WORKSPACE_ERROR', 'Tool output exceeds the configured size limit', {
          category: 'OUTPUT_LIMIT',
          outputBytes,
          maxOutputBytes: this.maxOutputBytes
        });
      }
      if (!registered.validateOutput(result.output)) {
        throw new AppError(
          'INTERNAL_ERROR',
          'Tool output does not match the registered schema',
          {
            toolName: call.name,
            validationErrors: registered.validateOutput.errors
          },
          500
        );
      }
      const toolResult: ToolResult = {
        status: 'SUCCEEDED',
        output: result.output,
        affectedFiles: result.affectedFiles ?? [],
        durationMs: Date.now() - startedAt
      };
      assertDomainContract('toolResult', toolResult);
      return toolResult;
    } catch (error) {
      const normalized = this.normalizeError(error, timedOut, context.signal?.aborted ?? false);
      const result = this.failure(
        startedAt,
        normalized,
        normalized.code === 'TASK_CANCELLED' ? 'CANCELLED' : 'FAILED'
      );
      assertDomainContract('toolResult', result);
      return result;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private abortPromise(signal: AbortSignal): Promise<ToolHandlerResult> {
    return new Promise((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  private failure(
    startedAt: number,
    error: NormalizedToolError,
    status: ToolResult['status'] = 'FAILED'
  ): ToolResult {
    return {
      status,
      error,
      affectedFiles: [],
      durationMs: Date.now() - startedAt
    };
  }

  private normalizeError(
    error: unknown,
    timedOut: boolean,
    externallyAborted: boolean
  ): NormalizedToolError {
    if (timedOut) {
      return {
        code: 'WORKSPACE_ERROR',
        message: 'Tool execution timed out',
        details: { category: 'TIMEOUT' },
        retryable: true
      };
    }
    if (externallyAborted) {
      return {
        code: 'TASK_CANCELLED',
        message: 'Tool execution was cancelled',
        details: { category: 'CANCELLED' },
        retryable: false
      };
    }
    if (error instanceof AppError) {
      const category =
        typeof error.details === 'object' && error.details !== null && 'category' in error.details
          ? String((error.details as { category: unknown }).category)
          : undefined;
      return {
        code: error.code,
        message: error.message,
        details: error.details,
        retryable:
          error.code === 'MODEL_ERROR' ||
          error.code === 'INDEX_ERROR' ||
          (error.code === 'WORKSPACE_ERROR' &&
            ['ENVIRONMENT', 'TIMEOUT', 'TRANSIENT'].includes(category ?? ''))
      };
    }
    return {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown tool execution error',
      retryable: false
    };
  }

  private jsonBytes(value: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', 'Tool arguments must be JSON serializable', {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private assertCall(
    call: ToolCall,
    permissions: ToolExecutionContext['permissions']
  ): RegisteredTool {
    const registered = this.tools.get(call.name);
    if (!registered) {
      throw new AppError('NOT_FOUND', 'Tool is not registered', {
        toolName: call.name
      });
    }
    if (!permissions.includes(registered.definition.permission)) {
      throw new AppError(
        'FORBIDDEN',
        'Tool permission was not granted',
        {
          toolName: call.name,
          requiredPermission: registered.definition.permission
        },
        403
      );
    }
    const argumentBytes = this.jsonBytes(call.arguments);
    if (argumentBytes > this.maxArgumentBytes) {
      throw new AppError('VALIDATION_ERROR', 'Tool arguments exceed the configured size limit', {
        argumentBytes,
        maxArgumentBytes: this.maxArgumentBytes
      });
    }
    if (!registered.validateInput(call.arguments)) {
      throw new AppError('VALIDATION_ERROR', 'Tool arguments do not match the registered schema', {
        validationErrors: registered.validateInput.errors
      });
    }
    return registered;
  }

  private async withWriteLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(workspace) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.writeLocks.set(workspace, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.writeLocks.get(workspace) === queued) this.writeLocks.delete(workspace);
    }
  }
}

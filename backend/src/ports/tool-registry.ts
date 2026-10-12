import type { ToolCall, ToolDefinition, ToolPermission, ToolResult } from '../types.js';

export interface ToolExecutionContext {
  workspacePath: string;
  projectSourcePath?: string;
  permissions: readonly ToolPermission[];
  signal?: AbortSignal;
}

export interface ToolHandlerResult {
  output: unknown;
  affectedFiles?: string[];
}

export type ToolHandler = (
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolHandlerResult>;

export interface ToolRegistrationPort {
  register(definition: ToolDefinition, handler: ToolHandler): void;
  definitions(): ToolDefinition[];
  validate(call: ToolCall, permissions: readonly ToolPermission[]): void;
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
}

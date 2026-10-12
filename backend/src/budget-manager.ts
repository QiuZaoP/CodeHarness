import { AppError } from './errors.js';
import type { ModelUsage } from './ports/model-gateway.js';
import type { RunBudget, RunState } from './types.js';

export interface BudgetLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxChangedFiles: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCost: number;
  maxReadBytes: number;
  maxVerificationRuns: number;
}

export class BudgetManager {
  constructor(private readonly limits: BudgetLimits) {}

  create(): RunBudget {
    return {
      ...this.limits,
      usedSteps: 0,
      usedToolCalls: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      usedCost: 0,
      usedReadBytes: 0,
      usedVerificationRuns: 0
    };
  }

  assertDuration(startedAt: string, budget?: RunBudget, now = Date.now()): void {
    const elapsedMs = now - Date.parse(startedAt);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new AppError('INTERNAL_ERROR', 'Task run start time is invalid', { startedAt }, 500);
    }
    const limit = budget?.maxDurationMs ?? this.limits.maxDurationMs;
    if (elapsedMs > limit) {
      this.exceeded('MAX_DURATION', limit, elapsedMs);
    }
  }

  reserveStep(state: RunState): RunState {
    this.assertCanCallModel(state);
    if (state.budget.usedSteps >= state.budget.maxSteps) {
      this.exceeded('MAX_STEPS', state.budget.maxSteps, state.budget.usedSteps);
    }
    return this.withBudget(state, { usedSteps: state.budget.usedSteps + 1 });
  }

  reserveToolCall(state: RunState): RunState {
    if (state.budget.usedToolCalls >= state.budget.maxToolCalls) {
      this.exceeded('MAX_TOOL_CALLS', state.budget.maxToolCalls, state.budget.usedToolCalls);
    }
    return this.withBudget(state, { usedToolCalls: state.budget.usedToolCalls + 1 });
  }

  reserveVerification(state: RunState): RunState {
    const used = state.budget.usedVerificationRuns ?? 0;
    const limit = state.budget.maxVerificationRuns ?? this.limits.maxVerificationRuns;
    if (used >= limit) this.exceeded('MAX_VERIFICATION_RUNS', limit, used);
    return this.withBudget(state, { usedVerificationRuns: used + 1 });
  }

  assertCanCallModel(state: RunState): void {
    this.assertRemaining(
      'MAX_INPUT_TOKENS',
      state.budget.maxInputTokens ?? this.limits.maxInputTokens,
      state.budget.usedInputTokens ?? 0
    );
    this.assertRemaining(
      'MAX_OUTPUT_TOKENS',
      state.budget.maxOutputTokens ?? this.limits.maxOutputTokens,
      state.budget.usedOutputTokens ?? 0
    );
    this.assertRemaining(
      'MAX_COST',
      state.budget.maxCost ?? this.limits.maxCost,
      state.budget.usedCost ?? 0
    );
  }

  assertCanRead(state: RunState): void {
    this.assertRemaining(
      'MAX_READ_BYTES',
      state.budget.maxReadBytes ?? this.limits.maxReadBytes,
      state.budget.usedReadBytes ?? 0
    );
  }

  recordModelUsage(state: RunState, usage: ModelUsage): RunState {
    for (const [name, value] of Object.entries(usage)) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new AppError('INTERNAL_ERROR', `Invalid model usage: ${name}`, { name, value }, 500);
      }
    }
    return this.withBudget(state, {
      usedInputTokens: (state.budget.usedInputTokens ?? 0) + usage.inputTokens,
      usedOutputTokens: (state.budget.usedOutputTokens ?? 0) + usage.outputTokens,
      usedCost: (state.budget.usedCost ?? 0) + (usage.cost ?? 0)
    });
  }

  recordReadBytes(state: RunState, bytes: number): RunState {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new AppError('INTERNAL_ERROR', 'Read byte usage must be a non-negative integer', {
        bytes
      });
    }
    return this.withBudget(state, {
      usedReadBytes: (state.budget.usedReadBytes ?? 0) + bytes
    });
  }

  recordChangedFiles(state: RunState, affectedFiles: readonly string[]): RunState {
    const changedFiles = [...new Set([...state.changedFiles, ...affectedFiles])].sort();
    return { ...state, changedFiles };
  }

  assertWithin(state: RunState): void {
    this.assertMaximum(
      'MAX_INPUT_TOKENS',
      state.budget.maxInputTokens ?? this.limits.maxInputTokens,
      state.budget.usedInputTokens ?? 0
    );
    this.assertMaximum(
      'MAX_OUTPUT_TOKENS',
      state.budget.maxOutputTokens ?? this.limits.maxOutputTokens,
      state.budget.usedOutputTokens ?? 0
    );
    this.assertMaximum(
      'MAX_COST',
      state.budget.maxCost ?? this.limits.maxCost,
      state.budget.usedCost ?? 0
    );
    this.assertMaximum(
      'MAX_READ_BYTES',
      state.budget.maxReadBytes ?? this.limits.maxReadBytes,
      state.budget.usedReadBytes ?? 0
    );
    this.assertMaximum(
      'MAX_CHANGED_FILES',
      state.budget.maxChangedFiles,
      state.changedFiles.length
    );
  }

  private withBudget(state: RunState, patch: Partial<RunBudget>): RunState {
    return { ...state, budget: { ...state.budget, ...patch } };
  }

  private assertMaximum(category: string, limit: number, used: number): void {
    if (used > limit) this.exceeded(category, limit, used);
  }

  private assertRemaining(category: string, limit: number, used: number): void {
    if (used >= limit) this.exceeded(category, limit, used);
  }

  private exceeded(category: string, limit: number, used: number): never {
    throw new AppError(
      'BUDGET_EXCEEDED',
      `Task budget exceeded: ${category}`,
      { category, limit, used },
      429
    );
  }
}

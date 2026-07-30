import { randomUUID } from 'node:crypto';
import type { EventBroker } from './broker.js';
import type { BudgetManager } from './budget-manager.js';
import { parseAllowedCommand, type CommandOutput } from './command-runner.js';
import { config } from './config.js';
import type { ContextCandidate, ContextManager, SelectedContext } from './context-manager.js';
import type { AppDatabase, TaskEventDraft, TaskRunCheckpoint } from './db.js';
import { AppError } from './errors.js';
import { assertDomainContract } from './event-contract.js';
import { logger } from './logger.js';
import type { ToolRegistrationPort } from './ports/tool-registry.js';
import type { DecisionRequest, DecisionResponse, ModelGateway } from './ports/model-gateway.js';
import type { CodeIndex, ProjectOverview } from './ports/code-index.js';
import { taskStateMachine } from './state-machine.js';
import { contractSchemaVersion } from './types.js';
import type {
  ChangeDecision,
  FileChange,
  HarnessObservation,
  HarnessTurn,
  Message,
  ModelDecision,
  StoredTask,
  RunState,
  TaskPlan,
  TaskReport,
  TaskStatus,
  ToolCall,
  ToolCallRecord,
  ToolResult,
  VerificationResult,
  WorkspaceSnapshot
} from './types.js';
import type { WorkspaceManager } from './workspace.js';

export interface HarnessDependencies {
  database: AppDatabase;
  broker: EventBroker;
  workspaceManager: WorkspaceManager;
  tools: ToolRegistrationPort;
  modelGateway: ModelGateway;
  codeIndex: CodeIndex;
  budgetManager: BudgetManager;
  contextManager: ContextManager;
}

interface LifecyclePatch {
  plan?: TaskPlan | null;
  stopReason?: string | null;
  resumeStatus?: StoredTask['resumeStatus'] | null;
  controlRequest?: StoredTask['controlRequest'] | null;
}

export class HarnessRunner {
  constructor(private readonly dependencies: HarnessDependencies) {}

  async createTask(projectId: string, sessionId: string, goal: string): Promise<StoredTask> {
    const { database } = this.dependencies;
    const project = database.getProject(projectId);
    const session = database.getSession(sessionId);
    if (!project || !session || session.projectId !== projectId) {
      throw new AppError(
        'NOT_FOUND',
        'Project or session not found',
        { projectId, sessionId },
        404
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const createdWorkspace = await this.dependencies.workspaceManager.createTaskWorkspace(
      projectId,
      id,
      project.sourcePath
    );
    const task: StoredTask = {
      id,
      projectId,
      sessionId,
      goal,
      status: 'CREATED',
      workspacePath: createdWorkspace.workspacePath,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    let result;
    try {
      result = database.createTaskWithEvent(
        task,
        { type: 'task.created', timestamp: now, payload: { goal } },
        randomUUID(),
        createdWorkspace.baseline
      );
    } catch (error) {
      await this.dependencies.workspaceManager.removeTask(id);
      throw error;
    }
    this.publishEvents(result.events);
    return result.task;
  }

  async run(taskId: string, signal?: AbortSignal): Promise<StoredTask> {
    let task = this.requireTask(taskId);
    try {
      if (task.status === 'CREATED') {
        this.throwIfStopped(task.id, signal);
        task = this.transition(task, 'PRECHECKING');
      }
      if (task.status === 'PRECHECKING') {
        this.throwIfStopped(task.id, signal);
        await this.precheck(task, signal);
        task = this.transition(task, 'PLANNING');
      }
      if (task.status === 'PLANNING') {
        this.throwIfStopped(task.id, signal);
        const plan = task.plan ?? (await this.plan(task, signal));
        task = this.transition(task, 'EXECUTING', { plan }, [
          { type: 'task.plan.updated', payload: { plan } }
        ]);
      }
      if (task.status === 'EXECUTING') {
        this.throwIfStopped(task.id, signal);
        task = await this.executeLoop(task, signal);
      }
      if (task.status === 'VERIFYING') {
        this.throwIfStopped(task.id, signal);
        task = this.transition(task, 'EXECUTING');
        task = await this.executeLoop(task, signal);
      }
      if (['WAITING_USER', 'PAUSED', 'CANCELLED'].includes(task.status)) {
        return task;
      }
      if (task.status !== 'READY_FOR_REVIEW') {
        throw new AppError(
          'CONFLICT',
          `Task cannot run from ${task.status}`,
          { taskId, status: task.status },
          409
        );
      }
      return task;
    } catch (error) {
      const current = this.requireTask(taskId);
      if (error instanceof AppError && error.code === 'MODEL_ERROR') {
        const details =
          typeof error.details === 'object' && error.details !== null
            ? (error.details as Record<string, unknown>)
            : {};
        logger.error(
          {
            taskId,
            phase: current.status,
            category: typeof details.category === 'string' ? details.category : 'UNKNOWN',
            status: typeof details.status === 'number' ? details.status : undefined,
            providerCode:
              typeof details.providerCode === 'string' ? details.providerCode : undefined,
            field: typeof details.field === 'string' ? details.field : undefined,
            verificationCommand:
              typeof details.verificationCommand === 'string'
                ? details.verificationCommand
                : undefined,
            cause: typeof details.cause === 'string' ? details.cause : undefined,
            message: error.message
          },
          'Model operation failed'
        );
      }
      const control = this.abortedControl(signal) ?? current.controlRequest;
      if (control === 'PAUSE' && !taskStateMachine.isTerminal(current.status)) {
        return this.pauseInterrupted(taskId, 'Paused by user');
      }
      if (control === 'CANCEL' && !taskStateMachine.isTerminal(current.status)) {
        return this.cancel(taskId);
      }
      if (
        error instanceof AppError &&
        (error.code === 'MODEL_ERROR' ||
          error.code === 'INDEX_ERROR' ||
          this.requiresUserReview(error)) &&
        taskStateMachine.canTransition(current.status, 'WAITING_USER')
      ) {
        return this.transition(
          current,
          'WAITING_USER',
          {
            stopReason: error.message,
            resumeStatus: taskStateMachine.pauseResumeTarget(current.status),
            controlRequest: null
          },
          [{ type: 'task.waiting_user', payload: { message: error.message } }]
        );
      }
      if (
        error instanceof AppError &&
        error.code === 'BUDGET_EXCEEDED' &&
        taskStateMachine.canTransition(current.status, 'PAUSED')
      ) {
        return this.transition(
          current,
          'PAUSED',
          {
            stopReason: error.message,
            resumeStatus: taskStateMachine.pauseResumeTarget(current.status),
            controlRequest: null
          },
          [{ type: 'task.paused', payload: { status: 'PAUSED' } }]
        );
      }
      if (
        !taskStateMachine.isTerminal(current.status) &&
        current.status !== 'PAUSED' &&
        current.status !== 'WAITING_USER'
      ) {
        const stopReason = error instanceof Error ? error.message : String(error);
        this.transition(
          current,
          'FAILED',
          { stopReason, resumeStatus: null, controlRequest: null },
          [{ type: 'task.failed', payload: { message: stopReason } }]
        );
      }
      throw error;
    }
  }

  getTask(taskId: string): StoredTask {
    return this.requireTask(taskId);
  }

  getFileChanges(taskId: string): FileChange[] {
    this.requireTask(taskId);
    return this.dependencies.database.getFileChanges(taskId);
  }

  getVerifications(taskId: string): VerificationResult[] {
    this.requireTask(taskId);
    return this.dependencies.database.getVerificationResults(taskId);
  }

  decideFileChange(
    taskId: string,
    changeId: string,
    decision: Exclude<ChangeDecision, 'PENDING'>,
    expectedVersion: number
  ): FileChange {
    const task = this.requireTask(taskId);
    if (task.status !== 'READY_FOR_REVIEW') {
      throw new AppError(
        'CONFLICT',
        'File changes can only be reviewed when the task is ready',
        { taskId, status: task.status },
        409
      );
    }
    const result = this.dependencies.database.decideFileChange(
      taskId,
      changeId,
      decision,
      expectedVersion,
      new Date().toISOString()
    );
    this.dependencies.broker.publish(result.event);
    return result.change;
  }

  getReport(taskId: string): TaskReport {
    const task = this.requireTask(taskId);
    const changes = this.dependencies.database.getFileChanges(taskId);
    const verifications = this.dependencies.database.getVerificationResults(taskId);
    const toolCalls = this.dependencies.database.getToolCalls(taskId).map((call) => ({
      id: call.id,
      stepId: call.stepId,
      name: call.tool.name,
      status: call.status
    }));
    const risks: string[] = [];
    if (changes.some(({ decision }) => decision === 'PENDING')) {
      risks.push('Some file changes are still pending review');
    }
    if (verifications.length === 0) risks.push('No verification command was recorded');
    if (verifications.at(-1)?.status !== 'PASSED') {
      risks.push('The latest verification result did not pass');
    }
    if (task.stopReason) risks.push(task.stopReason);
    const report: TaskReport = {
      taskId,
      status: task.status,
      summary: `${changes.length} file change(s), ${verifications.length} verification result(s)`,
      plan: task.plan,
      changes,
      verifications,
      toolCalls,
      risks,
      generatedAt: new Date().toISOString()
    };
    assertDomainContract('taskReport', report);
    return report;
  }

  pauseInterrupted(taskId: string, reason: string): StoredTask {
    const task = this.requireTask(taskId);
    const resumeStatus = taskStateMachine.pauseResumeTarget(task.status);
    return this.transition(
      task,
      'PAUSED',
      { stopReason: reason, resumeStatus, controlRequest: null },
      [{ type: 'task.paused', payload: { status: 'PAUSED' } }]
    );
  }

  resume(taskId: string): StoredTask {
    const task = this.requireTask(taskId);
    if (!['PAUSED', 'WAITING_USER'].includes(task.status) || !task.resumeStatus) {
      throw new AppError(
        'CONFLICT',
        'Task does not have a resumable checkpoint',
        { taskId, status: task.status },
        409
      );
    }
    const status = task.resumeStatus;
    const checkpoint = this.dependencies.database.getTaskRun(taskId);
    const runningToolCallIds = new Set(
      this.dependencies.database
        .getToolCalls(taskId)
        .filter(({ status: toolStatus }) => toolStatus === 'RUNNING')
        .map(({ id }) => id)
    );
    const activeTurn = checkpoint?.state.activeTurn;
    const preserveInterruptedTurn = activeTurn?.toolCallIds?.some((id) =>
      runningToolCallIds.has(id)
    );
    const resumed = this.transition(
      task,
      status,
      { stopReason: null, resumeStatus: null, controlRequest: null },
      [{ type: 'task.resumed', payload: { status } }]
    );
    const latestCheckpoint = this.dependencies.database.getTaskRun(taskId);
    if (latestCheckpoint) {
      const startedAt = new Date().toISOString();
      this.dependencies.database.updateTaskRun(
        {
          ...latestCheckpoint,
          startedAt,
          updatedAt: startedAt,
          state: {
            ...latestCheckpoint.state,
            phase: status,
            contextRefs: [],
            turnCount: 0,
            activeTurn: preserveInterruptedTurn ? activeTurn : undefined,
            consecutiveFailures: 0,
            lastVerificationPassed:
              activeTurn?.status === 'DECIDED' && activeTurn.decision.type === 'VERIFY'
                ? false
                : latestCheckpoint.state.lastVerificationPassed,
            stopReason: undefined,
            budget: this.dependencies.budgetManager.create()
          }
        },
        latestCheckpoint.version
      );
    }
    return resumed;
  }

  cancel(taskId: string, reason = 'Cancelled by user'): StoredTask {
    const task = this.requireTask(taskId);
    return this.transition(
      task,
      'CANCELLED',
      { stopReason: reason, resumeStatus: null, controlRequest: null },
      [{ type: 'task.cancelled', payload: { reason } }]
    );
  }

  async apply(taskId: string): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    if (task.status !== 'READY_FOR_REVIEW') {
      throw new AppError(
        'CONFLICT',
        'Only a reviewed task can be applied',
        { taskId, status: task.status },
        409
      );
    }
    const changes = this.dependencies.database.getFileChanges(taskId);
    const pending = changes.filter(({ decision }) => decision === 'PENDING');
    if (pending.length > 0) {
      throw new AppError(
        'CONFLICT',
        'Every file change must be accepted or rejected before apply',
        { pendingChangeIds: pending.map(({ id }) => id) },
        409
      );
    }
    await this.assertStoredDiffCurrent(task, changes);
    const baseline = this.dependencies.database
      .getWorkspaceSnapshots(task.id)
      .find(({ kind }) => kind === 'BASELINE');
    const project = this.dependencies.database.getProject(task.projectId);
    if (!baseline || !project) {
      throw new AppError('WORKSPACE_ERROR', 'Apply baseline or project source is missing');
    }
    const acceptedCount = changes.filter(({ decision }) => decision === 'ACCEPTED').length;
    return this.dependencies.workspaceManager.applyAcceptedChanges(
      task.id,
      task.workspacePath,
      project.sourcePath,
      baseline,
      changes,
      () =>
        this.transition(
          this.requireTask(taskId),
          'APPLIED',
          { stopReason: null, resumeStatus: null, controlRequest: null },
          [{ type: 'task.applied', payload: { changeCount: acceptedCount } }]
        )
    );
  }

  async rollback(taskId: string): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    if (taskStateMachine.isTerminal(task.status)) {
      throw new AppError(
        'CONFLICT',
        `Task cannot be rolled back from ${task.status}`,
        { taskId, status: task.status },
        409
      );
    }
    const baseline = this.dependencies.database
      .getWorkspaceSnapshots(task.id)
      .find((snapshot) => snapshot.kind === 'BASELINE');
    if (!baseline) throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot does not exist');
    await this.dependencies.workspaceManager.rollback(task.id, task.workspacePath, baseline);
    return this.cancel(taskId, 'Workspace rolled back by user');
  }

  async checkpoint(
    taskId: string,
    kind: Exclude<WorkspaceSnapshot['kind'], 'BASELINE'> = 'CHECKPOINT'
  ): Promise<WorkspaceSnapshot> {
    const task = this.requireTask(taskId);
    const snapshot = await this.dependencies.workspaceManager.createCheckpoint(
      task.id,
      task.workspacePath,
      kind
    );
    try {
      this.dependencies.database.recordWorkspaceSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      await this.dependencies.workspaceManager.removeSnapshot(task.id, snapshot.id);
      throw error;
    }
  }

  private transition(
    task: StoredTask,
    status: TaskStatus,
    patch: LifecyclePatch = {},
    additionalEvents: Array<Omit<TaskEventDraft, 'timestamp'>> = []
  ): StoredTask {
    taskStateMachine.assertTransition(task.status, status);
    const timestamp = new Date().toISOString();
    const taskPatch: Parameters<AppDatabase['transitionTask']>[0]['patch'] = { status };
    if (Object.hasOwn(patch, 'plan')) taskPatch.plan = patch.plan;
    if (Object.hasOwn(patch, 'stopReason')) taskPatch.stopReason = patch.stopReason;
    if (Object.hasOwn(patch, 'resumeStatus')) taskPatch.resumeStatus = patch.resumeStatus;
    if (Object.hasOwn(patch, 'controlRequest')) taskPatch.controlRequest = patch.controlRequest;
    const result = this.dependencies.database.transitionTask({
      taskId: task.id,
      expectedVersion: task.version,
      patch: taskPatch,
      events: [
        {
          type: 'task.state_changed',
          timestamp,
          payload: { from: task.status, to: status }
        },
        ...additionalEvents.map((event) => ({ ...event, timestamp }))
      ],
      audit: {
        id: randomUUID(),
        action: 'task.state_changed',
        timestamp
      }
    });
    this.publishEvents(result.events);
    this.synchronizeStoredRun(result.task);
    return result.task;
  }

  private async callTool(
    task: StoredTask,
    tool: ToolCall,
    toolCallId: string,
    signal?: AbortSignal
  ): Promise<ToolCallRecord> {
    const existing = this.dependencies.database.getToolCall(toolCallId);
    if (existing) {
      if (existing.status === 'RUNNING') {
        const finishedAt = new Date().toISOString();
        const result: ToolResult = {
          status: 'CANCELLED',
          error: {
            code: 'TASK_CANCELLED',
            message: 'Interrupted tool outcome is unknown; the call was not replayed',
            details: { category: 'INTERRUPTED_TOOL', toolCallId },
            retryable: false
          },
          affectedFiles: [],
          durationMs: Math.max(0, Date.now() - Date.parse(existing.startedAt))
        };
        const event = this.dependencies.database.completeToolCall(
          toolCallId,
          task.id,
          result,
          finishedAt,
          {
            type: 'tool.completed',
            timestamp: finishedAt,
            payload: { toolName: existing.tool.name, error: result.error!.message }
          }
        );
        this.dependencies.broker.publish(event);
        return this.dependencies.database.getToolCall(toolCallId)!;
      }
      return existing;
    }
    const permissions = ['READ', 'WRITE', 'COMMAND'] as const;
    const definition = this.dependencies.tools
      .definitions()
      .find((candidate) => candidate.name === tool.name);
    let checkpoint = this.ensureRunCheckpoint(task);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    if (definition?.permission === 'READ') {
      const calls = this.dependencies.database
        .getToolCalls(task.id)
        .filter((candidate) => candidate.startedAt >= checkpoint.startedAt);
      const reusable = [...calls]
        .reverse()
        .find(
          (candidate) =>
            candidate.status === 'SUCCEEDED' &&
            candidate.tool.name === tool.name &&
            JSON.stringify(candidate.tool.arguments) === JSON.stringify(tool.arguments)
        );
      const reusableIndex = reusable ? calls.findIndex(({ id }) => id === reusable.id) : -1;
      const workspaceChangedAfterRead = calls
        .slice(reusableIndex + 1)
        .some(
          ({ result }) => result?.status === 'SUCCEEDED' && (result.affectedFiles?.length ?? 0) > 0
        );
      if (reusable && !workspaceChangedAfterRead) return reusable;
    }
    if (definition?.permission === 'READ') {
      this.dependencies.budgetManager.assertCanRead(checkpoint.state);
    }
    checkpoint = this.saveRunCheckpoint(
      checkpoint,
      this.dependencies.budgetManager.reserveToolCall(
        this.synchronizeRunState(checkpoint.state, task)
      )
    );
    const startedAt = new Date().toISOString();
    const startedEvent = this.dependencies.database.startToolCall(
      {
        id: toolCallId,
        taskId: task.id,
        stepId: checkpoint.state.currentStepId,
        tool,
        status: 'RUNNING',
        startedAt
      },
      {
        type: 'tool.started',
        timestamp: startedAt,
        payload: { toolName: tool.name, arguments: this.safeArguments(tool.arguments) }
      }
    );
    this.dependencies.broker.publish(startedEvent);
    let result: ToolResult;
    try {
      this.dependencies.tools.validate(tool, permissions);
      result = await this.dependencies.tools.execute(tool, {
        workspacePath: task.workspacePath,
        projectSourcePath: this.dependencies.database.getProject(task.projectId)?.sourcePath,
        permissions,
        signal
      });
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError('WORKSPACE_ERROR', error instanceof Error ? error.message : String(error));
      result = {
        status: signal?.aborted ? 'CANCELLED' : 'FAILED',
        error: {
          code: signal?.aborted ? 'TASK_CANCELLED' : appError.code,
          message: appError.message,
          details: appError.details,
          retryable: this.isRetryable(appError)
        },
        affectedFiles: [],
        durationMs: Math.max(0, Date.now() - Date.parse(startedAt))
      };
    }
    if (result.status === 'SUCCEEDED' && this.isNoOpFileWrite(result.output)) {
      result = {
        status: 'FAILED',
        error: {
          code: 'CONFLICT',
          message: 'The file write produced no workspace change',
          details: { category: 'NO_OP_WRITE' },
          retryable: true
        },
        affectedFiles: [],
        durationMs: result.durationMs
      };
    }
    const finishedAt = new Date().toISOString();
    const completedEvent = this.dependencies.database.completeToolCall(
      toolCallId,
      task.id,
      result,
      finishedAt,
      {
        type: 'tool.completed',
        timestamp: finishedAt,
        payload:
          result.status === 'SUCCEEDED'
            ? { toolName: tool.name, result: this.summary(result.output) }
            : { toolName: tool.name, error: result.error?.message ?? result.status }
      }
    );
    this.dependencies.broker.publish(completedEvent);
    let state = this.synchronizeRunState(checkpoint.state, this.requireTask(task.id));
    if (definition?.permission === 'READ' && result.output !== undefined) {
      state = this.dependencies.budgetManager.recordReadBytes(
        state,
        Buffer.byteLength(JSON.stringify(result.output))
      );
    }
    state = this.dependencies.budgetManager.recordChangedFiles(state, result.affectedFiles);
    if (
      result.status === 'SUCCEEDED' &&
      (result.affectedFiles.length > 0 || tool.name === 'apply_patch' || tool.name === 'write_file')
    ) {
      state = { ...state, lastVerificationPassed: false };
    }
    checkpoint = this.saveRunCheckpoint(checkpoint, state);
    this.dependencies.budgetManager.assertWithin(checkpoint.state);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    const record = this.dependencies.database.getToolCall(toolCallId)!;
    if (result.status === 'CANCELLED' && signal?.aborted) {
      throw (
        signal.reason ??
        new AppError('TASK_CANCELLED', result.error?.message ?? 'Tool execution cancelled')
      );
    }
    return record;
  }

  private async precheck(task: StoredTask, signal?: AbortSignal): Promise<void> {
    this.throwIfStopped(task.id, signal);
    await this.dependencies.workspaceManager.assertReady(task.workspacePath);
    const status = await this.dependencies.workspaceManager.getStatus(task.workspacePath);
    if (!status.clean) {
      throw new AppError(
        'WORKSPACE_ERROR',
        'Task workspace contains changes before execution',
        { category: 'PRECHECK_DIRTY', entries: status.entries },
        409
      );
    }
    const project = this.dependencies.database.getProject(task.projectId);
    const baseline = this.dependencies.database
      .getWorkspaceSnapshots(task.id)
      .find((snapshot) => snapshot.kind === 'BASELINE');
    if (!project || !baseline) {
      throw new AppError('WORKSPACE_ERROR', 'Task source metadata or baseline is missing');
    }
    const capturedRevision = project.sourceMetadata?.git.revision;
    if (
      capturedRevision &&
      baseline.sourceRevision &&
      capturedRevision !== baseline.sourceRevision
    ) {
      throw new AppError('CONFLICT', 'Task baseline does not match the imported source revision', {
        capturedRevision,
        baselineRevision: baseline.sourceRevision
      });
    }
  }

  private async executeLoop(task: StoredTask, signal?: AbortSignal): Promise<StoredTask> {
    const controlledSignal = signal ?? new AbortController().signal;
    while (this.requireTask(task.id).status === 'EXECUTING') {
      this.throwIfStopped(task.id, signal);
      task = this.requireTask(task.id);
      let checkpoint = this.ensureRunCheckpoint(task);
      checkpoint = this.ensureActivePlanStep(task, checkpoint);
      task = this.requireTask(task.id);
      let turn = checkpoint.state.activeTurn;
      if (!turn || turn.status === 'OBSERVED') {
        if (
          turn?.status === 'OBSERVED' &&
          turn.decision.type === 'COMPLETE' &&
          !this.requiresWorkspaceChange(task) &&
          this.canCompleteReadOnly(task)
        ) {
          task = await this.completeDecision(task, turn.decision);
          continue;
        }
        const decision = await this.nextDecision(task, controlledSignal);
        checkpoint = this.beginTurn(task, decision);
        turn = checkpoint.state.activeTurn!;
      }
      task = await this.dispatchDecision(task, turn, controlledSignal);
    }
    return this.requireTask(task.id);
  }

  private async nextDecision(task: StoredTask, signal: AbortSignal): Promise<ModelDecision> {
    let checkpoint = this.ensureRunCheckpoint(task);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    checkpoint = await this.summarizeHistory(task, checkpoint, signal);
    const overview = await this.dependencies.codeIndex.getProjectOverview(task.projectId, signal);
    this.throwIfStopped(task.id, signal);
    const candidates = await this.contextCandidates(task, overview, checkpoint, signal);
    const selection = this.dependencies.contextManager.select(candidates);
    const state = {
      ...this.synchronizeRunState(checkpoint.state, task),
      contextRefs: selection.entries.map(({ reference }) => reference)
    };
    checkpoint = this.saveRunCheckpoint(checkpoint, state);
    this.dependencies.budgetManager.assertWithin(checkpoint.state);
    checkpoint = this.saveRunCheckpoint(
      checkpoint,
      this.dependencies.budgetManager.reserveStep(checkpoint.state)
    );
    const recoveryInstruction = this.recoveryInstruction(task.id);
    const recoveryExcludedTools: readonly ToolCall['name'][] = recoveryInstruction
      ? [
          ...(this.hasReadAfterInvalidPatch(task.id) ? (['read_file'] as const) : []),
          'list_files',
          'git_diff'
        ]
      : [];
    let response = await this.requestDecision(
      this.planningRequest(
        checkpoint.state,
        selection.entries,
        recoveryInstruction,
        recoveryExcludedTools
      ),
      signal
    );
    try {
      this.assertDecision(response.decision);
    } catch (error) {
      if (!this.isInvalidVerificationDecision(error, response.decision)) throw error;
      checkpoint = this.saveRunCheckpoint(
        checkpoint,
        this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage)
      );
      this.dependencies.budgetManager.assertWithin(checkpoint.state);
      response = await this.requestDecision(
        this.planningRequest(
          checkpoint.state,
          selection.entries,
          'The previous VERIFY decision was rejected by the command policy. Return VERIFY only with a literal allowlisted command such as "python -m pytest tests/test_parser.py -v" or "git diff --check". Do not return file-reading commands, shell commands, checklist text, or natural-language instructions.'
        ),
        signal
      );
      try {
        this.assertDecision(response.decision);
      } catch (retryError) {
        if (!this.isInvalidVerificationDecision(retryError, response.decision)) {
          throw retryError;
        }
        response = {
          ...response,
          decision: {
            type: 'VERIFY',
            reason: 'Use the harness verification fallback after two invalid model commands',
            commands: [this.verificationFallback(checkpoint.state.plan)]
          }
        };
      }
    }
    for (
      let correctionAttempt = 1;
      correctionAttempt <= 2 && this.isRejectedCompletion(checkpoint.state, response.decision);
      correctionAttempt += 1
    ) {
      checkpoint = this.saveRunCheckpoint(
        checkpoint,
        this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage)
      );
      this.dependencies.budgetManager.assertWithin(checkpoint.state);
      response = await this.requestDecision(
        this.planningRequest(
          checkpoint.state,
          selection.entries,
          `Correction ${correctionAttempt} of 2: the previous COMPLETE decision was rejected because verification or completion conditions are not satisfied. You MUST NOT return COMPLETE. Inspect the latest failed verification result and make a real fix with read_file/apply_patch/write_file, or return VERIFY with a literal allowlisted command.`
        ),
        signal
      );
      this.assertDecision(response.decision);
    }
    if (this.isRejectedCompletion(checkpoint.state, response.decision)) {
      throw new AppError(
        'MODEL_ERROR',
        'Model returned COMPLETE after completion was rejected',
        { category: 'INVALID_DECISION', reason: 'completion conditions are not satisfied' },
        502
      );
    }
    if (
      recoveryInstruction &&
      this.isExcludedRecoveryDecision(response.decision, recoveryExcludedTools)
    ) {
      checkpoint = this.saveRunCheckpoint(
        checkpoint,
        this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage)
      );
      response = await this.requestDecision(
        this.planningRequest(
          checkpoint.state,
          selection.entries,
          `${recoveryInstruction} The previous decision selected a tool that is unavailable in this recovery state. Return apply_patch, write_file, VERIFY, or PLAN_UPDATE now.`,
          recoveryExcludedTools
        ),
        signal
      );
      this.assertDecision(response.decision);
      if (this.isExcludedRecoveryDecision(response.decision, recoveryExcludedTools)) {
        throw new AppError(
          'MODEL_ERROR',
          'Model selected a read-only tool that is unavailable during patch recovery',
          {
            category: 'INVALID_DECISION',
            toolName:
              response.decision.type === 'TOOL_CALL' ? response.decision.tool.name : undefined
          },
          502
        );
      }
    }
    for (
      let correctionAttempt = 1;
      correctionAttempt <= 1 &&
      this.isRepeatedReadDecision(task.id, checkpoint.state, response.decision);
      correctionAttempt += 1
    ) {
      const repeatedToolName =
        response.decision.type === 'TOOL_CALL' ? response.decision.tool.name : undefined;
      checkpoint = this.saveRunCheckpoint(
        checkpoint,
        this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage)
      );
      this.dependencies.budgetManager.assertWithin(checkpoint.state);
      response = await this.requestDecision(
        this.planningRequest(
          checkpoint.state,
          selection.entries,
          `Correction ${correctionAttempt} of 1: the requested ${repeatedToolName ?? 'read'} call exactly repeats a successful read whose latest result is already present in TOOL_RESULT context. The workspace has not changed since that read. You MUST NOT request ${repeatedToolName ?? 'that read'} again. Use the existing file content now and return a different decision. If the file is invalid, return apply_patch with a hash and edits that repair it; otherwise verify, update the plan, or complete the next step.`,
          repeatedToolName ? [repeatedToolName] : []
        ),
        signal
      );
      this.assertDecision(response.decision);
    }
    if (this.isRepeatedReadDecision(task.id, checkpoint.state, response.decision)) {
      if (response.decision.type === 'TOOL_CALL' && response.decision.tool.name === 'read_file') {
        response = {
          ...response,
          decision: {
            type: 'TOOL_CALL',
            reason: 'Harness fallback: inspect the current workspace diff after repeated reads',
            tool: { name: 'git_diff', arguments: {} }
          }
        };
      } else {
        this.assertDecisionProgress(task.id, checkpoint.state, response.decision);
      }
    }
    checkpoint = this.saveRunCheckpoint(
      checkpoint,
      this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage)
    );
    this.dependencies.budgetManager.assertWithin(checkpoint.state);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    return response.decision;
  }

  private beginTurn(task: StoredTask, decision: ModelDecision): TaskRunCheckpoint {
    const checkpoint = this.ensureRunCheckpoint(task);
    const timestamp = new Date().toISOString();
    const sequence = (checkpoint.state.turnCount ?? 0) + 1;
    const toolCallCount =
      decision.type === 'TOOL_CALL' ? 1 : decision.type === 'VERIFY' ? decision.commands.length : 0;
    const turn: HarnessTurn = {
      sequence,
      decision,
      status: 'DECIDED',
      startedAt: timestamp,
      updatedAt: timestamp,
      toolCallIds: Array.from({ length: toolCallCount }, () => randomUUID())
    };
    const state = {
      ...this.synchronizeRunState(checkpoint.state, task),
      turnCount: sequence,
      activeTurn: turn
    };
    const result = this.dependencies.database.updateTaskRunWithAudit(
      { ...checkpoint, state, updatedAt: timestamp },
      checkpoint.version,
      {
        id: randomUUID(),
        taskId: task.id,
        action: 'harness.decision',
        resourceType: 'harness_turn',
        resourceId: `${checkpoint.runId}:${sequence}`,
        after: this.decisionAudit(decision),
        timestamp
      },
      {
        type: 'harness.decision',
        timestamp,
        payload: {
          sequence,
          decisionType: decision.type,
          reason: decision.reason
        }
      }
    );
    if (result.event) this.dependencies.broker.publish(result.event);
    return result.checkpoint;
  }

  private observeTurn(taskId: string, observation: HarnessObservation): TaskRunCheckpoint {
    const checkpoint = this.dependencies.database.getTaskRun(taskId);
    const turn = checkpoint?.state.activeTurn;
    if (!checkpoint || !turn || turn.status !== 'DECIDED') {
      throw new AppError(
        'CONFLICT',
        'Harness turn is not awaiting an observation',
        { taskId },
        409
      );
    }
    const timestamp = new Date().toISOString();
    const failed = observation.status === 'FAILED';
    const state: RunState = {
      ...this.synchronizeRunState(checkpoint.state, this.requireTask(taskId)),
      consecutiveFailures: failed ? (checkpoint.state.consecutiveFailures ?? 0) + 1 : 0,
      lastVerificationPassed: observation.verificationResultIds
        ? observation.status === 'SUCCEEDED'
        : checkpoint.state.lastVerificationPassed,
      activeTurn: {
        ...turn,
        status: 'OBSERVED',
        updatedAt: timestamp,
        observation
      }
    };
    return this.dependencies.database.updateTaskRunWithAudit(
      { ...checkpoint, state, updatedAt: timestamp },
      checkpoint.version,
      {
        id: randomUUID(),
        taskId,
        action: 'harness.observation',
        resourceType: 'harness_turn',
        resourceId: `${checkpoint.runId}:${turn.sequence}`,
        before: { status: 'DECIDED' },
        after: observation,
        timestamp
      }
    ).checkpoint;
  }

  private async dispatchDecision(
    task: StoredTask,
    turn: HarnessTurn,
    signal: AbortSignal
  ): Promise<StoredTask> {
    const decision = turn.decision;
    if (decision.type === 'PLAN_UPDATE') {
      try {
        this.assertPlan(decision.plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const observation: HarnessObservation = {
          status: 'FAILED',
          summary: message,
          error: {
            code: error instanceof AppError ? error.code : 'MODEL_ERROR',
            message,
            retryable: true
          }
        };
        const checkpoint = this.observeTurn(task.id, observation);
        return this.afterFailureLimit(task, checkpoint, observation);
      }
      task = this.updatePlan(task, decision.plan);
      this.observeTurn(task.id, {
        status: 'SUCCEEDED',
        summary: `Plan updated with ${decision.plan.steps.length} steps`
      });
      return task;
    }
    if (decision.type === 'TOOL_CALL') {
      const record = await this.callTool(task, decision.tool, turn.toolCallIds![0]!, signal);
      const observation = this.toolObservation(record);
      const checkpoint = this.observeTurn(task.id, observation);
      return this.afterFailureLimit(task, checkpoint, observation);
    }
    if (decision.type === 'ASK_USER') {
      this.observeTurn(task.id, {
        status: 'SUCCEEDED',
        summary: `Waiting for user input: ${decision.question}`
      });
      return this.transition(
        this.requireTask(task.id),
        'WAITING_USER',
        {
          stopReason: decision.question,
          resumeStatus: 'EXECUTING',
          controlRequest: null
        },
        [{ type: 'task.waiting_user', payload: { message: decision.question } }]
      );
    }
    if (decision.type === 'VERIFY') {
      return this.executeVerification(task, turn, signal);
    }
    return this.completeDecision(task, decision);
  }

  private async executeVerification(
    task: StoredTask,
    turn: HarnessTurn,
    signal: AbortSignal
  ): Promise<StoredTask> {
    if (turn.decision.type !== 'VERIFY') return task;
    if (turn.decision.commands.length === 0) {
      const observation: HarnessObservation = {
        status: 'FAILED',
        summary: 'Verification requires at least one command',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Verification requires at least one command',
          retryable: false
        }
      };
      const checkpoint = this.observeTurn(task.id, observation);
      return this.afterFailureLimit(task, checkpoint, observation);
    }
    task = this.transition(task, 'VERIFYING');
    const resultIds: string[] = [];
    let failed = false;
    const existingResults = this.dependencies.database
      .getVerificationResults(task.id)
      .filter(({ createdAt }) => createdAt >= turn.startedAt);
    for (const [index, command] of turn.decision.commands.entries()) {
      const existingVerification =
        existingResults.find(({ command: existingCommand }) => existingCommand === command) ??
        this.reusableVerification(task.id, command);
      if (existingVerification) {
        resultIds.push(existingVerification.id);
        failed ||= existingVerification.status !== 'PASSED';
        continue;
      }
      let checkpoint = this.ensureRunCheckpoint(task);
      checkpoint = this.saveRunCheckpoint(
        checkpoint,
        this.dependencies.budgetManager.reserveVerification(
          this.synchronizeRunState(checkpoint.state, task)
        )
      );
      const tool = this.verificationTool(command);
      const call = await this.callTool(task, tool, turn.toolCallIds![index]!, signal);
      this.throwIfStopped(task.id, signal);
      const output = call.result?.output as CommandOutput | undefined;
      const passed = call.result?.status === 'SUCCEEDED' && output?.code === 0;
      failed ||= !passed;
      const verification: VerificationResult = {
        id: randomUUID(),
        taskId: task.id,
        command,
        status: passed ? 'PASSED' : 'FAILED',
        exitCode: output?.code,
        outputSummary: output
          ? `${output.stdout}\n${output.stderr}`.trim().slice(0, 4000)
          : (call.result?.error?.message ?? 'Verification tool failed'),
        failureCategory: passed ? undefined : this.verificationFailureCategory(command, call),
        createdAt: new Date().toISOString()
      };
      resultIds.push(verification.id);
      const event = this.dependencies.database.recordVerification(verification, {
        type: 'verification.completed',
        timestamp: verification.createdAt,
        payload: { verification }
      });
      this.dependencies.broker.publish(event);
    }
    const baselineVerification =
      this.requiresWorkspaceChange(task) &&
      (this.dependencies.database.getTaskRun(task.id)?.state.changedFiles.length ?? 0) === 0;
    const plan = failed
      ? task.plan
      : baselineVerification
        ? this.advanceVerifiedPlan(task.plan)
        : this.completedPlan(task.plan);
    task = this.transition(this.requireTask(task.id), 'EXECUTING', { plan }, [
      ...(plan && plan !== task.plan
        ? [{ type: 'task.plan.updated' as const, payload: { plan } }]
        : [])
    ]);
    const observation: HarnessObservation = failed
      ? {
          status: 'FAILED',
          summary: 'One or more verification commands failed',
          verificationResultIds: resultIds,
          error: {
            code: 'WORKSPACE_ERROR',
            message: 'Verification failed',
            retryable: true
          }
        }
      : {
          status: 'SUCCEEDED',
          summary: `${resultIds.length} verification command(s) passed`,
          verificationResultIds: resultIds
        };
    const checkpoint = this.observeTurn(task.id, observation);
    return this.afterFailureLimit(task, checkpoint, observation);
  }

  private reusableVerification(taskId: string, command: string): VerificationResult | undefined {
    const candidates = this.dependencies.database
      .getVerificationResults(taskId)
      .filter(({ command: candidate, status }) => candidate === command && status === 'PASSED')
      .reverse();
    const toolCalls = this.dependencies.database.getToolCalls(taskId);
    for (const candidate of candidates) {
      const verificationTime = Date.parse(candidate.createdAt);
      const workspaceChanged = toolCalls.some((call) => {
        const callTime = Date.parse(call.finishedAt ?? call.startedAt);
        const writesFiles = (call.result?.affectedFiles.length ?? 0) > 0;
        const isFileWrite = call.tool.name === 'apply_patch' || call.tool.name === 'write_file';
        return (
          call.status === 'SUCCEEDED' && callTime > verificationTime && (writesFiles || isFileWrite)
        );
      });
      if (!workspaceChanged) return candidate;
    }
    return undefined;
  }

  private async completeDecision(
    task: StoredTask,
    decision: Extract<ModelDecision, { type: 'COMPLETE' }>
  ): Promise<StoredTask> {
    const planComplete = task.plan?.steps.every(({ status }) => status === 'DONE') ?? false;
    const readOnlyComplete = this.canCompleteReadOnly(task);
    const verified =
      this.dependencies.database.getTaskRun(task.id)?.state.lastVerificationPassed === true;
    const currentDiff = await this.dependencies.workspaceManager.getStructuredDiff(
      task.workspacePath
    );
    if (!planComplete || (!verified && !readOnlyComplete)) {
      const observation: HarnessObservation = {
        status: 'FAILED',
        summary: 'Completion rejected because the plan or verification is incomplete',
        error: {
          code: 'CONFLICT',
          message: 'Harness completion conditions are not satisfied',
          retryable: true
        }
      };
      const checkpoint = this.observeTurn(task.id, observation);
      return this.afterFailureLimit(task, checkpoint, observation);
    }
    if (this.requiresWorkspaceChange(task) && currentDiff.length === 0) {
      const observation: HarnessObservation = {
        status: 'FAILED',
        summary: 'Completion rejected because no workspace changes were produced',
        error: {
          code: 'CONFLICT',
          message: 'This task requests file changes, but the workspace is unchanged',
          retryable: true
        }
      };
      const checkpoint = this.observeTurn(task.id, observation);
      return this.afterFailureLimit(task, checkpoint, observation);
    }
    await this.finalizeChanges(task, currentDiff);
    const activeTurn = this.dependencies.database.getTaskRun(task.id)?.state.activeTurn;
    if (activeTurn?.status === 'DECIDED') {
      this.observeTurn(task.id, { status: 'SUCCEEDED', summary: decision.summary });
    }
    const completedAt = new Date().toISOString();
    const completionMessage: Message = {
      id: randomUUID(),
      sessionId: task.sessionId,
      role: 'ASSISTANT',
      content: decision.summary,
      createdAt: completedAt
    };
    this.dependencies.database.createMessage(completionMessage);
    const latestVerification = this.dependencies.database
      .getVerificationResults(task.id)
      .filter(({ status }) => status === 'PASSED')
      .at(-1);
    return this.transition(this.requireTask(task.id), 'READY_FOR_REVIEW', {}, [
      {
        type: 'task.completed',
        payload: {
          messageId: completionMessage.id,
          summary: completionMessage.content,
          verification: {
            command: latestVerification?.command ?? 'read-only task: no verification command',
            code: latestVerification?.exitCode ?? 0
          }
        }
      }
    ]);
  }

  private async finalizeChanges(
    task: StoredTask,
    diff?: Awaited<ReturnType<WorkspaceManager['getStructuredDiff']>>
  ): Promise<void> {
    const snapshots = this.dependencies.database.getWorkspaceSnapshots(task.id);
    if (!snapshots.some(({ kind }) => kind === 'FINAL')) {
      await this.checkpoint(task.id, 'FINAL');
    }
    const currentDiff =
      diff ?? (await this.dependencies.workspaceManager.getStructuredDiff(task.workspacePath));
    const toolCalls = this.dependencies.database.getToolCalls(task.id);
    const sideEffectNames = new Set(
      this.dependencies.tools
        .definitions()
        .filter(({ sideEffect }) => sideEffect)
        .map(({ name }) => name)
    );
    const changes = this.dependencies.database.replaceFileChanges(
      task.id,
      currentDiff.map((file): FileChange => {
        const origin =
          [...toolCalls]
            .reverse()
            .find(({ result }) => result?.affectedFiles.includes(file.path)) ??
          [...toolCalls]
            .reverse()
            .find(({ status, tool }) => status === 'SUCCEEDED' && sideEffectNames.has(tool.name));
        if (!origin) {
          throw new AppError(
            'WORKSPACE_ERROR',
            'A workspace change cannot be traced to a completed side-effect tool',
            { path: file.path }
          );
        }
        return {
          id: randomUUID(),
          taskId: task.id,
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
          decision: 'PENDING',
          toolCallId: origin.id,
          stepId: origin.stepId
        };
      })
    );
    const checkpoint = this.dependencies.database.getTaskRun(task.id);
    if (checkpoint) {
      this.saveRunCheckpoint(checkpoint, {
        ...this.synchronizeRunState(checkpoint.state, this.requireTask(task.id)),
        changedFiles: changes.map(({ path }) => path)
      });
    }
  }

  private canCompleteReadOnly(task: StoredTask): boolean {
    const planComplete = task.plan?.steps.every(({ status }) => status === 'DONE') ?? false;
    const state = this.dependencies.database.getTaskRun(task.id)?.state;
    return (
      planComplete &&
      (state?.changedFiles.length ?? 0) === 0 &&
      (state?.verificationResultIds.length ?? 0) === 0
    );
  }

  private requiresWorkspaceChange(task: StoredTask): boolean {
    const goal = task.goal.toLocaleLowerCase();
    const englishChangeIntent =
      /\b(?:fix|refactor|modify|change|update|implement|add|remove|replace|rewrite|patch|repair)\b/.test(
        goal
      );
    const chineseChangeIntent = [
      '修复',
      '重构',
      '修改',
      '更新',
      '实现',
      '新增',
      '删除',
      '替换',
      '重写',
      '补充',
      '改动',
      '添加',
      '增加',
      '加注释',
      '注释'
    ].some((indicator) => goal.includes(indicator));
    return englishChangeIntent || chineseChangeIntent;
  }

  private async assertStoredDiffCurrent(
    task: StoredTask,
    storedChanges: readonly FileChange[]
  ): Promise<void> {
    const current = await this.dependencies.workspaceManager.getStructuredDiff(task.workspacePath);
    const normalizedStored = storedChanges
      .map(({ path, status, additions, deletions, patch }) => ({
        path,
        status,
        additions,
        deletions,
        patch
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const normalizedCurrent = [...current].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    if (JSON.stringify(normalizedStored) !== JSON.stringify(normalizedCurrent)) {
      throw new AppError(
        'CONFLICT',
        'Task workspace changed after the review Diff was generated',
        undefined,
        409
      );
    }
  }

  private ensureActivePlanStep(task: StoredTask, checkpoint: TaskRunCheckpoint): TaskRunCheckpoint {
    if (checkpoint.state.currentStepId || !task.plan) return checkpoint;
    const first = task.plan.steps.find(({ status }) => status !== 'DONE');
    if (!first) return checkpoint;
    const plan: TaskPlan = {
      ...task.plan,
      steps: task.plan.steps.map((step) =>
        step.id === first.id ? { ...step, status: 'RUNNING' as const } : step
      )
    };
    const updatedTask = this.updatePlan(task, plan);
    return this.saveRunCheckpoint(this.dependencies.database.getTaskRun(task.id)!, {
      ...this.dependencies.database.getTaskRun(task.id)!.state,
      phase: updatedTask.status,
      plan,
      currentStepId: first.id
    });
  }

  private updatePlan(task: StoredTask, plan: TaskPlan): StoredTask {
    this.assertPlan(plan);
    return this.transition(task, task.status, { plan }, [
      { type: 'task.plan.updated', payload: { plan } }
    ]);
  }

  private assertPlan(plan: TaskPlan): void {
    if (!plan.goal.trim() || plan.steps.length === 0 || plan.steps.length > config.maxTaskSteps) {
      throw new AppError(
        'MODEL_ERROR',
        'Model returned an invalid task plan',
        { category: 'INVALID_PLAN', stepCount: plan.steps.length },
        502
      );
    }
    const ids = new Set(plan.steps.map(({ id }) => id));
    if (
      ids.size !== plan.steps.length ||
      plan.steps.some(({ id, title }) => !id.trim() || !title.trim()) ||
      plan.steps.filter(({ status }) => status === 'RUNNING').length > 1
    ) {
      throw new AppError(
        'MODEL_ERROR',
        'Task plan step identifiers or statuses are invalid',
        { category: 'INVALID_PLAN' },
        502
      );
    }
  }

  private advanceVerifiedPlan(plan: TaskPlan | undefined): TaskPlan | undefined {
    if (!plan) return undefined;
    const currentIndex = plan.steps.findIndex(({ status }) => status === 'RUNNING');
    const stepIndex =
      currentIndex >= 0 ? currentIndex : plan.steps.findIndex(({ status }) => status !== 'DONE');
    if (stepIndex < 0) return plan;
    const nextIndex = plan.steps.findIndex(
      ({ status }, index) => index > stepIndex && status !== 'DONE'
    );
    return {
      ...plan,
      steps: plan.steps.map((step, index) => {
        if (index === stepIndex) return { ...step, status: 'DONE' as const };
        if (index === nextIndex) return { ...step, status: 'RUNNING' as const };
        return step;
      })
    };
  }

  private completedPlan(plan: TaskPlan | undefined): TaskPlan | undefined {
    if (!plan) return undefined;
    return {
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, status: 'DONE' as const }))
    };
  }

  private toolObservation(record: ToolCallRecord): HarnessObservation {
    const commandOutput =
      record.tool.name === 'run_command'
        ? (record.result?.output as CommandOutput | undefined)
        : undefined;
    const commandFailed = commandOutput !== undefined && commandOutput.code !== 0;
    if (record.result?.status === 'SUCCEEDED' && !commandFailed) {
      return {
        status: 'SUCCEEDED',
        summary: JSON.stringify(this.summary(record.result.output)),
        toolCallId: record.id
      };
    }
    if (commandFailed) {
      return {
        status: 'FAILED',
        summary: `Command exited with code ${commandOutput.code}: ${
          `${commandOutput.stdout}\n${commandOutput.stderr}`.trim() || 'no output'
        }`,
        toolCallId: record.id,
        error: {
          code: 'WORKSPACE_ERROR',
          message: `Command exited with code ${commandOutput.code}`,
          retryable: true
        }
      };
    }
    return {
      status: 'FAILED',
      summary: record.result?.error?.message ?? `Tool ended in ${record.status}`,
      toolCallId: record.id,
      error: {
        code: record.result?.error?.code ?? 'WORKSPACE_ERROR',
        message: record.result?.error?.message ?? 'Tool execution failed',
        retryable: record.result?.error?.retryable ?? false
      }
    };
  }

  private afterFailureLimit(
    task: StoredTask,
    checkpoint: TaskRunCheckpoint,
    observation: HarnessObservation
  ): StoredTask {
    if (
      observation.status !== 'FAILED' ||
      (checkpoint.state.consecutiveFailures ?? 0) < config.maxConsecutiveHarnessFailures
    ) {
      return this.requireTask(task.id);
    }
    const message = `Harness stopped after ${checkpoint.state.consecutiveFailures} consecutive failures`;
    return this.transition(
      this.requireTask(task.id),
      'WAITING_USER',
      {
        stopReason: message,
        resumeStatus: 'EXECUTING',
        controlRequest: null
      },
      [{ type: 'task.waiting_user', payload: { message } }]
    );
  }

  private verificationTool(command: string): ToolCall {
    const request = parseAllowedCommand(command);
    return {
      name: 'run_command',
      arguments: { ...request }
    };
  }

  private verificationFailureCategory(
    command: string,
    call: ToolCallRecord
  ): VerificationResult['failureCategory'] {
    if (call.result?.error?.code === 'COMMAND_NOT_ALLOWED') return 'ENVIRONMENT';
    return /\btest\b/i.test(command) ? 'TEST' : 'CODE';
  }

  private decisionAudit(decision: ModelDecision): Record<string, unknown> {
    if (decision.type === 'TOOL_CALL') {
      return {
        type: decision.type,
        reason: decision.reason,
        toolName: decision.tool.name,
        arguments: this.safeArguments(decision.tool.arguments)
      };
    }
    if (decision.type === 'VERIFY') {
      return {
        type: decision.type,
        reason: decision.reason,
        commandCount: decision.commands.length
      };
    }
    if (decision.type === 'PLAN_UPDATE') {
      return {
        type: decision.type,
        reason: decision.reason,
        stepCount: decision.plan.steps.length
      };
    }
    return { type: decision.type, reason: decision.reason };
  }

  private isRetryable(error: AppError): boolean {
    return (
      error.code === 'CONFLICT' ||
      error.code === 'INDEX_ERROR' ||
      (error.code === 'WORKSPACE_ERROR' &&
        typeof error.details === 'object' &&
        error.details !== null &&
        'category' in error.details &&
        ['TIMEOUT', 'TEMPORARY'].includes(
          String((error.details as { category: unknown }).category)
        ))
    );
  }

  private requiresUserReview(error: AppError): boolean {
    if (typeof error.details !== 'object' || error.details === null) return false;
    const category =
      'category' in error.details
        ? String((error.details as { category: unknown }).category)
        : undefined;
    return category === 'INTERRUPTED_TOOL' || category === 'PRECHECK_DIRTY';
  }

  private isInvalidVerificationDecision(error: unknown, decision: ModelDecision): boolean {
    if (!(error instanceof AppError) || decision.type !== 'VERIFY') return false;
    if (typeof error.details !== 'object' || error.details === null) return false;
    return (error.details as { category?: unknown }).category === 'INVALID_DECISION';
  }

  private assertDecision(decision: ModelDecision): void {
    try {
      assertDomainContract('modelDecision', decision);
    } catch (error) {
      throw new AppError(
        'MODEL_ERROR',
        'Model returned an invalid Decision',
        {
          category: 'INVALID_DECISION',
          cause: error instanceof Error ? error.message : String(error)
        },
        502
      );
    }
    if (decision.type === 'VERIFY') {
      for (const command of decision.commands) {
        try {
          parseAllowedCommand(command);
        } catch (error) {
          throw new AppError(
            'MODEL_ERROR',
            'Model returned an invalid verification command',
            {
              category: 'INVALID_DECISION',
              verificationCommand: command.slice(0, 500),
              cause: error instanceof Error ? error.message : String(error)
            },
            502
          );
        }
      }
    }
  }

  private assertDecisionProgress(taskId: string, state: RunState, decision: ModelDecision): void {
    if (!this.isRepeatedReadDecision(taskId, state, decision)) return;
    throw new AppError(
      'MODEL_ERROR',
      'Model repeated the same successful tool call without making progress',
      {
        category: 'REPEATED_DECISION',
        toolName: decision.type === 'TOOL_CALL' ? decision.tool.name : undefined
      },
      502
    );
  }

  private verificationFallback(plan?: TaskPlan): string {
    for (const candidate of plan?.verification ?? []) {
      try {
        parseAllowedCommand(candidate.trim());
        return candidate.trim();
      } catch {
        // Fall through to the universal diff check.
      }
    }
    return 'git diff --check';
  }

  private isRejectedCompletion(state: RunState, decision: ModelDecision): boolean {
    const observation = state.activeTurn?.observation;
    return (
      decision.type === 'COMPLETE' &&
      state.activeTurn?.status === 'OBSERVED' &&
      observation?.status === 'FAILED' &&
      observation.error?.code === 'CONFLICT' &&
      observation.summary.startsWith('Completion rejected') &&
      state.verificationResultIds.length > 0
    );
  }

  private latestInvalidPatchCall(taskId: string): ToolCallRecord | undefined {
    const calls = this.dependencies.database.getToolCalls(taskId).filter(({ result }) => result);
    const patchIndex = [...calls]
      .reverse()
      .findIndex(
        ({ tool, result }) =>
          tool.name === 'apply_patch' &&
          result?.status === 'FAILED' &&
          result.error?.code === 'VALIDATION_ERROR' &&
          result.error.message.includes('Patch edits overlap')
      );
    if (patchIndex < 0) return undefined;
    const actualIndex = calls.length - patchIndex - 1;
    if (
      calls
        .slice(actualIndex + 1)
        .some(
          ({ result }) => result?.status === 'SUCCEEDED' && (result.affectedFiles?.length ?? 0) > 0
        )
    ) {
      return undefined;
    }
    return calls[actualIndex];
  }

  private isInvalidPatchObservation(taskId: string): boolean {
    return this.latestInvalidPatchCall(taskId) !== undefined;
  }

  private recoveryInstruction(taskId: string): string | undefined {
    const invalidPatch = this.latestInvalidPatchCall(taskId);
    if (!invalidPatch) return undefined;
    const details = invalidPatch.result?.error?.details;
    const lineCount =
      typeof details === 'object' && details !== null && !Array.isArray(details)
        ? (details as { lineCount?: unknown }).lineCount
        : undefined;
    const lineCountInstruction =
      typeof lineCount === 'number' ? ` The current file has exactly ${lineCount} lines.` : '';
    const readInstruction = this.hasReadAfterInvalidPatch(taskId)
      ? 'A numbered file result is already available; do not call read_file again.'
      : 'If numberedContent is not present in the latest file result, call read_file once for the same path and then use its numberedContent.';
    return `The previous apply_patch was rejected by the tool because its edit ranges overlap or are outside the current file.${lineCountInstruction} Treat the tool result as authoritative. ${readInstruction} Return one new valid TOOL_CALL apply_patch using the existing file content: edits use original-file 1-based line numbers within that file, each startLine may appear only once, and a replacement must be one edit with deleteCount plus replacement lines. Do not repeat the rejected patch, use a line beyond the current file, split one replacement into delete and insert edits, or spend a turn rereading the unchanged file.`;
  }

  private hasReadAfterInvalidPatch(taskId: string): boolean {
    const invalidPatch = this.latestInvalidPatchCall(taskId);
    if (!invalidPatch) return false;
    const calls = this.dependencies.database.getToolCalls(taskId).filter(({ result }) => result);
    const invalidIndex = calls.findIndex(({ id }) => id === invalidPatch.id);
    return calls
      .slice(invalidIndex + 1)
      .some(({ tool, result }) => tool.name === 'read_file' && result?.status === 'SUCCEEDED');
  }

  private isExcludedRecoveryDecision(
    decision: ModelDecision,
    excludedTools: readonly ToolCall['name'][]
  ): boolean {
    return decision.type === 'TOOL_CALL' && excludedTools.includes(decision.tool.name);
  }

  private isNoOpFileWrite(output: unknown): boolean {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
    const value = output as { previousHash?: unknown; hash?: unknown };
    return (
      typeof value.previousHash === 'string' &&
      typeof value.hash === 'string' &&
      value.previousHash === value.hash
    );
  }

  private isRepeatedReadDecision(
    taskId: string,
    _state: RunState,
    decision: ModelDecision
  ): boolean {
    if (
      decision.type !== 'TOOL_CALL' ||
      !['list_files', 'read_file', 'git_diff'].includes(decision.tool.name)
    ) {
      return false;
    }

    const runStartedAt = this.dependencies.database.getTaskRun(taskId)?.startedAt;
    if (!runStartedAt) return false;

    const successfulCalls = this.dependencies.database
      .getToolCalls(taskId)
      .filter(
        (call) =>
          call.status === 'SUCCEEDED' && Date.parse(call.startedAt) >= Date.parse(runStartedAt)
      );
    const reverseIndex = [...successfulCalls]
      .reverse()
      .findIndex(
        (call) =>
          call.tool.name === decision.tool.name &&
          JSON.stringify(call.tool.arguments) === JSON.stringify(decision.tool.arguments)
      );
    const matchingIndex = reverseIndex < 0 ? -1 : successfulCalls.length - reverseIndex - 1;
    if (matchingIndex < 0) return false;

    // A successful workspace write invalidates earlier reads, so rereading
    // after a change remains valid and gives the model fresh context.
    return !successfulCalls
      .slice(matchingIndex + 1)
      .some(({ result }) => (result?.affectedFiles?.length ?? 0) > 0);
  }

  private async plan(task: StoredTask, signal?: AbortSignal): Promise<TaskPlan> {
    const controlledSignal = signal ?? new AbortController().signal;
    let checkpoint = this.ensureRunCheckpoint(task);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    checkpoint = await this.summarizeHistory(task, checkpoint, controlledSignal);
    const overview = await this.dependencies.codeIndex.getProjectOverview(
      task.projectId,
      controlledSignal
    );
    this.throwIfStopped(task.id, signal);
    const candidates = await this.contextCandidates(task, overview, checkpoint, controlledSignal);
    const selection = this.dependencies.contextManager.select(candidates);
    const state = {
      ...this.synchronizeRunState(checkpoint.state, task),
      contextRefs: selection.entries.map(({ reference }) => reference)
    };
    checkpoint = this.saveRunCheckpoint(checkpoint, state);
    this.dependencies.budgetManager.assertWithin(checkpoint.state);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    checkpoint = this.saveRunCheckpoint(
      checkpoint,
      this.dependencies.budgetManager.reserveStep(checkpoint.state)
    );
    const response = await this.requestDecision(
      this.planningRequest(checkpoint.state, selection.entries),
      controlledSignal
    );
    this.assertDecision(response.decision);
    checkpoint = this.saveRunCheckpoint(
      checkpoint,
      this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage)
    );
    this.dependencies.budgetManager.assertWithin(checkpoint.state);
    this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    this.throwIfStopped(task.id, signal);
    if (response.decision.type !== 'PLAN_UPDATE') {
      throw new AppError(
        'MODEL_ERROR',
        'Planning requires a PLAN_UPDATE model decision',
        { category: 'INVALID_DECISION', decisionType: response.decision.type },
        502
      );
    }
    this.assertPlan(response.decision.plan);
    return response.decision.plan;
  }

  private planningRequest(
    state: RunState,
    context: readonly SelectedContext[],
    harnessInstruction?: string,
    excludedTools: readonly ToolCall['name'][] = []
  ) {
    return {
      runState: state,
      context,
      availableTools: this.dependencies.tools
        .definitions()
        .filter(({ name }) => name !== 'run_command' && !excludedTools.includes(name)),
      harnessInstruction
    };
  }

  private async requestDecision(
    request: DecisionRequest,
    signal: AbortSignal
  ): Promise<DecisionResponse> {
    const response = await this.dependencies.modelGateway.decide(request, signal);
    return { ...response, decision: this.normalizeDecision(response.decision) };
  }

  private normalizeDecision(decision: ModelDecision): ModelDecision {
    if (decision.type !== 'TOOL_CALL' || decision.tool.name !== 'run_command') return decision;
    const executable = decision.tool.arguments.executable;
    const args = decision.tool.arguments.args;
    if (
      typeof executable !== 'string' ||
      !Array.isArray(args) ||
      !args.every((arg) => typeof arg === 'string')
    ) {
      return decision;
    }
    const command = [executable, ...args].join(' ');
    parseAllowedCommand(command);
    return {
      type: 'VERIFY',
      reason: decision.reason,
      expectedObservation: decision.expectedObservation,
      commands: [command]
    };
  }

  private ensureRunCheckpoint(task: StoredTask): TaskRunCheckpoint {
    const existing = this.dependencies.database.getTaskRun(task.id);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const runId = randomUUID();
    const baseline = this.dependencies.database
      .getWorkspaceSnapshots(task.id)
      .find((snapshot) => snapshot.kind === 'BASELINE');
    const checkpoint: TaskRunCheckpoint = {
      taskId: task.id,
      runId,
      state: {
        schemaVersion: contractSchemaVersion,
        runId,
        taskId: task.id,
        sessionId: task.sessionId,
        phase: task.status,
        plan: task.plan,
        contextRefs: [],
        toolCallIds: [],
        workspaceSnapshotId: baseline?.id,
        changedFiles: [],
        verificationResultIds: [],
        budget: this.dependencies.budgetManager.create()
      },
      summarizedMessageCount: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: 1
    };
    this.dependencies.database.createTaskRun(checkpoint);
    return checkpoint;
  }

  private saveRunCheckpoint(
    checkpoint: TaskRunCheckpoint,
    state: RunState,
    patch: Partial<Pick<TaskRunCheckpoint, 'historySummary' | 'summarizedMessageCount'>> = {}
  ): TaskRunCheckpoint {
    return this.dependencies.database.updateTaskRun(
      {
        ...checkpoint,
        ...patch,
        state,
        updatedAt: new Date().toISOString()
      },
      checkpoint.version
    );
  }

  private synchronizeRunState(state: RunState, task: StoredTask): RunState {
    const toolCalls = this.dependencies.database.getToolCalls(task.id);
    const snapshots = this.dependencies.database.getWorkspaceSnapshots(task.id);
    const verifications = this.dependencies.database.getVerificationResults(task.id);
    return {
      ...state,
      phase: task.status,
      plan: task.plan,
      currentStepId: task.plan?.steps.find(({ status }) => status === 'RUNNING')?.id,
      toolCallIds: toolCalls.map(({ id }) => id),
      workspaceSnapshotId: snapshots.at(-1)?.id,
      verificationResultIds: verifications.map(({ id }) => id),
      stopReason: task.stopReason
    };
  }

  private synchronizeStoredRun(task: StoredTask): void {
    const checkpoint = this.dependencies.database.getTaskRun(task.id);
    if (!checkpoint) return;
    this.saveRunCheckpoint(checkpoint, this.synchronizeRunState(checkpoint.state, task));
  }

  private async summarizeHistory(
    task: StoredTask,
    checkpoint: TaskRunCheckpoint,
    signal: AbortSignal
  ): Promise<TaskRunCheckpoint> {
    const messages = this.dependencies.database.getMessages(task.sessionId);
    const olderCount = Math.max(0, messages.length - config.maxContextHistoryMessages);
    while (checkpoint.summarizedMessageCount < olderCount) {
      const batchEnd = Math.min(olderCount, checkpoint.summarizedMessageCount + 2);
      const candidates: ContextCandidate[] = messages
        .slice(checkpoint.summarizedMessageCount, batchEnd)
        .map(({ id, role, content }) => ({
          reference: {
            ref: `message:${id}:summary-input`,
            kind: 'SUMMARY' as const,
            source: 'session-history'
          },
          content: `${role}: ${content}`,
          priority: 1
        }));
      if (checkpoint.historySummary) {
        candidates.unshift({
          reference: {
            ref: `session:${task.sessionId}:previous-summary`,
            kind: 'SUMMARY',
            source: 'model-summary'
          },
          content: checkpoint.historySummary,
          priority: 2
        });
      }
      const bounded = this.dependencies.contextManager.select(candidates);
      let state = this.synchronizeRunState(checkpoint.state, task);
      checkpoint = this.saveRunCheckpoint(checkpoint, state);
      this.dependencies.budgetManager.assertWithin(checkpoint.state);
      this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
      this.dependencies.budgetManager.assertCanCallModel(checkpoint.state);
      try {
        const response = await this.dependencies.modelGateway.summarize(
          {
            goal: task.goal,
            observations: bounded.entries.map(({ content }) => content),
            changedFiles: checkpoint.state.changedFiles
          },
          signal
        );
        state = this.dependencies.budgetManager.recordModelUsage(checkpoint.state, response.usage);
        checkpoint = this.saveRunCheckpoint(checkpoint, state, {
          historySummary: response.summary,
          summarizedMessageCount: batchEnd
        });
      } catch (error) {
        if (signal.aborted || (error instanceof AppError && error.code === 'TASK_CANCELLED')) {
          throw error;
        }
        const category =
          error instanceof AppError &&
          typeof error.details === 'object' &&
          error.details !== null &&
          'category' in error.details
            ? String((error.details as { category: unknown }).category)
            : 'UNKNOWN';
        logger.warn(
          { taskId: task.id, category },
          'History summarization skipped after model failure'
        );
        checkpoint = this.saveRunCheckpoint(checkpoint, state, {
          summarizedMessageCount: olderCount
        });
        return checkpoint;
      }
      this.dependencies.budgetManager.assertWithin(checkpoint.state);
      this.dependencies.budgetManager.assertDuration(checkpoint.startedAt, checkpoint.state.budget);
    }
    return checkpoint;
  }

  private async contextCandidates(
    task: StoredTask,
    overview: ProjectOverview,
    checkpoint: TaskRunCheckpoint,
    signal: AbortSignal
  ): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [
      {
        reference: {
          ref: `task:${task.id}:goal`,
          kind: 'SUMMARY',
          source: 'user-goal'
        },
        content: task.goal,
        priority: 100
      },
      {
        reference: {
          ref: `project:${task.projectId}:overview`,
          kind: 'PROJECT_OVERVIEW',
          source: overview.degraded ? 'text-code-index' : 'code-index'
        },
        content: JSON.stringify(overview),
        priority: 90
      }
    ];
    for (const rulePath of [
      'AGENTS.md',
      'CLAUDE.md',
      '.github/copilot-instructions.md',
      'CONTRIBUTING.md'
    ]) {
      const rule = await this.dependencies.workspaceManager.readOptionalTextFile(
        task.workspacePath,
        rulePath,
        config.maxContextEntryBytes,
        signal
      );
      if (!rule) continue;
      candidates.push({
        reference: {
          ref: `task:${task.id}:rule:${rule.path}`,
          kind: 'FILE',
          source: 'repository-rule',
          startLine: 1
        },
        content: rule.truncated ? `${rule.content}\n...[truncated at source]` : rule.content,
        priority: 80
      });
    }
    if (checkpoint.historySummary) {
      candidates.push({
        reference: {
          ref: `session:${task.sessionId}:history-summary`,
          kind: 'SUMMARY',
          source: 'model-summary'
        },
        content: checkpoint.historySummary,
        priority: 70
      });
    }
    const messages = this.dependencies.database
      .getMessages(task.sessionId)
      .slice(-config.maxContextHistoryMessages);
    messages.forEach((message, index) => {
      candidates.push({
        reference: {
          ref: `message:${message.id}`,
          kind: 'SUMMARY',
          source: `session-message:${message.role.toLowerCase()}`
        },
        content: message.content,
        priority: 60 + index
      });
    });
    const recentToolCalls = this.dependencies.database
      .getToolCalls(task.id)
      .filter(({ result }) => result !== undefined)
      .slice(-4);
    const seenToolResults = new Set<string>();
    recentToolCalls.reverse().forEach((call, index) => {
      const dedupeKey = `${call.tool.name}:${JSON.stringify(call.tool.arguments)}`;
      if (seenToolResults.has(dedupeKey)) return;
      seenToolResults.add(dedupeKey);
      const chronologicalIndex = recentToolCalls.length - index - 1;
      candidates.push({
        reference: {
          ref: `tool-call:${call.id}:result`,
          kind: 'TOOL_RESULT',
          source: call.tool.name
        },
        content: [
          `Completed tool call: ${call.tool.name}`,
          `Arguments: ${JSON.stringify(call.tool.arguments)}`,
          `Observation: ${JSON.stringify(this.contextToolResult(call.result!))}`
        ].join('\n'),
        priority: 95 + chronologicalIndex
      });
    });
    return candidates;
  }

  private requireTask(taskId: string): StoredTask {
    const task = this.dependencies.database.getTask(taskId);
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', { taskId }, 404);
    return task;
  }

  private publishEvents(events: readonly Parameters<EventBroker['publish']>[0][]): void {
    events.forEach((event) => this.dependencies.broker.publish(event));
  }

  private throwIfStopped(taskId: string, signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw (
        signal.reason ??
        new AppError('TASK_CANCELLED', 'Task execution was cancelled', undefined, 409)
      );
    }
    const control = this.dependencies.database.getTask(taskId)?.controlRequest;
    if (control) {
      throw new AppError('TASK_CANCELLED', 'Task control was requested', { control }, 409);
    }
  }

  private abortedControl(signal?: AbortSignal): StoredTask['controlRequest'] | undefined {
    if (!signal?.aborted || !(signal.reason instanceof AppError)) return undefined;
    const details =
      typeof signal.reason.details === 'object' && signal.reason.details !== null
        ? signal.reason.details
        : undefined;
    if (!details || !('control' in details)) return undefined;
    const control = (details as { control?: unknown }).control;
    return control === 'PAUSE' || control === 'CANCEL' ? control : undefined;
  }

  private summary(value: unknown): unknown {
    if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 20) };
    if (typeof value === 'string') return value.slice(0, 1000);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.content === 'string' || typeof record.numberedContent === 'string') {
        return {
          path: record.path,
          lineCount: record.lineCount,
          hash: record.hash,
          bytes: record.bytes,
          contentOmitted: true
        };
      }
      if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
        return {
          ...record,
          stdout: typeof record.stdout === 'string' ? record.stdout.slice(0, 2000) : record.stdout,
          stderr: typeof record.stderr === 'string' ? record.stderr.slice(0, 2000) : record.stderr
        };
      }
    }
    return value;
  }

  private contextToolResult(result: ToolResult): ToolResult {
    if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
      return { ...result, output: this.summary(result.output) };
    }
    const output = result.output as Record<string, unknown>;
    if (typeof output.numberedContent === 'string') {
      return {
        ...result,
        output: {
          path: output.path,
          lineCount: output.lineCount,
          numberedContent: output.numberedContent,
          hash: output.hash,
          bytes: output.bytes
        }
      };
    }
    return { ...result, output: this.summary(result.output) };
  }

  private safeArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(arguments_).map(([key, value]) => {
        if (key === 'content') {
          return [
            key,
            {
              omitted: true,
              bytes: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : undefined
            }
          ];
        }
        if (key === 'edits' && Array.isArray(value)) return [key, { count: value.length }];
        return [key, value];
      })
    );
  }
}

export const defaultHarnessLimits = { maxSteps: config.maxTaskSteps };

import { AppError } from '../errors.js';
import type {
  DecisionRequest,
  DecisionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelGateway,
  ModelStreamHandler,
  SummaryRequest,
  SummaryResponse
} from '../ports/model-gateway.js';
import type { ModelDecision } from '../types.js';

export type FakeDecisionFactory = (request: DecisionRequest, index: number) => ModelDecision;

export class FakeModelGateway implements ModelGateway {
  private nextDecisionIndex = 0;

  constructor(
    private readonly decisions:
      readonly ModelDecision[] | FakeDecisionFactory = FakeModelGateway.defaultDecision
  ) {}

  async decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse> {
    signal.throwIfAborted();
    const decision = Array.isArray(this.decisions)
      ? this.decisions[this.nextDecisionIndex]
      : (this.decisions as FakeDecisionFactory)(request, this.nextDecisionIndex);
    if (!decision) {
      throw new AppError(
        'MODEL_ERROR',
        'FakeModelGateway has no queued decision',
        { category: 'FIXTURE', decisionIndex: this.nextDecisionIndex },
        500
      );
    }
    this.nextDecisionIndex += 1;
    onStreamEvent?.({ type: 'STRUCTURED_DELTA', delta: JSON.stringify(decision) });
    return {
      decision,
      model: 'fake-model',
      provider: 'fake',
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      durationMs: 0
    };
  }

  async summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse> {
    signal.throwIfAborted();
    const summary = `${request.goal}: ${request.changedFiles.length} changed files`;
    onStreamEvent?.({ type: 'TEXT_DELTA', delta: summary });
    return {
      summary,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 }
    };
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse> {
    signal.throwIfAborted();
    return {
      vectors: request.inputs.map((input) => [input.length]),
      model: 'fake-embedding-model',
      provider: 'fake',
      usage: { inputTokens: 0, cost: 0 }
    };
  }

  private static defaultDecision(request: DecisionRequest): ModelDecision {
    if (request.runState.phase !== 'PLANNING' && request.runState.plan) {
      const toolCallCount = request.runState.toolCallIds.length;
      if (toolCallCount === 0) {
        return {
          type: 'TOOL_CALL',
          reason: 'Inspect the workspace root',
          tool: { name: 'list_files', arguments: { path: '.' } }
        };
      }
      if (toolCallCount === 1) {
        return {
          type: 'TOOL_CALL',
          reason: 'Read the project overview',
          tool: { name: 'read_file', arguments: { path: 'README.md' } }
        };
      }
      if (toolCallCount === 2) {
        return {
          type: 'TOOL_CALL',
          reason: 'Confirm the isolated workspace state',
          tool: { name: 'git_status', arguments: {} }
        };
      }
      if (request.runState.verificationResultIds.length === 0) {
        return {
          type: 'VERIFY',
          reason: 'Run the planned baseline verification',
          commands: ['node --version']
        };
      }
      return {
        type: 'COMPLETE',
        reason: 'The plan and verification are complete',
        summary: FakeModelGateway.completionSummary(request)
      };
    }
    const goal =
      request.context.find(({ reference }) => reference.source === 'user-goal')?.content ??
      'Complete the requested task';
    return {
      type: 'PLAN_UPDATE',
      reason: 'Deterministic mock planning',
      plan: {
        goal,
        assumptions: ['Use the replaceable model gateway and the available code index'],
        steps: [
          { id: 'inspect', title: 'Inspect project files', status: 'PENDING' },
          { id: 'verify', title: 'Run baseline verification', status: 'PENDING' }
        ],
        verification: ['node --version']
      }
    };
  }

  private static completionSummary(request: DecisionRequest): string {
    const goal =
      request.context.find(({ reference }) => reference.source === 'user-goal')?.content ??
      request.runState.plan?.goal ??
      '';
    if (!/(入口|技术栈|tech\s*stack|entry|stack)/i.test(goal)) {
      return 'Inspected the project and completed baseline verification';
    }

    const overview = request.context
      .filter(({ reference }) => reference.kind === 'PROJECT_OVERVIEW')
      .map(({ content }) => this.parseProjectOverview(content))
      .find((candidate) => candidate);
    const entryFiles = overview?.entryFiles ?? [];
    const languages = overview?.languages ?? [];
    const buildCommands = overview?.buildCommands ?? [];
    if (/[\u4e00-\u9fff]/.test(goal)) {
      return [
        `项目入口：${entryFiles.length ? entryFiles.join('、') : '未在索引中识别到明确入口文件'}`,
        `主要技术栈：${languages.length ? languages.join('、') : '未识别到主要语言'}`,
        buildCommands.length ? `常用脚本：${buildCommands.join('、')}` : undefined
      ]
        .filter(Boolean)
        .join('。');
    }
    return [
      `Project entry: ${entryFiles.length ? entryFiles.join(', ') : 'no clear entry file detected'}`,
      `Primary stack: ${languages.length ? languages.join(', ') : 'no primary languages detected'}`,
      buildCommands.length ? `Common commands: ${buildCommands.join(', ')}` : undefined
    ]
      .filter(Boolean)
      .join('. ');
  }

  private static parseProjectOverview(content: string):
    | {
        entryFiles?: string[];
        languages?: string[];
        buildCommands?: string[];
      }
    | undefined {
    try {
      const parsed = JSON.parse(content) as {
        entryFiles?: unknown;
        languages?: unknown;
        buildCommands?: unknown;
      };
      return {
        entryFiles: Array.isArray(parsed.entryFiles)
          ? parsed.entryFiles.filter((item): item is string => typeof item === 'string')
          : undefined,
        languages: Array.isArray(parsed.languages)
          ? parsed.languages.filter((item): item is string => typeof item === 'string')
          : undefined,
        buildCommands: Array.isArray(parsed.buildCommands)
          ? parsed.buildCommands.filter((item): item is string => typeof item === 'string')
          : undefined
      };
    } catch {
      return undefined;
    }
  }
}

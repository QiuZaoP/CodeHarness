import { toolNames } from '../contract-values.js';
import type { ModelDecision, TaskPlan, ToolName } from '../types.js';
import { ModelGatewayError } from './errors.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ModelGatewayError(
      `Structured model output has an invalid ${field}`,
      'INVALID_RESPONSE',
      {
        field
      },
      502
    );
  }
  return value.trim();
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new ModelGatewayError(
      `Structured model output has an invalid ${field}`,
      'INVALID_RESPONSE',
      {
        field
      },
      502
    );
  }
  return value.map((item) => String(item));
}

function toolName(value: unknown): ToolName {
  if (typeof value !== 'string' || !toolNames.includes(value as ToolName)) {
    throw new ModelGatewayError(
      'Model tool name is not supported',
      'INVALID_RESPONSE',
      {
        field: 'tool.name'
      },
      502
    );
  }
  return value as ToolName;
}

function parseJsonText(content: string): unknown {
  const trimmed = content.trim();
  const candidates = jsonRecoveryCandidates(trimmed);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next recovery candidate
    }
  }
  throw new ModelGatewayError(
    'Model structured output is not valid JSON',
    'INVALID_RESPONSE',
    {},
    502
  );
}

function jsonRecoveryCandidates(content: string): string[] {
  const results = new Set<string>();
  results.add(content);

  const unfenced = content.startsWith('```')
    ? content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : content;
  results.add(unfenced);

  const extracted = extractJsonObject(unfenced);
  if (extracted !== unfenced) results.add(extracted);

  const sanitized = sanitizeJson(unfenced);
  if (sanitized !== unfenced) results.add(sanitized);

  if (extracted !== unfenced) {
    const sanitizedExtracted = sanitizeJson(extracted);
    if (sanitizedExtracted !== extracted) results.add(sanitizedExtracted);
  }

  return [...results];
}

function extractJsonObject(content: string): string {
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = content.slice(firstBrace, lastBrace + 1);
    if (candidate.length >= 2) return candidate;
  }
  const firstBracket = content.indexOf('[');
  const lastBracket = content.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = content.slice(firstBracket, lastBracket + 1);
    if (candidate.length >= 2) return candidate;
  }
  return content;
}

function sanitizeJson(content: string): string {
  let result = content;
  result = result.replace(/,\s*([}\]])/g, '$1');
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return result;
}

function parsePlan(value: unknown): TaskPlan {
  const object = record(value);
  if (!object)
    throw new ModelGatewayError('Model plan is not an object', 'INVALID_RESPONSE', {}, 502);
  const stepsValue = object.steps;
  if (!Array.isArray(stepsValue) || stepsValue.length === 0) {
    throw new ModelGatewayError(
      'Model plan must contain steps',
      'INVALID_RESPONSE',
      { field: 'plan.steps' },
      502
    );
  }
  const steps = stepsValue.map((step) => {
    const item = record(step);
    if (!item)
      throw new ModelGatewayError('Model plan step is invalid', 'INVALID_RESPONSE', {}, 502);
    const status = item.status;
    if (status !== 'PENDING' && status !== 'RUNNING' && status !== 'DONE') {
      throw new ModelGatewayError(
        'Model plan step status is invalid',
        'INVALID_RESPONSE',
        {
          field: 'plan.steps.status'
        },
        502
      );
    }
    return {
      id: nonEmptyString(item.id, 'plan.steps.id'),
      title: nonEmptyString(item.title, 'plan.steps.title'),
      status
    } as const;
  });
  return {
    goal: nonEmptyString(object.goal, 'plan.goal'),
    assumptions: stringArray(object.assumptions, 'plan.assumptions', true),
    steps,
    verification: stringArray(object.verification, 'plan.verification', true)
  };
}

export function parseModelDecision(content: string): ModelDecision {
  const object = record(parseJsonText(content));
  if (!object)
    throw new ModelGatewayError(
      'Model decision must be a JSON object',
      'INVALID_RESPONSE',
      {},
      502
    );
  const type = object.type;
  const base = {
    type,
    reason: nonEmptyString(object.reason, 'reason'),
    ...(object.expectedObservation === undefined || object.expectedObservation === null
      ? {}
      : { expectedObservation: nonEmptyString(object.expectedObservation, 'expectedObservation') })
  };
  switch (type) {
    case 'TOOL_CALL': {
      const tool = record(object.tool);
      const args = tool?.arguments;
      if (!tool || typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new ModelGatewayError(
          'Model tool call is invalid',
          'INVALID_RESPONSE',
          { field: 'tool' },
          502
        );
      }
      return {
        ...base,
        type,
        tool: { name: toolName(tool.name), arguments: args as Record<string, unknown> }
      } as ModelDecision;
    }
    case 'PLAN_UPDATE':
      return { ...base, type, plan: parsePlan(object.plan) } as ModelDecision;
    case 'ASK_USER':
      return {
        ...base,
        type,
        question: nonEmptyString(object.question, 'question')
      } as ModelDecision;
    case 'VERIFY':
      return { ...base, type, commands: stringArray(object.commands, 'commands') } as ModelDecision;
    case 'COMPLETE':
      return { ...base, type, summary: nonEmptyString(object.summary, 'summary') } as ModelDecision;
    default:
      throw new ModelGatewayError(
        'Model decision type is not supported',
        'INVALID_RESPONSE',
        {
          field: 'type'
        },
        502
      );
  }
}

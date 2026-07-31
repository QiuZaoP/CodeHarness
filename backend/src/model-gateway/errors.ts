import { AppError } from '../errors.js';

export type ModelFailureCategory =
  | 'CONFIGURATION'
  | 'VALIDATION'
  | 'INVALID_RESPONSE'
  | 'PROVIDER'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'CIRCUIT_OPEN'
  | 'NOT_SUPPORTED'
  | 'CANCELLED';

export class ModelGatewayError extends AppError {
  constructor(
    message: string,
    category: ModelFailureCategory,
    details: Record<string, unknown> = {},
    statusCode = 502
  ) {
    super('MODEL_ERROR', message, { category, ...details }, statusCode);
    this.name = 'ModelGatewayError';
  }
}

export function safeModelDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value || 'unknown provider failure');
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|secret)\s*[:=]\s*)["']?[^\s,"';]+/gi,
      '$1[REDACTED]'
    )
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .slice(0, 300);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function isRetryableFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ModelGatewayError) {
    const category =
      error.details && typeof error.details === 'object'
        ? (error.details as { category?: unknown }).category
        : undefined;
    return category === 'PROVIDER' || category === 'RATE_LIMIT' || category === 'TIMEOUT';
  }
  return true;
}

export function isFallbackEligible(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (!(error instanceof ModelGatewayError)) return true;
  const category =
    error.details && typeof error.details === 'object'
      ? (error.details as { category?: unknown }).category
      : undefined;
  return category !== 'VALIDATION' && category !== 'CANCELLED';
}

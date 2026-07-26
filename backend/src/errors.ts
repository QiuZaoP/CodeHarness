import type { ErrorCode } from './contract-values.ts';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = 'AppError';
  }
}

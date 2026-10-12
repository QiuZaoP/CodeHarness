import type { ErrorCode } from './types.js';

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

export function errorBody(error: unknown) {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  return {
    error: {
      code: 'INTERNAL_ERROR' as const,
      message: 'Internal server error'
    }
  };
}

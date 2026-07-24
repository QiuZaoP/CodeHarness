import pino from 'pino';
import type { LoggerOptions } from 'pino';
import { config } from './config.js';

export const loggerRedactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken'
] as const;

export const loggerOptions: LoggerOptions = {
  level: config.logLevel,
  base: undefined,
  redact: {
    paths: [...loggerRedactionPaths],
    censor: '[REDACTED]'
  }
};

export const logger = pino(loggerOptions);

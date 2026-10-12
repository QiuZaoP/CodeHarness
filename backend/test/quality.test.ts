import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loggerOptions } from '../src/logger.js';

describe('quality and deployment boundaries', () => {
  it('rejects malformed values and unsafe production configuration', () => {
    expect(() => loadConfig({ PORT: 'invalid' })).toThrow('PORT must be a positive integer');
    expect(() => loadConfig({ MOCK_MODE: 'sometimes' })).toThrow('MOCK_MODE must be true or false');
    expect(() => loadConfig({ NODE_ENV: 'production', MOCK_MODE: 'true' })).toThrow(
      'MOCK_MODE must be false in production'
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MOCK_MODE: 'false',
        HOST: '0.0.0.0',
        CORS_ORIGINS: 'https://app.example.test'
      })
    ).toThrow('Production binding must remain loopback');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MOCK_MODE: 'false',
        HOST: '127.0.0.1',
        CORS_ORIGINS: '*'
      })
    ).toThrow('CORS_ORIGINS cannot contain *');
    expect(
      loadConfig({
        NODE_ENV: 'production',
        MOCK_MODE: 'false',
        HOST: '127.0.0.1',
        CORS_ORIGINS: 'https://app.example.test'
      })
    ).toMatchObject({
      nodeEnv: 'production',
      mockMode: false,
      corsOrigins: ['https://app.example.test']
    });
  });

  it('redacts credentials from structured logs', () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      }
    });
    const testLogger = pino(loggerOptions, destination);
    testLogger.info({
      authorization: 'Bearer secret',
      headers: { cookie: 'session=secret' },
      provider: { apiKey: 'provider-secret', accessToken: 'access-secret' }
    });
    const serialized = chunks.join('');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('session=secret');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('access-secret');
    expect(serialized).toContain('[REDACTED]');
  });
});

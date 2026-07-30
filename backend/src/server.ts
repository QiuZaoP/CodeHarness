import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

async function isExistingCodeHarness(): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/api/health`, {
      signal: AbortSignal.timeout(1_000)
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown };
    return body.service === 'codeharness-backend';
  } catch {
    return false;
  }
}

const app = buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, modelMode: config.mockMode ? 'mock' : 'deepseek' },
    'CodeHarness backend started'
  );
} catch (error) {
  if (isAddressInUse(error) && (await isExistingCodeHarness())) {
    logger.warn(
      { host: config.host, port: config.port },
      'CodeHarness backend is already running; reusing the existing server'
    );
    await app.close().catch(() => undefined);
    process.exitCode = 0;
  } else {
    logger.error(error, 'Failed to start CodeHarness backend');
    await app.close().catch(() => undefined);
    process.exitCode = 1;
  }
}

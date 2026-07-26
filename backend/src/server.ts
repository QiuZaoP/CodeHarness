import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

const app = buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, 'CodeHarness backend started');
} catch (error) {
  logger.error(error, 'Failed to start CodeHarness backend');
  process.exit(1);
}

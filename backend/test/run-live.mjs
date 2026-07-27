/* global process */

import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--experimental-transform-types', '--test', 'backend/test/deepseek.integration.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, RUN_DEEPSEEK_LIVE: '1' }
  }
);

process.exit(result.status ?? 1);

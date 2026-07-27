import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['backend/test/**/*.test.ts'],
    exclude: ['backend/test/model-gateway.test.ts', 'backend/test/deepseek.integration.test.ts']
  }
});

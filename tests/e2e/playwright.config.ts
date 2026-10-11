import { resolve } from 'node:path';

import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: resolve('test-results/electron'),
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
});

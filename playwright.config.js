import {defineConfig} from '@playwright/test';

// Playwright enables FORCE_COLOR for workers; avoid conflicting inherited settings.
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: {trace: 'retain-on-failure'},
});

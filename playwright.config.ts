import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against a running Home Assistant with Chartroom installed.
// CI starts one in Docker (see .github/workflows/ci.yml); locally point HA_URL / HA_TOKEN at yours.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env['HA_URL'] ?? 'http://127.0.0.1:8123',
    storageState: 'test-results/.auth/state.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        ...(process.env['PW_CHANNEL'] ? { channel: process.env['PW_CHANNEL'] } : {}),
      },
    },
  ],
});

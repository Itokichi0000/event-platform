import { defineConfig, devices } from '@playwright/test';
// Smoke test against a running `docker compose` deployment on https://localhost (temporary).
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: 'https://localhost',
    ignoreHTTPSErrors: true,
    launchOptions: { args: ['--ignore-certificate-errors'] },
    trace: 'off',
    locale: 'ja-JP',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

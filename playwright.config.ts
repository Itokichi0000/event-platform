import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 8788;
const WEB_PORT = 4174;
const DB = `${process.env.TMPDIR ?? '/tmp'}/kamen-e2e-${process.pid}.sqlite`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'off',
    // The UI language follows the browser; the specs assert Japanese copy.
    locale: 'ja-JP',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `rm -f ${DB}* && pnpm --filter @kamen/server start`,
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_PATH: DB,
        // Test-only key. Never use a fixed key in production.
        KAMEN_MASTER_KEY: 'e2e0'.repeat(16),
        POW_DIFFICULTY: '8',
        // In-memory wallet: invoices settle 1.5 s after creation. Never in production.
        KAMEN_MOCK_WALLET: '1',
        KAMEN_MOCK_WALLET_SETTLE_MS: '1500',
      },
    },
    {
      command: `pnpm --filter @kamen/web build && pnpm --filter @kamen/web preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { KAMEN_API_URL: `http://localhost:${SERVER_PORT}` },
    },
  ],
});

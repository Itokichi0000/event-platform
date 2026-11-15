import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 8788;
const AGENT_PORT = 8798;
const RELAY_PORT = 7788;
const WEB_PORT = 4174;
const TMP = process.env.TMPDIR ?? '/tmp';
const DB = `${TMP}/kamen-e2e-${process.pid}.sqlite`;
const AGENT_DB = `${TMP}/kamen-e2e-agent-${process.pid}.sqlite`;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
// Test-only key. Never use a fixed key in production.
const MASTER_KEY = 'e2e0'.repeat(16);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
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
      // Minimal in-memory Nostr relay (packages/messaging/src/testing/relay.ts).
      command: `pnpm --filter @kamen/messaging relay`,
      port: RELAY_PORT,
      reuseExistingServer: false,
      env: { RELAY_PORT: String(RELAY_PORT) },
    },
    {
      command: `rm -f ${AGENT_DB}* && pnpm --filter @kamen/server agent`,
      url: `http://127.0.0.1:${AGENT_PORT}/health`,
      reuseExistingServer: false,
      env: {
        KAMEN_MASTER_KEY: MASTER_KEY,
        ROOM_RELAYS: RELAY,
        AGENT_PORT: String(AGENT_PORT),
        AGENT_DB_PATH: AGENT_DB,
        AGENT_BATCH_MS: '200',
      },
    },
    {
      command: `rm -f ${DB}* && pnpm --filter @kamen/server start`,
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_PATH: DB,
        KAMEN_MASTER_KEY: MASTER_KEY,
        POW_DIFFICULTY: '8',
        // In-memory wallet: invoices settle 1.5 s after creation. Never in production.
        KAMEN_MOCK_WALLET: '1',
        KAMEN_MOCK_WALLET_SETTLE_MS: '1500',
        ROOM_RELAYS: RELAY,
        AGENT_URL: `http://127.0.0.1:${AGENT_PORT}`,
      },
    },
    {
      command: `pnpm --filter @kamen/web build && pnpm --filter @kamen/web preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { KAMEN_API_URL: `http://localhost:${SERVER_PORT}`, KAMEN_CSP_CONNECT: RELAY },
    },
  ],
});

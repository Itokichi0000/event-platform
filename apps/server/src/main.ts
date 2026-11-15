import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/index.js';
import { runCleanup } from './jobs/cleanup.js';
import { settleDeposits } from './lib/deposits.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const ctx = createContext(db, config);
const app = createApp(ctx);

if (config.mockWalletSettleMs !== null) {
  console.log('WARNING: KAMEN_MOCK_WALLET=1 — invoices are fake. Never use this for a real event.');
}

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
function cleanup() {
  try {
    const r = runCleanup(ctx);
    console.log(
      `cleanup: keys=${r.retiredKeysets} quotes=${r.deletedQuotes} spent=${r.deletedSpent} ` +
        `invites=${r.deletedInviteCodes} links=${r.deletedScannerLinks} wallets=${r.clearedWallets}`,
    );
  } catch (e) {
    console.log(`cleanup failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}
async function periodic() {
  // Settle no-show deposits (and refund paid-but-unused ones) before deleting old records.
  try {
    const d = await settleDeposits(ctx);
    if (d.settled + d.refunded > 0)
      console.log(`deposits: settled=${d.settled} refunded=${d.refunded}`);
  } catch (e) {
    console.log(`deposit job failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }
  cleanup();
}
void periodic();
const cleanupTimer = setInterval(() => void periodic(), CLEANUP_INTERVAL_MS);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`kamen server listening on ${info.address}:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(cleanupTimer);
    ctx.payments.closeAll();
    server.close();
    db.$client.close();
    process.exit(0);
  });
}

import { startTestRelay } from './relay.js';

const relay = await startTestRelay(Number(process.env.RELAY_PORT ?? 7777));
console.log(`test relay listening on ${relay.url}`);
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.on(s, () => void relay.close().then(() => process.exit(0)));

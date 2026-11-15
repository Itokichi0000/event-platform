import { serve } from '@hono/node-server';
import { MarmotAdapter } from '@kamen/messaging/marmot';
import { createAgentApp } from './app.js';
import { loadAgentConfig } from './config.js';
import { RoomService } from './rooms.js';
import { AgentStore } from './store.js';

const config = loadAgentConfig();
if (config.relays.length === 0) {
  // Rooms are disabled. Stay idle (instead of exiting) so `docker compose up` stays quiet.
  console.log('kamen room agent: ROOM_RELAYS is not set, rooms are disabled; idling');
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
const store = new AgentStore(config.dbPath, config.masterKey);
const rooms = new RoomService(
  store,
  config.masterKey,
  config.relays,
  (eventId, secretKey) =>
    MarmotAdapter.create({ secretKey, backend: store.backend(eventId), relays: config.relays }),
  { batchMs: config.batchMs },
);
await rooms.resume();

const SWEEP_MS = 5 * 60 * 1000;
const sweep = async () => {
  const n = await rooms.sweep().catch(() => 0);
  if (n > 0) console.log(`agent: disbanded ${n} room(s)`);
};
void sweep();
const timer = setInterval(() => void sweep(), SWEEP_MS);

const server = serve(
  {
    fetch: createAgentApp(rooms, config.masterKey).fetch,
    port: config.port,
    hostname: config.host,
  },
  (i) =>
    console.log(
      `kamen room agent listening on ${i.address}:${i.port} (${config.relays.length} relays)`,
    ),
);

for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.on(s, () => {
    clearInterval(timer);
    server.close();
    void rooms.close().finally(() => {
      store.db.close();
      process.exit(0);
    });
  });
}

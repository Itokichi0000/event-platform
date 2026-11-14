import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/index.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = createApp(createContext(db, config));

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`kamen server listening on ${info.address}:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.$client.close();
    process.exit(0);
  });
}

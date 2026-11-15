import { z } from 'zod';
import { parseRelays } from '../lib/relays.js';

export { parseRelays };

const schema = z.object({
  KAMEN_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'KAMEN_MASTER_KEY must be 32-byte hex'),
  ROOM_RELAYS: z.string().default(''),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(8789),
  /** Bind address. The agent API is internal: keep it off public interfaces. */
  AGENT_HOST: z.string().default('127.0.0.1'),
  AGENT_DB_PATH: z.string().default('./data/agent.sqlite'),
  /** How long join requests are collected into one commit. */
  AGENT_BATCH_MS: z.coerce.number().int().min(0).max(10_000).default(1500),
});

export interface AgentConfig {
  masterKey: Uint8Array;
  relays: string[];
  port: number;
  host: string;
  dbPath: string;
  batchMs: number;
}

export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env,
): AgentConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const e = schema.parse(cleaned);
  const relays = parseRelays(e.ROOM_RELAYS);
  if (relays.length === 0)
    throw new Error('ROOM_RELAYS is not set: rooms are disabled, the agent is not needed');
  return {
    masterKey: Buffer.from(e.KAMEN_MASTER_KEY, 'hex'),
    relays,
    port: e.AGENT_PORT,
    host: e.AGENT_HOST,
    dbPath: e.AGENT_DB_PATH,
    batchMs: e.AGENT_BATCH_MS,
  };
}

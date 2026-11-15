import { z } from 'zod';
import { parseRelays } from './lib/relays.js';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/kamen.sqlite'),
  /** 32-byte hex. Encrypts keyset private keys and keys the PoW HMAC. `openssl rand -hex 32` */
  KAMEN_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/,
      'KAMEN_MASTER_KEY must be 32-byte lower-case hex (openssl rand -hex 32)',
    ),
  /** Leading zero bits required for free-event tickets. */
  POW_DIFFICULTY: z.coerce.number().int().min(0).max(32).default(18),
  POW_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /**
   * Public origin (e.g. https://kamen.example) used to check the URL in NIP-98 auth headers.
   * When unset, the request's Host header is used.
   */
  PUBLIC_ORIGIN: z.url().optional(),
  /** Lifetime of a Lightning invoice for a paid ticket. */
  INVOICE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  /** Development / E2E only: use an in-memory wallet instead of NWC. Refused in production. */
  KAMEN_MOCK_WALLET: z.enum(['0', '1']).default('0'),
  KAMEN_MOCK_WALLET_SETTLE_MS: z.coerce.number().int().min(0).default(1500),
  NODE_ENV: z.string().optional(),
  /** Deposits (hold invoices) can be paid only this many hours before the start. */
  DEPOSIT_WINDOW_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(72),
  /** Relays for event rooms (space- or comma-separated). Unset = rooms disabled. */
  ROOM_RELAYS: z.string().default(''),
  /** Internal URL of the room agent process. */
  AGENT_URL: z.url().default('http://127.0.0.1:8789'),
});

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  masterKey: Uint8Array;
  powDifficulty: number;
  powTtlSeconds: number;
  publicOrigin: string | undefined;
  invoiceTtlSeconds: number;
  /** null = use real NWC wallets. */
  mockWalletSettleMs: number | null;
  roomRelays: string[];
  agentUrl: string;
  depositWindowHours: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (e.g. `PUBLIC_ORIGIN=` in docker-compose) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  if (e.KAMEN_MOCK_WALLET === '1' && e.NODE_ENV === 'production') {
    throw new Error('invalid configuration:\nKAMEN_MOCK_WALLET must not be used in production');
  }
  return {
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH,
    masterKey: Buffer.from(e.KAMEN_MASTER_KEY, 'hex'),
    powDifficulty: e.POW_DIFFICULTY,
    powTtlSeconds: e.POW_TTL_SECONDS,
    publicOrigin: e.PUBLIC_ORIGIN ? new URL(e.PUBLIC_ORIGIN).origin : undefined,
    invoiceTtlSeconds: e.INVOICE_TTL_SECONDS,
    mockWalletSettleMs: e.KAMEN_MOCK_WALLET === '1' ? e.KAMEN_MOCK_WALLET_SETTLE_MS : null,
    roomRelays: parseRelays(e.ROOM_RELAYS),
    agentUrl: e.AGENT_URL,
    depositWindowHours: e.DEPOSIT_WINDOW_HOURS,
  };
}

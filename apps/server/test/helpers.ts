import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  encodeToken,
  finalizeIssue,
  prepareIssue,
  solvePow,
  toIssueRequest,
  toRedeemPayload,
  type PowChallenge,
  type Proof,
  type PublicKeyset,
} from '@kamen/core';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/index.js';

export const ORIGIN = 'http://kamen.test';
export const HOUR = 3600_000;

export function setup(opts: { now?: () => number } = {}) {
  const config = loadConfig({
    KAMEN_MASTER_KEY: '11'.repeat(32),
    POW_DIFFICULTY: '4',
    DATABASE_PATH: ':memory:',
  });
  const db = openDatabase(':memory:');
  const clock = { t: Date.now() };
  const ctx: AppContext = createContext(db, config, opts.now ?? (() => clock.t));
  const logs: string[] = [];
  const app = createApp(ctx, { log: (l) => logs.push(l) });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(ORIGIN + path, { ...init, headers: { host: 'kamen.test', ...init.headers } });

  return { app, ctx, db, logs, clock, request };
}

export type Harness = ReturnType<typeof setup>;

export function makeHost(h: Harness) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);

  function authHeader(
    method: string,
    path: string,
    body?: string | Uint8Array,
    url = ORIGIN + path,
  ) {
    const tags = [
      ['u', url],
      ['method', method],
    ];
    if (body !== undefined) tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
    const ev = finalizeEvent(
      { kind: 27235, created_at: Math.floor(h.ctx.now() / 1000), tags, content: '' },
      sk,
    );
    return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
  }

  async function call(method: string, path: string, json?: unknown) {
    const body = json === undefined ? undefined : JSON.stringify(json);
    return h.request(path, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: {
        authorization: authHeader(method, path, body),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    });
  }

  return { sk, pubkey, authHeader, call };
}

export async function createPublishedEvent(
  h: Harness,
  host: ReturnType<typeof makeHost>,
  overrides: Record<string, unknown> = {},
) {
  const now = h.ctx.now();
  const res = await host.call('POST', '/api/events', {
    title: 'Bitcoin Meetup',
    description: 'desc',
    startsAt: now + 24 * HOUR,
    endsAt: now + 27 * HOUR,
    location: 'Shibuya',
    capacity: 50,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const ev = (await res.json()) as { id: string };
  const pub = await host.call('PATCH', `/api/events/${ev.id}`, { status: 'published' });
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.status}`);
  return ev.id;
}

export async function getPublicEvent(h: Harness, id: string) {
  const res = await h.request(`/api/events/${id}`);
  return (await res.json()) as {
    keysets: PublicKeyset[];
    location: string | null;
    remaining: number;
    announcements: { body: string }[];
    [k: string]: unknown;
  };
}

export async function solveQuote(h: Harness, id: string) {
  const res = await h.request(`/api/events/${id}/quote`, { method: 'POST' });
  const { challenge } = (await res.json()) as { challenge: PowChallenge };
  return { challenge, nonce: solvePow(challenge)! };
}

/** Full participant flow. Returns the proof plus what the server saw. */
export async function getTicket(h: Harness, id: string) {
  const ev = await getPublicEvent(h, id);
  const keyset = ev.keysets.find((k) => k.kind === 'ticket')!;
  const pending = prepareIssue(keyset);
  const pow = await solveQuote(h, id);
  const res = await h.request(`/api/events/${id}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pow, outputs: { ticket: toIssueRequest(pending) } }),
  });
  if (res.status !== 200) return { res, pending, keyset };
  const body = (await res.json()) as { signatures: { ticket: never }; location: string | null };
  const proof = finalizeIssue(pending, body.signatures.ticket, keyset);
  return { res, pending, keyset, proof, location: body.location };
}

export async function createScannerToken(
  h: Harness,
  host: ReturnType<typeof makeHost>,
  id: string,
) {
  const res = await host.call('POST', `/api/events/${id}/scanner-links`, { label: 'door' });
  return (await res.json()) as { token: string; id: string };
}

export function redeem(h: Harness, id: string, token: string, proof: Proof | object) {
  const payload = 'secret' in proof ? toRedeemPayload(proof as Proof) : proof;
  return h.request(`/api/events/${id}/redeem`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export { encodeToken };

/** Untyped JSON body for assertions. */
export const json = (res: Response): Promise<any> => res.json();

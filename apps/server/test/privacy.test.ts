/**
 * Executable versions of the promises in docs/PRIVACY.md.
 */
import { describe, expect, it } from 'vitest';
import { spentKey } from '@kamen/core';
import {
  createPublishedEvent,
  createScannerToken,
  getTicket,
  makeHost,
  redeem,
  setup,
  type Harness,
} from './helpers.js';

/** Every value stored in every table, as text (BLOBs as hex). */
function dumpDatabase(h: Harness): string {
  const sqlite = h.db.$client;
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map(({ name }) =>
      (sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
        .map((row) =>
          Object.values(row)
            .map((v) => (Buffer.isBuffer(v) ? v.toString('hex') : String(v)))
            .join('|'),
        )
        .join('\n'),
    )
    .join('\n');
}

describe('privacy guarantees', () => {
  it('there is no participant table', () => {
    const h = setup();
    const tables = (
      h.db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables.sort()).toEqual(
      [
        'announcements',
        'checkin_buckets',
        'event_cohosts',
        'events',
        'hosts',
        'invite_codes',
        'keysets',
        'quotes',
        'scanner_links',
        'spent',
      ].sort(),
    );
  });

  it('never stores the blinded message B_, the blind signature C_, or the secret', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { pending, proof } = await getTicket(h, id);
    const { token } = await createScannerToken(h, host, id);
    await redeem(h, id, token, proof!);

    const dump = dumpDatabase(h);
    expect(dump).not.toContain(pending.B_);
    expect(dump).not.toContain(pending.r);
    expect(dump).not.toContain(proof!.secret);
    expect(dump).not.toContain(proof!.C);
    expect(dump).not.toContain(proof!.dleq!.e);
    // only the spent identifier Y is stored
    expect(dump).toContain(spentKey(proof!.secret));
    expect(dump).not.toContain(token); // only its hash
  });

  it('stores keyset private keys encrypted', async () => {
    const h = setup();
    const host = makeHost(h);
    await createPublishedEvent(h, host);
    const rows = h.db.$client
      .prepare("SELECT id, private_key_enc FROM keysets WHERE kind = 'ticket'")
      .all() as {
      id: string;
      private_key_enc: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.private_key_enc.startsWith('v1:')).toBe(true);
    const { keysetFromPrivateKey } = await import('@kamen/core');
    const pk = h.ctx.vault.decrypt(rows[0]!.private_key_enc, rows[0]!.id);
    expect(keysetFromPrivateKey('ticket', pk).id).toBe(rows[0]!.id);
    expect(rows[0]!.private_key_enc).not.toContain(pk);
    // wrong keyset id as associated data → refuses to decrypt
    expect(() => h.ctx.vault.decrypt(rows[0]!.private_key_enc, '00ffffffffffffff')).toThrow();
  });

  it('request logs contain no IP address, User-Agent, ids or payloads', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const ev = await h.request(`/api/events/${id}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 SecretBrowser',
        'x-forwarded-for': '203.0.113.7',
        'x-real-ip': '203.0.113.7',
      },
    });
    expect(ev.status).toBe(200);
    const { pending } = await getTicket(h, id);

    const all = h.logs.join('\n');
    expect(all).not.toContain('203.0.113.7');
    expect(all).not.toContain('SecretBrowser');
    expect(all).not.toContain(id);
    expect(all).not.toContain(pending.B_);
    expect(h.logs.some((l) => l.startsWith('GET /api/events/:id 200 '))).toBe(true);
    expect(h.logs.some((l) => l.startsWith('POST /api/events/:id/issue 200 '))).toBe(true);
    for (const line of h.logs) expect(line).toMatch(/^[A-Z]+ \/[^\s]* \d{3} \d+ms$/);
  });

  it('API responses set no cookies and are not cached', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const res = await h.request(`/api/events/${id}`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('internal errors are logged without request details', async () => {
    const h = setup();
    h.app.get('/api/boom', () => {
      throw new Error('kaboom');
    });
    const res = await h.request('/api/boom', { headers: { 'user-agent': 'UA-XYZ' } });
    expect(res.status).toBe(500);
    expect(h.logs.join('\n')).toContain('error: Error: kaboom');
    expect(h.logs.join('\n')).not.toContain('UA-XYZ');
  });
});

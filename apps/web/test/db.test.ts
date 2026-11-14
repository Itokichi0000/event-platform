import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Token } from '@kamen/core';
import {
  deleteTicket,
  getTicket,
  listTickets,
  resetDb,
  saveTicket,
  ticketsForEvent,
  updateTicket,
  type EventSnapshot,
} from '../src/lib/db';

const snap = (title: string, startsAt: number): EventSnapshot => ({
  title,
  startsAt,
  endsAt: startsAt + 1,
  location: null,
  locationVisibility: 'public',
  offlineCheckin: false,
  hostPubkey: 'ab'.repeat(32),
});

const token = (secret: string, eventId = 'evt'): Token => ({
  kind: 'ticket',
  eventId,
  keysetId: '00aabbccddeeff00',
  secret,
  C: '02' + '11'.repeat(32),
});

beforeEach(async () => {
  await resetDb();
});

describe('ticket storage', () => {
  it('saves, lists by date, filters by event, updates and deletes', async () => {
    const a = await saveTicket(token('a'.repeat(64), 'e1'), snap('later', 2000));
    const b = await saveTicket(token('b'.repeat(64), 'e2'), snap('sooner', 1000));
    expect((await listTickets()).map((t) => t.event.title)).toEqual(['sooner', 'later']);
    expect((await ticketsForEvent('e1')).map((t) => t.id)).toEqual([a.id]);
    expect(a.backedUpAt).toBeNull();
    await updateTicket(a.id, { backedUpAt: 5 });
    expect((await getTicket(a.id))?.backedUpAt).toBe(5);
    await deleteTicket(b.id);
    expect(await listTickets()).toHaveLength(1);
  });

  it('does not duplicate the same secret (e.g. restoring twice)', async () => {
    const first = await saveTicket(token('c'.repeat(64)), snap('x', 1));
    const again = await saveTicket(token('c'.repeat(64)), snap('x', 1), { backedUp: true });
    expect(again.id).toBe(first.id);
    expect(await listTickets()).toHaveLength(1);
  });

  it('local ids are random and never contain the secret', async () => {
    const secret = 'd'.repeat(64);
    const t = await saveTicket(token(secret), snap('x', 1));
    expect(t.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(secret).not.toContain(t.id);
  });
});

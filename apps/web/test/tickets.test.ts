import 'fake-indexeddb/auto';
import {
  decodeToken,
  encodeToken,
  finalizeIssue,
  generateKeyset,
  prepareIssue,
  signIssueRequest,
  toIssueRequest,
  toPublicKeyset,
  type Token,
} from '@kamen/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTickets, resetDb, type StoredTicket } from '../src/lib/db';
import { backupTextFor, qrTextFor, restoreTicket, RestoreError } from '../src/lib/tickets';

const keyset = generateKeyset('ticket');
const pub = toPublicKeyset(keyset);

function makeToken(eventId = 'evt1'): Token {
  const pending = prepareIssue(pub);
  const proof = finalizeIssue(pending, signIssueRequest(toIssueRequest(pending), keyset), pub);
  return { kind: 'ticket', eventId, ...proof };
}

function stored(token: Token, offlineCheckin: boolean): StoredTicket {
  return {
    id: 'x',
    token,
    createdAt: 0,
    backedUpAt: null,
    event: {
      title: 't',
      startsAt: 0,
      endsAt: 1,
      location: null,
      locationVisibility: 'public',
      offlineCheckin,
      hostPubkey: 'ab'.repeat(32),
    },
  };
}

beforeEach(async () => {
  await resetDb();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/api/events/evt1')
        ? Response.json({
            id: 'evt1',
            title: 'Meetup',
            startsAt: 1,
            endsAt: 2,
            location: 'Shibuya',
            locationVisibility: 'public',
            offlineCheckin: false,
            hostPubkey: 'ab'.repeat(32),
            keysets: [pub],
          })
        : Response.json({ error: 'event_not_found' }, { status: 404 }),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('QR vs backup text', () => {
  it('QR omits the DLEQ unless the event uses offline check-in; backup always keeps it', () => {
    const tk = makeToken();
    expect(decodeToken(qrTextFor(stored(tk, false))).dleq).toBeUndefined();
    expect(decodeToken(qrTextFor(stored(tk, true))).dleq).toEqual(tk.dleq);
    expect(decodeToken(backupTextFor(stored(tk, false))).dleq).toEqual(tk.dleq);
  });
});

describe('restoreTicket', () => {
  it('restores a valid backup with the event snapshot', async () => {
    const tk = makeToken();
    const t = await restoreTicket(encodeToken(tk));
    expect(t.token).toEqual(tk);
    expect(t.event.title).toBe('Meetup');
    expect(t.backedUpAt).not.toBeNull();
    expect(await listTickets()).toHaveLength(1);
  });

  it('rejects garbage, wrong signatures and unknown events', async () => {
    await expect(restoreTicket('hello')).rejects.toThrow(RestoreError);
    const tk = makeToken();
    const other = makeToken();
    await expect(restoreTicket(encodeToken({ ...tk, C: other.C }))).rejects.toMatchObject({
      reason: 'signature',
    });
    await expect(restoreTicket(encodeToken(makeToken('evt404')))).rejects.toMatchObject({
      reason: 'event',
    });
    expect(await listTickets()).toHaveLength(0);
  });
});

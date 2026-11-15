import 'fake-indexeddb/auto';
import {
  encodeQrToken,
  encodeToken,
  finalizeIssue,
  generateKeyset,
  prepareIssue,
  signIssueRequest,
  spentKey,
  toIssueRequest,
  toPublicKeyset,
  type Token,
} from '@kamen/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkIn, syncCheckins, type CheckinContext } from '../src/lib/checkin';
import { resetScannerStore, scannerStore } from '../src/lib/scanner-store';

const keyset = generateKeyset('ticket');
const pub = toPublicKeyset(keyset);

function ticket(eventId = 'evt'): Token {
  const pending = prepareIssue(pub);
  const proof = finalizeIssue(pending, signIssueRequest(toIssueRequest(pending), keyset), pub);
  return { kind: 'ticket', eventId, ...proof };
}

const qr = (tk: Token, offline = true) => encodeQrToken(tk, { offlineCheckin: offline });

let server: { redeemed: Set<string>; requests: unknown[]; down: boolean };

beforeEach(async () => {
  await resetScannerStore();
  server = { redeemed: new Set(), requests: [], down: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (server.down) throw new TypeError('Failed to fetch');
      if (url.endsWith('/redeem')) {
        const body = JSON.parse(String(init?.body));
        server.requests.push(body);
        const y = spentKey(body.secret);
        if (server.redeemed.has(y))
          return Response.json({ error: 'already_redeemed' }, { status: 409 });
        server.redeemed.add(y);
        return Response.json({
          ok: true,
          redeemed: server.redeemed.size,
          issued: 10,
          capacity: 10,
        });
      }
      if (url.endsWith('/spent')) return Response.json({ ys: [...server.redeemed] });
      return Response.json({ error: 'not_found' }, { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const ctx = (over: Partial<CheckinContext> = {}): CheckinContext => ({
  eventId: 'evt',
  token: 'scanner-token',
  keyset: pub,
  offlineCheckin: true,
  offline: false,
  ...over,
});

describe('online check-in', () => {
  it('never sends the DLEQ to the server', async () => {
    const tk = ticket();
    expect(await checkIn(ctx(), qr(tk))).toMatchObject({ kind: 'ok', offline: false });
    expect(server.requests).toEqual([{ keysetId: tk.keysetId, secret: tk.secret, C: tk.C }]);
  });

  it('rejects garbage, other events and tampered DLEQs locally', async () => {
    expect(await checkIn(ctx(), 'hello')).toEqual({ kind: 'bad', reason: 'unreadable' });
    expect(await checkIn(ctx(), qr(ticket('other')))).toEqual({
      kind: 'bad',
      reason: 'otherEvent',
    });
    const tk = ticket();
    const forged = encodeToken({ ...tk, C: ticket().C });
    expect(await checkIn(ctx(), forged)).toEqual({ kind: 'bad', reason: 'invalid' });
    expect(server.requests).toHaveLength(0);
  });

  it('a ticket redeemed online is remembered for later offline scans', async () => {
    const tk = ticket();
    await checkIn(ctx(), qr(tk));
    expect(await checkIn(ctx({ offline: true }), qr(tk))).toEqual({
      kind: 'bad',
      reason: 'usedHere',
    });
  });
});

describe('offline check-in', () => {
  it('accepts a DLEQ-verified ticket once, queues it, and rejects the repeat', async () => {
    const tk = ticket();
    expect(await checkIn(ctx({ offline: true }), qr(tk))).toEqual({ kind: 'ok', offline: true });
    expect(await checkIn(ctx({ offline: true }), qr(tk))).toEqual({
      kind: 'bad',
      reason: 'usedHere',
    });
    expect(await scannerStore.queued('evt')).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
  });

  it('cannot verify a QR without DLEQ, and refuses events without offline check-in', async () => {
    expect(await checkIn(ctx({ offline: true }), qr(ticket(), false))).toEqual({
      kind: 'bad',
      reason: 'noDleq',
    });
    expect(
      await checkIn(ctx({ offline: true, offlineCheckin: false }), qr(ticket(), false)),
    ).toEqual({
      kind: 'warn',
      reason: 'offlineUnsupported',
    });
  });

  it('falls back to offline mode when the network fails mid-scan', async () => {
    server.down = true;
    expect(await checkIn(ctx(), qr(ticket()))).toEqual({ kind: 'ok', offline: true });
    expect(await checkIn(ctx({ offlineCheckin: false }), qr(ticket(), false))).toEqual({
      kind: 'warn',
      reason: 'network',
    });
  });

  it('sync sends the queue, reports tickets used on another device as conflicts, and pulls the spent list', async () => {
    const a = ticket();
    const b = ticket();
    const elsewhere = ticket();
    await checkIn(ctx({ offline: true }), qr(a));
    await checkIn(ctx({ offline: true }), qr(b));
    server.redeemed.add(spentKey(b.secret)); // b was used at another door meanwhile
    server.redeemed.add(spentKey(elsewhere.secret));

    const r = await syncCheckins('evt', 'scanner-token');
    expect(r).toMatchObject({ sent: 1, conflicts: 1, remaining: 0 });
    const conflicts = await scannerStore.conflicts('evt');
    expect(conflicts.map((c) => [c.y, c.reason])).toEqual([
      [spentKey(b.secret), 'already_redeemed'],
    ]);
    // the spent list from the server now blocks "elsewhere" offline too
    expect(await checkIn(ctx({ offline: true }), qr(elsewhere))).toEqual({
      kind: 'bad',
      reason: 'usedHere',
    });
  });

  it('sync keeps the queue while offline', async () => {
    await checkIn(ctx({ offline: true }), qr(ticket()));
    server.down = true;
    expect(await syncCheckins('evt', 'scanner-token')).toMatchObject({ sent: 0, remaining: 1 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  createPublishedEvent,
  createScannerToken,
  getPublicEvent,
  getTicket,
  HOUR,
  makeHost,
  redeem,
  setup,
  solveQuote,
  json,
} from './helpers.js';
import { prepareIssue, toIssueRequest } from '@kamen/core';

describe('issue → redeem', () => {
  it('a ticket enters once and is rejected the second time', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await getTicket(h, id);
    const { token } = await createScannerToken(h, host, id);

    const first = await redeem(h, id, token, proof!);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, redeemed: 1 });

    const second = await redeem(h, id, token, proof!);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_redeemed' });

    const stats = await json(await host.call('GET', `/api/events/${id}/stats`));
    expect(stats).toMatchObject({ issued: 1, redeemed: 1, capacity: 50 });
    expect(stats.checkinsPer15Min).toHaveLength(1);
    expect(stats.checkinsPer15Min[0].count).toBe(1);
  });

  it('concurrent redemptions of the same ticket: exactly one succeeds', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await getTicket(h, id);
    const { token } = await createScannerToken(h, host, id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => redeem(h, id, token, proof!)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
  });

  it('rejects forged and tampered tickets', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const a = (await getTicket(h, id)).proof!;
    const b = (await getTicket(h, id)).proof!;
    const { token } = await createScannerToken(h, host, id);
    expect((await redeem(h, id, token, { ...a, C: b.C })).status).toBe(422);
    expect((await redeem(h, id, token, { ...a, secret: b.secret })).status).toBe(422);
    // a ticket of another event
    const other = await createPublishedEvent(h, host);
    const c = (await getTicket(h, other)).proof!;
    expect((await redeem(h, id, token, c)).status).toBe(422);
  });

  it('the redeem endpoint refuses payloads carrying the DLEQ', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await getTicket(h, id);
    const { token } = await createScannerToken(h, host, id);
    const { keysetId, secret, C, dleq } = proof!;
    const res = await h.request(`/api/events/${id}/redeem`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ keysetId, secret, C, dleq }),
    });
    expect(res.status).toBe(400);
  });
});

describe('issuing', () => {
  it('stops at capacity', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host, { capacity: 2 });
    expect((await getTicket(h, id)).res.status).toBe(200);
    expect((await getTicket(h, id)).res.status).toBe(200);
    const third = await getTicket(h, id);
    expect(third.res.status).toBe(409);
    expect(await third.res.json()).toEqual({ error: 'sold_out' });
    expect((await getPublicEvent(h, id)).remaining).toBe(0);
  });

  it('a PoW solution can be used only once', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const ev = await getPublicEvent(h, id);
    const pow = await solveQuote(h, id);
    const send = () =>
      h.request(`/api/events/${id}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pow,
          outputs: { ticket: toIssueRequest(prepareIssue(ev.keysets[0]!)) },
        }),
      });
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'pow_already_used' });
  });

  it('rejects PoW for another event, expired PoW, forged PoW and insufficient work', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const other = await createPublishedEvent(h, host);
    const ev = await getPublicEvent(h, id);
    const issue = (pow: unknown) =>
      h.request(`/api/events/${id}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pow,
          outputs: { ticket: toIssueRequest(prepareIssue(ev.keysets[0]!)) },
        }),
      });

    expect((await issue(await solveQuote(h, other))).status).toBe(422);

    const forged = await solveQuote(h, id);
    expect(
      (await issue({ ...forged, challenge: { ...forged.challenge, difficulty: 0 } })).status,
    ).toBe(422);

    const expiring = await solveQuote(h, id);
    h.clock.t += 11 * 60 * 1000;
    const expired = await issue(expiring);
    expect(expired.status).toBe(422);
    expect(await expired.json()).toEqual({ error: 'pow_expired' });
  });

  it('rejects drafts, cancelled and ended events', async () => {
    const h = setup();
    const host = makeHost(h);
    const now = h.ctx.now();
    const draft = await host.call('POST', '/api/events', {
      title: 'draft',
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      capacity: 5,
    });
    const { id } = await json(draft);
    expect((await h.request(`/api/events/${id}/quote`, { method: 'POST' })).status).toBe(403);

    await host.call('PATCH', `/api/events/${id}`, { status: 'published' });
    expect((await h.request(`/api/events/${id}/quote`, { method: 'POST' })).status).toBe(200);

    h.clock.t += 3 * HOUR;
    expect((await h.request(`/api/events/${id}/quote`, { method: 'POST' })).status).toBe(410);

    const id2 = await createPublishedEvent(h, host);
    await host.call('PATCH', `/api/events/${id2}`, { status: 'cancelled' });
    expect((await h.request(`/api/events/${id2}/quote`, { method: 'POST' })).status).toBe(410);
  });

  it('rejects unsupported kinds and mismatching keysets', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const ev = await getPublicEvent(h, id);
    const out = toIssueRequest(prepareIssue(ev.keysets[0]!));
    const send = async (outputs: unknown) =>
      h.request(`/api/events/${id}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pow: await solveQuote(h, id), outputs }),
      });
    expect((await send({ ticket: out, stamp: out })).status).toBe(400);
    expect((await send({ ticket: { ...out, keysetId: '00aaaaaaaaaaaaaa' } })).status).toBe(422);
    expect((await send({ ticket: { ...out, B_: '02' + '00'.repeat(32) } })).status).toBe(422);
  });
});

describe('location visibility', () => {
  it('hides the location publicly and reveals it at issue time', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host, {
      location: 'Secret bar, 3F',
      locationVisibility: 'ticket_holders',
    });
    const ev = await getPublicEvent(h, id);
    expect(ev.location).toBeNull();
    expect(JSON.stringify(ev)).not.toContain('Secret bar');
    expect((await getTicket(h, id)).location).toBe('Secret bar, 3F');
  });

  it('public events show the location and do not repeat it at issue time', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    expect((await getPublicEvent(h, id)).location).toBe('Shibuya');
    expect((await getTicket(h, id)).location).toBeNull();
  });
});

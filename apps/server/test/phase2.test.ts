import {
  finalizeIssue,
  prepareIssue,
  spentKey,
  toIssueRequest,
  toRedeemPayload,
} from '@kamen/core';
import { nip19 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { runCleanup } from '../src/jobs/cleanup.js';
import {
  createPublishedEvent,
  createScannerToken,
  getPublicEvent,
  getTicket,
  HOUR,
  json,
  makeHost,
  redeem,
  setup,
  solveQuote,
  type Harness,
} from './helpers.js';

const NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${'c'.repeat(64)}`;

async function paidEvent(h: Harness, host: ReturnType<typeof makeHost>, extra = {}) {
  const id = await createPublishedEvent(h, host, {
    issuePolicy: 'paid',
    priceMsat: 21_000,
    ...extra,
  });
  const res = await host.call('PUT', `/api/events/${id}/wallet`, { nwc: NWC });
  expect(res.status).toBe(200);
  return id;
}

async function buy(h: Harness, id: string) {
  const res = await h.request(`/api/events/${id}/quote`, { method: 'POST' });
  return { res, body: await json(res) };
}

async function issueWithQuote(h: Harness, id: string, quoteId: string) {
  const ev = await getPublicEvent(h, id);
  const keyset = ev.keysets[0]!;
  const pending = prepareIssue(keyset);
  const res = await h.request(`/api/events/${id}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteId, outputs: { ticket: toIssueRequest(pending) } }),
  });
  if (res.status !== 200) return { res };
  const body = await json(res);
  return { res, proof: finalizeIssue(pending, body.signatures.ticket, keyset), pending };
}

describe('paid tickets (NWC)', () => {
  it('invoice → paid → exactly one ticket per quote', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    const ev = await getPublicEvent(h, id);
    expect(ev).toMatchObject({ issuePolicy: 'paid', priceMsat: 21_000, paymentsReady: true });

    const { body: quote } = await buy(h, id);
    expect(quote).toMatchObject({ kind: 'invoice', amountMsat: 21_000 });
    expect(quote.invoice).toMatch(/^lnbcrt/);
    expect(quote.quoteId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // not paid yet
    expect((await json(await h.request(`/api/events/${id}/quotes/${quote.quoteId}`))).state).toBe(
      'unpaid',
    );
    const early = await issueWithQuote(h, id, quote.quoteId);
    expect(early.res.status).toBe(402);

    // pay (the mock wallet settles through lookup_invoice)
    const [hash] = [...h.wallet.invoices.keys()];
    h.wallet.invoices.get(hash!)!.settled = true;
    expect((await json(await h.request(`/api/events/${id}/quotes/${quote.quoteId}`))).state).toBe(
      'paid',
    );

    const first = await issueWithQuote(h, id, quote.quoteId);
    expect(first.res.status).toBe(200);
    const again = await issueWithQuote(h, id, quote.quoteId);
    expect(again.res.status).toBe(409);
    expect(await json(again.res)).toEqual({ error: 'quote_already_used' });

    const { token } = await createScannerToken(h, host, id);
    expect((await redeem(h, id, token, first.proof!)).status).toBe(200);
  });

  it('payment notifications mark the quote paid without polling the wallet', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    const { body: quote } = await buy(h, id);
    await new Promise((r) => setTimeout(r, 0)); // let watch() subscribe
    const [hash] = [...h.wallet.invoices.keys()];
    h.wallet.settle(hash!);
    const row = h.db.$client
      .prepare('SELECT state FROM quotes WHERE id = ?')
      .get(quote.quoteId) as {
      state: string;
    };
    expect(row.state).toBe('paid');
  });

  it('stores no payer data and no link between the quote and the blinded message', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    const { body: quote } = await buy(h, id);
    h.wallet.settle([...h.wallet.invoices.keys()][0]!);
    const { pending } = await issueWithQuote(h, id, quote.quoteId);
    const cols = (
      h.db.$client.prepare('PRAGMA table_info(quotes)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols.sort()).toEqual(['event_id', 'expires_at', 'id', 'payment_hash', 'state']);
    const quoteRow = JSON.stringify(h.db.$client.prepare('SELECT * FROM quotes').all());
    expect(quoteRow).not.toContain(pending!.B_);
  });

  it('paid-but-unissued quotes hold seats; unpaid quotes do not', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host, { capacity: 1 });
    const a = (await buy(h, id)).body;
    const b = (await buy(h, id)).body; // unpaid quotes do not reserve
    expect(b.kind).toBe('invoice');
    h.wallet.settle([...h.wallet.invoices.keys()][0]!);
    expect((await getPublicEvent(h, id)).remaining).toBe(0);
    expect((await buy(h, id)).res.status).toBe(409); // sold out now
    // the late payer of b still gets a ticket (paid quotes are always honoured)
    h.wallet.settle([...h.wallet.invoices.keys()][1]!);
    expect((await issueWithQuote(h, id, a.quoteId)).res.status).toBe(200);
    expect((await issueWithQuote(h, id, b.quoteId)).res.status).toBe(200);
  });

  it('expired invoices cannot be used; wallet errors surface as 502', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    const { body: quote } = await buy(h, id);
    h.clock.t += 16 * 60 * 1000;
    expect((await json(await h.request(`/api/events/${id}/quotes/${quote.quoteId}`))).state).toBe(
      'expired',
    );
    expect((await issueWithQuote(h, id, quote.quoteId)).res.status).toBe(402);
    h.wallet.failNext = true;
    expect((await buy(h, id)).res.status).toBe(502);
  });

  it('a paid event needs a price and a wallet; the wallet must be able to invoice', async () => {
    const h = setup();
    const host = makeHost(h);
    const now = h.ctx.now();
    const base = {
      title: 'p',
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      capacity: 5,
      issuePolicy: 'paid',
    };
    expect((await host.call('POST', '/api/events', base)).status).toBe(400);
    const id = await createPublishedEvent(h, host, { issuePolicy: 'paid', priceMsat: 5000 });
    expect((await getPublicEvent(h, id)).paymentsReady).toBe(false);
    expect((await buy(h, id)).res.status).toBe(409);

    expect(
      (
        await host.call('PUT', `/api/events/${id}/wallet`, {
          nwc: 'https://not-nwc.example/xxxxxxxxxxxx',
        })
      ).status,
    ).toBe(422);
    h.wallet.methodsList = ['get_info', 'pay_invoice'];
    const missing = await host.call('PUT', `/api/events/${id}/wallet`, { nwc: NWC });
    expect(missing.status).toBe(422);
    expect(await json(missing)).toMatchObject({ error: 'wallet_missing_methods' });
    h.wallet.methodsList = ['make_invoice', 'lookup_invoice', 'pay_invoice'];
    const spendy = await json(await host.call('PUT', `/api/events/${id}/wallet`, { nwc: NWC }));
    expect(spendy).toEqual({ connected: true, warnings: ['can_spend'] });
  });

  it('never returns or stores the NWC secret in plain text', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    const view = JSON.stringify(await json(await host.call('GET', `/api/host/events/${id}`)));
    expect(view).not.toContain('walletconnect');
    expect(view).toContain('"walletConnected":true');
    const stored = h.db.$client.prepare('SELECT nwc_enc FROM events').get() as { nwc_enc: string };
    expect(stored.nwc_enc.startsWith('v1:')).toBe(true);
    expect(stored.nwc_enc).not.toContain('c'.repeat(64));
  });
});

describe('invite codes', () => {
  async function inviteEvent(h: Harness, host: ReturnType<typeof makeHost>) {
    return createPublishedEvent(h, host, { issuePolicy: 'invite' });
  }
  async function issueWithInvite(h: Harness, id: string, invite?: string) {
    const ev = await getPublicEvent(h, id);
    const pending = prepareIssue(ev.keysets[0]!);
    return h.request(`/api/events/${id}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pow: await solveQuote(h, id),
        ...(invite ? { invite } : {}),
        outputs: { ticket: toIssueRequest(pending) },
      }),
    });
  }

  it('limits uses, normalizes input and stores only a keyed hash', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await inviteEvent(h, host);
    const created = await json(
      await host.call('POST', `/api/events/${id}/invite-codes`, { label: 'TG', maxUses: 2 }),
    );
    expect(created.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    expect((await issueWithInvite(h, id)).status).toBe(422);
    expect((await issueWithInvite(h, id, 'WRONG-CODE1')).status).toBe(403);
    expect((await issueWithInvite(h, id, created.code)).status).toBe(200);
    expect(
      (await issueWithInvite(h, id, created.code.toLowerCase().replace('-', ' '))).status,
    ).toBe(200);
    expect((await issueWithInvite(h, id, created.code)).status).toBe(403); // used up

    const list = await json(await host.call('GET', `/api/events/${id}/invite-codes`));
    expect(list).toEqual([{ id: created.id, label: 'TG', maxUses: 2, usesLeft: 0 }]);
    const dump = JSON.stringify(h.db.$client.prepare('SELECT * FROM invite_codes').all());
    expect(dump).not.toContain(created.code);
    expect(dump).not.toContain(created.code.replace('-', ''));
  });

  it('a failed issue (sold out) does not consume the invite', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host, { issuePolicy: 'invite', capacity: 1 });
    const { code } = await json(
      await host.call('POST', `/api/events/${id}/invite-codes`, { code: 'MEETUP2026', maxUses: 5 }),
    );
    expect((await issueWithInvite(h, id, code)).status).toBe(200);
    expect((await issueWithInvite(h, id, code)).status).toBe(409);
    const [row] = await json(await host.call('GET', `/api/events/${id}/invite-codes`));
    expect(row.usesLeft).toBe(4);
  });

  it('custom codes must be long enough and unique', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await inviteEvent(h, host);
    expect(
      (await host.call('POST', `/api/events/${id}/invite-codes`, { code: 'abc', maxUses: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await host.call('POST', `/api/events/${id}/invite-codes`, { code: 'SAME-CODE', maxUses: 1 }))
        .status,
    ).toBe(201);
    expect(
      (await host.call('POST', `/api/events/${id}/invite-codes`, { code: 'same code', maxUses: 1 }))
        .status,
    ).toBe(409);
  });
});

describe('co-hosts', () => {
  it('can edit, announce, issue check-in links and see stats, but not owner-only settings', async () => {
    const h = setup();
    const owner = makeHost(h);
    const co = makeHost(h);
    const id = await createPublishedEvent(h, owner);
    const npub = nip19.npubEncode(co.pubkey);
    expect((await owner.call('POST', `/api/events/${id}/cohosts`, { pubkey: npub })).status).toBe(
      201,
    );
    expect(await json(await owner.call('GET', `/api/events/${id}/cohosts`))).toEqual([
      { pubkey: co.pubkey },
    ]);

    expect((await co.call('PATCH', `/api/events/${id}`, { title: 'by cohost' })).status).toBe(200);
    expect((await co.call('POST', `/api/events/${id}/announcements`, { body: 'hi' })).status).toBe(
      201,
    );
    expect((await co.call('POST', `/api/events/${id}/scanner-links`, {})).status).toBe(201);
    expect((await co.call('GET', `/api/events/${id}/stats`)).status).toBe(200);
    const list = await json(await co.call('GET', '/api/host/events'));
    expect(list.map((e: { id: string; role: string }) => [e.id, e.role])).toEqual([[id, 'cohost']]);

    for (const [m, p, b] of [
      ['PATCH', `/api/events/${id}`, { status: 'cancelled' }],
      ['PUT', `/api/events/${id}/wallet`, { nwc: NWC }],
      ['POST', `/api/events/${id}/invite-codes`, { maxUses: 1 }],
      ['POST', `/api/events/${id}/cohosts`, { pubkey: owner.pubkey }],
    ] as const) {
      expect((await co.call(m, p, b)).status).toBe(403);
    }

    expect((await owner.call('DELETE', `/api/events/${id}/cohosts/${npub}`)).status).toBe(204);
    expect((await co.call('GET', `/api/events/${id}/stats`)).status).toBe(403);
  });

  it('rejects invalid keys and the owner itself', async () => {
    const h = setup();
    const owner = makeHost(h);
    const id = await createPublishedEvent(h, owner);
    expect(
      (await owner.call('POST', `/api/events/${id}/cohosts`, { pubkey: 'npub1nope' })).status,
    ).toBe(400);
    expect(
      (await owner.call('POST', `/api/events/${id}/cohosts`, { pubkey: owner.pubkey })).status,
    ).toBe(409);
  });
});

describe('ticket return', () => {
  it('frees the seat and makes the ticket unusable', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host, { capacity: 1 });
    const { proof } = await getTicket(h, id);
    expect((await getTicket(h, id)).res.status).toBe(409);

    const ret = await h.request(`/api/events/${id}/return`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toRedeemPayload(proof!)),
    });
    expect(ret.status).toBe(200);
    expect((await getPublicEvent(h, id)).remaining).toBe(1);
    const stats = await json(await host.call('GET', `/api/events/${id}/stats`));
    expect(stats).toMatchObject({ issued: 0, returned: 1 });

    const { token } = await createScannerToken(h, host, id);
    expect((await redeem(h, id, token, proof!)).status).toBe(409);
    expect((await getTicket(h, id)).res.status).toBe(200);
  });

  it('cannot return twice, a used ticket, or a forged one', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const a = (await getTicket(h, id)).proof!;
    const b = (await getTicket(h, id)).proof!;
    const ret = (p: object) =>
      h.request(`/api/events/${id}/return`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      });
    expect((await ret(toRedeemPayload(a))).status).toBe(200);
    expect((await ret(toRedeemPayload(a))).status).toBe(409);
    const { token } = await createScannerToken(h, host, id);
    await redeem(h, id, token, b);
    expect((await ret(toRedeemPayload(b))).status).toBe(409);
    expect((await ret({ ...toRedeemPayload(b), C: a.C })).status).toBe(422);
    expect((await ret({ ...toRedeemPayload(b), dleq: b.dleq })).status).toBe(400);
  });
});

describe('offline check-in support', () => {
  it('the event flag is public and the scanner can fetch the spent list only when enabled', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await getTicket(h, id);
    const { token } = await createScannerToken(h, host, id);
    const spentList = () =>
      h.request(`/api/events/${id}/spent`, { headers: { authorization: `Bearer ${token}` } });
    expect((await getPublicEvent(h, id)).offlineCheckin).toBe(false);
    expect((await spentList()).status).toBe(403);

    await host.call('PATCH', `/api/events/${id}`, { offlineCheckin: true });
    expect((await getPublicEvent(h, id)).offlineCheckin).toBe(true);
    await redeem(h, id, token, proof!);
    expect(await json(await spentList())).toEqual({ ys: [spentKey(proof!.secret)] });
    expect((await h.request(`/api/events/${id}/spent`)).status).toBe(401);
  });
});

describe('retention job', () => {
  it('48 h after the end: keys, spent list, quotes and wallet are gone; aggregates stay', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    const { body: quote } = await buy(h, id);
    h.wallet.settle([...h.wallet.invoices.keys()][0]!);
    const { proof } = await issueWithQuote(h, id, quote.quoteId);
    const { token } = await createScannerToken(h, host, id);
    await redeem(h, id, token, proof!);
    await host.call('POST', `/api/events/${id}/invite-codes`, { maxUses: 1 });

    h.clock.t += 28 * HOUR; // event ended 1 h ago
    let r = runCleanup(h.ctx);
    expect(r).toMatchObject({ retiredKeysets: 0, deletedInviteCodes: 1 });

    h.clock.t += 48 * HOUR;
    r = runCleanup(h.ctx);
    expect(r).toMatchObject({
      retiredKeysets: 2,
      deletedSpent: 1,
      clearedWallets: 1,
      deletedScannerLinks: 1,
    });
    expect(r.deletedQuotes).toBeGreaterThanOrEqual(1);

    const q = (sql: string) => h.db.$client.prepare(sql).all();
    expect(q('SELECT * FROM quotes')).toEqual([]);
    expect(q('SELECT * FROM spent')).toEqual([]);
    expect(q('SELECT private_key_enc FROM keysets')).toEqual([
      { private_key_enc: null },
      { private_key_enc: null },
    ]);
    expect(q('SELECT nwc_enc, issued_count, redeemed_count FROM events')).toEqual([
      { nwc_enc: null, issued_count: 1, redeemed_count: 1 },
    ]);
    expect((await getPublicEvent(h, id)).keysets).toHaveLength(2); // public keys stay
  });

  it('removes stale unpaid quotes but keeps paid ones', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await paidEvent(h, host);
    await buy(h, id);
    const { body: paid } = await buy(h, id);
    h.wallet.settle([...h.wallet.invoices.keys()][1]!);
    h.clock.t += 2 * HOUR;
    runCleanup(h.ctx);
    const rows = h.db.$client.prepare('SELECT id, state FROM quotes').all();
    expect(rows).toEqual([{ id: paid.quoteId, state: 'paid' }]);
  });
});

import {
  finalizeIssue,
  prepareIssue,
  spentKey,
  toIssueRequest,
  toRedeemPayload,
  type PendingIssue,
  type Proof,
  type PublicKeyset,
} from '@kamen/core';
import { describe, expect, it } from 'vitest';
import { runCleanup } from '../src/jobs/cleanup.js';
import { settleDeposits } from '../src/lib/deposits.js';
import {
  createPublishedEvent,
  createScannerToken,
  getPublicEvent,
  HOUR,
  json,
  makeHost,
  setup,
  solveQuote,
  type Harness,
} from './helpers.js';

const NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${'c'.repeat(64)}`;
type Host = ReturnType<typeof makeHost>;
const post = (h: Harness, path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function event(h: Harness, id: string) {
  const ev = await getPublicEvent(h, id);
  return {
    ev,
    ticket: ev.keysets.find((k) => k.kind === 'ticket') as PublicKeyset,
    vote: ev.keysets.find((k) => k.kind === 'vote') as PublicKeyset,
    stamp: ev.stampKeyset as PublicKeyset,
  };
}

/** Get a ticket with an arbitrary issue body (pow added unless disabled). */
async function issue(h: Harness, id: string, extra: Record<string, unknown> = {}, withPow = true) {
  const { ticket } = await event(h, id);
  const pending = prepareIssue(ticket);
  const res = await post(h, `/api/events/${id}/issue`, {
    ...(withPow ? { pow: await solveQuote(h, id) } : {}),
    ...extra,
    outputs: { ticket: toIssueRequest(pending) },
  });
  const body = await json(res);
  return {
    res,
    body,
    proof: res.status === 200 ? finalizeIssue(pending, body.signatures.ticket, ticket) : null,
  };
}

/** Check in with stamp + vote extras; returns the finalized stamp and vote credential. */
async function checkIn(
  h: Harness,
  host: Host,
  id: string,
  proof: Proof,
  extra: Record<string, unknown> = {},
) {
  const { stamp, vote } = await event(h, id);
  const ps = prepareIssue(stamp);
  const pv = prepareIssue(vote);
  const { token } = await createScannerToken(h, host, id);
  const res = await post(
    h,
    `/api/events/${id}/redeem`,
    { ...toRedeemPayload(proof), stampB_: ps.B_, voteB_: pv.B_, ...extra },
    { authorization: `Bearer ${token}` },
  );
  const body = await json(res);
  const pick = async (p: PendingIssue, ks: PublicKeyset) => {
    const r = await h.request(`/api/stamps/${p.B_}`);
    return r.status === 200 ? finalizeIssue(p, await json(r), ks) : null;
  };
  return { res, body, stamp: await pick(ps, stamp), vote: await pick(pv, vote), ps, pv };
}

describe('stamps (御朱印) and check-in credentials', () => {
  it('are signed at check-in, picked up once, and verify against the host / event keys', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await issue(h, id);
    const r = await checkIn(h, host, id, proof!);
    expect(r.res.status).toBe(200);
    expect(r.body.extras).toMatchObject({ stamp: true, vote: true });
    expect(r.stamp?.keysetId).toBe((await event(h, id)).stamp.id);
    expect(r.vote?.keysetId).toBe((await event(h, id)).vote.id);
    expect((await h.request(`/api/stamps/${r.ps.B_}`)).status).toBe(404); // one-time pickup
  });

  it('one stamp keyset per host, shared by its events, different between hosts', async () => {
    const h = setup();
    const a = makeHost(h);
    const b = makeHost(h);
    const e1 = await createPublishedEvent(h, a);
    const e2 = await createPublishedEvent(h, a);
    const e3 = await createPublishedEvent(h, b);
    const k1 = (await event(h, e1)).stamp.id;
    expect((await event(h, e2)).stamp.id).toBe(k1);
    expect((await event(h, e3)).stamp.id).not.toBe(k1);
  });

  it('stored check-in signatures expire after 24 h', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await issue(h, id);
    const { stamp } = await event(h, id);
    const ps = prepareIssue(stamp);
    const { token } = await createScannerToken(h, host, id);
    await post(
      h,
      `/api/events/${id}/redeem`,
      { ...toRedeemPayload(proof!), stampB_: ps.B_ },
      { authorization: `Bearer ${token}` },
    );
    h.clock.t += 25 * HOUR;
    expect((await h.request(`/api/stamps/${ps.B_}`)).status).toBe(404);
    expect(runCleanup(h.ctx).deletedPendingSignatures).toBe(1);
  });

  it('swap: N stamps for N fresh ones; reuse and cross-host bundles are refused', async () => {
    const h = setup();
    const host = makeHost(h);
    const stamps: Proof[] = [];
    let ks: PublicKeyset | null = null;
    for (let i = 0; i < 2; i++) {
      const id = await createPublishedEvent(h, host);
      ks = (await event(h, id)).stamp;
      const { proof } = await issue(h, id);
      stamps.push((await checkIn(h, host, id, proof!)).stamp!);
    }
    const outs = stamps.map(() => prepareIssue(ks!));
    const swap = (proofs: Proof[], o = outs) =>
      post(h, '/api/stamps/swap', {
        proofs: proofs.map(toRedeemPayload),
        outputs: o.map(toIssueRequest),
      });
    const res = await swap(stamps);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ hostPubkey: host.pubkey, count: 2 });
    const fresh = outs.map((p, i) => finalizeIssue(p, body.signatures[i], ks!));
    expect(fresh).toHaveLength(2);
    expect(
      (
        await swap(
          stamps,
          stamps.map(() => prepareIssue(ks!)),
        )
      ).status,
    ).toBe(409);
    expect((await swap(fresh.slice(0, 1), outs)).status).toBe(400);
  });

  it('regulars-first: issuing requires N stamps of the same host and returns fresh ones', async () => {
    const h = setup();
    const host = makeHost(h);
    const other = makeHost(h);
    const past = await createPublishedEvent(h, host);
    const { proof } = await issue(h, past);
    const stamp = (await checkIn(h, host, past, proof!)).stamp!;
    const id = await createPublishedEvent(h, host, { minStamps: 1 });
    const ks = (await event(h, id)).stamp;
    expect((await getPublicEvent(h, id)).minStamps).toBe(1);
    expect((await issue(h, id)).res.status).toBe(403);
    const out = prepareIssue(ks);
    const ok = await issue(h, id, {
      stamps: { proofs: [toRedeemPayload(stamp)], outputs: [toIssueRequest(out)] },
    });
    expect(ok.res.status).toBe(200);
    expect(finalizeIssue(out, ok.body.stampSignatures[0], ks).keysetId).toBe(ks.id);
    const again = await issue(h, id, {
      stamps: { proofs: [toRedeemPayload(stamp)], outputs: [toIssueRequest(prepareIssue(ks))] },
    });
    expect(again.res.status).toBe(409);
    // stamps of another host do not count
    const otherEvent = await createPublishedEvent(h, other);
    const { proof: p2 } = await issue(h, otherEvent);
    const foreign = (await checkIn(h, other, otherEvent, p2!)).stamp!;
    const bad = await issue(h, id, {
      stamps: { proofs: [toRedeemPayload(foreign)], outputs: [toIssueRequest(prepareIssue(ks))] },
    });
    expect(bad.res.status).toBe(422);
  });
});

describe('anonymous polls and questions', () => {
  async function attendee(h: Harness, host: Host, id: string) {
    const { proof } = await issue(h, id);
    return (await checkIn(h, host, id, proof!)).vote!;
  }

  it('one vote per credential per poll; only counts are stored', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { id: pid } = await json(
      await host.call('POST', `/api/events/${id}/polls`, {
        question: 'Next topic?',
        options: ['LN', 'Mining'],
      }),
    );
    const a = await attendee(h, host, id);
    const b = await attendee(h, host, id);
    const vote = (cred: Proof, option: number) =>
      post(h, `/api/events/${id}/polls/${pid}/vote`, { credential: toRedeemPayload(cred), option });
    expect((await vote(a, 0)).status).toBe(200);
    expect((await vote(b, 1)).status).toBe(200);
    expect((await vote(a, 1)).status).toBe(409);
    expect((await vote({ ...a, C: b.C }, 0)).status).toBe(403);
    const [poll] = await json(await h.request(`/api/events/${id}/polls`));
    expect(poll).toMatchObject({ question: 'Next topic?', counts: [1, 1], status: 'open' });
    // the database holds neither credentials nor who-chose-what
    const voters = JSON.stringify(h.db.$client.prepare('SELECT * FROM poll_voters').all());
    expect(voters).not.toContain(spentKey(a.secret));
    expect(
      h.db.$client
        .prepare('PRAGMA table_info(poll_voters)')
        .all()
        .map((c) => (c as { name: string }).name),
    ).toEqual(['poll_id', 'voter']);
    await host.call('POST', `/api/events/${id}/polls/${pid}/close`);
    expect((await vote(await attendee(h, host, id), 0)).status).toBe(409);
  });

  it('a credential pseudonym differs per poll (no cross-poll linking in the database)', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const p1 = (
      await json(
        await host.call('POST', `/api/events/${id}/polls`, { question: 'a', options: ['x', 'y'] }),
      )
    ).id;
    const p2 = (
      await json(
        await host.call('POST', `/api/events/${id}/polls`, { question: 'b', options: ['x', 'y'] }),
      )
    ).id;
    const a = await attendee(h, host, id);
    for (const pid of [p1, p2])
      await post(h, `/api/events/${id}/polls/${pid}/vote`, {
        credential: toRedeemPayload(a),
        option: 0,
      });
    const rows = h.db.$client.prepare('SELECT voter FROM poll_voters').all() as { voter: string }[];
    expect(new Set(rows.map((r) => r.voter)).size).toBe(2);
  });

  it('questions: 3 per attendee, one upvote each, hosts can hide', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const a = await attendee(h, host, id);
    const b = await attendee(h, host, id);
    const ask = (cred: Proof, body: string) =>
      post(h, `/api/events/${id}/questions`, { credential: toRedeemPayload(cred), body });
    const ids: string[] = [];
    for (const q of ['q1', 'q2', 'q3']) ids.push((await json(await ask(a, q))).id);
    expect((await ask(a, 'q4')).status).toBe(429);
    const up = (cred: Proof, qid: string) =>
      post(h, `/api/events/${id}/questions/${qid}/upvote`, { credential: toRedeemPayload(cred) });
    expect((await up(b, ids[1]!)).status).toBe(200);
    expect((await up(b, ids[1]!)).status).toBe(409);
    const list = await json(await h.request(`/api/events/${id}/questions`));
    expect(list[0]).toMatchObject({ body: 'q2', upvotes: 1 });
    await host.call('POST', `/api/events/${id}/questions/${ids[0]}/hide`);
    expect(
      (await json(await h.request(`/api/events/${id}/questions`))).map(
        (q: { body: string }) => q.body,
      ),
    ).toEqual(['q2', 'q3']);
  });

  it('credentials of another event are not accepted', async () => {
    const h = setup();
    const host = makeHost(h);
    const e1 = await createPublishedEvent(h, host);
    const e2 = await createPublishedEvent(h, host);
    const cred = await attendee(h, host, e1);
    const res = await post(h, `/api/events/${e2}/questions`, {
      credential: toRedeemPayload(cred),
      body: 'hi',
    });
    expect(res.status).toBe(403);
  });
});

describe('draws (no monetary value)', () => {
  it('attendees enter with their credential; the host draws; winners see their code', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { id: did } = await json(
      await host.call('POST', `/api/events/${id}/draws`, { title: 'LT order', winners: 1 }),
    );
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { proof } = await issue(h, id);
      const cred = (await checkIn(h, host, id, proof!)).vote!;
      const r = await json(
        await post(h, `/api/events/${id}/draws/${did}/enter`, {
          credential: toRedeemPayload(cred),
        }),
      );
      expect(r.code).toMatch(/^[0-9A-F]{8}$/);
      // entering twice gives the same code
      expect(
        (
          await json(
            await post(h, `/api/events/${id}/draws/${did}/enter`, {
              credential: toRedeemPayload(cred),
            }),
          )
        ).code,
      ).toBe(r.code);
      codes.push(r.code);
    }
    const drawn = await json(await host.call('POST', `/api/events/${id}/draws/${did}/draw`));
    expect(drawn.entries).toBe(3);
    expect(drawn.winningCodes).toHaveLength(1);
    expect(codes).toContain(drawn.winningCodes[0]);
    const [pub] = await json(await h.request(`/api/events/${id}/draws`));
    expect(pub).toMatchObject({ status: 'drawn', winningCodes: drawn.winningCodes });
    expect((await host.call('POST', `/api/events/${id}/draws/${did}/draw`)).status).toBe(409);
  });
});

describe('deposits (hold invoice)', () => {
  async function depositEvent(h: Harness, host: Host, extra = {}) {
    const id = await createPublishedEvent(h, host, { depositMsat: 5000, ...extra });
    expect((await host.call('PUT', `/api/events/${id}/wallet`, { nwc: NWC })).status).toBe(200);
    return id;
  }
  const pay = (h: Harness, hash: string) => h.wallet.payHold(hash);
  const holdHash = (h: Harness) => [...h.wallet.holds.keys()].at(-1)!;

  it('pay → ticket → check-in refunds; no-shows are settled after the event', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await depositEvent(h, host);
    expect((await getPublicEvent(h, id)).depositMsat).toBe(5000);

    // without a paid deposit there is no ticket
    expect((await issue(h, id)).res.status).toBe(402);
    const d1 = await json(await post(h, `/api/events/${id}/deposit`, {}));
    expect(d1.invoice).toMatch(/^lnbcrt/);
    expect((await issue(h, id, { depositId: d1.depositId })).res.status).toBe(402);
    pay(h, holdHash(h));
    expect((await json(await h.request(`/api/events/${id}/deposits/${d1.depositId}`))).state).toBe(
      'held',
    );
    const t1 = await issue(h, id, { depositId: d1.depositId });
    expect(t1.res.status).toBe(200);
    expect((await issue(h, id, { depositId: d1.depositId })).res.status).toBe(402); // one ticket per deposit

    // a second attendee who will not come
    const d2 = await json(await post(h, `/api/events/${id}/deposit`, {}));
    pay(h, holdHash(h));
    expect((await issue(h, id, { depositId: d2.depositId })).res.status).toBe(200);

    const r = await checkIn(h, host, id, t1.proof!, { depositRef: d1.depositId });
    expect(r.body.extras.deposit).toBe('refunded');
    expect(h.wallet.holds.get([...h.wallet.holds.keys()][0]!)!.state).toBe('cancelled');

    h.clock.t += 28 * HOUR;
    expect(await settleDeposits(h.ctx)).toEqual({ settled: 1, refunded: 0 });
    expect(h.wallet.holds.get(holdHash(h))!.state).toBe('settled');
  });

  it('returning the ticket refunds the deposit', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await depositEvent(h, host);
    const d = await json(await post(h, `/api/events/${id}/deposit`, {}));
    pay(h, holdHash(h));
    const t = await issue(h, id, { depositId: d.depositId });
    const res = await post(h, `/api/events/${id}/return`, {
      ...toRedeemPayload(t.proof!),
      depositRef: d.depositId,
    });
    expect(await json(res)).toMatchObject({ ok: true, deposit: 'refunded' });
  });

  it('deposits open only shortly before the event; not combinable with paid tickets', async () => {
    const h = setup();
    const host = makeHost(h);
    const now = h.ctx.now();
    const far = await depositEvent(h, host, {
      startsAt: now + 10 * 24 * HOUR,
      endsAt: now + 10 * 24 * HOUR + 3 * HOUR,
    });
    expect(await json(await post(h, `/api/events/${far}/deposit`, {}))).toEqual({
      error: 'deposit_window_not_open',
    });
    const bad = await host.call('POST', '/api/events', {
      title: 'x',
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      capacity: 5,
      issuePolicy: 'paid',
      priceMsat: 1000,
      depositMsat: 5000,
    });
    expect(bad.status).toBe(400);
  });

  it('the preimage is stored encrypted', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await depositEvent(h, host);
    await post(h, `/api/events/${id}/deposit`, {});
    const row = h.db.$client.prepare('SELECT preimage_enc FROM deposits').get() as {
      preimage_enc: string;
    };
    expect(row.preimage_enc.startsWith('v1:')).toBe(true);
  });
});

describe('approval-based events', () => {
  it('apply with a Nostr signature → host approves → one ticket; applications are deleted later', async () => {
    const h = setup();
    const host = makeHost(h);
    const applicant = makeHost(h); // any Nostr key can sign NIP-98
    const id = await createPublishedEvent(h, host, { issuePolicy: 'approval' });
    const path = `/api/events/${id}/applications`;
    const res = await h.request(path, {
      method: 'POST',
      headers: { authorization: applicant.authHeader('POST', path) },
    });
    expect(res.status).toBe(201);
    const { id: aid, token } = await json(res);
    const status = async () =>
      (await json(await h.request(`${path}/${aid}`, { headers: { 'x-kamen-claim': token } })))
        .state;
    expect(await status()).toBe('pending');
    expect(
      (await h.request(`${path}/${aid}`, { headers: { 'x-kamen-claim': 'wrong-token-xxxxxxxx' } }))
        .status,
    ).toBe(404);

    expect((await issue(h, id, { approval: { id: aid, token } }, false)).res.status).toBe(403);
    const list = await json(await host.call('GET', path));
    expect(list).toEqual([
      expect.objectContaining({ id: aid, pubkey: applicant.pubkey, state: 'pending' }),
    ]);
    expect((await host.call('POST', `${path}/${aid}/approve`)).status).toBe(200);
    expect(await status()).toBe('approved');
    const ok = await issue(h, id, { approval: { id: aid, token } }, false);
    expect(ok.res.status).toBe(200);
    expect(await status()).toBe('issued');
    expect((await issue(h, id, { approval: { id: aid, token } }, false)).res.status).toBe(403);
    expect((await host.call('POST', `${path}/${aid}/reject`)).status).toBe(409);

    h.clock.t += 80 * HOUR;
    expect(runCleanup(h.ctx).deletedApprovals).toBe(1);
  });

  it('only approval events accept applications; unsigned requests are refused', async () => {
    const h = setup();
    const host = makeHost(h);
    const applicant = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const path = `/api/events/${id}/applications`;
    expect((await h.request(path, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await h.request(path, {
          method: 'POST',
          headers: { authorization: applicant.authHeader('POST', path) },
        })
      ).status,
    ).toBe(409);
  });
});

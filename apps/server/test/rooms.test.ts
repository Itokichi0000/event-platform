import {
  finalizeIssue,
  prepareIssue,
  toIssueRequest,
  toRedeemPayload,
  type Proof,
  type PublicKeyset,
} from '@kamen/core';
import { InMemoryAdapter, InMemoryHub, type SignedEvent } from '@kamen/messaging';
import { getPublicKey } from 'nostr-tools/pure';
import { randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { RoomService } from '../src/agent/rooms.js';
import { AgentStore } from '../src/agent/store.js';
import { AgentRequestError, type AgentClient } from '../src/lib/agent-client.js';
import {
  createPublishedEvent,
  createScannerToken,
  getPublicEvent,
  HOUR,
  json,
  makeHost,
  redeem,
  setup,
  solveQuote,
  type Harness,
} from './helpers.js';

/** The real RoomService over the in-memory messaging adapter, called in-process. */
function localAgent() {
  const hub = new InMemoryHub();
  const store = new AgentStore(':memory:', Buffer.from('33'.repeat(32), 'hex'));
  const rooms = new RoomService(
    store,
    Buffer.from('33'.repeat(32), 'hex'),
    ['wss://relay.test'],
    async (_e, sk) => new InMemoryAdapter(hub, getPublicKey(Buffer.from(sk, 'hex'))),
    { batchMs: 5, verify: () => true },
  );
  const calls: string[] = [];
  const client: AgentClient = {
    join: async (eventId, title, endsAt, kp) => {
      calls.push('join');
      return rooms.join(eventId, title, endsAt, kp);
    },
    announce: async (eventId, body) => {
      calls.push(`announce:${body}`);
      await rooms.announce(eventId, body);
    },
    disband: async (eventId) => {
      calls.push('disband');
      await rooms.disband(eventId);
    },
  };
  const participant = () => new InMemoryAdapter(hub, getPublicKey(randomBytes(32)));
  return { hub, rooms, store, client, calls, participant };
}

const brokenAgent: AgentClient = {
  join: async () => {
    throw new AgentRequestError('agent_unreachable');
  },
  announce: async () => {
    throw new AgentRequestError('agent_unreachable');
  },
  disband: async () => {
    throw new AgentRequestError('agent_unreachable');
  },
};

/** Issue ticket + room pass in one request. */
async function getTicketAndPass(h: Harness, id: string) {
  const ev = await getPublicEvent(h, id);
  const tk = ev.keysets.find((k) => k.kind === 'ticket') as PublicKeyset;
  const rk = ev.keysets.find((k) => k.kind === 'room') as PublicKeyset;
  const pt = prepareIssue(tk);
  const pr = prepareIssue(rk);
  const res = await h.request(`/api/events/${id}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pow: await solveQuote(h, id),
      outputs: { ticket: toIssueRequest(pt), room: toIssueRequest(pr) },
    }),
  });
  const body = await json(res);
  return {
    res,
    body,
    ticket: finalizeIssue(pt, body.signatures.ticket, tk),
    pass: body.signatures.room ? finalizeIssue(pr, body.signatures.room, rk) : null,
    pending: { pt, pr },
  };
}

function joinRoom(h: Harness, id: string, pass: Proof, keyPackage: SignedEvent) {
  return h.request(`/api/events/${id}/room/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: toRedeemPayload(pass), keyPackage }),
  });
}

describe('room passes', () => {
  it('are issued with the ticket from a separate keyset', async () => {
    const agent = localAgent();
    const h = setup({ agent: agent.client });
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const ev = await getPublicEvent(h, id);
    expect(ev.roomAvailable).toBe(true);
    const kinds = ev.keysets.map((k) => k.kind).sort();
    expect(kinds).toEqual(['room', 'ticket']);
    const { pass, ticket } = await getTicketAndPass(h, id);
    expect(pass).not.toBeNull();
    expect(pass!.keysetId).not.toBe(ticket.keysetId);
    expect((await json(await host.call('GET', `/api/events/${id}/stats`))).issued).toBe(1);
  });

  it('are omitted (ticket still issued) when rooms are disabled', async () => {
    const h = setup(); // no agent = no ROOM_RELAYS
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    expect((await getPublicEvent(h, id)).roomAvailable).toBe(false);
    const { res, pass, ticket } = await getTicketAndPass(h, id);
    expect(res.status).toBe(200);
    expect(pass).toBeNull();
    const { token } = await createScannerToken(h, host, id);
    expect((await redeem(h, id, token, ticket)).status).toBe(200);
  });

  it('a room pass is not a ticket and vice versa', async () => {
    const agent = localAgent();
    const h = setup({ agent: agent.client });
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { pass, ticket } = await getTicketAndPass(h, id);
    const { token } = await createScannerToken(h, host, id);
    expect((await redeem(h, id, token, pass!)).status).toBe(422);
    const p = agent.participant();
    expect((await joinRoom(h, id, ticket, await p.publishKeyPackage())).status).toBe(422);
  });
});

describe('POST /room/join', () => {
  it('spends the pass once and returns a welcome for the participant', async () => {
    const agent = localAgent();
    const h = setup({ agent: agent.client });
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { pass } = await getTicketAndPass(h, id);
    const p = agent.participant();
    const res = await joinRoom(h, id, pass!, await p.publishKeyPackage());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ relays: ['wss://relay.test'] });
    expect(body.agentPubkey).toMatch(/^[0-9a-f]{64}$/);
    const info = await p.join(body.welcome);
    expect(info.roomId).toBe(body.roomId);

    const again = await joinRoom(h, id, pass!, await agent.participant().publishKeyPackage());
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: 'pass_already_used' });
  });

  it('restores the pass when the agent is down; tickets and check-in keep working', async () => {
    const h = setup({ agent: brokenAgent });
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { pass, ticket } = await getTicketAndPass(h, id);
    const hub = new InMemoryHub();
    const kp = await new InMemoryAdapter(hub, getPublicKey(randomBytes(32))).publishKeyPackage();
    const res = await joinRoom(h, id, pass!, kp);
    expect(res.status).toBe(503);
    expect(h.db.$client.prepare('SELECT COUNT(*) AS n FROM spent').get()).toEqual({ n: 0 });
    // announcements still post (room delivery is best effort)
    expect(
      (await host.call('POST', `/api/events/${id}/announcements`, { body: 'hi' })).status,
    ).toBe(201);
    const { token } = await createScannerToken(h, host, id);
    expect((await redeem(h, id, token, ticket)).status).toBe(200);
  });

  it('rejects forged passes and closed rooms', async () => {
    const agent = localAgent();
    const h = setup({ agent: agent.client });
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const a = (await getTicketAndPass(h, id)).pass!;
    const b = (await getTicketAndPass(h, id)).pass!;
    const kp = await agent.participant().publishKeyPackage();
    expect((await joinRoom(h, id, { ...a, C: b.C }, kp)).status).toBe(422);
    await host.call('PATCH', `/api/events/${id}`, { roomEnabled: false });
    expect((await joinRoom(h, id, a, kp)).status).toBe(409);
    expect((await getPublicEvent(h, id)).roomAvailable).toBe(false);
  });

  it('closes 24 h after the event', async () => {
    const agent = localAgent();
    const h = setup({ agent: agent.client });
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { pass } = await getTicketAndPass(h, id);
    h.clock.t += 28 * HOUR; // event ended 1 h ago: still open
    expect((await getPublicEvent(h, id)).roomAvailable).toBe(true);
    h.clock.t += 24 * HOUR;
    expect((await getPublicEvent(h, id)).roomAvailable).toBe(false);
    expect(
      (await joinRoom(h, id, pass!, await agent.participant().publishKeyPackage())).status,
    ).toBe(409);
  });
});

describe('announcements and disbanding', () => {
  it('announcements are posted into the room; the owner can disband it now', async () => {
    const agent = localAgent();
    const h = setup({ agent: agent.client });
    const host = makeHost(h);
    const co = makeHost(h);
    const id = await createPublishedEvent(h, host);
    await host.call('POST', `/api/events/${id}/cohosts`, { pubkey: co.pubkey });
    const { pass } = await getTicketAndPass(h, id);
    const p = agent.participant();
    const body = await json(await joinRoom(h, id, pass!, await p.publishKeyPackage()));
    await p.join(body.welcome);
    const got: string[] = [];
    let status = '';
    await p.subscribe(body.roomId, {
      onMessage: (m) => got.push(m.content),
      onStatus: (s) => (status = s),
    });

    await host.call('POST', `/api/events/${id}/announcements`, { body: 'Doors open' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(['Doors open']);

    expect((await co.call('POST', `/api/events/${id}/room/disband`)).status).toBe(403);
    expect((await host.call('POST', `/api/events/${id}/room/disband`)).status).toBe(200);
    expect(status).toBe('disbanded');
    expect(agent.store.rooms()).toEqual([]);
    expect((await getPublicEvent(h, id)).roomAvailable).toBe(false);
  });
});

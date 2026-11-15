import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { InMemoryAdapter, InMemoryHub } from '@kamen/messaging';
import { MarmotAdapter, MemoryBackend } from '@kamen/messaging/marmot';
import { startTestRelay } from '@kamen/messaging/testing';
import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { agentSecret, AGENT_SECRET_HEADER, createAgentApp } from '../src/agent/app.js';
import { agentSecretKey, DISBAND_AFTER_END_MS, RoomService } from '../src/agent/rooms.js';
import { AgentStore } from '../src/agent/store.js';

const MASTER = Buffer.from('22'.repeat(32), 'hex');
const HOUR = 3600_000;

function memoryAgent(opts: { batchMs?: number; now?: () => number; verify?: () => boolean } = {}) {
  const hub = new InMemoryHub();
  const store = new AgentStore(':memory:', MASTER);
  const created: string[] = [];
  const rooms = new RoomService(
    store,
    MASTER,
    ['wss://relay.test'],
    async (eventId, sk) => {
      created.push(eventId);
      return new InMemoryAdapter(hub, getPublicKey(Buffer.from(sk, 'hex')));
    },
    {
      batchMs: opts.batchMs ?? 20,
      verify: opts.verify ?? (() => true),
      ...(opts.now ? { now: opts.now } : {}),
    },
  );
  const participant = () => new InMemoryAdapter(hub, getPublicKey(randomBytes(32)));
  return { hub, store, rooms, created, participant };
}

describe('agent keys', () => {
  it('are per event, deterministic and valid', () => {
    const a = agentSecretKey(MASTER, 'event1');
    expect(agentSecretKey(MASTER, 'event1')).toBe(a);
    expect(agentSecretKey(MASTER, 'event2')).not.toBe(a);
    expect(() => getPublicKey(Buffer.from(a, 'hex'))).not.toThrow();
  });
});

describe('RoomService (in-memory messaging)', () => {
  it('batches simultaneous joins into one commit', async () => {
    const { rooms, hub, participant } = memoryAgent({ batchMs: 50 });
    const people = [participant(), participant(), participant()];
    const res = await Promise.all(
      people.map(async (p) =>
        rooms.join('evtaaaaaaaaa', 'Meetup', Date.now() + HOUR, await p.publishKeyPackage()),
      ),
    );
    expect(new Set(res.map((r) => r.roomId)).size).toBe(1);
    for (const [i, p] of people.entries()) await p.join(res[i]!.welcome);
    const room = hub.rooms.get(res[0]!.roomId)!;
    expect(room.members.size).toBe(4); // agent + 3
  });

  it('rejects forged key packages', async () => {
    const { rooms, participant } = memoryAgent({ verify: () => false });
    const kp = await participant().publishKeyPackage();
    await expect(rooms.join('evtaaaaaaaaa', 'M', Date.now() + HOUR, kp)).rejects.toThrow(
      'invalid_key_package',
    );
  });

  it('disbands rooms 24 h after the event and forgets their state', async () => {
    const clock = { t: Date.now() };
    const { rooms, store } = memoryAgent({ now: () => clock.t });
    await rooms.ensure('evtaaaaaaaaa', 'M', clock.t + HOUR);
    await rooms.ensure('evtbbbbbbbbb', 'N', clock.t + 10 * HOUR);
    clock.t += HOUR + DISBAND_AFTER_END_MS + 1;
    expect(await rooms.sweep()).toBe(1);
    expect(store.rooms().map((r) => r.event_id)).toEqual(['evtbbbbbbbbb']);
  });
});

describe('agent HTTP API', () => {
  it('requires the shared secret and validates input', async () => {
    const { rooms } = memoryAgent();
    const app = createAgentApp(rooms, MASTER, () => {});
    const call = (path: string, body: unknown, secret = agentSecret(MASTER)) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AGENT_SECRET_HEADER]: secret },
        body: JSON.stringify(body),
      });
    expect(
      (await call('/rooms/evtaaaaaaaaa/ensure', { title: 'M', endsAt: Date.now() + HOUR }, 'nope'))
        .status,
    ).toBe(401);
    const ok = await call('/rooms/evtaaaaaaaaa/ensure', { title: 'M', endsAt: Date.now() + HOUR });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ relays: ['wss://relay.test'] });
    expect((await call('/rooms/BAD!/ensure', { title: 'M', endsAt: 1 })).status).toBe(400);
    expect((await call('/rooms/evtaaaaaaaaa/announce', { body: '' })).status).toBe(400);
  });
});

describe('RoomService with marmot-ts, encrypted state and restart', () => {
  it('keeps working after a restart from the encrypted store', { timeout: 60_000 }, async () => {
    const relay = await startTestRelay();
    const store = new AgentStore(':memory:', MASTER);
    const factory = (eventId: string, secretKey: string) =>
      MarmotAdapter.create({ secretKey, backend: store.backend(eventId), relays: [relay.url] });
    const mkPerson = () =>
      MarmotAdapter.create({
        secretKey: bytesToHex(randomBytes(32)),
        backend: new MemoryBackend(),
        relays: [relay.url],
      });

    const first = new RoomService(store, MASTER, [relay.url], factory, { batchMs: 10 });
    const alice = await mkPerson();
    const r1 = await first.join(
      'evtaaaaaaaaa',
      'Meetup',
      Date.now() + HOUR,
      await alice.publishKeyPackage(),
    );
    await alice.join(r1.welcome);
    await first.close();

    // Stored state is encrypted: no plaintext JSON of MLS state in the database.
    const raw = store.db.prepare('SELECT value_enc FROM kv').all() as { value_enc: string }[];
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.value_enc.startsWith('v1:'))).toBe(true);

    const second = new RoomService(store, MASTER, [relay.url], factory, { batchMs: 10 });
    await second.resume();
    const bob = await mkPerson();
    const r2 = await second.join(
      'evtaaaaaaaaa',
      'Meetup',
      Date.now() + HOUR,
      await bob.publishKeyPackage(),
    );
    expect(r2.roomId).toBe(r1.roomId);
    expect(r2.agentPubkey).toBe(r1.agentPubkey);
    await bob.join(r2.welcome);

    const got: string[] = [];
    await alice.subscribe(r1.roomId, { onMessage: (m) => got.push(m.content) });
    await second.announce('evtaaaaaaaaa', 'doors open');
    const end = Date.now() + 15_000;
    while (!got.includes('doors open') && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    expect(got).toContain('doors open');

    expect(await second.disband('evtaaaaaaaaa')).toBe(true);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM kv').get()).toEqual({ n: 0 });
    await second.close();
    await alice.close();
    await bob.close();
    await relay.close();
  });
});

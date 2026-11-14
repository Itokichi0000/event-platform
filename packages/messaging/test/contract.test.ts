/**
 * The same scenario against both MessagingAdapter implementations:
 * agent creates a room → participants hand over key packages → agent adds them (batched) →
 * participants join → chat → agent posts → agent disbands → everyone sees `disbanded`.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryAdapter,
  InMemoryHub,
  type MessagingAdapter,
  type RoomMessage,
  type RoomStatus,
} from '../src/index.js';
import { MarmotAdapter, MemoryBackend } from '../src/marmot/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/index.js';

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

interface Factory {
  name: string;
  make(): Promise<MessagingAdapter>;
  relays(): string[];
  before?(): Promise<void>;
  after?(): Promise<void>;
}

let relay: TestRelay;
const hub = new InMemoryHub();

const factories: Factory[] = [
  {
    name: 'InMemoryAdapter',
    make: async () => new InMemoryAdapter(hub, getPublicKey(randomBytes(32))),
    relays: () => ['wss://memory'],
  },
  {
    name: 'MarmotAdapter (marmot-ts + local relay)',
    make: () =>
      MarmotAdapter.create({
        secretKey: bytesToHex(randomBytes(32)),
        backend: new MemoryBackend(),
        relays: [relay.url],
      }),
    relays: () => [relay.url],
    before: async () => {
      relay = await startTestRelay();
    },
    after: async () => relay.close(),
  },
];

for (const f of factories) {
  describe(f.name, () => {
    beforeAll(async () => f.before?.());
    afterAll(async () => f.after?.());

    it('room lifecycle: add, join, chat, disband', { timeout: 60_000 }, async () => {
      const agent = await f.make();
      const people = await Promise.all([f.make(), f.make(), f.make()]);
      const { roomId } = await agent.createRoom({ name: 'Event room', relays: f.relays() });

      // Participants create key packages locally; the agent adds two in one commit, then one.
      const kps = await Promise.all(people.map((p) => p.publishKeyPackage()));
      expect(kps.every((k) => k.kind === 30443)).toBe(true);
      const welcomes = [
        ...(await agent.addMember(roomId, kps.slice(0, 2))),
        ...(await agent.addMember(roomId, kps.slice(2))),
      ];
      expect(welcomes.map((w) => w.recipient)).toEqual(people.map((p) => p.pubkey));

      for (const [i, p] of people.entries()) {
        const info = await p.join(welcomes[i]!.event);
        expect(info.roomId).toBe(roomId);
        expect(await p.status(roomId)).toBe('active');
      }

      const inbox = new Map<string, RoomMessage[]>();
      const statuses = new Map<string, RoomStatus>();
      for (const m of [agent, ...people]) {
        inbox.set(m.pubkey, []);
        await m.subscribe(roomId, {
          onMessage: (msg) => inbox.get(m.pubkey)!.push(msg),
          onStatus: (s) => statuses.set(m.pubkey, s),
        });
      }

      await people[0]!.send(roomId, 'hello from A');
      await agent.send(roomId, '[announcement] venue changed');
      const [a, b, c] = people as [MessagingAdapter, MessagingAdapter, MessagingAdapter];
      await until(() => inbox.get(c.pubkey)!.length >= 2 && inbox.get(b.pubkey)!.length >= 2);
      await until(() => inbox.get(agent.pubkey)!.length >= 1 && inbox.get(a.pubkey)!.length >= 1);
      expect(inbox.get(b.pubkey)!.map((m) => [m.sender, m.content])).toEqual([
        [a.pubkey, 'hello from A'],
        [agent.pubkey, '[announcement] venue changed'],
      ]);
      // nobody receives their own message back
      expect(inbox.get(a.pubkey)!.map((m) => m.content)).toEqual(['[announcement] venue changed']);

      await agent.destroy(roomId, { disband: true });
      await until(() => people.every((p) => statuses.get(p.pubkey) === 'disbanded'));
      for (const p of people) expect(await p.status(roomId)).toBe('disbanded');
      expect(await agent.rooms()).not.toContain(roomId);

      for (const p of people) await p.destroy(roomId);
      expect(await a.rooms()).toEqual([]);
      for (const m of [agent, ...people]) await m.close();
    });

    it(
      'only the admin can add members; a welcome only opens for its recipient',
      { timeout: 30_000 },
      async () => {
        const agent = await f.make();
        const p1 = await f.make();
        const p2 = await f.make();
        const { roomId } = await agent.createRoom({ name: 'r', relays: f.relays() });
        const [w1] = await agent.addMember(roomId, [await p1.publishKeyPackage()]);
        await p1.join(w1!.event);
        await expect(p1.addMember(roomId, [await p2.publishKeyPackage()])).rejects.toThrow();
        await expect(p2.join(w1!.event)).rejects.toThrow();
        for (const m of [agent, p1, p2]) await m.close();
      },
    );
  });
}

describe('what relays see (MarmotAdapter)', () => {
  let r: TestRelay;
  beforeAll(async () => {
    r = await startTestRelay();
  });
  afterAll(async () => r.close());

  it(
    'no key packages or relay lists; group messages use one-off keys and only an h tag',
    { timeout: 60_000 },
    async () => {
      const mk = () =>
        MarmotAdapter.create({
          secretKey: bytesToHex(randomBytes(32)),
          backend: new MemoryBackend(),
          relays: [r.url],
        });
      const agent = await mk();
      const p = await mk();
      const { roomId } = await agent.createRoom({ name: 'r', relays: [r.url] });
      const [w] = await agent.addMember(roomId, [await p.publishKeyPackage()]);
      await p.join(w!.event);
      await p.subscribe(roomId, {});
      await agent.subscribe(roomId, {});
      await p.send(roomId, 'secret words');
      await until(() => r.events.filter((e) => e.kind === 445).length >= 2);

      const kinds = new Set(r.events.map((e) => e.kind));
      expect([...kinds].sort((x, y) => x - y)).toEqual([445, 1059]);
      const group = r.events.filter((e) => e.kind === 445);
      expect(new Set(group.map((e) => e.pubkey)).size).toBe(group.length);
      expect(group.some((e) => e.pubkey === p.pubkey || e.pubkey === agent.pubkey)).toBe(false);
      for (const e of group) expect(e.tags.map((t) => t[0])).toEqual(['h']);
      expect(JSON.stringify(r.events)).not.toContain('secret words');
      expect(hexToBytes(roomId).length).toBeGreaterThan(0);
      await agent.close();
      await p.close();
    },
  );
});

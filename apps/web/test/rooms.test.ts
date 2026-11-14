import 'fake-indexeddb/auto';
import {
  finalizeIssue,
  generateKeyset,
  prepareIssue,
  signIssueRequest,
  toIssueRequest,
  toPublicKeyset,
  type Token,
} from '@kamen/core';
import { InMemoryAdapter, InMemoryHub } from '@kamen/messaging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicEvent } from '../src/lib/api';
import { getTicket, resetDb, saveTicket } from '../src/lib/db';
import { forgetRoom, joinRoom, purgeExpiredRooms, type AdapterFactory } from '../src/rooms/client';
import { maskName, maskSpec } from '../src/rooms/mask';
import { resetRoomStore, roomStore } from '../src/rooms/store';

const roomKs = generateKeyset('room');
const hub = new InMemoryHub();
let agent: InMemoryAdapter;
let roomId: string;

/** In-memory messaging: the "agent" adds whoever calls /room/join. */
const factory: AdapterFactory = async ({ secretKey }) => {
  const { getPublicKey } = await import('nostr-tools/pure');
  const sk = Uint8Array.from(secretKey.match(/../g)!.map((h) => parseInt(h, 16)));
  return new InMemoryAdapter(hub, getPublicKey(sk));
};

function pass(): Token {
  const pub = toPublicKeyset(roomKs);
  const p = prepareIssue(pub);
  return {
    kind: 'room',
    eventId: 'evt',
    ...finalizeIssue(p, signIssueRequest(toIssueRequest(p), roomKs), pub),
  };
}

const event = (over: Partial<PublicEvent> = {}): PublicEvent =>
  ({
    id: 'evt',
    title: 'Meetup',
    startsAt: Date.now(),
    endsAt: Date.now() + 3600_000,
    roomAvailable: true,
    roomRelays: ['wss://relay.test'],
    keysets: [],
    ...over,
  }) as PublicEvent;

let joinCalls: unknown[];

beforeEach(async () => {
  await resetDb();
  await resetRoomStore();
  agent = new InMemoryAdapter(hub, 'a'.repeat(64));
  roomId = (await agent.createRoom({ name: 'r', relays: ['wss://relay.test'] })).roomId;
  joinCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/room/join')) {
        const body = JSON.parse(String(init?.body));
        joinCalls.push(body);
        const [w] = await agent.addMember(roomId, [body.keyPackage]);
        return Response.json({
          roomId,
          agentPubkey: agent.pubkey,
          relays: ['wss://relay.test'],
          welcome: w!.event,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function ticketWithPass() {
  const tk = {
    kind: 'ticket',
    eventId: 'evt',
    keysetId: '00aabbccddeeff00',
    secret: [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    C: '02' + '11'.repeat(32),
  } as Token;
  return saveTicket(
    tk,
    {
      title: 'Meetup',
      startsAt: 0,
      endsAt: 1,
      location: null,
      locationVisibility: 'public',
      offlineCheckin: false,
      hostPubkey: 'c'.repeat(64),
    },
    { roomPass: pass() },
  );
}

describe('joinRoom', () => {
  it('uses a fresh per-event key, sends only the pass (no DLEQ) and key package, then forgets the pass', async () => {
    const t = await ticketWithPass();
    const record = await joinRoom(t, event(), factory);
    expect(record.roomId).toBe(roomId);
    expect(record.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(record.agentPubkey).toBe(agent.pubkey);
    const sent = joinCalls[0] as { pass: Record<string, unknown>; keyPackage: { pubkey: string } };
    expect(Object.keys(sent.pass).sort()).toEqual(['C', 'keysetId', 'secret']);
    expect(sent.keyPackage.pubkey).toBe(record.pubkey);
    expect((await getTicket(t.id))?.roomPass).toBeUndefined();
    expect(await roomStore.get('evt')).toMatchObject({ roomId });

    // A second participant gets a different key.
    await roomStore.purge('evt');
    const t2 = await ticketWithPass();
    const r2 = await joinRoom(t2, event(), factory);
    expect(r2.pubkey).not.toBe(record.pubkey);
  });

  it('keeps the pass when joining fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'room_unavailable' }, { status: 503 })),
    );
    const t = await ticketWithPass();
    await expect(joinRoom(t, event(), factory)).rejects.toThrow();
    expect((await getTicket(t.id))?.roomPass).toBeDefined();
    expect(await roomStore.get('evt')).toBeUndefined();
  });

  it('refuses without a pass or when the room is unavailable', async () => {
    const t = await ticketWithPass();
    await expect(joinRoom(t, event({ roomAvailable: false }), factory)).rejects.toThrow(
      'unavailable',
    );
    const { roomPass: _p, ...noPass } = t;
    await expect(joinRoom(noPass, event(), factory)).rejects.toThrow('no_pass');
  });
});

describe('local cleanup', () => {
  it('forgetRoom deletes the key, MLS state and messages', async () => {
    const t = await ticketWithPass();
    const record = await joinRoom(t, event(), factory);
    await roomStore.addMessage({
      id: 'm1',
      sender: 'x',
      content: 'hi',
      createdAt: 1,
      eventId: 'evt',
    });
    await roomStore.backend('evt').set('groupState', 'k', new Uint8Array([1, 2]));
    expect(await roomStore.backend('evt').get('groupState', 'k')).toEqual(new Uint8Array([1, 2]));
    await forgetRoom(record, factory);
    expect(await roomStore.get('evt')).toBeUndefined();
    expect(await roomStore.messages('evt')).toEqual([]);
    expect(await roomStore.backend('evt').keys('groupState')).toEqual([]);
  });

  it('purges rooms 24 h after the event ended', async () => {
    const t = await ticketWithPass();
    await joinRoom(t, event({ endsAt: Date.now() - 25 * 3600_000 }), factory);
    await purgeExpiredRooms(Date.now(), factory);
    expect(await roomStore.all()).toEqual([]);
  });
});

describe('masks', () => {
  it('are deterministic per key and differ between keys', () => {
    const a = 'ab'.repeat(32);
    const b = 'cd'.repeat(32);
    expect(maskName(a, 'ja')).toBe(maskName(a, 'ja'));
    expect(maskName(a, 'en')).not.toBe(maskName(b, 'en'));
    expect(maskSpec(a)).toEqual(maskSpec(a));
    expect(maskName(a, 'en')).toMatch(/^[A-Z][a-z]+ [A-Za-z ]+ #\d{1,3}$/);
  });
});

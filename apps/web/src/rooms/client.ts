/**
 * Participant side of rooms (docs/SPEC.md §5):
 * new per-event key → key package (kept off relays) → POST /room/join with the room pass →
 * join from the Welcome → chat. Rooms are cleaned up locally when disbanded or 24 h after the end.
 */
import { bytesToHex, toRedeemPayload } from '@kamen/core';
import type { MessagingAdapter } from '@kamen/messaging';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { api, type PublicEvent } from '@/lib/api';
import { clearRoomPass, type StoredTicket } from '@/lib/db';
import { roomStore, type RoomRecord } from './store';

export const ROOM_LOCAL_TTL_AFTER_END_MS = 24 * 60 * 60 * 1000;

export type AdapterFactory = (
  record: Pick<RoomRecord, 'eventId' | 'secretKey' | 'relays'>,
) => Promise<MessagingAdapter>;

/** Default: the Marmot implementation, loaded only when a room is actually used. */
export const marmotFactory: AdapterFactory = async ({ eventId, secretKey, relays }) => {
  const { MarmotAdapter } = await import('@kamen/messaging/marmot');
  return MarmotAdapter.create({ secretKey, backend: roomStore.backend(eventId), relays });
};

const adapters = new Map<string, Promise<MessagingAdapter>>();

export function adapterFor(record: RoomRecord, factory: AdapterFactory = marmotFactory) {
  let a = adapters.get(record.eventId);
  if (!a) {
    a = factory(record);
    adapters.set(record.eventId, a);
  }
  return a;
}

async function dropAdapter(eventId: string) {
  const a = adapters.get(eventId);
  adapters.delete(eventId);
  if (a) await (await a).close().catch(() => {});
}

export async function joinRoom(
  ticket: StoredTicket,
  event: PublicEvent,
  factory: AdapterFactory = marmotFactory,
): Promise<RoomRecord> {
  const existing = await roomStore.get(event.id);
  if (existing) return existing;
  if (!ticket.roomPass) throw new Error('no_pass');
  if (!event.roomAvailable || event.roomRelays.length === 0) throw new Error('unavailable');

  // A fresh key for this event only: never the participant's usual npub.
  const sk = generateSecretKey();
  const secretKey = bytesToHex(sk);
  const pubkey = getPublicKey(sk);
  const draft = { eventId: event.id, secretKey, relays: event.roomRelays };
  const adapter = await adapterFor({ ...draft } as RoomRecord, factory);
  try {
    // The key package goes to the room agent over HTTPS, not to relays.
    const keyPackage = await adapter.publishKeyPackage();
    const res = await api.roomJoin(event.id, toRedeemPayload(ticket.roomPass), keyPackage);
    await clearRoomPass(ticket.id); // the pass is spent now
    await adapter.join(res.welcome);
    const record: RoomRecord = {
      ...draft,
      roomId: res.roomId,
      pubkey,
      agentPubkey: res.agentPubkey,
      relays: res.relays,
      eventTitle: event.title,
      eventEndsAt: event.endsAt,
      joinedAt: Date.now(),
    };
    await roomStore.save(record);
    return record;
  } catch (e) {
    await dropAdapter(event.id);
    await roomStore.purge(event.id);
    throw e;
  }
}

/** Delete the room from this device (MLS state, key, history). */
export async function forgetRoom(record: RoomRecord, factory: AdapterFactory = marmotFactory) {
  try {
    const a = await adapterFor(record, factory);
    await a.destroy(record.roomId).catch(() => {});
  } finally {
    await dropAdapter(record.eventId);
    await roomStore.purge(record.eventId);
  }
}

/** Leave the room (others see us go) and forget it locally. */
export async function leaveRoom(record: RoomRecord, factory: AdapterFactory = marmotFactory) {
  try {
    await (await adapterFor(record, factory)).leave(record.roomId);
  } catch {
    /* forgetting locally is what matters for this device */
  }
  await forgetRoom(record, factory);
}

/** Remove rooms whose event ended more than 24 h ago (even if the disband was never seen). */
export async function purgeExpiredRooms(now = Date.now(), factory: AdapterFactory = marmotFactory) {
  for (const r of await roomStore.all()) {
    if (r.eventEndsAt + ROOM_LOCAL_TTL_AFTER_END_MS <= now) await forgetRoom(r, factory);
  }
}

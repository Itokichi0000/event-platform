/**
 * Mutual reveal (両想い開示, docs/SPEC.md §5). A "willing to share" is NIP-44-encrypted from the
 * sender's per-event key to the recipient's per-event key and posted as an MLS message of kind
 * 7350 without any recipient tag: every member tries to decrypt, only the recipient succeeds.
 * Received likes are never displayed. Only when both sides liked each other does each client
 * send the npub its user chose. Limitation: a modified client can see a one-sided like.
 */
import type { MessagingAdapter, RoomMessage } from '@kamen/messaging';
import { hexToBytes } from '@kamen/core';
import { decode as nip19decode } from 'nostr-tools/nip19';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { roomStore, type RevealState, type RoomRecord } from './store';

export const REVEAL_KIND = 7350;

type RevealMsg = { t: 'like' } | { t: 'reveal'; npub: string };

export function isNpub(value: string): boolean {
  try {
    return nip19decode(value.trim()).type === 'npub';
  } catch {
    return false;
  }
}

export function sealReveal(secretKey: string, peer: string, msg: RevealMsg): string {
  return encrypt(JSON.stringify(msg), getConversationKey(hexToBytes(secretKey), peer));
}

export function openReveal(secretKey: string, sender: string, content: string): RevealMsg | null {
  try {
    const msg = JSON.parse(
      decrypt(content, getConversationKey(hexToBytes(secretKey), sender)),
    ) as RevealMsg;
    if (msg.t === 'like') return msg;
    if (msg.t === 'reveal' && typeof msg.npub === 'string' && isNpub(msg.npub)) return msg;
    return null;
  } catch {
    return null; // not addressed to us
  }
}

const blank = (eventId: string, peer: string): RevealState => ({
  eventId,
  peer,
  iLiked: false,
  theyLiked: false,
  revealSent: false,
});

async function sendReveal(adapter: MessagingAdapter, record: RoomRecord, st: RevealState) {
  if (!st.myNpub || st.revealSent) return st;
  await adapter.send(
    record.roomId,
    sealReveal(record.secretKey, st.peer, { t: 'reveal', npub: st.myNpub }),
    REVEAL_KIND,
  );
  return { ...st, revealSent: true };
}

/** The local user is willing to share `myNpub` with `peer`. */
export async function like(
  adapter: MessagingAdapter,
  record: RoomRecord,
  peer: string,
  myNpub: string,
) {
  let st = (await roomStore.reveal(record.eventId, peer)) ?? blank(record.eventId, peer);
  st = { ...st, iLiked: true, myNpub: myNpub.trim() };
  await adapter.send(record.roomId, sealReveal(record.secretKey, peer, { t: 'like' }), REVEAL_KIND);
  if (st.theyLiked) st = await sendReveal(adapter, record, st);
  await roomStore.saveReveal(st);
  return st;
}

/** Process an incoming kind-7350 message. Returns the updated state if it was for us. */
export async function handleReveal(adapter: MessagingAdapter, record: RoomRecord, m: RoomMessage) {
  if (m.kind !== REVEAL_KIND || m.sender === record.pubkey) return null;
  const msg = openReveal(record.secretKey, m.sender, m.content);
  if (!msg) return null;
  let st = (await roomStore.reveal(record.eventId, m.sender)) ?? blank(record.eventId, m.sender);
  if (msg.t === 'like') {
    st = { ...st, theyLiked: true };
    if (st.iLiked) st = await sendReveal(adapter, record, st);
  } else if (st.iLiked) {
    // A reveal is only meaningful once we liked them (a well-behaved client never sends earlier).
    st = { ...st, theirNpub: msg.npub };
  }
  await roomStore.saveReveal(st);
  return st;
}

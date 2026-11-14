import {
  decodeToken,
  encodeQrToken,
  encodeToken,
  finalizeIssue,
  prepareIssue,
  toIssueRequest,
  toRedeemPayload,
  verifyProofOffline,
  type PowChallenge,
  type Token,
} from '@kamen/core';
import { api, ApiError, type PublicEvent, type QuoteState } from './api';
import {
  deletePendingQuote,
  deleteTicket,
  saveTicket,
  savePendingQuote,
  updateTicket,
  type EventSnapshot,
  type PendingQuote,
  type StoredTicket,
} from './db';
import { solvePowInWorkers } from './pow';

export type AcquireStage = 'challenge' | 'invoice' | 'pay' | 'work' | 'issue' | 'save';

export function snapshotOf(event: PublicEvent, location: string | null): EventSnapshot {
  return {
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location ?? location,
    locationVisibility: event.locationVisibility,
    offlineCheckin: event.offlineCheckin,
    hostPubkey: event.hostPubkey,
    issuePolicy: event.issuePolicy,
    status: event.status,
  };
}

function ticketKeyset(event: PublicEvent) {
  const keyset = event.keysets.find((k) => k.kind === 'ticket');
  if (!keyset) throw new Error('no ticket keyset');
  return keyset;
}

/**
 * Blind → issue → verify DLEQ → unblind → IndexedDB (docs/SPEC.md §4). Only the blinded
 * message B_ and the issue condition (PoW / invite code / paid quote id) reach the server.
 */
async function issueAndSave(
  event: PublicEvent,
  condition: {
    pow?: { challenge: PowChallenge; nonce: number };
    invite?: string;
    quoteId?: string;
  },
  onStage: (stage: AcquireStage, progress?: number) => void,
): Promise<StoredTicket> {
  const keyset = ticketKeyset(event);
  const pending = prepareIssue(keyset);
  // The room pass rides along in the same request, blinded under the room keyset.
  const roomKeyset = event.roomAvailable ? event.keysets.find((k) => k.kind === 'room') : undefined;
  const roomPending = roomKeyset ? prepareIssue(roomKeyset) : undefined;
  onStage('issue');
  const res = await api.issue(event.id, {
    ...condition,
    outputs: {
      ticket: toIssueRequest(pending),
      ...(roomPending ? { room: toIssueRequest(roomPending) } : {}),
    },
  });
  // Throws if the signature was not made with the advertised public key.
  const proof = finalizeIssue(pending, res.signatures.ticket, keyset);
  let roomPass: Token | undefined;
  if (roomKeyset && roomPending && res.signatures.room) {
    try {
      roomPass = {
        kind: 'room',
        eventId: event.id,
        ...finalizeIssue(roomPending, res.signatures.room, roomKeyset),
      };
    } catch {
      // A bad room signature must not cost the participant their ticket.
      roomPass = undefined;
    }
  }
  onStage('save');
  return saveTicket(
    { kind: 'ticket', eventId: event.id, ...proof },
    snapshotOf(event, res.location),
    roomPass ? { roomPass } : {},
  );
}

/** Free and invite-only events: solve the PoW (in Web Workers) and get a ticket. */
export async function acquireTicket(
  event: PublicEvent,
  onStage: (stage: AcquireStage, progress?: number) => void,
  opts: { invite?: string; signal?: AbortSignal } = {},
): Promise<StoredTicket> {
  onStage('challenge');
  const quote = await api.quote(event.id);
  if (quote.kind !== 'pow') throw new Error('unexpected quote kind');
  onStage('work', 0);
  const nonce = await solvePowInWorkers(quote.challenge, (p) => onStage('work', p), opts.signal);
  return issueAndSave(
    event,
    { pow: { challenge: quote.challenge, nonce }, ...(opts.invite ? { invite: opts.invite } : {}) },
    onStage,
  );
}

/** Paid events, step 1: get an invoice and remember the quote on this device. */
export async function startPurchase(event: PublicEvent): Promise<PendingQuote> {
  const quote = await api.quote(event.id);
  if (quote.kind !== 'invoice') throw new Error('unexpected quote kind');
  const pending: PendingQuote = {
    quoteId: quote.quoteId,
    eventId: event.id,
    invoice: quote.invoice,
    amountMsat: quote.amountMsat,
    expiresAt: quote.expiresAt,
    createdAt: Date.now(),
  };
  await savePendingQuote(pending);
  return pending;
}

export async function quoteState(pending: PendingQuote): Promise<QuoteState> {
  return (await api.quoteStatus(pending.eventId, pending.quoteId)).state;
}

/** Paid events, step 2: once paid, exchange the quote for a ticket. */
export async function claimPaidTicket(
  event: PublicEvent,
  pending: PendingQuote,
  onStage: (stage: AcquireStage) => void,
): Promise<StoredTicket> {
  const ticket = await issueAndSave(event, { quoteId: pending.quoteId }, onStage);
  await deletePendingQuote(pending.quoteId);
  return ticket;
}

/** Forget a quote that can no longer produce a ticket (expired, or already issued elsewhere). */
export async function dropQuote(pending: PendingQuote): Promise<void> {
  await deletePendingQuote(pending.quoteId);
}

/** Text shown in the door QR code (DLEQ only for offline check-in, see docs/PRIVACY.md). */
export function qrTextFor(ticket: StoredTicket): string {
  return encodeQrToken(ticket.token, { offlineCheckin: ticket.event.offlineCheckin });
}

/** Backup string: the full token including the DLEQ. Never leaves the device unless copied. */
export function backupTextFor(ticket: StoredTicket): string {
  return encodeToken(ticket.token);
}

/**
 * Re-read the public event so the ticket shows current details (cancellation, venue, offline
 * check-in). A hidden location learnt at issue time is kept. Returns null when offline.
 */
export async function refreshTicket(
  ticket: StoredTicket,
): Promise<{ ticket: StoredTicket; event: PublicEvent } | null> {
  let event: PublicEvent;
  try {
    event = await api.event(ticket.token.eventId);
  } catch {
    return null;
  }
  const snapshot = snapshotOf(event, ticket.event.location);
  const updated = { ...ticket, event: snapshot };
  if (JSON.stringify(snapshot) !== JSON.stringify(ticket.event)) {
    await updateTicket(ticket.id, { event: snapshot });
  }
  return { ticket: updated, event };
}

/** Give the ticket back (frees a seat) and remove it from this device. */
export async function returnTicket(ticket: StoredTicket): Promise<void> {
  try {
    await api.returnTicket(ticket.token.eventId, toRedeemPayload(ticket.token));
  } catch (e) {
    // Already spent or returned: it is useless either way, so remove it locally too.
    if (!(e instanceof ApiError && e.code === 'already_redeemed')) throw e;
  }
  await deleteTicket(ticket.id);
}

export class RestoreError extends Error {
  constructor(readonly reason: 'format' | 'kind' | 'signature' | 'event') {
    super(reason);
    this.name = 'RestoreError';
  }
}

/**
 * Restore from a backup string. Fetches the public event to rebuild the snapshot and, when the
 * backup carries a DLEQ, checks the signature against the event's public key.
 */
export async function restoreTicket(text: string): Promise<StoredTicket> {
  let token: Token;
  try {
    token = decodeToken(text);
  } catch {
    throw new RestoreError('format');
  }
  if (token.kind !== 'ticket') throw new RestoreError('kind');
  let event: PublicEvent;
  try {
    event = await api.event(token.eventId);
  } catch {
    throw new RestoreError('event');
  }
  const keyset = event.keysets.find((k) => k.id === token.keysetId);
  if (!keyset || (token.dleq && !verifyProofOffline(token, keyset))) {
    throw new RestoreError('signature');
  }
  return saveTicket(token, snapshotOf(event, null), { backedUp: true });
}

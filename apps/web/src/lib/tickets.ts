import {
  decodeToken,
  encodeQrToken,
  encodeToken,
  finalizeIssue,
  prepareIssue,
  toIssueRequest,
  toRedeemPayload,
  verifyProofOffline,
  type PendingIssue,
  type PowChallenge,
  type Token,
} from '@kamen/core';
import { nip98Header } from './nostr';
import { api, ApiError, request, type PublicEvent, type QuoteState } from './api';
import {
  applicationStore,
  depositStore,
  putTicket,
  stampStore,
  type PendingDeposit,
  type StoredApplication,
  type StoredStamp,
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

export interface IssueCondition {
  pow?: { challenge: PowChallenge; nonce: number };
  invite?: string;
  quoteId?: string;
  approval?: { id: string; token: string };
  depositId?: string;
}

/** Fresh blinded stamp + vote credential for the door QR (signed at check-in). */
export function prepareCheckin(event: PublicEvent): NonNullable<StoredTicket['checkin']> {
  const vote = event.keysets.find((k) => k.kind === 'vote');
  return {
    stamp: { ...prepareIssue(event.stampKeyset), keyset: event.stampKeyset },
    ...(vote ? { vote: { ...prepareIssue(vote), keyset: vote } } : {}),
  };
}

/**
 * Blind → issue → verify DLEQ → unblind → IndexedDB (docs/SPEC.md §4). Only blinded messages and
 * the issue condition (PoW / invite code / paid quote / approval / deposit / stamps) reach the
 * server.
 */
async function issueAndSave(
  event: PublicEvent,
  condition: IssueCondition,
  onStage: (stage: AcquireStage, progress?: number) => void,
): Promise<StoredTicket> {
  const keyset = ticketKeyset(event);
  const pending = prepareIssue(keyset);
  // The room pass rides along in the same request, blinded under the room keyset.
  const roomKeyset = event.roomAvailable ? event.keysets.find((k) => k.kind === 'room') : undefined;
  const roomPending = roomKeyset ? prepareIssue(roomKeyset) : undefined;
  // Regulars-first: present stamps of this host; they are swapped for fresh ones.
  let stampSwap: { used: StoredStamp[]; outputs: PendingIssue[] } | undefined;
  if (event.minStamps > 0) {
    const mine = (await stampStore.forHost(event.hostPubkey)).filter(
      (s) => s.keysetId === event.stampKeyset.id,
    );
    if (mine.length < event.minStamps) throw new ApiError(403, 'stamps_required');
    const used = mine.slice(0, event.minStamps);
    stampSwap = { used, outputs: used.map(() => prepareIssue(event.stampKeyset)) };
  }
  onStage('issue');
  const res = await api.issue(event.id, {
    ...condition,
    ...(stampSwap
      ? {
          stamps: {
            proofs: stampSwap.used.map((s) => toRedeemPayload(s)),
            outputs: stampSwap.outputs.map(toIssueRequest),
          },
        }
      : {}),
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
  const sigs = res.stampSignatures;
  if (stampSwap && sigs) {
    const { used, outputs } = stampSwap;
    const fresh = outputs.flatMap((p, i) => {
      const sig = sigs[i];
      if (!sig) return [];
      return [
        {
          ...finalizeIssue(p, sig, event.stampKeyset),
          hostPubkey: event.hostPubkey,
          eventTitle: used[i]?.eventTitle ?? null,
          receivedAt: used[i]?.receivedAt ?? Date.now(),
        },
      ];
    });
    await stampStore.replace(
      used.map((s) => s.secret),
      fresh,
    );
  }
  onStage('save');
  const saved = await saveTicket(
    { kind: 'ticket', eventId: event.id, ...proof },
    snapshotOf(event, res.location),
    roomPass ? { roomPass } : {},
  );
  const full: StoredTicket = {
    ...saved,
    checkin: prepareCheckin(event),
    ...(condition.depositId ? { depositId: condition.depositId } : {}),
  };
  await putTicket(full);
  return full;
}

/** Free / invite-only / deposit events: solve the PoW (in Web Workers) and get a ticket. */
export async function acquireTicket(
  event: PublicEvent,
  onStage: (stage: AcquireStage, progress?: number) => void,
  opts: { invite?: string; depositId?: string; signal?: AbortSignal } = {},
): Promise<StoredTicket> {
  onStage('challenge');
  const quote = await api.quote(event.id);
  if (quote.kind !== 'pow') throw new Error('unexpected quote kind');
  onStage('work', 0);
  const nonce = await solvePowInWorkers(quote.challenge, (p) => onStage('work', p), opts.signal);
  const ticket = await issueAndSave(
    event,
    {
      pow: { challenge: quote.challenge, nonce },
      ...(opts.invite ? { invite: opts.invite } : {}),
      ...(opts.depositId ? { depositId: opts.depositId } : {}),
    },
    onStage,
  );
  if (opts.depositId) await depositStore.delete(event.id);
  return ticket;
}

/** Approval-based events: claim the ticket once the host approved the application. */
export async function claimApprovedTicket(
  event: PublicEvent,
  application: StoredApplication,
  onStage: (stage: AcquireStage) => void,
  depositId?: string,
): Promise<StoredTicket> {
  const ticket = await issueAndSave(
    event,
    {
      approval: { id: application.id, token: application.token },
      ...(depositId ? { depositId } : {}),
    },
    onStage,
  );
  await applicationStore.delete(event.id);
  if (depositId) await depositStore.delete(event.id);
  return ticket;
}

/**
 * Apply to an approval-based event. The browser's Nostr extension signs the request, so the
 * host learns this npub (docs/SPEC.md §2, shown to the user before applying).
 */
export async function applyToEvent(event: PublicEvent): Promise<StoredApplication> {
  if (!window.nostr) throw new Error('no_nip07');
  const url = new URL(`/api/events/${event.id}/applications`, location.origin).toString();
  const authorization = await nip98Header(window.nostr, url, 'POST');
  const res = await request<{ id: string; token: string }>(`/api/events/${event.id}/applications`, {
    method: 'POST',
    headers: { authorization },
  });
  const app = { eventId: event.id, id: res.id, token: res.token, createdAt: Date.now() };
  await applicationStore.put(app);
  return app;
}

/** Deposit events, step 1: create the hold invoice and remember it on this device. */
export async function startDeposit(event: PublicEvent): Promise<PendingDeposit> {
  const res = await api.createDeposit(event.id);
  const pending: PendingDeposit = {
    eventId: event.id,
    depositId: res.depositId,
    invoice: res.invoice,
    amountMsat: res.amountMsat,
    expiresAt: res.expiresAt,
    createdAt: Date.now(),
  };
  await depositStore.put(pending);
  return pending;
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

/**
 * Text shown in the door QR code: the ticket (DLEQ only for offline check-in, docs/PRIVACY.md),
 * plus the blinded stamp / vote credential to be signed at check-in and the deposit reference.
 */
export function qrTextFor(ticket: StoredTicket): string {
  return encodeQrToken(
    ticket.token,
    { offlineCheckin: ticket.event.offlineCheckin },
    {
      ...(ticket.checkin?.stamp ? { stampB_: ticket.checkin.stamp.B_ } : {}),
      ...(ticket.checkin?.vote ? { voteB_: ticket.checkin.vote.B_ } : {}),
      ...(ticket.depositId ? { depositRef: ticket.depositId } : {}),
    },
  );
}

/** Tickets saved before phase 4 get check-in extras once the event's keys are known. */
export async function ensureCheckin(
  ticket: StoredTicket,
  event: PublicEvent,
): Promise<StoredTicket> {
  if (ticket.checkin || ticket.voteCredential) return ticket;
  const updated = { ...ticket, checkin: prepareCheckin(event) };
  await putTicket(updated);
  return updated;
}

/**
 * After check-in, pick up the signatures made by the scanner (one time each): the stamp goes
 * into the 御朱印帳, the vote credential into the ticket. Returns what was received now.
 */
export async function pickupCheckin(
  ticket: StoredTicket,
): Promise<{ ticket: StoredTicket; stamp: boolean }> {
  let t = ticket;
  let gotStamp = false;
  for (const kind of ['stamp', 'vote'] as const) {
    const p = t.checkin?.[kind];
    if (!p) continue;
    let sig;
    try {
      sig = await api.pickupSignature(p.B_);
    } catch {
      continue; // not checked in yet (404) or offline
    }
    try {
      const proof = finalizeIssue(p, sig, p.keyset);
      const { [kind]: _done, ...rest } = t.checkin ?? {};
      t = { ...t, checkin: rest };
      if (kind === 'stamp') {
        await stampStore.add({
          ...proof,
          hostPubkey: t.event.hostPubkey,
          eventTitle: t.event.title,
          receivedAt: Date.now(),
        });
        gotStamp = true;
      } else {
        t = { ...t, voteCredential: proof };
      }
      await putTicket(t);
    } catch {
      /* invalid signature: ignore */
    }
  }
  return { ticket: t, stamp: gotStamp };
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
    await api.returnTicket(ticket.token.eventId, {
      ...toRedeemPayload(ticket.token),
      ...(ticket.depositId ? { depositRef: ticket.depositId } : {}),
    });
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

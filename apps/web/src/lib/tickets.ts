import {
  decodeToken,
  encodeQrToken,
  encodeToken,
  finalizeIssue,
  prepareIssue,
  toIssueRequest,
  verifyProofOffline,
  type Token,
} from '@kamen/core';
import { api, type PublicEvent } from './api';
import { saveTicket, type EventSnapshot, type StoredTicket } from './db';
import { solvePowInWorkers } from './pow';

export type AcquireStage = 'challenge' | 'work' | 'issue' | 'save';

export function snapshotOf(event: PublicEvent, location: string | null): EventSnapshot {
  return {
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location ?? location,
    locationVisibility: event.locationVisibility,
    offlineCheckin: event.offlineCheckin,
    hostPubkey: event.hostPubkey,
  };
}

/**
 * Participant flow (docs/SPEC.md §4): blind → PoW → issue → verify DLEQ → unblind → IndexedDB.
 * Only the blinded message B_ and the PoW solution are sent to the server.
 */
export async function acquireTicket(
  event: PublicEvent,
  onStage: (stage: AcquireStage, progress?: number) => void,
  signal?: AbortSignal,
): Promise<StoredTicket> {
  const keyset = event.keysets.find((k) => k.kind === 'ticket');
  if (!keyset) throw new Error('no ticket keyset');
  const pending = prepareIssue(keyset);

  onStage('challenge');
  const { challenge } = await api.quote(event.id);

  onStage('work', 0);
  const nonce = await solvePowInWorkers(challenge, (p) => onStage('work', p), signal);

  onStage('issue');
  const res = await api.issue(event.id, {
    pow: { challenge, nonce },
    outputs: { ticket: toIssueRequest(pending) },
  });
  // Throws if the signature was not made with the advertised public key.
  const proof = finalizeIssue(pending, res.signatures.ticket, keyset);

  onStage('save');
  return saveTicket(
    { kind: 'ticket', eventId: event.id, ...proof },
    snapshotOf(event, res.location),
  );
}

/** Text shown in the door QR code (DLEQ only for offline check-in, see docs/PRIVACY.md). */
export function qrTextFor(ticket: StoredTicket): string {
  return encodeQrToken(ticket.token, { offlineCheckin: ticket.event.offlineCheckin });
}

/** Backup string: the full token including the DLEQ. Never leaves the device unless copied. */
export function backupTextFor(ticket: StoredTicket): string {
  return encodeToken(ticket.token);
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

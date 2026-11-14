/**
 * Check-in decisions, online and offline, independent of the UI so they can be unit-tested.
 */
import {
  decodeToken,
  spentKey,
  toRedeemPayload,
  verifyProofOffline,
  type PublicKeyset,
  type Token,
} from '@kamen/core';
import { api, ApiError, NetworkError } from './api';
import { scannerStore } from './scanner-store';

export type Verdict =
  | { kind: 'ok'; offline: boolean; counts?: { redeemed: number; issued: number } }
  | {
      kind: 'bad';
      reason:
        'unreadable' | 'otherEvent' | 'invalid' | 'used' | 'usedHere' | 'cancelled' | 'noDleq';
    }
  | { kind: 'warn'; reason: 'network' | 'offlineUnsupported' };

export interface CheckinContext {
  eventId: string;
  token: string;
  keyset: PublicKeyset | null;
  offlineCheckin: boolean;
  /** Whether the device believes it is offline (navigator.onLine === false). */
  offline: boolean;
}

export async function checkIn(ctx: CheckinContext, text: string): Promise<Verdict> {
  let ticket: Token;
  try {
    ticket = decodeToken(text);
  } catch {
    return { kind: 'bad', reason: 'unreadable' };
  }
  if (ticket.kind !== 'ticket') return { kind: 'bad', reason: 'unreadable' };
  if (ticket.eventId !== ctx.eventId) return { kind: 'bad', reason: 'otherEvent' };
  // Offline check-in events put the DLEQ in the QR; verify it locally before anything else.
  const verified = !!ticket.dleq && !!ctx.keyset && verifyProofOffline(ticket, ctx.keyset);
  if (ticket.dleq && !verified) return { kind: 'bad', reason: 'invalid' };

  const y = spentKey(ticket.secret);
  if (ctx.offlineCheckin && (await scannerStore.isSpent(ctx.eventId, y))) {
    return { kind: 'bad', reason: 'usedHere' };
  }

  const offlineAccept = async (): Promise<Verdict> => {
    if (!ctx.offlineCheckin) return { kind: 'warn', reason: 'offlineUnsupported' };
    if (!verified) return { kind: 'bad', reason: 'noDleq' };
    await scannerStore.queueCheckin({
      eventId: ctx.eventId,
      y,
      payload: toRedeemPayload(ticket),
      scannedAt: Date.now(),
    });
    return { kind: 'ok', offline: true };
  };

  if (ctx.offline) return offlineAccept();

  try {
    // The DLEQ (with its blinding factor) is stripped: the server must never see it.
    const res = await api.redeem(ctx.eventId, ctx.token, toRedeemPayload(ticket));
    if (ctx.offlineCheckin) await scannerStore.addSpent(ctx.eventId, [y]);
    return { kind: 'ok', offline: false, counts: { redeemed: res.redeemed, issued: res.issued } };
  } catch (e) {
    if (e instanceof NetworkError) {
      return ctx.offlineCheckin ? offlineAccept() : { kind: 'warn', reason: 'network' };
    }
    const code = e instanceof ApiError ? e.code : '';
    if (code === 'already_redeemed') {
      if (ctx.offlineCheckin) await scannerStore.addSpent(ctx.eventId, [y]);
      return { kind: 'bad', reason: 'used' };
    }
    if (code === 'event_cancelled') return { kind: 'bad', reason: 'cancelled' };
    return { kind: 'bad', reason: 'invalid' };
  }
}

export interface SyncResult {
  sent: number;
  conflicts: number;
  remaining: number;
  counts?: { redeemed: number; issued: number };
}

/**
 * Send queued offline check-ins. A ticket the server already had as spent was used on another
 * device (or returned): it is recorded as a conflict. Then refresh the local spent list.
 */
export async function syncCheckins(eventId: string, token: string): Promise<SyncResult> {
  const queue = await scannerStore.queued(eventId);
  let sent = 0;
  let conflicts = 0;
  let counts: SyncResult['counts'];
  for (const item of queue) {
    try {
      const res = await api.redeem(eventId, token, item.payload);
      counts = { redeemed: res.redeemed, issued: res.issued };
      sent++;
    } catch (e) {
      if (e instanceof NetworkError) break;
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'invalid_scanner_token' || code === 'missing_scanner_token') break;
      await scannerStore.addConflict({
        eventId,
        y: item.y,
        reason: code === 'already_redeemed' ? 'already_redeemed' : 'invalid',
        scannedAt: item.scannedAt,
      });
      conflicts++;
    }
    if (item.id !== undefined) await scannerStore.dequeue(item.id);
  }
  try {
    const { ys } = await api.spentList(eventId, token);
    await scannerStore.addSpent(eventId, ys);
  } catch {
    /* offline or not an offline check-in event */
  }
  const remaining = (await scannerStore.queued(eventId)).length;
  return { sent, conflicts, remaining, ...(counts ? { counts } : {}) };
}

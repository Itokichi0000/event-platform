/**
 * Data retention (docs/SPEC.md §7, docs/PRIVACY.md). Runs periodically:
 *
 * - 48 h after an event ends: delete the ticket / room private keys (the public key stays),
 *   the spent list of those keysets, all quotes, and the NWC connection string. Only the
 *   aggregates (issued / redeemed / returned, check-in buckets) remain.
 * - When an event ends: delete its invite codes.
 * - Expired check-in links are deleted.
 * - Unpaid quotes are deleted an hour after their invoice expired.
 */
import type { AppContext } from '../context.js';

export const RETENTION_AFTER_END_MS = 48 * 60 * 60 * 1000;
const UNPAID_QUOTE_GRACE_MS = 60 * 60 * 1000;

export interface CleanupResult {
  retiredKeysets: number;
  deletedQuotes: number;
  deletedSpent: number;
  deletedInviteCodes: number;
  deletedScannerLinks: number;
  clearedWallets: number;
}

export function runCleanup(ctx: AppContext): CleanupResult {
  const now = ctx.now();
  const cutoff = now - RETENTION_AFTER_END_MS;
  const sqlite = ctx.db.$client;
  const retiredEvents = (
    sqlite
      .prepare('SELECT id FROM events WHERE ends_at <= ? AND nwc_enc IS NOT NULL')
      .all(cutoff) as {
      id: string;
    }[]
  ).map((r) => r.id);

  const result = sqlite.transaction((): CleanupResult => {
    const deletedSpent = sqlite
      .prepare(
        `DELETE FROM spent WHERE keyset_id IN (
           SELECT k.id FROM keysets k JOIN events e ON e.id = k.event_id
           WHERE k.kind IN ('ticket', 'room') AND e.ends_at <= ?)`,
      )
      .run(cutoff).changes;
    const retiredKeysets = sqlite
      .prepare(
        `UPDATE keysets SET private_key_enc = NULL
         WHERE kind IN ('ticket', 'room') AND private_key_enc IS NOT NULL
           AND event_id IN (SELECT id FROM events WHERE ends_at <= ?)`,
      )
      .run(cutoff).changes;
    const endedQuotes = sqlite
      .prepare('DELETE FROM quotes WHERE event_id IN (SELECT id FROM events WHERE ends_at <= ?)')
      .run(cutoff).changes;
    const staleQuotes = sqlite
      .prepare(`DELETE FROM quotes WHERE state IN ('unpaid', 'expired') AND expires_at <= ?`)
      .run(now - UNPAID_QUOTE_GRACE_MS).changes;
    const clearedWallets = sqlite
      .prepare('UPDATE events SET nwc_enc = NULL WHERE nwc_enc IS NOT NULL AND ends_at <= ?')
      .run(cutoff).changes;
    const deletedInviteCodes = sqlite
      .prepare(
        'DELETE FROM invite_codes WHERE event_id IN (SELECT id FROM events WHERE ends_at <= ?)',
      )
      .run(now).changes;
    const deletedScannerLinks = sqlite
      .prepare('DELETE FROM scanner_links WHERE expires_at <= ?')
      .run(now).changes;
    return {
      retiredKeysets,
      deletedQuotes: endedQuotes + staleQuotes,
      deletedSpent,
      deletedInviteCodes,
      deletedScannerLinks,
      clearedWallets,
    };
  })();

  for (const id of retiredEvents) ctx.payments.forget(id);
  ctx.payments.sweep();
  return result;
}

/**
 * Data retention (docs/SPEC.md §7, docs/PRIVACY.md). Runs periodically:
 *
 * - 48 h after an event ends: delete the ticket / room private keys (the public key stays),
 *   the spent list of those keysets, all quotes, and the NWC connection string. Only the
 *   aggregates (issued / redeemed / returned, check-in buckets) remain.
 * - When an event ends: delete its invite codes.
 * - Expired check-in links are deleted.
 * - Unpaid quotes are deleted an hour after their invoice expired.
 * - Phase 4: 48 h after the end, also the vote keyset, the per-scope credential pseudonyms
 *   (poll voters, question authors / voters, draw entries), approvals and finished deposits.
 *   Poll counts, questions and draw results stay. Check-in signatures expire after 24 h.
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
  deletedPseudonyms: number;
  deletedApprovals: number;
  deletedPendingSignatures: number;
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
           WHERE k.kind IN ('ticket', 'room', 'vote') AND e.ends_at <= ?)`,
      )
      .run(cutoff).changes;
    const retiredKeysets = sqlite
      .prepare(
        `UPDATE keysets SET private_key_enc = NULL
         WHERE kind IN ('ticket', 'room', 'vote') AND private_key_enc IS NOT NULL
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
    const ended = `(SELECT id FROM events WHERE ends_at <= ?)`;
    let deletedPseudonyms = 0;
    for (const sql of [
      `DELETE FROM poll_voters WHERE poll_id IN (SELECT id FROM polls WHERE event_id IN ${ended})`,
      `DELETE FROM question_votes WHERE question_id IN (SELECT id FROM questions WHERE event_id IN ${ended})`,
      `DELETE FROM question_quota WHERE event_id IN ${ended}`,
      `DELETE FROM draw_entries WHERE draw_id IN (SELECT id FROM draws WHERE event_id IN ${ended})`,
    ]) {
      deletedPseudonyms += sqlite.prepare(sql).run(cutoff).changes;
    }
    const deletedApprovals = sqlite
      .prepare(`DELETE FROM approvals WHERE event_id IN ${ended}`)
      .run(cutoff).changes;
    sqlite
      .prepare(
        `DELETE FROM deposits WHERE state IN ('refunded', 'settled', 'expired') AND event_id IN ${ended}`,
      )
      .run(cutoff);
    const deletedPendingSignatures = sqlite
      .prepare('DELETE FROM pending_signatures WHERE expires_at <= ?')
      .run(now).changes;
    return {
      deletedPseudonyms,
      deletedApprovals,
      deletedPendingSignatures,
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

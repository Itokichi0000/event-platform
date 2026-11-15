/**
 * No-show deposits with hold invoices (docs/SPEC.md §4 デポジット).
 *
 * The server creates the preimage, the host's wallet (NWC) creates a hold invoice for its hash,
 * and the participant's payment stays locked in the Lightning network: the server never holds
 * funds. At check-in (or when the ticket is returned) the hold invoice is cancelled (refund);
 * after the event, deposits of no-shows are settled to the host.
 *
 * Privacy cost (shown to participants): the deposit reference in the door QR links the payment
 * to the check-in.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { EventRow } from '../db/schema.js';

export interface DepositRow {
  id: string;
  event_id: string;
  payment_hash: string;
  preimage_enc: string;
  state: 'unpaid' | 'held' | 'issued' | 'refunded' | 'settled' | 'expired';
  expires_at: number;
}

export function walletUri(ctx: AppContext, row: EventRow): string | null {
  return row.nwcEnc ? ctx.vault.decrypt(row.nwcEnc, `nwc:${row.id}`) : null;
}

export function newPreimage(): { preimage: string; paymentHash: string } {
  const pre = randomBytes(32);
  return {
    preimage: pre.toString('hex'),
    paymentHash: createHash('sha256').update(pre).digest('hex'),
  };
}

export function getDeposit(ctx: AppContext, eventId: string, id: string): DepositRow | undefined {
  return ctx.db.$client
    .prepare('SELECT * FROM deposits WHERE id = ? AND event_id = ?')
    .get(id, eventId) as DepositRow | undefined;
}

/** Ask the wallet whether an unpaid hold invoice has been paid (accepted). */
export async function refreshDeposit(
  ctx: AppContext,
  row: EventRow,
  dep: DepositRow,
): Promise<DepositRow> {
  if (dep.state !== 'unpaid') return dep;
  const uri = walletUri(ctx, row);
  let state: DepositRow['state'] = dep.state;
  try {
    if (uri) {
      const res = await ctx.payments.wallet(row.id, uri).lookupInvoice(dep.payment_hash);
      if (res === 'accepted') state = 'held';
      else if (res === 'expired' || res === 'failed' || ctx.now() >= dep.expires_at)
        state = 'expired';
    }
  } catch {
    if (ctx.now() >= dep.expires_at) state = 'expired';
  }
  if (state !== dep.state) {
    ctx.db.$client
      .prepare('UPDATE deposits SET state = ? WHERE id = ? AND state = ?')
      .run(state, dep.id, dep.state);
  }
  return { ...dep, state };
}

/**
 * Cancel the hold invoice (refund) of an issued deposit. Returns the resulting state, or null if
 * the reference is unknown. Idempotent.
 */
export async function refundDeposit(
  ctx: AppContext,
  row: EventRow,
  id: string,
): Promise<string | null> {
  const dep = getDeposit(ctx, row.id, id);
  if (!dep) return null;
  if (dep.state !== 'issued' && dep.state !== 'held') return dep.state;
  const uri = walletUri(ctx, row);
  if (!uri) return dep.state;
  try {
    await ctx.payments.wallet(row.id, uri).cancelHoldInvoice(dep.payment_hash);
    ctx.db.$client.prepare(`UPDATE deposits SET state = 'refunded' WHERE id = ?`).run(id);
    return 'refunded';
  } catch {
    // Retried by the deposit job is not possible without the reference being re-presented, so
    // keep it 'issued' and report; the participant can show the QR again.
    return dep.state;
  }
}

/**
 * After the event: settle deposits of no-shows (issued, never refunded) to the host, refund
 * deposits that were paid but never turned into a ticket, and expire unpaid ones.
 */
export async function settleDeposits(
  ctx: AppContext,
): Promise<{ settled: number; refunded: number }> {
  const sqlite = ctx.db.$client;
  const now = ctx.now();
  let settled = 0;
  let refunded = 0;
  sqlite
    .prepare(`UPDATE deposits SET state = 'expired' WHERE state = 'unpaid' AND expires_at <= ?`)
    .run(now);
  const rows = sqlite
    .prepare(
      `SELECT d.*, e.nwc_enc AS nwc_enc, e.ends_at AS ends_at FROM deposits d JOIN events e ON e.id = d.event_id
       WHERE d.state IN ('held', 'issued') AND e.ends_at <= ?`,
    )
    .all(now) as (DepositRow & { nwc_enc: string | null; ends_at: number })[];
  for (const d of rows) {
    if (!d.nwc_enc) continue;
    const wallet = ctx.payments.wallet(
      d.event_id,
      ctx.vault.decrypt(d.nwc_enc, `nwc:${d.event_id}`),
    );
    try {
      if (d.state === 'issued') {
        await wallet.settleHoldInvoice(ctx.vault.decrypt(d.preimage_enc, `deposit:${d.id}`));
        sqlite.prepare(`UPDATE deposits SET state = 'settled' WHERE id = ?`).run(d.id);
        settled++;
      } else {
        await wallet.cancelHoldInvoice(d.payment_hash);
        sqlite.prepare(`UPDATE deposits SET state = 'refunded' WHERE id = ?`).run(d.id);
        refunded++;
      }
    } catch {
      /* retried on the next run */
    }
  }
  return { settled, refunded };
}

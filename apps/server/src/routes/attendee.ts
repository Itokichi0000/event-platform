/**
 * Phase 4 attendee endpoints (docs/SPEC.md §4–§5): stamps (御朱印), anonymous polls and questions,
 * value-less draws, hold-invoice deposits and approval applications.
 */
import { randomBytes, randomInt } from 'node:crypto';
import {
  isKeysetId,
  pointFromHex,
  signIssueRequest,
  spentKey,
  verifyProofWithKeyset,
} from '@kamen/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { apiError, getEvent, stampKeysetById, type AppContext } from '../context.js';
import type { EventRow } from '../db/schema.js';
import { credentialSchema, pseudonym, verifyCredential } from '../lib/credentials.js';
import { getDeposit, newPreimage, refreshDeposit, walletUri } from '../lib/deposits.js';
import { nip98Auth, type HostEnv } from '../lib/nip98.js';
import { randomId, sha256Hex } from '../lib/secrets.js';
import { jsonBody } from '../lib/validate.js';

const point = z.string().regex(/^0[23][0-9a-f]{64}$/);
export const stampProofSchema = credentialSchema;
export const stampBundleSchema = z.object({
  proofs: z.array(stampProofSchema).min(1).max(50),
  outputs: z
    .array(z.object({ keysetId: z.string().refine(isKeysetId), B_: point }))
    .min(1)
    .max(50),
});
export type StampBundle = z.infer<typeof stampBundleSchema>;

const QUESTIONS_PER_ATTENDEE = 3;
export const DEPOSIT_INVOICE_TTL_S = 15 * 60;

/**
 * Spend stamps and sign the same number of fresh blinded stamps, inside the caller's transaction.
 * All stamps must come from `hostPubkey`'s stamp keyset (when given). Returns the signatures.
 */
export function swapStamps(ctx: AppContext, bundle: StampBundle, hostPubkey?: string) {
  if (bundle.proofs.length !== bundle.outputs.length) apiError(400, 'stamp_count_mismatch');
  const first = bundle.proofs[0]?.keysetId ?? '';
  const keyset = stampKeysetById(ctx, first);
  if (!keyset || (hostPubkey && keyset.hostPubkey !== hostPubkey)) apiError(422, 'invalid_stamp');
  for (const p of bundle.proofs) {
    if (p.keysetId !== keyset.id || !verifyProofWithKeyset(p, keyset))
      apiError(422, 'invalid_stamp');
  }
  for (const o of bundle.outputs) {
    if (o.keysetId !== keyset.id) apiError(422, 'invalid_stamp');
    try {
      pointFromHex(o.B_);
    } catch {
      apiError(422, 'invalid_blinded_message');
    }
  }
  const ins = ctx.db.$client.prepare(
    'INSERT INTO spent (keyset_id, y) VALUES (?, ?) ON CONFLICT DO NOTHING',
  );
  for (const p of bundle.proofs) {
    if (ins.run(keyset.id, spentKey(p.secret)).changes === 0) apiError(409, 'stamp_already_used');
  }
  return {
    hostPubkey: keyset.hostPubkey,
    signatures: bundle.outputs.map((o) => signIssueRequest(o, keyset)),
  };
}

function assertActive(row: EventRow) {
  if (row.status !== 'published') apiError(409, 'event_not_published');
}

export function attendeeRoutes(ctx: AppContext) {
  const app = new Hono<HostEnv>();
  const sqlite = ctx.db.$client;

  // ---------------------------------------------------------------- stamps (御朱印)

  /** One-time pickup of a signature made at check-in (stamp or vote credential). */
  app.get('/stamps/:blinded', (c) => {
    const blinded = c.req.param('blinded');
    if (!point.safeParse(blinded).success) apiError(400, 'invalid_request');
    const row = sqlite
      .prepare('SELECT kind, payload, expires_at FROM pending_signatures WHERE blinded = ?')
      .get(blinded) as { kind: string; payload: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= ctx.now()) apiError(404, 'not_ready');
    sqlite.prepare('DELETE FROM pending_signatures WHERE blinded = ?').run(blinded);
    return c.json({ kind: row.kind, ...(JSON.parse(row.payload) as object) });
  });

  /**
   * Prove attendance: present N stamps, receive N fresh ones (the old ones become spent).
   * The host's verifier learns only "N stamps of this host", not which events.
   */
  app.post('/stamps/swap', async (c) => {
    const bundle = await jsonBody(c, stampBundleSchema);
    const res = sqlite.transaction(() => swapStamps(ctx, bundle))();
    return c.json({ ...res, count: res.signatures.length });
  });

  // ---------------------------------------------------------------- polls

  app.get('/events/:id/polls', (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    const polls = sqlite
      .prepare(
        'SELECT id, question, options, status, created_at FROM polls WHERE event_id = ? ORDER BY created_at DESC',
      )
      .all(row.id) as {
      id: string;
      question: string;
      options: string;
      status: string;
      created_at: number;
    }[];
    const counts = sqlite.prepare('SELECT option_index, count FROM poll_counts WHERE poll_id = ?');
    return c.json(
      polls.map((p) => {
        const options = JSON.parse(p.options) as string[];
        const tally = new Array<number>(options.length).fill(0);
        for (const r of counts.all(p.id) as { option_index: number; count: number }[])
          tally[r.option_index] = r.count;
        return {
          id: p.id,
          question: p.question,
          options,
          counts: tally,
          status: p.status,
          createdAt: p.created_at,
        };
      }),
    );
  });

  /** One vote per check-in credential per poll. Only counts are stored. */
  app.post('/events/:id/polls/:pid/vote', async (c) => {
    const body = await jsonBody(
      c,
      z.object({ credential: credentialSchema, option: z.number().int().min(0) }),
    );
    const row = getEvent(ctx, c.req.param('id'));
    const poll = sqlite
      .prepare('SELECT id, options, status FROM polls WHERE id = ? AND event_id = ?')
      .get(c.req.param('pid'), row.id) as
      { id: string; options: string; status: string } | undefined;
    if (!poll) apiError(404, 'poll_not_found');
    if (poll.status !== 'open') apiError(409, 'poll_closed');
    if (body.option >= (JSON.parse(poll.options) as string[]).length)
      apiError(400, 'invalid_option');
    const y = verifyCredential(ctx, row.id, body.credential);
    sqlite.transaction(() => {
      const voted = sqlite
        .prepare('INSERT INTO poll_voters (poll_id, voter) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(poll.id, pseudonym(ctx, `poll:${poll.id}`, y));
      if (voted.changes === 0) apiError(409, 'already_voted');
      sqlite
        .prepare(
          `INSERT INTO poll_counts (poll_id, option_index, count) VALUES (?, ?, 1)
           ON CONFLICT (poll_id, option_index) DO UPDATE SET count = count + 1`,
        )
        .run(poll.id, body.option);
    })();
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- questions

  app.get('/events/:id/questions', (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    return c.json(
      (
        sqlite
          .prepare(
            `SELECT id, body, upvotes, created_at FROM questions WHERE event_id = ? AND hidden = 0
             ORDER BY upvotes DESC, created_at ASC`,
          )
          .all(row.id) as { id: string; body: string; upvotes: number; created_at: number }[]
      ).map((q) => ({ id: q.id, body: q.body, upvotes: q.upvotes, createdAt: q.created_at })),
    );
  });

  app.post('/events/:id/questions', async (c) => {
    const body = await jsonBody(
      c,
      z.object({ credential: credentialSchema, body: z.string().trim().min(1).max(500) }),
    );
    const row = getEvent(ctx, c.req.param('id'));
    assertActive(row);
    const y = verifyCredential(ctx, row.id, body.credential);
    const id = randomId(16);
    sqlite.transaction(() => {
      const author = pseudonym(ctx, `questions:${row.id}`, y);
      const used = sqlite
        .prepare(
          `INSERT INTO question_quota (event_id, author, count) VALUES (?, ?, 1)
           ON CONFLICT (event_id, author) DO UPDATE SET count = count + 1 WHERE count < ?`,
        )
        .run(row.id, author, QUESTIONS_PER_ATTENDEE);
      if (used.changes === 0) apiError(429, 'question_limit');
      sqlite
        .prepare('INSERT INTO questions (id, event_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(id, row.id, body.body, ctx.now());
    })();
    return c.json({ id }, 201);
  });

  app.post('/events/:id/questions/:qid/upvote', async (c) => {
    const body = await jsonBody(c, z.object({ credential: credentialSchema }));
    const row = getEvent(ctx, c.req.param('id'));
    const qid = c.req.param('qid');
    const exists = sqlite
      .prepare('SELECT 1 FROM questions WHERE id = ? AND event_id = ? AND hidden = 0')
      .get(qid, row.id);
    if (!exists) apiError(404, 'question_not_found');
    const y = verifyCredential(ctx, row.id, body.credential);
    sqlite.transaction(() => {
      const v = sqlite
        .prepare(
          'INSERT INTO question_votes (question_id, voter) VALUES (?, ?) ON CONFLICT DO NOTHING',
        )
        .run(qid, pseudonym(ctx, `question:${qid}`, y));
      if (v.changes === 0) apiError(409, 'already_voted');
      sqlite.prepare('UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?').run(qid);
    })();
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- draws (no monetary value)

  app.get('/events/:id/draws', (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    const draws = sqlite
      .prepare(
        'SELECT id, title, winners, status, result, created_at FROM draws WHERE event_id = ? ORDER BY created_at DESC',
      )
      .all(row.id) as {
      id: string;
      title: string;
      winners: number;
      status: string;
      result: string | null;
      created_at: number;
    }[];
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?');
    return c.json(
      draws.map((d) => ({
        id: d.id,
        title: d.title,
        winners: d.winners,
        status: d.status,
        entries: (count.get(d.id) as { n: number }).n,
        winningCodes: d.result ? (JSON.parse(d.result) as string[]) : [],
        createdAt: d.created_at,
      })),
    );
  });

  /** Enter with the check-in credential. Returns the entry code shown if it wins. */
  app.post('/events/:id/draws/:did/enter', async (c) => {
    const body = await jsonBody(c, z.object({ credential: credentialSchema }));
    const row = getEvent(ctx, c.req.param('id'));
    const draw = sqlite
      .prepare('SELECT id, status FROM draws WHERE id = ? AND event_id = ?')
      .get(c.req.param('did'), row.id) as { id: string; status: string } | undefined;
    if (!draw) apiError(404, 'draw_not_found');
    if (draw.status !== 'open') apiError(409, 'draw_closed');
    const y = verifyCredential(ctx, row.id, body.credential);
    const entry = pseudonym(ctx, `draw:${draw.id}`, y);
    sqlite
      .prepare('INSERT INTO draw_entries (draw_id, entry) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(draw.id, entry);
    return c.json({ code: entryCode(entry) });
  });

  // ---------------------------------------------------------------- deposits (hold invoice)

  /**
   * Create the deposit hold invoice. Allowed only within DEPOSIT_WINDOW_HOURS before the start,
   * because hold invoices cannot stay locked for long.
   */
  app.post('/events/:id/deposit', async (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    assertActive(row);
    if (row.depositMsat <= 0) apiError(409, 'no_deposit');
    if (row.endsAt <= ctx.now()) apiError(410, 'event_ended');
    if (ctx.now() < row.startsAt - ctx.config.depositWindowHours * 3600_000)
      apiError(409, 'deposit_window_not_open');
    const uri = walletUri(ctx, row);
    if (!uri) apiError(409, 'payments_not_configured');
    const { preimage, paymentHash } = newPreimage();
    let inv;
    try {
      inv = await ctx.payments
        .wallet(row.id, uri)
        .makeHoldInvoice(
          row.depositMsat,
          paymentHash,
          `${row.title} deposit (Kamen)`,
          DEPOSIT_INVOICE_TTL_S,
        );
    } catch {
      apiError(502, 'wallet_unavailable');
    }
    const id = randomBytes(16).toString('hex');
    sqlite
      .prepare(
        `INSERT INTO deposits (id, event_id, payment_hash, preimage_enc, state, expires_at) VALUES (?, ?, ?, ?, 'unpaid', ?)`,
      )
      .run(id, row.id, paymentHash, ctx.vault.encrypt(preimage, `deposit:${id}`), inv.expiresAt);
    return c.json({
      depositId: id,
      invoice: inv.invoice,
      amountMsat: row.depositMsat,
      expiresAt: inv.expiresAt,
    });
  });

  app.get('/events/:id/deposits/:did', async (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    const dep = getDeposit(ctx, row.id, c.req.param('did'));
    if (!dep) apiError(404, 'deposit_not_found');
    const fresh = await refreshDeposit(ctx, row, dep);
    return c.json({ state: fresh.state, expiresAt: fresh.expires_at });
  });

  // ---------------------------------------------------------------- approval applications

  /**
   * Apply to an approval-based event, signed with the applicant's Nostr key (NIP-07 → NIP-98).
   * The applicant's pubkey is stored for this event only (deleted 48 h after the end) and is
   * never linked to the ticket. Returns a claim token for checking status and claiming.
   */
  const applicantAuth = nip98Auth({ publicOrigin: ctx.config.publicOrigin, now: ctx.now });
  app.post('/events/:id/applications', applicantAuth, async (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    assertActive(row);
    if (row.issuePolicy !== 'approval') apiError(409, 'not_approval_event');
    const pubkey = c.get('hostPubkey'); // the signer of the NIP-98 event
    const token = randomBytes(24).toString('base64url');
    const id = randomId(16);
    const existing = sqlite
      .prepare('SELECT id FROM approvals WHERE event_id = ? AND applicant_pubkey = ?')
      .get(row.id, pubkey) as { id: string } | undefined;
    if (existing) {
      // Re-applying from another device issues a new claim token for the same application.
      sqlite
        .prepare('UPDATE approvals SET token_hash = ? WHERE id = ?')
        .run(sha256Hex(token), existing.id);
      return c.json({ id: existing.id, token });
    }
    sqlite
      .prepare(
        `INSERT INTO approvals (id, event_id, applicant_pubkey, token_hash, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, row.id, pubkey, sha256Hex(token), ctx.now());
    return c.json({ id, token }, 201);
  });

  app.get('/events/:id/applications/:aid', (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    const token = c.req.header('x-kamen-claim') ?? '';
    const app_ = sqlite
      .prepare('SELECT state FROM approvals WHERE id = ? AND event_id = ? AND token_hash = ?')
      .get(c.req.param('aid'), row.id, sha256Hex(token)) as { state: string } | undefined;
    if (!app_) apiError(404, 'application_not_found');
    return c.json({ state: app_.state });
  });

  return app;
}

/** Short, human-comparable code for a draw entry (shown on the winner's screen and to the host). */
export function entryCode(entry: string): string {
  return entry.slice(0, 8).toUpperCase();
}

/** Uniformly pick `k` distinct winners. */
export function pickWinners(entries: string[], k: number): string[] {
  const pool = [...entries];
  const out: string[] = [];
  while (out.length < k && pool.length > 0)
    out.push(pool.splice(randomInt(pool.length), 1)[0] as string);
  return out;
}

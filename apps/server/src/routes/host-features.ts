/** Phase 4 host endpoints: polls, questions moderation, draws and approval decisions. */
import { Hono } from 'hono';
import { z } from 'zod';
import { apiError, getManagedEvent, type AppContext } from '../context.js';
import type { HostEnv } from '../lib/nip98.js';
import { randomId } from '../lib/secrets.js';
import { jsonBody } from '../lib/validate.js';
import { entryCode, pickWinners } from './attendee.js';
import { hostMiddleware } from './host-auth.js';

export function hostFeatureRoutes(ctx: AppContext) {
  const app = new Hono<HostEnv>();
  const { host } = hostMiddleware(ctx);
  const sqlite = ctx.db.$client;
  const managed = (id: string, pk: string) => getManagedEvent(ctx, id, pk);

  app.post('/events/:id/polls', ...host, async (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    const body = await jsonBody(
      c,
      z.object({
        question: z.string().trim().min(1).max(200),
        options: z.array(z.string().trim().min(1).max(100)).min(2).max(8),
      }),
    );
    const id = randomId(16);
    sqlite
      .prepare(
        'INSERT INTO polls (id, event_id, question, options, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, row.id, body.question, JSON.stringify(body.options), ctx.now());
    return c.json({ id }, 201);
  });

  app.post('/events/:id/polls/:pid/close', ...host, (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    const r = sqlite
      .prepare(`UPDATE polls SET status = 'closed' WHERE id = ? AND event_id = ?`)
      .run(c.req.param('pid'), row.id);
    if (r.changes === 0) apiError(404, 'poll_not_found');
    return c.json({ ok: true });
  });

  app.get('/events/:id/questions/all', ...host, (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    return c.json(
      (
        sqlite
          .prepare(
            'SELECT id, body, upvotes, hidden, created_at FROM questions WHERE event_id = ? ORDER BY upvotes DESC, created_at ASC',
          )
          .all(row.id) as {
          id: string;
          body: string;
          upvotes: number;
          hidden: number;
          created_at: number;
        }[]
      ).map((q) => ({
        id: q.id,
        body: q.body,
        upvotes: q.upvotes,
        hidden: q.hidden === 1,
        createdAt: q.created_at,
      })),
    );
  });

  app.post('/events/:id/questions/:qid/hide', ...host, (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    const r = sqlite
      .prepare('UPDATE questions SET hidden = 1 WHERE id = ? AND event_id = ?')
      .run(c.req.param('qid'), row.id);
    if (r.changes === 0) apiError(404, 'question_not_found');
    return c.json({ ok: true });
  });

  app.post('/events/:id/draws', ...host, async (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    const body = await jsonBody(
      c,
      z.object({
        title: z.string().trim().min(1).max(100),
        winners: z.number().int().min(1).max(100),
      }),
    );
    const id = randomId(16);
    sqlite
      .prepare(
        'INSERT INTO draws (id, event_id, title, winners, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, row.id, body.title, body.winners, ctx.now());
    return c.json({ id }, 201);
  });

  /** Draw winners uniformly at random among entries. The result is the winners' entry codes. */
  app.post('/events/:id/draws/:did/draw', ...host, (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    const draw = sqlite
      .prepare('SELECT id, winners, status FROM draws WHERE id = ? AND event_id = ?')
      .get(c.req.param('did'), row.id) as
      { id: string; winners: number; status: string } | undefined;
    if (!draw) apiError(404, 'draw_not_found');
    if (draw.status !== 'open') apiError(409, 'draw_closed');
    const entries = (
      sqlite.prepare('SELECT entry FROM draw_entries WHERE draw_id = ?').all(draw.id) as {
        entry: string;
      }[]
    ).map((e) => e.entry);
    const codes = pickWinners(entries, draw.winners).map(entryCode);
    sqlite
      .prepare(`UPDATE draws SET status = 'drawn', result = ?, drawn_at = ? WHERE id = ?`)
      .run(JSON.stringify(codes), ctx.now(), draw.id);
    return c.json({ winningCodes: codes, entries: entries.length });
  });

  app.get('/events/:id/applications', ...host, (c) => {
    const row = managed(c.req.param('id'), c.get('hostPubkey'));
    return c.json(
      (
        sqlite
          .prepare(
            'SELECT id, applicant_pubkey, state, created_at FROM approvals WHERE event_id = ? ORDER BY created_at ASC',
          )
          .all(row.id) as {
          id: string;
          applicant_pubkey: string;
          state: string;
          created_at: number;
        }[]
      ).map((a) => ({
        id: a.id,
        pubkey: a.applicant_pubkey,
        state: a.state,
        createdAt: a.created_at,
      })),
    );
  });

  for (const [action, state] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(`/events/:id/applications/:aid/${action}`, ...host, (c) => {
      const row = managed(c.req.param('id'), c.get('hostPubkey'));
      const r = sqlite
        .prepare(
          `UPDATE approvals SET state = ? WHERE id = ? AND event_id = ? AND state IN ('pending', 'approved', 'rejected')`,
        )
        .run(state, c.req.param('aid'), row.id);
      if (r.changes === 0) apiError(409, 'application_not_changeable');
      return c.json({ ok: true });
    });
  }

  return app;
}

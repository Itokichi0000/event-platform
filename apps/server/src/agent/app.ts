/** Internal HTTP API of the room agent. Reachable only from the API server (shared secret). */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { privacyLogger } from '../lib/logger.js';
import { deriveKey } from '../lib/secrets.js';
import { AgentError, type RoomService } from './rooms.js';

export const AGENT_SECRET_HEADER = 'x-kamen-agent';

/** Shared secret between API server and agent, derived from the master key both hold. */
export function agentSecret(masterKey: Uint8Array): string {
  return deriveKey(masterKey, 'agent-api').toString('hex');
}

const eventShape = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string().max(100_000),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

const roomShape = z.object({
  title: z.string().min(1).max(120),
  endsAt: z.number().int().positive(),
});
const joinShape = roomShape.extend({ keyPackage: eventShape });
const announceShape = z.object({ body: z.string().min(1).max(2000) });
const eventIdShape = z.string().regex(/^[a-z2-7]{6,64}$/);

export function createAgentApp(
  rooms: RoomService,
  masterKey: Uint8Array,
  log: (l: string) => void = console.log,
) {
  const secret = Buffer.from(agentSecret(masterKey));
  const app = new Hono();
  app.use('*', privacyLogger(log));
  app.get('/health', (c) => c.json({ ok: true }));
  app.use('/rooms/*', bodyLimit({ maxSize: 128 * 1024 }), async (c, next) => {
    const given = Buffer.from(c.req.header(AGENT_SECRET_HEADER) ?? '');
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) {
      throw new HTTPException(401, {
        res: Response.json({ error: 'unauthorized' }, { status: 401 }),
      });
    }
    await next();
  });

  const parse = async <T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, shape: T) => {
    const r = shape.safeParse(await c.req.json().catch(() => null));
    if (!r.success)
      throw new HTTPException(400, {
        res: Response.json({ error: 'invalid_request' }, { status: 400 }),
      });
    return r.data as z.infer<T>;
  };
  const eventId = (raw: string) => {
    if (!eventIdShape.safeParse(raw).success) {
      throw new HTTPException(400, {
        res: Response.json({ error: 'invalid_event' }, { status: 400 }),
      });
    }
    return raw;
  };

  app.post('/rooms/:eventId/ensure', async (c) => {
    const body = await parse(c, roomShape);
    return c.json(await rooms.ensure(eventId(c.req.param('eventId')), body.title, body.endsAt));
  });

  app.post('/rooms/:eventId/join', async (c) => {
    const body = await parse(c, joinShape);
    return c.json(
      await rooms.join(eventId(c.req.param('eventId')), body.title, body.endsAt, body.keyPackage),
    );
  });

  app.post('/rooms/:eventId/announce', async (c) => {
    const { body } = await parse(c, announceShape);
    return c.json({ posted: await rooms.announce(eventId(c.req.param('eventId')), body) });
  });

  app.delete('/rooms/:eventId', async (c) => {
    return c.json({ disbanded: await rooms.disband(eventId(c.req.param('eventId'))) });
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.res ?? c.json({ error: 'error' }, err.status);
    if (err instanceof AgentError)
      return c.json({ error: err.code }, err.code === 'invalid_key_package' ? 400 : 503);
    log(`agent error: ${err.name}`);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}

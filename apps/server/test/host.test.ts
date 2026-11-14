import { describe, expect, it } from 'vitest';
import {
  createPublishedEvent,
  createScannerToken,
  getPublicEvent,
  getTicket,
  HOUR,
  makeHost,
  ORIGIN,
  redeem,
  setup,
  json,
} from './helpers.js';

describe('NIP-98 auth', () => {
  const body = () =>
    JSON.stringify({
      title: 't',
      startsAt: Date.now() + HOUR,
      endsAt: Date.now() + 2 * HOUR,
      capacity: 3,
    });

  it('rejects missing, malformed and wrong-kind tokens', async () => {
    const h = setup();
    expect((await h.request('/api/host/events')).status).toBe(401);
    const bad = await h.request('/api/host/events', { headers: { authorization: 'Nostr !!!' } });
    expect(bad.status).toBe(401);
  });

  it('binds method, URL, host and body', async () => {
    const h = setup();
    const host = makeHost(h);
    const b = body();
    const post = (authorization: string, payload = b) =>
      h.request('/api/events', {
        method: 'POST',
        body: payload,
        headers: { authorization, 'content-type': 'application/json' },
      });
    expect((await post(host.authHeader('POST', '/api/events', b))).status).toBe(201);
    expect((await post(host.authHeader('PATCH', '/api/events', b))).status).toBe(401);
    expect((await post(host.authHeader('POST', '/api/other', b))).status).toBe(401);
    expect(
      (await post(host.authHeader('POST', '/api/events', b, 'http://evil.test/api/events'))).status,
    ).toBe(401);
    expect(
      (await post(host.authHeader('POST', '/api/events', b), b.replace('"t"', '"x"'))).status,
    ).toBe(401);
  });

  it('rejects stale and replayed tokens', async () => {
    const h = setup();
    const host = makeHost(h);
    const auth = host.authHeader('GET', '/api/host/events');
    expect((await h.request('/api/host/events', { headers: { authorization: auth } })).status).toBe(
      200,
    );
    expect((await h.request('/api/host/events', { headers: { authorization: auth } })).status).toBe(
      401,
    );
    const stale = host.authHeader('GET', '/api/host/events');
    h.clock.t += 2 * 60 * 1000;
    expect(
      (await h.request('/api/host/events', { headers: { authorization: stale } })).status,
    ).toBe(401);
  });

  it('another host cannot manage the event', async () => {
    const h = setup();
    const owner = makeHost(h);
    const intruder = makeHost(h);
    const id = await createPublishedEvent(h, owner);
    expect((await intruder.call('PATCH', `/api/events/${id}`, { title: 'pwned' })).status).toBe(
      403,
    );
    expect((await intruder.call('GET', `/api/events/${id}/stats`)).status).toBe(403);
    expect((await intruder.call('POST', `/api/events/${id}/scanner-links`, {})).status).toBe(403);
    expect(
      (await intruder.call('POST', `/api/events/${id}/announcements`, { body: 'x' })).status,
    ).toBe(403);
  });
});

describe('event management', () => {
  it('lists own events with counters', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    await getTicket(h, id);
    const list = await json(await host.call('GET', '/api/host/events'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, issued: 1, redeemed: 0, status: 'published' });
  });

  it('validates time range and capacity changes', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host, { capacity: 3 });
    await getTicket(h, id);
    await getTicket(h, id);
    expect((await host.call('PATCH', `/api/events/${id}`, { capacity: 1 })).status).toBe(409);
    expect((await host.call('PATCH', `/api/events/${id}`, { capacity: 10 })).status).toBe(200);
    expect((await host.call('PATCH', `/api/events/${id}`, { endsAt: 1 })).status).toBe(400);
    expect((await host.call('PATCH', `/api/events/${id}`, { status: 'draft' })).status).toBe(409);
  });

  it('partial updates keep other fields', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    await host.call('PATCH', `/api/events/${id}`, { title: 'New title' });
    const ev = await getPublicEvent(h, id);
    expect(ev).toMatchObject({ title: 'New title', location: 'Shibuya', description: 'desc' });
  });

  it('cancelled events cannot be revived and reject check-in', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await getTicket(h, id);
    const { token } = await createScannerToken(h, host, id);
    await host.call('PATCH', `/api/events/${id}`, { status: 'cancelled' });
    expect((await host.call('PATCH', `/api/events/${id}`, { status: 'published' })).status).toBe(
      409,
    );
    expect((await redeem(h, id, token, proof!)).status).toBe(410);
  });

  it('announcements appear on the public page, newest first, and can be deleted', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    await host.call('POST', `/api/events/${id}/announcements`, { body: 'first' });
    h.clock.t += 1000;
    const res = await host.call('POST', `/api/events/${id}/announcements`, {
      body: 'venue changed',
    });
    const { id: aid } = await json(res);
    expect((await getPublicEvent(h, id)).announcements.map((a) => a.body)).toEqual([
      'venue changed',
      'first',
    ]);
    expect((await host.call('DELETE', `/api/events/${id}/announcements/${aid}`)).status).toBe(204);
    expect((await getPublicEvent(h, id)).announcements).toHaveLength(1);
  });

  it('cover image upload and public download', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const path = `/api/events/${id}/cover`;
    const put = await h.request(path, {
      method: 'PUT',
      body: img,
      headers: { authorization: host.authHeader('PUT', path, img), 'content-type': 'image/jpeg' },
    });
    expect(put.status).toBe(200);
    expect((await getPublicEvent(h, id)).coverVersion).toBe(1);
    const get = await h.request(path);
    expect(get.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(img);

    const svg = new TextEncoder().encode('<svg/>');
    const bad = await h.request(path, {
      method: 'PUT',
      body: svg,
      headers: {
        authorization: host.authHeader('PUT', path, svg),
        'content-type': 'image/svg+xml',
      },
    });
    expect(bad.status).toBe(422);
  });
});

describe('scanner links', () => {
  it('work only for their event, until revoked or expired', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const other = await createPublishedEvent(h, host);
    const { token, id: linkId } = await createScannerToken(h, host, id);
    const session = (eventId: string, t = token) =>
      h.request(`/api/events/${eventId}/scanner-session`, {
        headers: { authorization: `Bearer ${t}` },
      });

    expect((await session(id)).status).toBe(200);
    expect((await session(other)).status).toBe(401);
    expect((await session(id, 'x'.repeat(43))).status).toBe(401);

    const links = await json(await host.call('GET', `/api/events/${id}/scanner-links`));
    expect(links).toHaveLength(1);
    expect(JSON.stringify(links)).not.toContain(token);

    expect((await host.call('DELETE', `/api/events/${id}/scanner-links/${linkId}`)).status).toBe(
      204,
    );
    expect((await session(id)).status).toBe(401);

    const { token: t2 } = await createScannerToken(h, host, id);
    h.clock.t += 40 * HOUR; // event ends at +27h, links expire 6h later
    expect((await session(id, t2)).status).toBe(401);
  });

  it('redeem needs a valid link', async () => {
    const h = setup();
    const host = makeHost(h);
    const id = await createPublishedEvent(h, host);
    const { proof } = await getTicket(h, id);
    expect((await redeem(h, id, 'nope'.repeat(10), proof!)).status).toBe(401);
  });
});

describe('ORIGIN constant', () => {
  it('is a valid URL', () => expect(new URL(ORIGIN).host).toBe('kamen.test'));
});

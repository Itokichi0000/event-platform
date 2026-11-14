/**
 * Minimal in-memory NIP-01 relay for tests and the E2E suite (not for production).
 * Supports EVENT / REQ (kinds, authors, ids, #tag, since, until, limit) / CLOSE, EOSE, OK.
 * Addressable events (30000-39999) replace older ones with the same pubkey + kind + d tag.
 */
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { WebSocketServer, type WebSocket } from 'ws';

type Filter = Record<string, unknown> & {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
};

function matches(e: Event, f: Filter): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('#') && Array.isArray(v)) {
      const name = k.slice(1);
      if (!e.tags.some((t) => t[0] === name && v.includes(t[1]))) return false;
    }
  }
  return true;
}

export interface TestRelay {
  url: string;
  events: Event[];
  close(): Promise<void>;
}

export async function startTestRelay(port = 0): Promise<TestRelay> {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const events: Event[] = [];
  const subs = new Map<WebSocket, Map<string, Filter[]>>();

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(raw)) as unknown[];
      } catch {
        return;
      }
      const [type, ...rest] = msg;
      if (type === 'EVENT') {
        const e = rest[0] as Event;
        if (!verifyEvent(e))
          return ws.send(JSON.stringify(['OK', e?.id, false, 'invalid: bad signature']));
        if (events.some((x) => x.id === e.id))
          return ws.send(JSON.stringify(['OK', e.id, true, 'duplicate:']));
        if (e.kind >= 30000 && e.kind < 40000) {
          const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
          const i = events.findIndex(
            (x) =>
              x.kind === e.kind &&
              x.pubkey === e.pubkey &&
              (x.tags.find((t) => t[0] === 'd')?.[1] ?? '') === d,
          );
          if (i >= 0) events.splice(i, 1);
        }
        events.push(e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const [client, map] of subs) {
          for (const [id, filters] of map) {
            if (filters.some((f) => matches(e, f))) client.send(JSON.stringify(['EVENT', id, e]));
          }
        }
      } else if (type === 'REQ') {
        const [id, ...filters] = rest as [string, ...Filter[]];
        subs.get(ws)?.set(id, filters);
        const out = new Map<string, Event>();
        for (const f of filters) {
          const hits = events
            .filter((e) => matches(e, f))
            .sort((a, b) => b.created_at - a.created_at);
          for (const e of hits.slice(0, f.limit ?? hits.length)) out.set(e.id, e);
        }
        for (const e of out.values()) ws.send(JSON.stringify(['EVENT', id, e]));
        ws.send(JSON.stringify(['EOSE', id]));
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(rest[0] as string);
      }
    });
  });

  const address = wss.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `ws://127.0.0.1:${actualPort}`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

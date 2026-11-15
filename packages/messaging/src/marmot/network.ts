/**
 * NostrNetworkInterface for marmot-ts on top of nostr-tools' SimplePool, with two privacy
 * adjustments (docs/SPEC.md §5, docs/MARMOT-NOTES.md):
 *
 * - `holdKinds`: events of these kinds are NOT sent to relays but kept in `held`
 *   (participants' kind 30443 key packages are handed to the room agent over HTTP instead).
 * - `inboxRelays`: Welcomes go to the room's relays, so participants never publish
 *   kind 10002 / 10050 relay lists.
 */
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import type { SignedEvent } from '../types.js';

export interface PublishResponse {
  from: string;
  ok: boolean;
  message?: string;
}

export interface Observer<T> {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
}

export interface MarmotNetwork {
  publish(relays: string[], event: SignedEvent): Promise<Record<string, PublishResponse>>;
  request(relays: string[], filters: Filter | Filter[]): Promise<SignedEvent[]>;
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): { subscribe(observer: Partial<Observer<SignedEvent>>): { unsubscribe(): void } };
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}

export interface NetworkOptions {
  pool?: SimplePool;
  inboxRelays: () => string[];
  holdKinds?: number[];
  /** Called for every event actually sent to relays (e.g. to capture Welcome gift wraps). */
  onPublished?: (event: SignedEvent) => void;
  maxWaitMs?: number;
}

export interface HeldNetwork extends MarmotNetwork {
  /** Events withheld from relays (see `holdKinds`), newest last. */
  readonly held: SignedEvent[];
  close(): void;
}

export function createNetwork(opts: NetworkOptions): HeldNetwork {
  const pool = opts.pool ?? new SimplePool({ enablePing: true, enableReconnect: true });
  const hold = new Set(opts.holdKinds ?? []);
  const maxWait = opts.maxWaitMs ?? 8000;
  const held: SignedEvent[] = [];

  return {
    held,
    async publish(relays, event) {
      const out: Record<string, PublishResponse> = {};
      if (hold.has(event.kind)) {
        held.push(event);
        for (const r of relays) out[r] = { from: r, ok: true, message: 'held locally' };
        return out;
      }
      const pending = pool.publish(relays, event as Event, { maxWait });
      await Promise.all(
        relays.map(async (url, i) => {
          try {
            const msg = String((await pending[i]) ?? '');
            const failed = msg.startsWith('connection failure');
            out[url] = { from: url, ok: !failed, ...(msg ? { message: msg } : {}) };
          } catch (err) {
            out[url] = {
              from: url,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      if (Object.values(out).some((r) => r.ok)) opts.onPublished?.(event);
      return out;
    },

    async request(relays, filters) {
      const list = Array.isArray(filters) ? filters : [filters];
      const seen = new Map<string, SignedEvent>();
      let failures = 0;
      let attempts = 0;
      await Promise.all(
        relays.flatMap((relay) =>
          list.map(
            (filter) =>
              new Promise<void>((resolve) => {
                attempts++;
                const limit = filter.limit ?? Infinity;
                let count = 0;
                pool.subscribeManyEose([relay], filter, {
                  maxWait,
                  onevent: (e) => {
                    if (count++ < limit) seen.set(e.id, e as SignedEvent);
                  },
                  onclose: (reasons) => {
                    // A normal end is EOSE; anything else (connection failure, CLOSED) is a failure,
                    // which marmot-ts needs as a rejection rather than as "no more events".
                    if (reasons.some((r) => !/eose/i.test(r.reason))) failures++;
                    resolve();
                  },
                });
              }),
          ),
        ),
      );
      if (attempts > 0 && failures === attempts) throw new Error('all relays failed');
      return [...seen.values()];
    },

    subscription(relays, filters) {
      const list = Array.isArray(filters) ? filters : [filters];
      return {
        subscribe(observer) {
          const closers = list.map((filter) =>
            pool.subscribeMany(relays, filter, {
              onevent: (e) => observer.next?.(e as SignedEvent),
            }),
          );
          return { unsubscribe: () => closers.forEach((c) => c.close()) };
        },
      };
    },

    async getUserInboxRelays() {
      return opts.inboxRelays();
    },

    close() {
      pool.destroy();
    },
  };
}

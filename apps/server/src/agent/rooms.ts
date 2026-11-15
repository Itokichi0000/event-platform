/**
 * Room agent logic (docs/SPEC.md §5): one Marmot group per event, administered by a per-event
 * identity derived from the master key. Member additions are processed serially and batched
 * into one commit per window. Announcements are posted into the room. Rooms are disbanded
 * 24 h after the event ends. Messages pass through memory only; nothing is logged or stored.
 */
import { createHash, hkdfSync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { MessagingAdapter, SignedEvent, Welcome } from '@kamen/messaging';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import type { AgentStore } from './store.js';

export const DISBAND_AFTER_END_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH = 25;

/** Per-event agent key, so rooms of different events cannot be linked by the agent's pubkey. */
export function agentSecretKey(masterKey: Uint8Array, eventId: string): string {
  let sk = Buffer.from(
    hkdfSync('sha256', masterKey, new Uint8Array(0), `kamen/room-agent/${eventId}`, 32),
  );
  while (!secp256k1.utils.isValidSecretKey(sk)) sk = createHash('sha256').update(sk).digest();
  return sk.toString('hex');
}

export type AdapterFactory = (eventId: string, secretKey: string) => Promise<MessagingAdapter>;

export class AgentError extends Error {
  constructor(
    readonly code: 'invalid_key_package' | 'room_disbanded' | 'room_failed',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AgentError';
  }
}

interface PendingJoin {
  keyPackage: SignedEvent;
  resolve: (w: Welcome) => void;
  reject: (e: unknown) => void;
}

export interface RoomInfoForClient {
  roomId: string;
  agentPubkey: string;
  relays: string[];
}

export class RoomService {
  readonly #adapters = new Map<string, Promise<MessagingAdapter>>();
  readonly #pending = new Map<string, PendingJoin[]>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One global queue: all MLS operations of this agent run strictly one after another. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: AgentStore,
    private readonly masterKey: Uint8Array,
    private readonly relays: string[],
    private readonly factory: AdapterFactory,
    private readonly opts: {
      batchMs: number;
      now?: () => number;
      /** Signature check for key packages (replaceable for the in-memory test adapter). */
      verify?: (e: SignedEvent) => boolean;
    } = { batchMs: 1500 },
  ) {}

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  #adapter(eventId: string): Promise<MessagingAdapter> {
    let a = this.#adapters.get(eventId);
    if (!a) {
      a = this.factory(eventId, agentSecretKey(this.masterKey, eventId));
      this.#adapters.set(eventId, a);
    }
    return a;
  }

  /** Reconnect to every stored room (after a restart) so the agent keeps up with the groups. */
  async resume(): Promise<void> {
    for (const row of this.store.rooms()) {
      try {
        const adapter = await this.#adapter(row.event_id);
        await adapter.subscribe(row.room_id, {});
      } catch {
        /* reported on next use */
      }
    }
  }

  /** Create the event's room if it does not exist yet. */
  ensure(eventId: string, title: string, endsAt: number): Promise<RoomInfoForClient> {
    return this.#serial(async () => {
      const adapter = await this.#adapter(eventId);
      let row = this.store.room(eventId);
      if (!row) {
        const { roomId } = await adapter.createRoom({ name: title, relays: this.relays });
        row = { event_id: eventId, room_id: roomId, ends_at: endsAt };
        this.store.saveRoom(row);
        await adapter.subscribe(roomId, {});
      } else if (row.ends_at !== endsAt) {
        this.store.saveRoom({ ...row, ends_at: endsAt });
      }
      return { roomId: row.room_id, agentPubkey: adapter.pubkey, relays: this.relays };
    });
  }

  /** Queue a member addition; resolves with the member's Welcome once the batch is committed. */
  async join(eventId: string, title: string, endsAt: number, keyPackage: SignedEvent) {
    const verify = this.opts.verify ?? ((e: SignedEvent) => verifyEvent(e as Event));
    if (keyPackage.kind !== 30443 || !verify(keyPackage)) {
      throw new AgentError('invalid_key_package');
    }
    const info = await this.ensure(eventId, title, endsAt);
    const welcome = await new Promise<Welcome>((resolve, reject) => {
      const list = this.#pending.get(eventId) ?? [];
      list.push({ keyPackage, resolve, reject });
      this.#pending.set(eventId, list);
      if (list.length >= MAX_BATCH) this.#flush(eventId);
      else if (!this.#timers.has(eventId)) {
        this.#timers.set(
          eventId,
          setTimeout(() => this.#flush(eventId), this.opts.batchMs),
        );
      }
    });
    return { ...info, welcome: welcome.event };
  }

  #flush(eventId: string): void {
    clearTimeout(this.#timers.get(eventId));
    this.#timers.delete(eventId);
    const batch = this.#pending.get(eventId) ?? [];
    this.#pending.delete(eventId);
    if (batch.length === 0) return;
    void this.#serial(async () => {
      const row = this.store.room(eventId);
      if (!row) return batch.forEach((p) => p.reject(new AgentError('room_disbanded')));
      const adapter = await this.#adapter(eventId);
      try {
        const welcomes = await adapter.addMember(
          row.room_id,
          batch.map((p) => p.keyPackage),
        );
        batch.forEach((p, i) => p.resolve(welcomes[i] as Welcome));
      } catch {
        // Isolate a bad key package: retry one by one.
        for (const p of batch) {
          try {
            const [w] = await adapter.addMember(row.room_id, [p.keyPackage]);
            p.resolve(w as Welcome);
          } catch (e) {
            p.reject(new AgentError('room_failed', e instanceof Error ? e.message : undefined));
          }
        }
      }
    });
  }

  /** Post a host announcement into the room (if the room exists). */
  announce(eventId: string, body: string): Promise<boolean> {
    return this.#serial(async () => {
      const row = this.store.room(eventId);
      if (!row) return false;
      await (await this.#adapter(eventId)).send(row.room_id, body);
      return true;
    });
  }

  /** End the room for everyone and delete the agent's state for it. */
  disband(eventId: string): Promise<boolean> {
    return this.#serial(async () => {
      const row = this.store.room(eventId);
      if (!row) return false;
      const adapter = await this.#adapter(eventId);
      try {
        await adapter.destroy(row.room_id, { disband: true });
      } finally {
        await adapter.close();
        this.#adapters.delete(eventId);
        this.store.deleteRoom(eventId);
      }
      return true;
    });
  }

  /** Disband rooms whose event ended more than 24 h ago. */
  async sweep(): Promise<number> {
    const now = (this.opts.now ?? Date.now)();
    let n = 0;
    for (const row of this.store.rooms()) {
      if (row.ends_at + DISBAND_AFTER_END_MS <= now) {
        try {
          if (await this.disband(row.event_id)) n++;
        } catch {
          /* retried on the next sweep */
        }
      }
    }
    return n;
  }

  async close(): Promise<void> {
    for (const a of this.#adapters.values()) await (await a).close();
    this.#adapters.clear();
  }
}

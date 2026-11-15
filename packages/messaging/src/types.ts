/**
 * The only messaging surface the apps use (docs/SPEC.md §5). Implementations: `MarmotAdapter`
 * (marmot-ts, alpha) and `InMemoryAdapter` (tests). Apps never import marmot-ts directly.
 */

/** A signed Nostr event (NIP-01). */
export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Chat message kind (NIP-C7 style kind 9). Apps may define others (e.g. mutual reveal). */
export const CHAT_KIND = 9;

export interface RoomMessage {
  id: string;
  /** Application kind of the rumor inside MLS (9 = chat). */
  kind: number;
  /** Hex pubkey of the sender's per-event key (or the room agent). */
  sender: string;
  content: string;
  /** Unix ms. */
  createdAt: number;
}

export type RoomStatus = 'active' | 'removed' | 'disbanded';

export interface RoomInfo {
  roomId: string;
  relays: string[];
}

/** A Welcome for one new member (a NIP-59 gift wrap addressed to `recipient`). */
export interface Welcome {
  recipient: string;
  event: SignedEvent;
}

export interface RoomHandlers {
  onMessage?: (message: RoomMessage) => void;
  onStatus?: (status: RoomStatus) => void;
}

export interface MessagingAdapter {
  /** Hex pubkey of this identity. */
  readonly pubkey: string;
  /** Agent: create a room in which this identity is the only admin. */
  createRoom(opts: { name: string; relays: string[] }): Promise<RoomInfo>;
  /**
   * Participant: create a key package. It is returned to the caller (to be handed to the room
   * agent directly) and is NOT published to relays.
   */
  publishKeyPackage(): Promise<SignedEvent>;
  /** Agent: add members in one commit. Returns one Welcome per member. */
  addMember(roomId: string, keyPackages: SignedEvent[]): Promise<Welcome[]>;
  /** Participant: join from a Welcome addressed to this identity. */
  join(welcome: SignedEvent): Promise<RoomInfo>;
  /** Send an application message (default kind 9 = chat). */
  send(roomId: string, content: string, kind?: number): Promise<void>;
  /** Start receiving (backlog + live). Returns an unsubscribe function. */
  subscribe(roomId: string, handlers: RoomHandlers): Promise<() => void>;
  status(roomId: string): Promise<RoomStatus | null>;
  /** Rooms stored locally. */
  rooms(): Promise<string[]>;
  leave(roomId: string): Promise<void>;
  /** Delete local state. With `disband` (agent), first end the room for everyone. */
  destroy(roomId: string, opts?: { disband?: boolean }): Promise<void>;
  close(): Promise<void>;
}

/** Async key/value backend the Marmot stores are built on (SQLite, IndexedDB, memory). */
export interface KeyValueBackend {
  get(namespace: string, key: string): Promise<unknown>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
  clear(namespace: string): Promise<void>;
}

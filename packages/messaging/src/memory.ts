/**
 * In-memory MessagingAdapter for tests of the apps (no crypto, no relays). Behaviour mirrors
 * the Marmot one: only the creator may add members, members receive each other's messages,
 * disbanding ends the room for everyone.
 */
import type {
  MessagingAdapter,
  RoomHandlers,
  RoomInfo,
  RoomMessage,
  RoomStatus,
  SignedEvent,
  Welcome,
} from './types.js';

interface Room {
  admin: string;
  relays: string[];
  members: Set<string>;
  messages: RoomMessage[];
  disbanded: boolean;
  listeners: Map<string, RoomHandlers>;
}

export class InMemoryHub {
  readonly rooms = new Map<string, Room>();
  #seq = 0;
  nextId(prefix: string) {
    return `${prefix}${(++this.#seq).toString(16).padStart(8, '0')}`;
  }
}

const fakeEvent = (
  pubkey: string,
  kind: number,
  content: string,
  tags: string[][] = [],
): SignedEvent => ({
  id: Math.random().toString(16).slice(2).padEnd(64, '0'),
  pubkey,
  created_at: Math.floor(Date.now() / 1000),
  kind,
  tags,
  content,
  sig: '0'.repeat(128),
});

export class InMemoryAdapter implements MessagingAdapter {
  readonly #joined = new Set<string>();

  constructor(
    private readonly hub: InMemoryHub,
    readonly pubkey: string,
  ) {}

  async createRoom(opts: { name: string; relays: string[] }): Promise<RoomInfo> {
    const roomId = this.hub.nextId('room');
    this.hub.rooms.set(roomId, {
      admin: this.pubkey,
      relays: opts.relays,
      members: new Set([this.pubkey]),
      messages: [],
      disbanded: false,
      listeners: new Map(),
    });
    this.#joined.add(roomId);
    return { roomId, relays: opts.relays };
  }

  async publishKeyPackage(): Promise<SignedEvent> {
    return fakeEvent(this.pubkey, 30443, 'kp');
  }

  async addMember(roomId: string, keyPackages: SignedEvent[]): Promise<Welcome[]> {
    const room = this.#room(roomId);
    if (room.admin !== this.pubkey) throw new Error('not admin');
    if (room.disbanded) throw new Error('room disbanded');
    return keyPackages.map((kp) => {
      if (kp.kind !== 30443) throw new Error('not a key package');
      room.members.add(kp.pubkey);
      return {
        recipient: kp.pubkey,
        event: fakeEvent(this.pubkey, 1059, roomId, [['p', kp.pubkey]]),
      };
    });
  }

  async join(welcome: SignedEvent): Promise<RoomInfo> {
    const recipient = welcome.tags.find((t) => t[0] === 'p')?.[1];
    if (welcome.kind !== 1059 || recipient !== this.pubkey) throw new Error('welcome not for us');
    const room = this.#room(welcome.content);
    if (!room.members.has(this.pubkey)) throw new Error('not added');
    this.#joined.add(welcome.content);
    return { roomId: welcome.content, relays: room.relays };
  }

  async send(roomId: string, content: string): Promise<void> {
    const room = this.#room(roomId);
    if (room.disbanded || !room.members.has(this.pubkey)) throw new Error('cannot send');
    const msg: RoomMessage = {
      id: this.hub.nextId('msg'),
      sender: this.pubkey,
      content,
      createdAt: Date.now(),
    };
    room.messages.push(msg);
    for (const [pk, h] of room.listeners) if (pk !== this.pubkey) h.onMessage?.(msg);
  }

  async subscribe(roomId: string, handlers: RoomHandlers): Promise<() => void> {
    const room = this.#room(roomId);
    room.listeners.set(this.pubkey, handlers);
    for (const m of room.messages) if (m.sender !== this.pubkey) handlers.onMessage?.(m);
    return () => room.listeners.delete(this.pubkey);
  }

  async status(roomId: string): Promise<RoomStatus | null> {
    const room = this.hub.rooms.get(roomId);
    if (!room || !this.#joined.has(roomId)) return null;
    if (room.disbanded) return 'disbanded';
    return room.members.has(this.pubkey) ? 'active' : 'removed';
  }

  async rooms(): Promise<string[]> {
    return [...this.#joined];
  }

  async leave(roomId: string): Promise<void> {
    this.#room(roomId).members.delete(this.pubkey);
  }

  async destroy(roomId: string, opts: { disband?: boolean } = {}): Promise<void> {
    const room = this.hub.rooms.get(roomId);
    if (room && opts.disband) {
      if (room.admin !== this.pubkey) throw new Error('not admin');
      room.disbanded = true;
      for (const h of room.listeners.values()) h.onStatus?.('disbanded');
    }
    room?.listeners.delete(this.pubkey);
    this.#joined.delete(roomId);
  }

  async close(): Promise<void> {}

  #room(roomId: string): Room {
    const room = this.hub.rooms.get(roomId);
    if (!room) throw new Error('unknown room');
    return room;
  }
}

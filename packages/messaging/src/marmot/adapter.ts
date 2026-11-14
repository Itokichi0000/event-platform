/**
 * MessagingAdapter backed by marmot-ts 0.9.0 (alpha). This file and its siblings are the only
 * places that import marmot-ts (enforced by ESLint).
 */
import {
  createApplicationMessageIntent,
  deserializeApplicationData,
  MarmotClient,
} from '@internet-privacy/marmot-ts';
import { createInviteIntent } from '@internet-privacy/marmot-ts/client';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { getEventHash } from 'nostr-tools/pure';
import type {
  KeyValueBackend,
  MessagingAdapter,
  RoomHandlers,
  RoomInfo,
  RoomMessage,
  RoomStatus,
  SignedEvent,
  Welcome,
} from '../types.js';
import { createNetwork, type HeldNetwork, type NetworkOptions } from './network.js';
import { localSigner } from './signer.js';
import { namespacedStore } from './stores.js';

const KEY_PACKAGE_KIND = 30443;
const GIFT_WRAP_KIND = 1059;
const CHAT_KIND = 9;
/** Convergence settles after ~1 s of quiet (settlement_quiescence_ms); wait a little longer. */
const DISBAND_WAIT_MS = 15_000;

export interface MarmotAdapterOptions {
  /** 32-byte hex secret key of this identity (participant: per-event key; agent: derived key). */
  secretKey: string;
  backend: KeyValueBackend;
  /** Relays used for Welcomes and as fallback for groups without relays. */
  relays: string[];
  /** Persisted random slot id for kind 30443 (64 hex). Generated if omitted. */
  clientId?: string;
  network?: Omit<NetworkOptions, 'inboxRelays' | 'holdKinds' | 'onPublished'>;
}

type Group = Awaited<ReturnType<MarmotClient['groups']['get']>>;

export class MarmotAdapter implements MessagingAdapter {
  readonly pubkey: string;
  readonly #client: MarmotClient;
  readonly #network: HeldNetwork;
  readonly #relays: string[];
  readonly #published: SignedEvent[] = [];
  readonly #connections = new Map<string, { unsubscribe(): void }>();

  private constructor(opts: MarmotAdapterOptions, pubkey: string) {
    this.pubkey = pubkey;
    this.#relays = opts.relays;
    this.#network = createNetwork({
      ...opts.network,
      inboxRelays: () => this.#relays,
      holdKinds: [KEY_PACKAGE_KIND],
      onPublished: (e) => {
        if (e.kind === GIFT_WRAP_KIND) this.#published.push(e);
      },
    });
    const store = <T>(ns: string) => namespacedStore<T>(opts.backend, ns);
    this.#client = new MarmotClient({
      signer: localSigner(opts.secretKey),
      network: this.#network as never,
      clientId: opts.clientId ?? bytesToHex(randomBytes(32)),
      groupStateStore: store('groupState'),
      keyPackageStore: store('keyPackages'),
      inviteStore: store('invites'),
      ingestStateStore: store('ingestState'),
      rewindStore: store('rewind'),
      removedMarkerStore: store('removedMarkers'),
      lifecycleStore: store('lifecycle'),
    } as ConstructorParameters<typeof MarmotClient>[0]);
  }

  static async create(opts: MarmotAdapterOptions): Promise<MarmotAdapter> {
    const pubkey = await localSigner(opts.secretKey).getPublicKey();
    return new MarmotAdapter(opts, pubkey);
  }

  async createRoom(opts: { name: string; relays: string[] }): Promise<RoomInfo> {
    const group = await this.#client.groups.create(opts.name, {
      adminPubkeys: [this.pubkey],
      relays: opts.relays,
    });
    return { roomId: bytesToHex(group.id), relays: opts.relays };
  }

  async publishKeyPackage(): Promise<SignedEvent> {
    await this.#client.keyPackages.create({ relays: this.#relays });
    const event = this.#network.held.findLast((e) => e.kind === KEY_PACKAGE_KIND);
    if (!event) throw new Error('key package was not produced');
    return event;
  }

  async addMember(roomId: string, keyPackages: SignedEvent[]): Promise<Welcome[]> {
    const start = this.#published.length;
    const intents = keyPackages.map((keyPackageEvent) =>
      createInviteIntent({ keyPackageEvent: keyPackageEvent as never, actorPubkey: this.pubkey }),
    );
    await this.#client.groups.commit(roomId, {
      extraProposals: intents.flatMap((i) => i.extraProposals ?? []),
      welcomeRecipients: intents.flatMap((i) => i.welcomeRecipients ?? []),
    } as never);
    const wraps = this.#published.slice(start);
    return keyPackages.map((kp) => {
      const event = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === kp.pubkey));
      if (!event) throw new Error('welcome was not delivered');
      return { recipient: kp.pubkey, event };
    });
  }

  async join(welcome: SignedEvent): Promise<RoomInfo> {
    await this.#client.invites.ingestEvent(welcome as never);
    await this.#client.invites.decryptGiftWraps();
    const unread = await this.#client.invites.getUnread();
    for (const rumor of unread as { id: string }[]) {
      try {
        const { group } = await this.#client.joinGroupFromWelcome({ welcomeRumor: rumor } as never);
        await this.#client.invites.markAsRead(rumor.id);
        return { roomId: bytesToHex(group.id), relays: group.relays ?? this.#relays };
      } catch {
        /* not this one */
      }
    }
    throw new Error('no joinable welcome');
  }

  async send(roomId: string, content: string): Promise<void> {
    const rumor = {
      id: '',
      kind: CHAT_KIND,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content,
    };
    rumor.id = getEventHash(rumor);
    await this.#client.groups.send(roomId, createApplicationMessageIntent(rumor as never));
  }

  async subscribe(roomId: string, handlers: RoomHandlers): Promise<() => void> {
    const group = await this.#client.groups.get(roomId);
    const onMessage = (data: Uint8Array) => {
      try {
        const rumor = deserializeApplicationData(data) as {
          id: string;
          pubkey: string;
          content: string;
          created_at: number;
          kind: number;
        };
        if (rumor.kind !== CHAT_KIND) return;
        const msg: RoomMessage = {
          id: rumor.id,
          sender: rumor.pubkey,
          content: rumor.content,
          createdAt: rumor.created_at * 1000,
        };
        handlers.onMessage?.(msg);
      } catch {
        /* ignore malformed payloads */
      }
    };
    const onDisbanded = () => handlers.onStatus?.('disbanded');
    const onRemoved = () => handlers.onStatus?.('removed');
    group.on('applicationMessage', onMessage);
    group.on('disbanded', onDisbanded);
    group.on('removed', onRemoved);
    if (!this.#connections.has(roomId)) {
      this.#connections.set(
        roomId,
        await this.#client.groups.connect(roomId, { fallbackRelays: this.#relays }),
      );
    }
    return () => {
      group.off('applicationMessage', onMessage);
      group.off('disbanded', onDisbanded);
      group.off('removed', onRemoved);
    };
  }

  async status(roomId: string): Promise<RoomStatus | null> {
    try {
      return (await this.#client.groups.get(roomId)).status as RoomStatus;
    } catch {
      return null;
    }
  }

  async rooms(): Promise<string[]> {
    return (await this.#client.groups.loadAll()).map((g: Group) => bytesToHex(g.id));
  }

  async leave(roomId: string): Promise<void> {
    await this.#client.groups.leave(roomId);
  }

  async destroy(roomId: string, opts: { disband?: boolean } = {}): Promise<void> {
    if (opts.disband) {
      const group = await this.#client.groups.get(roomId);
      if (group.status === 'active') {
        if (!this.#connections.has(roomId)) {
          this.#connections.set(
            roomId,
            await this.#client.groups.connect(roomId, { fallbackRelays: this.#relays }),
          );
        }
        const res = await group.disband();
        if (res.kind === 'rejected' || res.kind === 'failed')
          throw new Error(`disband ${res.kind}`);
        const deadline = Date.now() + DISBAND_WAIT_MS;
        const current = () => group.status as RoomStatus;
        while (current() !== 'disbanded' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (current() !== 'disbanded') throw new Error('disband did not settle');
      }
    }
    this.#connections.get(roomId)?.unsubscribe();
    this.#connections.delete(roomId);
    await this.#client.groups.destroy(roomId);
  }

  async close(): Promise<void> {
    for (const c of this.#connections.values()) c.unsubscribe();
    this.#connections.clear();
    this.#network.close();
  }
}

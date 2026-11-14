/**
 * Keeps NWC connections and payment-notification subscriptions per event while invoices are
 * outstanding, and closes them when idle. Payment state is also checked on demand
 * (`lookup_invoice`) whenever a participant polls their quote, so notifications are an
 * accelerator, not a requirement.
 */
import type { Wallet, WalletFactory } from './wallet.js';

interface Entry {
  uri: string;
  wallet: Wallet;
  unsubscribe: (() => void) | null;
  lastUsed: number;
}

const IDLE_MS = 5 * 60 * 1000;

export class PaymentHub {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly factory: WalletFactory,
    private readonly onPaid: (eventId: string, paymentHash: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Wallet for an event, (re)connecting if the connection string changed. */
  wallet(eventId: string, uri: string): Wallet {
    let e = this.#entries.get(eventId);
    if (e && e.uri !== uri) {
      this.#drop(eventId, e);
      e = undefined;
    }
    if (!e) {
      e = { uri, wallet: this.factory(uri), unsubscribe: null, lastUsed: this.now() };
      this.#entries.set(eventId, e);
    }
    e.lastUsed = this.now();
    return e.wallet;
  }

  /** Subscribe to payment notifications for the event (best effort). */
  async watch(eventId: string, uri: string): Promise<void> {
    const wallet = this.wallet(eventId, uri);
    const e = this.#entries.get(eventId);
    if (!e || e.unsubscribe) return;
    try {
      e.unsubscribe = await wallet.subscribePayments((hash) => this.onPaid(eventId, hash));
    } catch {
      // Wallets without notification support still work through lookup_invoice polling.
    }
  }

  /** Close connections idle for longer than IDLE_MS. */
  sweep(): void {
    const cutoff = this.now() - IDLE_MS;
    for (const [id, e] of this.#entries) if (e.lastUsed < cutoff) this.#drop(id, e);
  }

  forget(eventId: string): void {
    const e = this.#entries.get(eventId);
    if (e) this.#drop(eventId, e);
  }

  closeAll(): void {
    for (const [id, e] of this.#entries) this.#drop(id, e);
  }

  #drop(id: string, e: Entry): void {
    try {
      e.unsubscribe?.();
      e.wallet.close();
    } catch {
      /* ignore */
    }
    this.#entries.delete(id);
  }
}

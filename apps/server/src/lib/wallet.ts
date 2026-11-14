/**
 * Lightning wallet access for paid tickets. The server never holds funds: invoices are created
 * in the host's own wallet through Nostr Wallet Connect (NIP-47) and paid directly to it.
 * The interface is small so tests (and the E2E suite) can substitute a mock.
 */
import { NWCClient } from '@getalby/sdk/nwc';

export type InvoiceState = 'settled' | 'pending' | 'failed' | 'expired';

export interface Invoice {
  invoice: string;
  paymentHash: string;
  /** Unix ms. */
  expiresAt: number;
}

export interface Wallet {
  /** NIP-47 methods the connection may call. */
  methods(): Promise<string[]>;
  makeInvoice(amountMsat: number, description: string, expirySeconds: number): Promise<Invoice>;
  lookupInvoice(paymentHash: string): Promise<InvoiceState>;
  /** Calls `onPaid(paymentHash)` for incoming payments. Returns an unsubscribe function. */
  subscribePayments(onPaid: (paymentHash: string) => void): Promise<() => void>;
  close(): void;
}

export type WalletFactory = (nwcUri: string) => Wallet;

export class InvalidNwcUriError extends Error {
  constructor() {
    super('invalid NWC connection string');
    this.name = 'InvalidNwcUriError';
  }
}

/** Validates the shape of a `nostr+walletconnect://` URI without connecting. */
export function parseNwcUri(uri: string): { walletPubkey: string; relayUrls: string[] } {
  try {
    const opts = NWCClient.parseWalletConnectUrl(uri.trim(), true);
    if (!/^[0-9a-f]{64}$/.test(opts.walletPubkey) || opts.relayUrls.length === 0) throw new Error();
    return { walletPubkey: opts.walletPubkey, relayUrls: opts.relayUrls };
  } catch {
    throw new InvalidNwcUriError();
  }
}

export const nwcWalletFactory: WalletFactory = (uri) => {
  const client = new NWCClient({ nostrWalletConnectUrl: uri.trim() });
  return {
    async methods() {
      return (await client.getInfo()).methods;
    },
    async makeInvoice(amountMsat, description, expirySeconds) {
      const tx = await client.makeInvoice({
        amount: amountMsat,
        description,
        expiry: expirySeconds,
      });
      return {
        invoice: tx.invoice,
        paymentHash: tx.payment_hash,
        expiresAt: (tx.expires_at || Math.floor(Date.now() / 1000) + expirySeconds) * 1000,
      };
    },
    async lookupInvoice(paymentHash) {
      const tx = await client.lookupInvoice({ payment_hash: paymentHash });
      if (tx.state === 'settled') return 'settled';
      if (tx.state === 'failed') return 'failed';
      if (tx.expires_at && tx.expires_at * 1000 < Date.now()) return 'expired';
      return 'pending';
    },
    async subscribePayments(onPaid) {
      return client.subscribeNotifications(
        (n) => {
          if (n.notification.type === 'incoming' && n.notification.state !== 'failed') {
            onPaid(n.notification.payment_hash);
          }
        },
        ['payment_received'],
      );
    },
    close() {
      client.close();
    },
  };
};

/**
 * In-memory wallet for tests and local development (`KAMEN_MOCK_WALLET=1`, refused in
 * production). Invoices settle after `settleAfterMs`, or explicitly via `settle()`.
 */
export class MockWalletBackend {
  readonly invoices = new Map<
    string,
    { amountMsat: number; settled: boolean; createdAt: number }
  >();
  readonly #listeners = new Set<(hash: string) => void>();
  methodsList = ['get_info', 'make_invoice', 'lookup_invoice'];
  failNext = false;

  constructor(
    private readonly settleAfterMs: number | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  settle(paymentHash: string): void {
    const inv = this.invoices.get(paymentHash);
    if (!inv) throw new Error('unknown invoice');
    inv.settled = true;
    for (const l of this.#listeners) l(paymentHash);
  }

  factory: WalletFactory = (uri) => {
    parseNwcUri(uri);
    return {
      methods: async () => this.methodsList,
      makeInvoice: async (amountMsat, _description, expirySeconds) => {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('wallet unavailable');
        }
        const paymentHash = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
        this.invoices.set(paymentHash, { amountMsat, settled: false, createdAt: this.now() });
        return {
          invoice: `lnbcrt${Math.floor(amountMsat / 1000)}n1mock${paymentHash.slice(0, 20)}`,
          paymentHash,
          expiresAt: this.now() + expirySeconds * 1000,
        };
      },
      lookupInvoice: async (paymentHash) => {
        const inv = this.invoices.get(paymentHash);
        if (!inv) throw new Error('unknown invoice');
        if (
          !inv.settled &&
          this.settleAfterMs !== null &&
          this.now() - inv.createdAt >= this.settleAfterMs
        ) {
          inv.settled = true;
        }
        return inv.settled ? 'settled' : 'pending';
      },
      subscribePayments: async (onPaid) => {
        this.#listeners.add(onPaid);
        return () => this.#listeners.delete(onPaid);
      },
      close: () => {},
    };
  };
}

/**
 * In-memory set whose entries expire. Used for single-use PoW challenge ids and NIP-98 event ids.
 * Deliberately not persisted: it holds nothing about participants and is useless after expiry.
 * (A restart forgets used ids; the PoW TTL bounds the replay window, see docs/PRIVACY.md.)
 */
export class TtlSet {
  readonly #entries = new Map<string, number>();
  readonly #maxSize: number;

  constructor(maxSize = 100_000) {
    this.#maxSize = maxSize;
  }

  /** Adds `key` until `expiresAt` (ms). Returns false if it was already present (replay). */
  add(key: string, expiresAt: number, now = Date.now()): boolean {
    this.#sweep(now);
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing > now) return false;
    if (this.#entries.size >= this.#maxSize) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, expiresAt);
    return true;
  }

  #sweep(now: number): void {
    if (this.#entries.size < 1000) return;
    for (const [k, exp] of this.#entries) if (exp <= now) this.#entries.delete(k);
  }
}

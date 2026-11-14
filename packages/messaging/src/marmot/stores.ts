import type { KeyValueBackend } from '../types.js';

/** marmot-ts's GenericKeyValueStore shape. */
export interface KvStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

/** One namespaced store over a backend. Writes are serialized per namespace. */
export function namespacedStore<T>(backend: KeyValueBackend, namespace: string): KvStore<T> {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    getItem: async (key) => ((await backend.get(namespace, key)) as T | undefined) ?? null,
    setItem: (key, value) => serial(async () => (await backend.set(namespace, key, value), value)),
    removeItem: (key) => serial(() => backend.delete(namespace, key)),
    clear: () => serial(() => backend.clear(namespace)),
    keys: () => backend.keys(namespace),
  };
}

/** In-memory backend (tests, short-lived processes). */
export class MemoryBackend implements KeyValueBackend {
  readonly data = new Map<string, Map<string, unknown>>();
  #ns(n: string) {
    let m = this.data.get(n);
    if (!m) this.data.set(n, (m = new Map()));
    return m;
  }
  async get(n: string, k: string) {
    return this.#ns(n).get(k);
  }
  async set(n: string, k: string, v: unknown) {
    this.#ns(n).set(k, v);
  }
  async delete(n: string, k: string) {
    this.#ns(n).delete(k);
  }
  async keys(n: string) {
    return [...this.#ns(n).keys()];
  }
  async clear(n: string) {
    this.#ns(n).clear();
  }
}

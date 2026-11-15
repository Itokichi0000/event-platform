import type { PowChallenge } from '@kamen/core';

/**
 * Solve a PoW challenge with several Web Workers in parallel (disjoint nonce ranges).
 * `onProgress` receives the estimated completion ratio (0..1, capped at 0.99).
 */
export function solvePowInWorkers(
  challenge: PowChallenge,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const n = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  const expected = 2 ** challenge.difficulty;
  const workers: Worker[] = [];
  let attempts = 0;

  return new Promise<number>((resolve, reject) => {
    const stop = () => workers.forEach((w) => w.terminate());
    signal?.addEventListener('abort', () => {
      stop();
      reject(new DOMException('aborted', 'AbortError'));
    });
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      w.onmessage = (
        e: MessageEvent<
          { type: 'progress'; delta: number } | { type: 'done'; nonce: number | null }
        >,
      ) => {
        if (e.data.type === 'progress') {
          attempts += e.data.delta;
          onProgress?.(Math.min(0.99, 1 - Math.exp(-attempts / expected)));
        } else if (e.data.nonce !== null) {
          stop();
          onProgress?.(1);
          resolve(e.data.nonce);
        }
      };
      w.onerror = (err) => {
        stop();
        reject(err);
      };
      // 2^40 nonces per worker: far beyond any difficulty we use.
      w.postMessage({ challenge, startNonce: i * 2 ** 40 });
    }
  });
}

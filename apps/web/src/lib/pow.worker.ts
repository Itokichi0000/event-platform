/// <reference lib="webworker" />
import { solvePow, type PowChallenge } from '@kamen/core/pow';

interface Job {
  challenge: PowChallenge;
  startNonce: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { challenge, startNonce } = e.data;
  let last = 0;
  const nonce = solvePow(challenge, {
    startNonce,
    progressEvery: 20_000,
    onProgress: (attempts) => {
      self.postMessage({ type: 'progress', delta: attempts - last });
      last = attempts;
    },
  });
  self.postMessage({ type: 'done', nonce });
};

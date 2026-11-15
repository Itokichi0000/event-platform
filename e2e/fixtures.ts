import type { BrowserContext } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

/** Installs a fake NIP-07 extension (window.nostr) backed by a key held in the test process. */
export async function installNostrSigner(context: BrowserContext) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  await context.exposeFunction('__kamenGetPubkey', () => pubkey);
  await context.exposeFunction('__kamenSign', (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, sk),
  );
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: () => w.__kamenGetPubkey!(),
      signEvent: (e: unknown) => w.__kamenSign!(e),
    };
  });
  return { pubkey };
}

import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { nip98Header } from '../src/lib/nostr';

describe('nip98Header', () => {
  it('signs URL, method and body hash as NIP-98 requires', async () => {
    const sk = generateSecretKey();
    const signer = {
      signEvent: async (e: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(e, sk),
    };
    const body = JSON.stringify({ a: 1 });
    const header = await nip98Header(signer, 'https://kamen.example/api/events', 'post', body);
    expect(header.startsWith('Nostr ')).toBe(true);
    const ev = JSON.parse(atob(header.slice(6)));
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(27235);
    expect(ev.tags).toContainEqual(['u', 'https://kamen.example/api/events']);
    expect(ev.tags).toContainEqual(['method', 'POST']);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(ev.tags).toContainEqual(['payload', hex]);
  });

  it('omits the payload tag for bodiless requests', async () => {
    const sk = generateSecretKey();
    const header = await nip98Header(
      { signEvent: async (e) => finalizeEvent(e, sk) },
      'https://kamen.example/api/host/session',
      'POST',
    );
    const ev = JSON.parse(atob(header.slice(6)));
    expect(ev.tags.find((t: string[]) => t[0] === 'payload')).toBeUndefined();
  });
});

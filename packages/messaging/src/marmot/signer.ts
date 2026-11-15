/** Nostr signer with NIP-44 (what marmot-ts needs to seal and open Welcome gift wraps). */
import { hexToBytes } from '@noble/hashes/utils.js';
import { getConversationKey, decrypt, encrypt } from 'nostr-tools/nip44';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

export interface LocalSigner {
  getPublicKey(): Promise<string>;
  signEvent(draft: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  }>;
  nip44: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

export function localSigner(secretKeyHex: string): LocalSigner {
  const sk = hexToBytes(secretKeyHex);
  const pubkey = getPublicKey(sk);
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (draft) =>
      finalizeEvent(
        {
          kind: draft.kind,
          created_at: draft.created_at,
          tags: draft.tags,
          content: draft.content,
        },
        sk,
      ),
    nip44: {
      encrypt: async (peer, plaintext) => encrypt(plaintext, getConversationKey(sk, peer)),
      decrypt: async (peer, ciphertext) => decrypt(ciphertext, getConversationKey(sk, peer)),
    },
  };
}

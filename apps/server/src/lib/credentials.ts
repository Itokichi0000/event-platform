/**
 * Check-in credentials (vote keyset) and per-scope pseudonyms.
 *
 * A credential is a blind-signed token handed out at check-in. Presenting it proves "checked in
 * at this event" without revealing which ticket. To stop the database from linking a person's
 * actions across polls / questions / draws, only HMAC(scope, Y) is stored, never Y itself.
 */
import { createHmac } from 'node:crypto';
import { isKeysetId, isSecret, spentKey, verifyProofWithKeyset } from '@kamen/core';
import { z } from 'zod';
import { apiError, ensureEventKeyset, loadKeyset, type AppContext } from '../context.js';
import { deriveKey } from './secrets.js';

export const credentialSchema = z
  .object({
    keysetId: z.string().refine(isKeysetId),
    secret: z.string().refine(isSecret),
    C: z.string().regex(/^0[23][0-9a-f]{64}$/),
  })
  .strict();

export type Credential = z.infer<typeof credentialSchema>;

/** Verify a check-in credential for the event; returns its spent identifier Y. */
export function verifyCredential(ctx: AppContext, eventId: string, cred: Credential): string {
  ensureEventKeyset(ctx, eventId, 'vote');
  const keyset = loadKeyset(ctx, eventId, 'vote');
  if (cred.keysetId !== keyset.id || !verifyProofWithKeyset(cred, keyset)) {
    apiError(403, 'invalid_credential');
  }
  return spentKey(cred.secret);
}

let pseudonymKey: Buffer | null = null;
let pseudonymFor: Uint8Array | null = null;

/** HMAC(scope, Y): stable within one poll / question / draw, unlinkable across scopes. */
export function pseudonym(ctx: AppContext, scope: string, y: string): string {
  if (pseudonymFor !== ctx.config.masterKey) {
    pseudonymKey = deriveKey(ctx.config.masterKey, 'credential-pseudonym');
    pseudonymFor = ctx.config.masterKey;
  }
  return createHmac('sha256', pseudonymKey as Buffer)
    .update(`${scope}\n${y}`)
    .digest('hex');
}

import { describe, expect, it } from 'vitest';
import {
  finalizeIssue,
  generateKeyset,
  InvalidSignatureError,
  keysetFromPrivateKey,
  KEYSET_KINDS,
  prepareIssue,
  signIssueRequest,
  spentKey,
  toIssueRequest,
  toPublicKeyset,
  toRedeemPayload,
  verifyProofOffline,
  verifyProofWithKeyset,
  type Proof,
} from '../src/index.js';

function issue(kind: (typeof KEYSET_KINDS)[number] = 'ticket') {
  const keyset = generateKeyset(kind);
  const pub = toPublicKeyset(keyset);
  const pending = prepareIssue(pub);
  const response = signIssueRequest(toIssueRequest(pending), keyset);
  return { keyset, pub, pending, response, proof: finalizeIssue(pending, response, pub) };
}

describe('keysets', () => {
  it.each(KEYSET_KINDS)('generates a %s keyset with a v1 id', (kind) => {
    const ks = generateKeyset(kind);
    expect(ks.kind).toBe(kind);
    expect(ks.id).toMatch(/^00[0-9a-f]{14}$/);
    expect(ks.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(ks.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keysetFromPrivateKey(kind, ks.privateKey)).toEqual(ks);
  });

  it('public view omits the private key', () => {
    expect(toPublicKeyset(generateKeyset('room'))).not.toHaveProperty('privateKey');
  });

  it('rejects unknown kinds', () => {
    expect(() => generateKeyset('sats' as never)).toThrow(TypeError);
  });
});

describe('issue → redeem lifecycle', () => {
  it('produces a proof that verifies offline and with the private key', () => {
    const { keyset, pub, proof } = issue();
    expect(verifyProofOffline(proof, pub)).toBe(true);
    expect(verifyProofWithKeyset(toRedeemPayload(proof), keyset)).toBe(true);
  });

  it('only sends keysetId and B_ to the server', () => {
    const { pending } = issue();
    expect(Object.keys(toIssueRequest(pending)).sort()).toEqual(['B_', 'keysetId']);
  });

  it('redeem payload carries no DLEQ / blinding factor', () => {
    const { proof } = issue();
    const payload = toRedeemPayload(proof);
    expect(payload).toEqual({ keysetId: proof.keysetId, secret: proof.secret, C: proof.C });
    expect(JSON.stringify(payload)).not.toContain(proof.dleq!.r);
  });

  it('the server-visible B_ is unrelated to the redeemed secret and C', () => {
    const { pending, response, proof } = issue();
    const redeemed = JSON.stringify(toRedeemPayload(proof));
    expect(redeemed).not.toContain(pending.B_);
    expect(redeemed).not.toContain(response.C_);
  });

  it('fresh secrets and blinding factors every time', () => {
    const pub = toPublicKeyset(generateKeyset('ticket'));
    const a = prepareIssue(pub);
    const b = prepareIssue(pub);
    expect(a.secret).not.toBe(b.secret);
    expect(a.r).not.toBe(b.r);
    expect(a.B_).not.toBe(b.B_);
  });

  it('rejects a signature made with a key other than the advertised one (tagging attack)', () => {
    const advertised = generateKeyset('ticket');
    const tagging = generateKeyset('ticket');
    const pending = prepareIssue(toPublicKeyset(advertised));
    const evil = signIssueRequest(toIssueRequest(pending), { ...tagging, id: advertised.id });
    expect(() => finalizeIssue(pending, evil, toPublicKeyset(advertised))).toThrow(
      InvalidSignatureError,
    );
  });

  it('rejects mismatching keyset ids', () => {
    const { keyset, pending } = issue();
    const other = generateKeyset('ticket');
    expect(() => signIssueRequest(toIssueRequest(pending), other)).toThrow(InvalidSignatureError);
    const response = signIssueRequest(toIssueRequest(pending), keyset);
    expect(() => finalizeIssue(pending, response, toPublicKeyset(other))).toThrow(
      InvalidSignatureError,
    );
  });

  it('a ticket from one keyset does not verify under another (e.g. room vs ticket)', () => {
    const { proof } = issue('ticket');
    const room = generateKeyset('room');
    const forged: Proof = { ...proof, keysetId: room.id };
    expect(verifyProofOffline(forged, toPublicKeyset(room))).toBe(false);
    expect(verifyProofWithKeyset(toRedeemPayload(forged), room)).toBe(false);
  });

  it('rejects forged or tampered proofs', () => {
    const { keyset, pub, proof } = issue();
    const other = issue().proof;
    const swappedC: Proof = { ...proof, C: other.C };
    expect(verifyProofOffline(swappedC, pub)).toBe(false);
    expect(verifyProofWithKeyset(toRedeemPayload(swappedC), keyset)).toBe(false);
    const swappedSecret: Proof = { ...proof, secret: other.secret };
    expect(verifyProofOffline(swappedSecret, pub)).toBe(false);
    expect(verifyProofWithKeyset(toRedeemPayload(swappedSecret), keyset)).toBe(false);
    expect(verifyProofOffline({ ...proof, C: 'zz' }, pub)).toBe(false);
    expect(verifyProofWithKeyset({ ...toRedeemPayload(proof), secret: 'nothex' }, keyset)).toBe(
      false,
    );
  });

  it('offline verification needs the DLEQ', () => {
    const { pub, proof } = issue();
    const { dleq: _dleq, ...noDleq } = proof;
    expect(verifyProofOffline(noDleq, pub)).toBe(false);
  });
});

describe('spentKey', () => {
  it('is deterministic per secret and differs between secrets', () => {
    const a = issue().proof;
    const b = issue().proof;
    expect(spentKey(a.secret)).toBe(spentKey(a.secret));
    expect(spentKey(a.secret)).not.toBe(spentKey(b.secret));
    expect(spentKey(a.secret)).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it('rejects malformed secrets', () => {
    expect(() => spentKey('abc')).toThrow();
  });
});

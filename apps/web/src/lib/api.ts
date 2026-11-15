import type {
  IssueRequest,
  IssueResponse,
  PowChallenge,
  PublicKeyset,
  RedeemPayload,
  CheckinExtras,
} from '@kamen/core';
import type { SignedEvent } from '@kamen/messaging';

export interface Announcement {
  id: string;
  body: string;
  createdAt: number;
}

export type IssuePolicy = 'pow' | 'invite' | 'paid' | 'approval';

export interface PublicEvent {
  id: string;
  hostPubkey: string;
  title: string;
  description: string;
  startsAt: number;
  endsAt: number;
  location: string | null;
  locationVisibility: 'public' | 'ticket_holders';
  capacity: number;
  remaining: number;
  issuePolicy: IssuePolicy;
  priceMsat: number;
  paymentsReady: boolean;
  status: 'draft' | 'published' | 'cancelled';
  coverVersion: number | null;
  offlineCheckin: boolean;
  /** A room pass can be issued / the room can be entered right now. */
  roomAvailable: boolean;
  roomRelays: string[];
  /** Hold-invoice deposit (0 = none), refunded at check-in. */
  depositMsat: number;
  /** Stamps of this host required to get a ticket (regulars-first). */
  minStamps: number;
  /** The host's stamp (御朱印) public key. */
  stampKeyset: PublicKeyset;
  keysets: PublicKeyset[];
  announcements: Announcement[];
}

export interface HostEvent extends PublicEvent {
  location: string;
  issued: number;
  redeemed: number;
  returned: number;
  walletConnected: boolean;
  roomEnabled: boolean;
  /** The server has rooms configured (ROOM_RELAYS). */
  roomsConfigured: boolean;
  role: 'owner' | 'cohost';
  createdAt: number;
  updatedAt: number;
}

export interface EventInput {
  title: string;
  description: string;
  startsAt: number;
  endsAt: number;
  location: string;
  locationVisibility: 'public' | 'ticket_holders';
  capacity: number;
  issuePolicy: IssuePolicy;
  priceMsat: number;
  offlineCheckin: boolean;
  roomEnabled: boolean;
  depositMsat: number;
  minStamps: number;
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  status: 'open' | 'closed';
  createdAt: number;
}

export interface Question {
  id: string;
  body: string;
  upvotes: number;
  hidden?: boolean;
  createdAt: number;
}

export interface Draw {
  id: string;
  title: string;
  winners: number;
  status: 'open' | 'drawn';
  entries: number;
  winningCodes: string[];
  createdAt: number;
}

export interface Application {
  id: string;
  pubkey: string;
  state: 'pending' | 'approved' | 'rejected' | 'issued';
  createdAt: number;
}

export interface Stats {
  capacity: number;
  issued: number;
  redeemed: number;
  returned: number;
  checkinsPer15Min: { start: number; count: number }[];
}

export interface ScannerLink {
  id: string;
  label: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface InviteCode {
  id: string;
  label: string;
  maxUses: number;
  usesLeft: number;
}

export type Quote =
  | { kind: 'pow'; challenge: PowChallenge }
  | { kind: 'invoice'; quoteId: string; invoice: string; amountMsat: number; expiresAt: number };

export type QuoteState = 'unpaid' | 'paid' | 'issued' | 'expired';

export interface ScannerSession {
  eventId: string;
  title: string;
  expiresAt: number;
  issued: number;
  redeemed: number;
  offlineCheckin: boolean;
  status: PublicEvent['status'];
}

export interface RoomJoinResult {
  roomId: string;
  agentPubkey: string;
  relays: string[];
  welcome: SignedEvent;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Network failure (offline, server down) as opposed to an API error response. */
export class NetworkError extends Error {
  constructor() {
    super('network_error');
    this.name = 'NetworkError';
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // credentials: 'omit' — the API never uses cookies.
    res = await fetch(path, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new NetworkError();
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const ev = (id: string) => `/api/events/${encodeURIComponent(id)}`;
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

export const api = {
  event: (id: string) => request<PublicEvent>(ev(id)),
  coverUrl: (id: string, version: number) => `${ev(id)}/cover?v=${version}`,
  quote: (id: string) => request<Quote>(`${ev(id)}/quote`, { method: 'POST' }),
  quoteStatus: (id: string, quoteId: string) =>
    request<{ state: QuoteState; expiresAt: number }>(
      `${ev(id)}/quotes/${encodeURIComponent(quoteId)}`,
    ),
  issue: (
    id: string,
    body: {
      pow?: { challenge: PowChallenge; nonce: number };
      invite?: string;
      quoteId?: string;
      approval?: { id: string; token: string };
      depositId?: string;
      stamps?: { proofs: RedeemPayload[]; outputs: IssueRequest[] };
      outputs: { ticket: IssueRequest; room?: IssueRequest };
    },
  ) =>
    request<{
      signatures: { ticket: IssueResponse; room?: IssueResponse };
      stampSignatures?: IssueResponse[];
      location: string | null;
    }>(`${ev(id)}/issue`, json(body)),
  roomJoin: (id: string, pass: RedeemPayload, keyPackage: SignedEvent) =>
    request<RoomJoinResult>(`${ev(id)}/room/join`, json({ pass, keyPackage })),
  returnTicket: (id: string, payload: RedeemPayload & { depositRef?: string }) =>
    request<{ ok: true; deposit: string | null }>(`${ev(id)}/return`, json(payload)),
  pickupSignature: (blinded: string) =>
    request<IssueResponse & { kind: 'stamp' | 'vote' }>(`/api/stamps/${blinded}`),
  polls: (id: string) => request<Poll[]>(`${ev(id)}/polls`),
  vote: (id: string, pollId: string, credential: RedeemPayload, option: number) =>
    request<{ ok: true }>(`${ev(id)}/polls/${pollId}/vote`, json({ credential, option })),
  questions: (id: string) => request<Question[]>(`${ev(id)}/questions`),
  ask: (id: string, credential: RedeemPayload, body: string) =>
    request<{ id: string }>(`${ev(id)}/questions`, json({ credential, body })),
  upvote: (id: string, qid: string, credential: RedeemPayload) =>
    request<{ ok: true }>(`${ev(id)}/questions/${qid}/upvote`, json({ credential })),
  draws: (id: string) => request<Draw[]>(`${ev(id)}/draws`),
  enterDraw: (id: string, did: string, credential: RedeemPayload) =>
    request<{ code: string }>(`${ev(id)}/draws/${did}/enter`, json({ credential })),
  createDeposit: (id: string) =>
    request<{ depositId: string; invoice: string; amountMsat: number; expiresAt: number }>(
      `${ev(id)}/deposit`,
      { method: 'POST' },
    ),
  depositStatus: (id: string, did: string) =>
    request<{
      state: 'unpaid' | 'held' | 'issued' | 'refunded' | 'settled' | 'expired';
      expiresAt: number;
    }>(`${ev(id)}/deposits/${did}`),
  applicationStatus: (id: string, aid: string, token: string) =>
    request<{ state: Application['state'] }>(`${ev(id)}/applications/${aid}`, {
      headers: { 'x-kamen-claim': token },
    }),
  scannerSession: (id: string, token: string) =>
    request<ScannerSession>(`${ev(id)}/scanner-session`, bearer(token)),
  spentList: (id: string, token: string) =>
    request<{ ys: string[] }>(`${ev(id)}/spent`, bearer(token)),
  redeem: (id: string, token: string, payload: RedeemPayload & CheckinExtras) =>
    request<{ ok: true; redeemed: number; capacity: number; issued: number }>(`${ev(id)}/redeem`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

import type {
  IssueRequest,
  IssueResponse,
  PowChallenge,
  PublicKeyset,
  RedeemPayload,
} from '@kamen/core';
import type { SignedEvent } from '@kamen/messaging';

export interface Announcement {
  id: string;
  body: string;
  createdAt: number;
}

export type IssuePolicy = 'pow' | 'invite' | 'paid';

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
      outputs: { ticket: IssueRequest; room?: IssueRequest };
    },
  ) =>
    request<{
      signatures: { ticket: IssueResponse; room?: IssueResponse };
      location: string | null;
    }>(`${ev(id)}/issue`, json(body)),
  roomJoin: (id: string, pass: RedeemPayload, keyPackage: SignedEvent) =>
    request<RoomJoinResult>(`${ev(id)}/room/join`, json({ pass, keyPackage })),
  returnTicket: (id: string, payload: RedeemPayload) =>
    request<{ ok: true }>(`${ev(id)}/return`, json(payload)),
  scannerSession: (id: string, token: string) =>
    request<ScannerSession>(`${ev(id)}/scanner-session`, bearer(token)),
  spentList: (id: string, token: string) =>
    request<{ ys: string[] }>(`${ev(id)}/spent`, bearer(token)),
  redeem: (id: string, token: string, payload: RedeemPayload) =>
    request<{ ok: true; redeemed: number; capacity: number; issued: number }>(`${ev(id)}/redeem`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

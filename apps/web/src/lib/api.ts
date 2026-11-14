import type {
  IssueRequest,
  IssueResponse,
  PowChallenge,
  PublicKeyset,
  RedeemPayload,
} from '@kamen/core';

export interface Announcement {
  id: string;
  body: string;
  createdAt: number;
}

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
  issuePolicy: 'pow';
  status: 'draft' | 'published' | 'cancelled';
  coverVersion: number | null;
  offlineCheckin: boolean;
  keysets: PublicKeyset[];
  announcements: Announcement[];
}

export interface HostEvent extends PublicEvent {
  location: string;
  issued: number;
  redeemed: number;
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
}

export interface Stats {
  capacity: number;
  issued: number;
  redeemed: number;
  checkinsPer15Min: { start: number; count: number }[];
}

export interface ScannerLink {
  id: string;
  label: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
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

export const api = {
  event: (id: string) => request<PublicEvent>(`/api/events/${encodeURIComponent(id)}`),
  coverUrl: (id: string, version: number) =>
    `/api/events/${encodeURIComponent(id)}/cover?v=${version}`,
  quote: (id: string) =>
    request<{ kind: 'pow'; challenge: PowChallenge }>(
      `/api/events/${encodeURIComponent(id)}/quote`,
      { method: 'POST' },
    ),
  issue: (
    id: string,
    body: { pow: { challenge: PowChallenge; nonce: number }; outputs: { ticket: IssueRequest } },
  ) =>
    request<{ signatures: { ticket: IssueResponse }; location: string | null }>(
      `/api/events/${encodeURIComponent(id)}/issue`,
      json(body),
    ),
  scannerSession: (id: string, token: string) =>
    request<{
      eventId: string;
      title: string;
      expiresAt: number;
      issued: number;
      redeemed: number;
    }>(`/api/events/${encodeURIComponent(id)}/scanner-session`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  redeem: (id: string, token: string, payload: RedeemPayload) =>
    request<{ ok: true; redeemed: number; capacity: number; issued: number }>(
      `/api/events/${encodeURIComponent(id)}/redeem`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ),
};

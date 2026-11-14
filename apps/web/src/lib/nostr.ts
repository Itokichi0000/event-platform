/**
 * Host login: NIP-07 browser extension signs one NIP-98 event, exchanged for a short-lived
 * session token kept in sessionStorage (never a cookie).
 */
import { npubEncode } from 'nostr-tools/nip19';
import { request } from './api';

interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(e: UnsignedEvent): Promise<UnsignedEvent & { id: string; pubkey: string; sig: string }>;
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build a NIP-98 `Authorization` header value with the given signer. */
export async function nip98Header(
  signer: Pick<Nip07, 'signEvent'>,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (body !== undefined) tags.push(['payload', await sha256Hex(body)]);
  const signed = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });
  const json = JSON.stringify(signed);
  return 'Nostr ' + btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

const SESSION_KEY = 'kamen.hostSession';

export interface HostSession {
  token: string;
  expiresAt: number;
  pubkey: string;
}

export function getSession(): HostSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as HostSession;
    return s.expiresAt > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export async function login(): Promise<HostSession> {
  if (!window.nostr) throw new Error('no_nip07');
  const pubkey = await window.nostr.getPublicKey();
  const url = new URL('/api/host/session', location.origin).toString();
  const authorization = await nip98Header(window.nostr, url, 'POST');
  const res = await request<{ token: string; expiresAt: number }>('/api/host/session', {
    method: 'POST',
    headers: { authorization },
  });
  const session = { ...res, pubkey };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/** Authenticated host request. */
export function hostRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = getSession();
  if (!s) return Promise.reject(new Error('not_logged_in'));
  return request<T>(path, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${s.token}` },
  });
}

export function hostJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  return hostRequest<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

export function shortNpub(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
  } catch {
    return pubkey.slice(0, 8);
  }
}

/** API server → room agent. The agent runs as a separate process (src/agent/). */
import type { SignedEvent } from '@kamen/messaging';
import { agentSecret, AGENT_SECRET_HEADER } from '../agent/app.js';

export interface JoinResult {
  roomId: string;
  agentPubkey: string;
  relays: string[];
  welcome: SignedEvent;
}

export interface AgentClient {
  join(
    eventId: string,
    title: string,
    endsAt: number,
    keyPackage: SignedEvent,
  ): Promise<JoinResult>;
  announce(eventId: string, body: string): Promise<void>;
  disband(eventId: string): Promise<void>;
}

export class AgentRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentRequestError';
  }
}

export function httpAgentClient(
  baseUrl: string,
  masterKey: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): AgentClient {
  const secret = agentSecret(masterKey);
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          [AGENT_SECRET_HEADER]: secret,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AgentRequestError('agent_unreachable');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new AgentRequestError(data.error ?? `agent_${res.status}`);
    return data as T;
  };
  return {
    join: (eventId, title, endsAt, keyPackage) =>
      call('POST', `/rooms/${eventId}/join`, { title, endsAt, keyPackage }),
    announce: async (eventId, body) =>
      void (await call('POST', `/rooms/${eventId}/announce`, { body })),
    disband: async (eventId) => void (await call('DELETE', `/rooms/${eventId}`, undefined, 60_000)),
  };
}

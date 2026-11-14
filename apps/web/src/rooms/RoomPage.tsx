import type { MessagingAdapter, RoomMessage } from '@kamen/messaging';
import { ArrowLeft, LogOut, Megaphone, Send, ShieldAlert, VenetianMask } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { lang, t } from '@/i18n';
import { api, type PublicEvent } from '@/lib/api';
import { ticketsForEvent, type StoredTicket } from '@/lib/db';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { adapterFor, forgetRoom, joinRoom, leaveRoom } from './client';
import { maskName } from './mask';
import { MaskAvatar } from './MaskAvatar';
import { roomStore, type RoomRecord, type StoredMessage } from './store';

type Ended = 'disbanded' | 'removed' | null;

export function RoomPage() {
  const { eventId = '' } = useParams();
  const [record, setRecord] = useState<RoomRecord | null | undefined>(undefined);
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [ticket, setTicket] = useState<StoredTicket | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<Ended>(null);

  useEffect(() => {
    roomStore.get(eventId).then(
      (r) => setRecord(r ?? null),
      () => setRecord(null),
    );
    api.event(eventId).then(setEvent, () => {});
    ticketsForEvent(eventId).then(
      (ts) => setTicket(ts[0] ?? null),
      () => {},
    );
  }, [eventId]);

  if (record === undefined) {
    return (
      <Layout>
        <PageMessage title={t.app.loading}>
          <Spinner />
        </PageMessage>
      </Layout>
    );
  }

  if (ended) {
    return (
      <Layout>
        <PageMessage title={ended === 'disbanded' ? t.room.disbanded : t.room.removed}>
          <Button asChild variant="outline">
            <Link to="/tickets">{t.app.myTickets}</Link>
          </Button>
        </PageMessage>
      </Layout>
    );
  }

  if (record) return <Chat record={record} onEnded={setEnded} />;

  const canJoin = !!ticket?.roomPass && !!event?.roomAvailable;

  async function enter() {
    if (!ticket || !event) return;
    setJoining(true);
    setError(null);
    try {
      setRecord(await joinRoom(ticket, event));
    } catch {
      setError(t.room.joinFailed);
      setJoining(false);
    }
  }

  return (
    <Layout>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <VenetianMask className="size-6 text-primary" />
        {t.room.title}
      </h1>
      {event && <p className="mt-1 text-sm text-muted-foreground">{event.title}</p>}
      <p className="mt-4 text-sm">{t.room.intro}</p>
      <PrivacyCard />
      {error && (
        <Alert variant="destructive" className="mt-4">
          {error}
        </Alert>
      )}
      {!canJoin && event && (
        <Alert variant="warning" className="mt-4">
          {event.roomAvailable ? t.room.noPass : t.room.unavailable}
        </Alert>
      )}
      <Button size="xl" className="mt-6 w-full" disabled={!canJoin || joining} onClick={enter}>
        {joining ? <Spinner /> : <VenetianMask />}
        {joining ? t.room.joining : t.room.enter}
      </Button>
    </Layout>
  );
}

function PrivacyCard({ compact = false }: { compact?: boolean }) {
  const body = (
    <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      {t.room.privacy.map((p) => (
        <li key={p} className="flex gap-2">
          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-warning" />
          {p}
        </li>
      ))}
    </ul>
  );
  if (compact) {
    return (
      <details className="border-b px-4 py-2" data-testid="room-privacy">
        <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-warning">
          <ShieldAlert className="size-3.5" />
          {t.event.privacyTitle}
        </summary>
        <div className="mt-2">{body}</div>
      </details>
    );
  }
  return (
    <Card className="mt-4 border-warning/30" data-testid="room-privacy">
      <CardContent className="pt-5">{body}</CardContent>
    </Card>
  );
}

function Chat({ record, onEnded }: { record: RoomRecord; onEnded: (e: Ended) => void }) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const adapterRef = useRef<MessagingAdapter | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | null = null;
    const add = (m: RoomMessage) => {
      const stored = { ...m, eventId: record.eventId };
      void roomStore.addMessage(stored);
      setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, stored]));
    };
    const end = async (status: 'disbanded' | 'removed') => {
      await forgetRoom(record);
      if (alive) onEnded(status);
    };
    (async () => {
      setMessages(await roomStore.messages(record.eventId));
      const adapter = await adapterFor(record);
      adapterRef.current = adapter;
      const status = await adapter.status(record.roomId);
      if (status === 'disbanded' || status === 'removed') return end(status);
      unsubscribe = await adapter.subscribe(record.roomId, {
        onMessage: add,
        onStatus: (s) => {
          if (s === 'disbanded' || s === 'removed') void end(s);
        },
      });
      if (alive) setConnected(true);
    })().catch(() => {});
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [record, onEnded]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !adapterRef.current) return;
    setSending(true);
    try {
      await adapterRef.current.send(record.roomId, content);
      const own: StoredMessage = {
        id: `local-${crypto.randomUUID()}`,
        sender: record.pubkey,
        content,
        createdAt: Date.now(),
        eventId: record.eventId,
      };
      await roomStore.addMessage(own);
      setMessages((list) => [...list, own]);
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="-ml-2 size-9 shrink-0"
          aria-label={t.app.back}
        >
          <Link to="/tickets">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{record.eventTitle}</p>
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="my-mask"
          >
            <MaskAvatar pubkey={record.pubkey} size={18} />
            {t.room.yourMask}: {maskName(record.pubkey, lang)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (!confirm(t.room.leaveConfirm)) return;
            await leaveRoom(record);
            onEnded('removed');
          }}
        >
          <LogOut />
          {t.room.leave}
        </Button>
      </header>
      <PrivacyCard compact />

      <main className="flex-1 overflow-y-auto px-4 py-4" data-testid="room-messages">
        {!connected && (
          <p className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            {t.room.connecting}
          </p>
        )}
        {messages.length === 0 && connected && (
          <p className="py-10 text-center text-sm text-muted-foreground">{t.room.empty}</p>
        )}
        <ul className="flex flex-col gap-3">
          {messages.map((m) => {
            const mine = m.sender === record.pubkey;
            const host = m.sender === record.agentPubkey;
            if (host) {
              return (
                <li key={m.id} data-testid="room-announcement">
                  <Card className="border-primary/40 bg-primary/10">
                    <CardContent className="pt-4">
                      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-primary">
                        <Megaphone className="size-3.5" />
                        {t.room.host}
                      </p>
                      <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {formatTime(m.createdAt)}
                      </p>
                    </CardContent>
                  </Card>
                </li>
              );
            }
            return (
              <li
                key={m.id}
                className={cn('flex items-end gap-2', mine && 'flex-row-reverse')}
                data-testid="room-message"
              >
                <MaskAvatar pubkey={m.sender} />
                <div className={cn('max-w-[75%]', mine && 'text-right')}>
                  <p className="mb-0.5 text-[11px] text-muted-foreground">
                    {mine ? t.room.you : maskName(m.sender, lang)} · {formatTime(m.createdAt)}
                  </p>
                  <p
                    className={cn(
                      'inline-block whitespace-pre-wrap rounded-2xl px-3 py-2 text-left text-sm',
                      mine ? 'bg-primary text-primary-foreground' : 'bg-card border',
                    )}
                  >
                    {m.content}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <div ref={bottom} />
      </main>

      <form onSubmit={send} className="safe-bottom flex gap-2 border-t px-4 pt-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.room.placeholder}
          aria-label={t.room.placeholder}
          maxLength={2000}
          disabled={!connected}
        />
        <Button
          type="submit"
          disabled={!connected || sending || !draft.trim()}
          aria-label={t.room.send}
        >
          {sending ? <Spinner /> : <Send />}
        </Button>
      </form>
    </div>
  );
}

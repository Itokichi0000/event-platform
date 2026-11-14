import { InvalidSignatureError } from '@kamen/core';
import {
  Calendar,
  KeyRound,
  Lock,
  MapPin,
  Megaphone,
  ShieldCheck,
  Ticket,
  Users,
  VenetianMask,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { DateBadge, EventCover } from '@/components/EventCover';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { PaymentPanel, type PaymentPhase } from '@/components/PaymentPanel';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatSats, t } from '@/i18n';
import { api, ApiError, NetworkError, type PublicEvent } from '@/lib/api';
import {
  pendingQuotesForEvent,
  ticketsForEvent,
  type PendingQuote,
  type StoredTicket,
} from '@/lib/db';
import { formatDate, formatDateTime, formatRange } from '@/lib/format';
import { shortNpub } from '@/lib/nostr';
import {
  acquireTicket,
  claimPaidTicket,
  dropQuote,
  quoteState,
  startPurchase,
  type AcquireStage,
} from '@/lib/tickets';

type Load =
  | { state: 'loading' }
  | { state: 'error'; notFound: boolean }
  | { state: 'ready'; event: PublicEvent };

const POLL_MS = 2500;

export function EventPage() {
  const { id = '' } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [held, setHeld] = useState<StoredTicket | null>(null);
  const [stage, setStage] = useState<{ stage: AcquireStage; progress?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Invite links carry the code in the fragment (#invite=…), which browsers never send to servers.
  const [invite, setInvite] = useState(
    () => new URLSearchParams(hash.slice(1)).get('invite') ?? '',
  );
  const [quote, setQuote] = useState<PendingQuote | null>(null);
  const [payPhase, setPayPhase] = useState<PaymentPhase>('waiting');
  const claiming = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .event(id)
      .then((event) => alive && setLoad({ state: 'ready', event }))
      .catch(
        (e) =>
          alive && setLoad({ state: 'error', notFound: e instanceof ApiError && e.status === 404 }),
      );
    ticketsForEvent(id).then(
      (ts) => alive && setHeld(ts[0] ?? null),
      () => {},
    );
    // Resume a payment started earlier on this device.
    pendingQuotesForEvent(id).then(
      (qs) =>
        alive && qs.length > 0 && setQuote(qs.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id]);

  const fail = useCallback((e: unknown, ev: PublicEvent) => {
    setStage(null);
    if (e instanceof InvalidSignatureError) setError(t.event.errors.invalid_signature);
    else if (e instanceof NetworkError) setError(t.app.networkError);
    else if (e instanceof ApiError && e.code in t.event.errors) {
      setError(t.event.errors[e.code as keyof typeof t.event.errors]);
      if (e.code === 'sold_out') setLoad({ state: 'ready', event: { ...ev, remaining: 0 } });
    } else setError(t.event.errors.generic);
  }, []);

  // Poll the payment state of an outstanding invoice and claim the ticket once paid.
  useEffect(() => {
    if (!quote || load.state !== 'ready') return;
    const ev = load.event;
    let alive = true;
    const tick = async () => {
      if (claiming.current) return;
      try {
        const state = await quoteState(quote);
        if (!alive) return;
        if (state === 'expired') return setPayPhase('expired');
        if (state === 'issued') {
          // Issued but not on this device: nothing more can be done with this quote.
          await dropQuote(quote);
          setQuote(null);
          return setError(t.event.errors.quote_already_used);
        }
        if (state !== 'paid') return;
        claiming.current = true;
        setPayPhase('paid');
        const ticket = await claimPaidTicket(ev, quote, (s) => setStage({ stage: s }));
        navigate(`/t/${ticket.id}?new=1`);
      } catch (e) {
        claiming.current = false;
        if (!(e instanceof NetworkError)) fail(e, ev);
      }
    };
    void tick();
    const h = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [quote, load, navigate, fail]);

  if (load.state === 'loading') {
    return (
      <Layout>
        <PageMessage title={t.app.loading}>
          <Spinner />
        </PageMessage>
      </Layout>
    );
  }
  if (load.state === 'error') {
    return (
      <Layout>
        <PageMessage title={load.notFound ? t.app.notFound : t.app.networkError}>
          <Button variant="outline" onClick={() => location.reload()}>
            {t.app.retry}
          </Button>
        </PageMessage>
      </Layout>
    );
  }

  const ev = load.event;
  const ended = ev.endsAt <= Date.now();
  const soldOut = ev.remaining <= 0;
  const paid = ev.issuePolicy === 'paid';
  const blocked = ev.status !== 'published' || ended || soldOut || (paid && !ev.paymentsReady);
  const canJoin = !blocked && !held && !(ev.issuePolicy === 'invite' && !invite.trim());

  async function join() {
    setError(null);
    try {
      if (paid) {
        setStage({ stage: 'invoice' });
        const q = await startPurchase(ev);
        setStage(null);
        setPayPhase('waiting');
        setQuote(q);
        return;
      }
      const ticket = await acquireTicket(
        ev,
        (s, p) => setStage({ stage: s, ...(p === undefined ? {} : { progress: p }) }),
        ev.issuePolicy === 'invite' ? { invite: invite.trim() } : {},
      );
      navigate(`/t/${ticket.id}?new=1`);
    } catch (e) {
      fail(e, ev);
    }
  }

  async function retryPayment() {
    if (quote) await dropQuote(quote);
    setQuote(null);
    claiming.current = false;
    await join();
  }

  const joinLabel = ended
    ? t.event.ended
    : ev.status === 'cancelled'
      ? t.event.cancelled
      : soldOut
        ? t.event.soldOut
        : paid
          ? ev.paymentsReady
            ? t.event.joinPaid(formatSats(ev.priceMsat))
            : t.event.paymentsNotReady
          : ev.issuePolicy === 'invite'
            ? t.event.joinInvite
            : t.event.joinFree;

  return (
    <Layout className="pb-40">
      {ev.status === 'draft' && (
        <Alert variant="warning" className="mb-4">
          {t.event.draft}
        </Alert>
      )}
      {ev.status === 'cancelled' && (
        <Alert variant="destructive" className="mb-4">
          {t.event.cancelled}
        </Alert>
      )}

      <EventCover
        id={ev.id}
        coverVersion={ev.coverVersion}
        className="shadow-2xl shadow-black/40"
      />

      <h1 className="mt-6 text-3xl font-bold leading-tight tracking-tight text-balance sm:text-4xl">
        {ev.title}
      </h1>

      <div className="mt-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <DateBadge ms={ev.startsAt} />
          <div>
            <p className="font-medium">{formatDate(ev.startsAt)}</p>
            <p className="text-sm text-muted-foreground">{formatRange(ev.startsAt, ev.endsAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="grid size-12 shrink-0 place-items-center rounded-lg border">
            {ev.location !== null ? (
              <MapPin className="size-5 text-muted-foreground" />
            ) : (
              <Lock className="size-5 text-muted-foreground" />
            )}
          </div>
          <p className={ev.location !== null ? 'font-medium' : 'text-sm text-muted-foreground'}>
            {ev.location !== null ? ev.location || '—' : t.event.locationHidden}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <VenetianMask className="size-4" />
            {t.event.hostedBy}:{' '}
            <span className="font-mono text-foreground">{shortNpub(ev.hostPubkey)}</span>
          </span>
          <Badge variant={soldOut ? 'destructive' : 'secondary'}>
            <Users />
            {soldOut ? t.event.soldOut : t.event.remaining(ev.remaining, ev.capacity)}
          </Badge>
          <Badge variant={paid ? 'default' : 'success'}>
            {paid ? <Zap /> : <Ticket />}
            {paid ? formatSats(ev.priceMsat) : t.event.free}
          </Badge>
          {ev.issuePolicy === 'invite' && (
            <Badge variant="outline">
              <KeyRound />
              {t.event.inviteOnly}
            </Badge>
          )}
        </div>
      </div>

      {quote && !held && (
        <section className="mt-8">
          <PaymentPanel quote={quote} phase={payPhase} onRetry={retryPayment} />
        </section>
      )}

      {ev.announcements.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Megaphone className="size-4" />
            {t.event.announcements}
          </h2>
          <div className="flex flex-col gap-2">
            {ev.announcements.map((a) => (
              <Card key={a.id} className="border-primary/30 bg-primary/5">
                <CardContent className="pt-4">
                  <p className="whitespace-pre-wrap text-sm">{a.body}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {ev.description && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t.event.about}
          </h2>
          <p className="whitespace-pre-wrap leading-relaxed text-foreground/90">{ev.description}</p>
        </section>
      )}

      <section className="mt-8">
        <Card>
          <CardContent className="pt-5">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <ShieldCheck className="size-5 text-success" />
              {t.event.privacyTitle}
            </h2>
            <ul className="flex flex-col gap-2 text-sm">
              {t.event.privacyPoints.map((p) => (
                <li key={p} className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                  {p}
                </li>
              ))}
            </ul>
            {ev.issuePolicy === 'invite' && <p className="mt-3 text-sm">{t.event.privacyInvite}</p>}
            {paid && <p className="mt-3 text-sm">{t.event.privacyPaid}</p>}
            {ev.offlineCheckin && (
              <p className="mt-3 text-sm text-warning" data-testid="offline-notice">
                {t.event.privacyOffline}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t.event.privacyNote}</p>
          </CardContent>
        </Card>
      </section>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t bg-background/90 px-4 pt-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}
          {held ? (
            <Button asChild size="xl" className="w-full">
              <Link to={`/t/${held.id}`}>
                <Ticket />
                {t.event.showTicket}
              </Link>
            </Button>
          ) : stage ? (
            <div className="flex flex-col gap-2 py-1" aria-live="polite">
              <div className="flex items-center justify-center gap-2 text-sm">
                <Spinner />
                {t.event.stage[stage.stage]}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.round(progressOf(stage) * 100)}%` }}
                />
              </div>
            </div>
          ) : quote ? null : (
            <>
              {ev.issuePolicy === 'invite' && !blocked && (
                <Input
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder={t.event.invitePlaceholder}
                  aria-label={t.event.inviteLabel}
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="text-center font-mono tracking-widest"
                />
              )}
              <Button size="xl" className="w-full" disabled={!canJoin} onClick={join}>
                {paid ? <Zap /> : <Ticket />}
                {joinLabel}
              </Button>
            </>
          )}
          <p className="flex items-center justify-center gap-1 pb-1 text-xs text-muted-foreground">
            <Calendar className="size-3" />
            {formatDate(ev.startsAt)}
          </p>
        </div>
      </div>
    </Layout>
  );
}

function progressOf(s: { stage: AcquireStage; progress?: number }): number {
  switch (s.stage) {
    case 'challenge':
    case 'invoice':
      return 0.05;
    case 'pay':
      return 0.3;
    case 'work':
      return 0.05 + 0.8 * (s.progress ?? 0);
    case 'issue':
      return 0.9;
    case 'save':
      return 0.97;
  }
}

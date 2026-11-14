import {
  Ban,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Megaphone,
  Pencil,
  Rocket,
  ScanLine,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { EventCover } from '@/components/EventCover';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { QrCode } from '@/components/QrCode';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { t } from '@/i18n';
import type { Announcement, HostEvent, ScannerLink, Stats } from '@/lib/api';
import { formatDate, formatRange, formatTime } from '@/lib/format';
import { hostJson, hostRequest } from '@/lib/nostr';
import { HostBar, HostGate } from './HostGate';
import { CohostsCard, InviteCodesCard, WalletCard } from './OwnerSettings';
import { statusBadge } from './HostHome';

const POLL_MS = 4000;

export function HostEventPage() {
  return <HostGate>{(session) => <Manage session={session} />}</HostGate>;
}

function Manage({ session }: { session: Parameters<typeof HostBar>[0]['session'] }) {
  const { id = '' } = useParams();
  const [ev, setEv] = useState<HostEvent | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [links, setLinks] = useState<ScannerLink[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [e, l] = await Promise.all([
        hostRequest<HostEvent>(`/api/host/events/${id}`),
        hostRequest<ScannerLink[]>(`/api/events/${id}/scanner-links`),
      ]);
      setEv(e);
      setLinks(l);
    } catch {
      setError(t.app.networkError);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Counters refresh every few seconds while the page is visible.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      hostRequest<Stats>(`/api/events/${id}/stats`).then(
        (s) => alive && setStats(s),
        () => {},
      );
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [id]);

  if (!ev) {
    return (
      <Layout wide>
        <PageMessage title={error ?? t.app.loading}>{!error && <Spinner />}</PageMessage>
      </Layout>
    );
  }

  async function setStatus(status: HostEvent['status']) {
    if (status === 'cancelled' && !confirm(t.host.manage.cancelConfirm)) return;
    setEv(await hostJson<HostEvent>('PATCH', `/api/events/${id}`, { status }));
  }

  const publicUrl = `${location.origin}/e/${ev.id}`;
  const issued = stats?.issued ?? ev.issued;
  const redeemed = stats?.redeemed ?? ev.redeemed;

  return (
    <Layout wide>
      <HostBar session={session} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <EventCover id={ev.id} coverVersion={ev.coverVersion} className="sm:w-56" />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                {statusBadge(ev.status)}
                {ev.role === 'cohost' && <Badge variant="outline">{t.host.cohost}</Badge>}
              </div>
              <h1 className="mt-2 text-2xl font-bold tracking-tight">{ev.title}</h1>
              <p className="text-sm text-muted-foreground">
                {formatDate(ev.startsAt)} · {formatRange(ev.startsAt, ev.endsAt)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {ev.status === 'draft' && (
                  <Button onClick={() => setStatus('published')}>
                    <Rocket />
                    {t.host.manage.publish}
                  </Button>
                )}
                <Button asChild variant="secondary">
                  <Link to={`/e/${ev.id}`} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    {t.host.manage.view}
                  </Link>
                </Button>
                <CopyButton text={publicUrl} label={t.host.manage.copyLink} />
                {ev.status !== 'cancelled' && (
                  <Button asChild variant="ghost">
                    <Link to={`/host/e/${ev.id}/edit`}>
                      <Pencil />
                      {t.host.manage.edit}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Counter label={t.host.manage.issued} value={issued} testId="count-issued" />
            <Counter label={t.host.manage.redeemed} value={redeemed} testId="count-redeemed" />
            <Counter
              label={t.host.manage.returned}
              value={stats?.returned ?? ev.returned}
              testId="count-returned"
            />
            <Counter label={t.host.manage.capacity} value={ev.capacity} />
          </div>
          <div className="-mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary/40"
              style={{ width: `${(issued / ev.capacity) * 100}%` }}
            >
              <div
                className="h-full bg-primary"
                style={{ width: issued ? `${(redeemed / issued) * 100}%` : 0 }}
              />
            </div>
          </div>

          <CheckinChart buckets={stats?.checkinsPer15Min ?? []} />

          <Announcements eventId={ev.id} items={ev.announcements} onChange={reload} />

          <p className="text-xs text-muted-foreground">{t.host.manage.notHeld}</p>

          {ev.status !== 'cancelled' && ev.role === 'owner' && (
            <div>
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => setStatus('cancelled')}
              >
                <Ban />
                {t.host.manage.cancel}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <ScannerLinks eventId={ev.id} links={links} onChange={reload} />
          {ev.role === 'owner' ? (
            <>
              {ev.issuePolicy === 'paid' && <WalletCard ev={ev} onChange={reload} />}
              {ev.issuePolicy === 'invite' && <InviteCodesCard eventId={ev.id} />}
              <CohostsCard eventId={ev.id} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t.host.manage.ownerOnly}</p>
          )}
        </div>
      </div>
    </Layout>
  );
}

function Counter({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums" data-testid={testId}>
        {value}
      </p>
    </Card>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? <Check /> : <Copy />}
      {label}
    </Button>
  );
}

function CheckinChart({ buckets }: { buckets: Stats['checkinsPer15Min'] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t.host.manage.checkins}</CardTitle>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.host.manage.noCheckins}</p>
        ) : (
          <div className="flex h-32 items-end gap-1">
            {buckets.map((b) => (
              <div key={b.start} className="flex max-w-12 flex-1 flex-col items-center gap-1">
                <span className="text-[10px] tabular-nums text-muted-foreground">{b.count}</span>
                <div
                  className="w-full rounded-t bg-primary"
                  style={{ height: `${(b.count / max) * 96}px` }}
                />
                <span className="text-[10px] text-muted-foreground">{formatTime(b.start)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Announcements({
  eventId,
  items,
  onChange,
}: {
  eventId: string;
  items: Announcement[];
  onChange: () => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Megaphone className="size-4" />
          {t.host.manage.announcements}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t.host.manage.announcementPlaceholder}
          maxLength={2000}
          aria-label={t.host.manage.announcements}
        />
        <Button
          className="self-end"
          disabled={!body.trim() || busy}
          onClick={async () => {
            setBusy(true);
            await hostJson('POST', `/api/events/${eventId}/announcements`, { body }).catch(
              () => {},
            );
            setBody('');
            setBusy(false);
            await onChange();
          }}
        >
          {t.host.manage.post}
        </Button>
        {items.map((a) => (
          <div key={a.id} className="flex gap-2 rounded-lg border p-3 text-sm">
            <p className="flex-1 whitespace-pre-wrap">{a.body}</p>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="delete"
              onClick={async () => {
                await hostJson('DELETE', `/api/events/${eventId}/announcements/${a.id}`).catch(
                  () => {},
                );
                await onChange();
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ScannerLinks({
  eventId,
  links,
  onChange,
}: {
  eventId: string;
  links: ScannerLink[];
  onChange: () => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const now = Date.now();

  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ScanLine className="size-4" />
          {t.host.manage.scannerLinks}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{t.host.manage.scannerHint}</p>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t.host.manage.scannerLabel}
          maxLength={60}
        />
        <Button
          variant="secondary"
          onClick={async () => {
            setError(false);
            try {
              const res = await hostJson<{ token: string }>(
                'POST',
                `/api/events/${eventId}/scanner-links`,
                { label },
              );
              // The token goes in the fragment: browsers never send it to the server.
              setFresh(`${location.origin}/scan/${eventId}#${res.token}`);
              setLabel('');
              await onChange();
            } catch {
              setError(true);
            }
          }}
        >
          <Link2 />
          {t.host.manage.createLink}
        </Button>
        {error && <Alert variant="destructive">{t.app.networkError}</Alert>}
        {fresh && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs text-primary">{t.host.manage.linkOnce}</p>
            <QrCode text={fresh} size={240} className="max-w-[12rem]" />
            <code
              className="w-full break-all text-[10px] text-muted-foreground"
              data-testid="scanner-url"
            >
              {fresh}
            </code>
            <CopyButton text={fresh} label={t.ticket.copy} />
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {links.map((l) => {
            const dead = l.revokedAt !== null || l.expiresAt <= now;
            return (
              <li key={l.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className={dead ? 'truncate text-muted-foreground line-through' : 'truncate'}>
                    {l.label || '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {l.revokedAt !== null
                      ? t.host.manage.revoked
                      : `${t.host.manage.expires}: ${formatDate(l.expiresAt)} ${formatTime(l.expiresAt)}`}
                  </p>
                </div>
                {!dead && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={async () => {
                      await hostJson(
                        'DELETE',
                        `/api/events/${eventId}/scanner-links/${l.id}`,
                      ).catch(() => {});
                      await onChange();
                    }}
                  >
                    {t.host.manage.revoke}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DateBadge } from '@/components/EventCover';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { t } from '@/i18n';
import type { HostEvent } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { hostRequest } from '@/lib/nostr';
import { HostBar, HostGate } from './HostGate';

export function HostHome() {
  return <HostGate>{(session) => <HostEvents session={session} />}</HostGate>;
}

export function statusBadge(status: HostEvent['status']) {
  const variant =
    status === 'published' ? 'success' : status === 'cancelled' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{t.host.status[status]}</Badge>;
}

function HostEvents({ session }: { session: Parameters<typeof HostBar>[0]['session'] }) {
  const [events, setEvents] = useState<HostEvent[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    hostRequest<HostEvent[]>('/api/host/events').then(setEvents, () => setError(true));
  }, []);

  return (
    <Layout wide>
      <HostBar session={session} />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t.host.title}</h1>
        <Button asChild>
          <Link to="/host/new">
            <Plus />
            {t.host.newEvent}
          </Link>
        </Button>
      </div>
      {error ? (
        <PageMessage title={t.app.networkError} />
      ) : events === null ? (
        <PageMessage title={t.app.loading}>
          <Spinner />
        </PageMessage>
      ) : events.length === 0 ? (
        <PageMessage title={t.host.noEvents} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {events.map((ev) => (
            <li key={ev.id}>
              <Link to={`/host/e/${ev.id}`}>
                <Card className="flex items-center gap-4 p-4 transition-colors hover:bg-accent">
                  <DateBadge ms={ev.startsAt} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold">{ev.title}</p>
                    </div>
                    <p className="text-sm text-muted-foreground">{formatDate(ev.startsAt)}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      {statusBadge(ev.status)}
                      {ev.role === 'cohost' && <Badge variant="outline">{t.host.cohost}</Badge>}
                      <span className="tabular-nums">
                        {t.host.manage.issued} {ev.issued}/{ev.capacity} · {t.host.manage.redeemed}{' '}
                        {ev.redeemed}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="size-5 text-muted-foreground" />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

import { ChevronRight, MapPin, RotateCcw, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DateBadge } from '@/components/EventCover';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { t } from '@/i18n';
import { listTickets, type StoredTicket } from '@/lib/db';
import { formatDate, formatRange } from '@/lib/format';

export function MyTickets() {
  const [tickets, setTickets] = useState<StoredTicket[] | null>(null);
  const [params] = useSearchParams();
  useEffect(() => {
    listTickets().then(setTickets, () => setTickets([]));
  }, []);

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t.app.myTickets}</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/tickets/restore">
            <RotateCcw />
            {t.ticket.restore}
          </Link>
        </Button>
      </div>
      {params.get('returned') === '1' && (
        <Alert variant="success" className="mb-4">
          {t.ticket.returned}
        </Alert>
      )}
      {tickets === null ? (
        <PageMessage title={t.app.loading}>
          <Spinner />
        </PageMessage>
      ) : tickets.length === 0 ? (
        <PageMessage title={t.ticket.empty}>
          <Ticket className="size-10 text-muted-foreground" strokeWidth={1.2} />
          <p className="max-w-xs text-sm text-muted-foreground">{t.ticket.emptyBody}</p>
        </PageMessage>
      ) : (
        <ul className="flex flex-col gap-3">
          {tickets.map((tk) => {
            const past = tk.event.endsAt < Date.now();
            return (
              <li key={tk.id}>
                <Link to={`/t/${tk.id}`}>
                  <Card
                    className={`flex items-center gap-4 p-4 transition-colors hover:bg-accent ${past ? 'opacity-60' : ''}`}
                  >
                    <DateBadge ms={tk.event.startsAt} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{tk.event.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(tk.event.startsAt)} ·{' '}
                        {formatRange(tk.event.startsAt, tk.event.endsAt)}
                      </p>
                      {tk.event.location && (
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <MapPin className="size-3" />
                          {tk.event.location}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="size-5 text-muted-foreground" />
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Layout>
  );
}

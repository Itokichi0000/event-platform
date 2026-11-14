import { CalendarPlus, ShieldCheck, Ticket } from 'lucide-react';
import { Link } from 'react-router';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export function Home() {
  return (
    <Layout>
      <section className="py-10 text-center">
        <p className="mb-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 text-success" />
          {t.app.tagline}
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          仮面をつけて、
          <br />
          会いに行こう。
        </h1>
        <p className="mx-auto mt-4 max-w-md text-muted-foreground">{t.home.lead}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link to="/tickets">
              <Ticket />
              {t.home.openTickets}
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/host">
              <CalendarPlus />
              {t.home.forHosts}
            </Link>
          </Button>
        </div>
      </section>
      <section className="grid gap-3">
        {t.home.points.map(([title, body]) => (
          <div key={title} className="rounded-xl border bg-card p-5">
            <p className="font-semibold">{title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>
    </Layout>
  );
}

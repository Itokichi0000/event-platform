import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { EventPage } from '@/pages/EventPage';
import { Home } from '@/pages/Home';
import { MyTickets } from '@/pages/MyTickets';
import { RestorePage } from '@/pages/RestorePage';
import { TicketPage } from '@/pages/TicketPage';

// Host and scanner screens are split out: participants never download them.
const HostHome = lazy(() => import('@/pages/host/HostHome').then((m) => ({ default: m.HostHome })));
const EventFormPage = lazy(() =>
  import('@/pages/host/EventForm').then((m) => ({ default: m.EventFormPage })),
);
const HostEventPage = lazy(() =>
  import('@/pages/host/HostEventPage').then((m) => ({ default: m.HostEventPage })),
);
const ScannerPage = lazy(() =>
  import('@/pages/ScannerPage').then((m) => ({ default: m.ScannerPage })),
);

export function App() {
  return (
    <BrowserRouter>
      <Suspense
        fallback={
          <PageMessage title={t.app.loading}>
            <Spinner />
          </PageMessage>
        }
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/e/:id" element={<EventPage />} />
          <Route path="/tickets" element={<MyTickets />} />
          <Route path="/tickets/restore" element={<RestorePage />} />
          <Route path="/t/:id" element={<TicketPage />} />
          <Route path="/host" element={<HostHome />} />
          <Route path="/host/new" element={<EventFormPage />} />
          <Route path="/host/e/:id" element={<HostEventPage />} />
          <Route path="/host/e/:id/edit" element={<EventFormPage />} />
          <Route path="/scan/:id" element={<ScannerPage />} />
          <Route
            path="*"
            element={
              <Layout>
                <PageMessage title={t.app.notFound}>
                  <Button asChild variant="outline">
                    <Link to="/">{t.app.home}</Link>
                  </Button>
                </PageMessage>
              </Layout>
            }
          />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

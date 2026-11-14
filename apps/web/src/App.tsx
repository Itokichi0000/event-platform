import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { Layout, PageMessage } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { EventPage } from '@/pages/EventPage';
import { Home } from '@/pages/Home';
import { EventFormPage } from '@/pages/host/EventForm';
import { HostEventPage } from '@/pages/host/HostEventPage';
import { HostHome } from '@/pages/host/HostHome';
import { MyTickets } from '@/pages/MyTickets';
import { RestorePage } from '@/pages/RestorePage';
import { ScannerPage } from '@/pages/ScannerPage';
import { TicketPage } from '@/pages/TicketPage';

export function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  );
}

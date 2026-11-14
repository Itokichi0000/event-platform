import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  MapPin,
  Smartphone,
  Sun,
  Trash2,
  Undo2,
  VenetianMask,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { QrCode, downloadBlob, qrPng } from '@/components/QrCode';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { t } from '@/i18n';
import { deleteTicket, getTicket, updateTicket, type StoredTicket } from '@/lib/db';
import { formatDate, formatRange } from '@/lib/format';
import { checkStorage, type StorageStatus } from '@/lib/storage';
import { backupTextFor, qrTextFor, refreshTicket, returnTicket } from '@/lib/tickets';
import { useInstallPrompt } from '@/lib/install';

export function TicketPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const isNew = params.get('new') === '1';
  const [ticket, setTicket] = useState<StoredTicket | null | undefined>(undefined);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const install = useInstallPrompt();

  const [returning, setReturning] = useState(false);
  const [roomOpen, setRoomOpen] = useState<boolean | null>(null);
  const [roomAvailable, setRoomAvailable] = useState(false);
  const [returnError, setReturnError] = useState(false);

  useEffect(() => {
    let alive = true;
    getTicket(id).then(
      async (tk) => {
        if (!alive) return;
        setTicket(tk ?? null);
        // Online: pick up cancellation, venue changes and the offline check-in setting.
        const fresh = tk ? await refreshTicket(tk) : null;
        if (alive && fresh) {
          setTicket(fresh.ticket);
          setRoomAvailable(fresh.event.roomAvailable);
        }
      },
      () => alive && setTicket(null),
    );
    checkStorage().then(
      (s) => alive && setStorage(s),
      () => {},
    );
    // Light module (no marmot-ts): whether a room was already joined on this device.
    void import('@/rooms/store')
      .then(async ({ roomStore }) => {
        const tk = await getTicket(id);
        if (tk && alive) setRoomOpen(!!(await roomStore.get(tk.token.eventId)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  if (ticket === undefined) {
    return (
      <Layout>
        <PageMessage title={t.app.loading}>
          <Spinner />
        </PageMessage>
      </Layout>
    );
  }
  if (ticket === null) {
    return (
      <Layout>
        <PageMessage title={t.ticket.notFound}>
          <Button asChild variant="outline">
            <Link to="/tickets/restore">{t.ticket.restore}</Link>
          </Button>
        </PageMessage>
      </Layout>
    );
  }

  const tk = ticket;
  const markBackedUp = async () => {
    await updateTicket(tk.id, { backedUpAt: Date.now() });
    setTicket({ ...tk, backedUpAt: Date.now() });
  };

  async function copyBackup() {
    await navigator.clipboard.writeText(backupTextFor(tk));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
    await markBackedUp();
  }

  async function saveImage() {
    downloadBlob(await qrPng(qrTextFor(tk), tk.event.title), `kamen-ticket.png`);
  }

  async function giveBack() {
    if (!confirm(t.ticket.returnConfirm)) return;
    setReturning(true);
    setReturnError(false);
    try {
      await returnTicket(tk);
      navigate('/tickets?returned=1');
    } catch {
      setReturning(false);
      setReturnError(true);
    }
  }

  async function remove() {
    if (!confirm(t.ticket.deleteConfirm)) return;
    await deleteTicket(tk.id);
    navigate('/tickets');
  }

  const needsBackup = tk.backedUpAt === null;
  const cancelled = tk.event.status === 'cancelled';
  const returnable = !cancelled && tk.event.endsAt > Date.now();

  return (
    <Layout>
      {cancelled && (
        <Alert variant="destructive" className="mb-4">
          {t.ticket.cancelled}
        </Alert>
      )}
      <div className="flex flex-col items-center text-center">
        <Badge variant="secondary" className="mb-3">
          {t.ticket.title}
        </Badge>
        <h1 className="text-2xl font-bold tracking-tight text-balance">{tk.event.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatDate(tk.event.startsAt)} · {formatRange(tk.event.startsAt, tk.event.endsAt)}
        </p>
        {tk.event.location && (
          <p className="mt-1 flex items-center gap-1 text-sm">
            <MapPin className="size-4 text-muted-foreground" />
            {tk.event.location}
          </p>
        )}
      </div>

      <div className="mt-6 flex flex-col items-center gap-3">
        <div className="rounded-2xl bg-white p-3 shadow-2xl shadow-primary/10">
          <QrCode text={qrTextFor(tk)} label={t.ticket.showAtDoor} className="max-w-[20rem]" />
        </div>
        <p className="text-sm font-medium">{t.ticket.showAtDoor}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Sun className="size-3" />
          {t.ticket.brightness}
        </p>
        {tk.event.offlineCheckin && (
          <p
            className="max-w-sm text-center text-xs text-warning"
            data-testid="ticket-offline-note"
          >
            {t.ticket.offlineNote}
          </p>
        )}
      </div>

      {storage?.likelyPrivate && (
        <Alert variant="destructive" className="mt-6">
          <AlertTriangle />
          <span>{t.ticket.privateWarning}</span>
        </Alert>
      )}
      {storage && !storage.likelyPrivate && !storage.persisted && needsBackup && (
        <Alert variant="warning" className="mt-6">
          <AlertTriangle />
          <span>{t.ticket.notPersisted}</span>
        </Alert>
      )}

      <Card className={needsBackup && isNew ? 'mt-6 border-primary/50' : 'mt-6'}>
        <CardContent className="flex flex-col gap-3 pt-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{t.ticket.backupTitle}</h2>
            {!needsBackup && (
              <Badge variant="success">
                <Check />
                {t.ticket.backupDone}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{t.ticket.backupBody}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant={needsBackup ? 'default' : 'secondary'} onClick={copyBackup}>
              {copied ? <Check /> : <Copy />}
              {copied ? t.ticket.copied : t.ticket.copy}
            </Button>
            <Button variant="secondary" onClick={saveImage}>
              <Download />
              {t.ticket.saveImage}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.ticket.backupHint}</p>
        </CardContent>
      </Card>

      {install.available && (
        <Card className="mt-4">
          <CardContent className="flex items-center gap-3 pt-5">
            <Smartphone className="size-5 shrink-0 text-muted-foreground" />
            <p className="flex-1 text-sm">{t.ticket.installHint}</p>
            <Button size="sm" variant="outline" onClick={install.prompt}>
              {t.ticket.install}
            </Button>
          </CardContent>
        </Card>
      )}

      {(roomOpen || (roomAvailable && tk.roomPass)) && (
        <Card className="mt-4 border-primary/30">
          <CardContent className="flex items-center gap-3 pt-5">
            <VenetianMask className="size-6 shrink-0 text-primary" />
            <div className="flex-1">
              <p className="font-semibold">{t.room.title}</p>
              <p className="text-xs text-muted-foreground">{t.room.intro}</p>
            </div>
            <Button asChild size="sm">
              <Link to={`/r/${tk.token.eventId}`}>{roomOpen ? t.room.open : t.room.enter}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {returnable && (
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-2 pt-5">
            <h2 className="font-semibold">{t.ticket.returnTitle}</h2>
            <p className="text-sm text-muted-foreground">{t.ticket.returnBody}</p>
            {tk.event.issuePolicy === 'paid' && (
              <p className="text-sm text-warning">{t.ticket.returnPaid}</p>
            )}
            {returnError && <p className="text-sm text-destructive">{t.ticket.returnFailed}</p>}
            <Button
              variant="outline"
              className="self-start"
              onClick={giveBack}
              disabled={returning}
            >
              {returning ? <Spinner /> : <Undo2 />}
              {t.ticket.returnButton}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="mt-8 flex justify-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/e/${tk.token.eventId}`}>{t.app.back}</Link>
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={remove}>
          <Trash2 />
          {t.ticket.delete}
        </Button>
      </div>
    </Layout>
  );
}

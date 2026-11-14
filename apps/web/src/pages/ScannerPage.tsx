import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Keyboard,
  RefreshCw,
  WifiOff,
  XCircle,
} from 'lucide-react';
import type QrScannerType from 'qr-scanner';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { PageMessage, Spinner } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { t } from '@/i18n';
import { api, NetworkError } from '@/lib/api';
import { checkIn, syncCheckins, type Verdict } from '@/lib/checkin';
import { formatTime } from '@/lib/format';
import { scannerStore, type CachedEvent, type Conflict } from '@/lib/scanner-store';
import { cn } from '@/lib/utils';

const RESULT_MS = 1800;
const SAME_CODE_COOLDOWN_MS = 4000;
const SYNC_INTERVAL_MS = 10_000;

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function verdictText(v: Verdict): string {
  if (v.kind === 'ok') return v.offline ? t.scanner.okOffline : t.scanner.ok;
  if (v.kind === 'warn')
    return v.reason === 'network' ? t.scanner.network : t.scanner.offlineUnsupported;
  return {
    unreadable: t.scanner.unreadable,
    otherEvent: t.scanner.otherEvent,
    invalid: t.scanner.invalid,
    used: t.scanner.used,
    usedHere: t.scanner.usedHere,
    cancelled: t.scanner.cancelled,
    noDleq: t.scanner.noDleq,
  }[v.reason];
}

/**
 * Check-in scanner, opened from a link like /scan/<eventId>#<token>. The token sits in the URL
 * fragment, so it is never sent in requests' URLs or Referer headers.
 *
 * For offline check-in events the device keeps the public key and a local spent list, accepts
 * DLEQ-verified tickets while offline, and syncs (reporting conflicts) when back online.
 */
export function ScannerPage() {
  const { id = '' } = useParams();
  const token = useLocation().hash.replace(/^#/, '');
  const online = useOnline();
  const [session, setSession] = useState<
    | { state: 'loading' }
    | { state: 'invalid' }
    | { state: 'ready'; event: CachedEvent; cached: boolean }
  >({ state: 'loading' });
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [manual, setManual] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScannerType | null>(null);
  const busy = useRef(false);
  const lastCode = useRef<{ text: string; at: number } | null>(null);

  const refreshLocal = useCallback(async () => {
    setPending((await scannerStore.queued(id)).length);
    setConflicts(await scannerStore.conflicts(id));
  }, [id]);

  // Load the session online, or fall back to what this device cached last time.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, ev] = await Promise.all([api.scannerSession(id, token), api.event(id)]);
        const cached: CachedEvent = {
          eventId: id,
          title: s.title,
          keyset: ev.keysets.find((k) => k.kind === 'ticket') ?? null,
          offlineCheckin: s.offlineCheckin,
          status: s.status,
          issued: s.issued,
          redeemed: s.redeemed,
          savedAt: Date.now(),
        };
        await scannerStore.saveEvent(cached);
        if (alive) setSession({ state: 'ready', event: cached, cached: false });
      } catch (e) {
        const cached = e instanceof NetworkError ? await scannerStore.getEvent(id) : undefined;
        if (!alive) return;
        setSession(cached ? { state: 'ready', event: cached, cached: true } : { state: 'invalid' });
      }
      await refreshLocal();
    })();
    return () => {
      alive = false;
    };
  }, [id, token, refreshLocal]);

  const offlineCheckin = session.state === 'ready' && session.event.offlineCheckin;

  const sync = useCallback(async () => {
    if (!offlineCheckin || !navigator.onLine) return;
    setSyncing(true);
    try {
      const r = await syncCheckins(id, token);
      if (r.counts) {
        setSession((s) =>
          s.state === 'ready' ? { ...s, event: { ...s.event, ...r.counts }, cached: false } : s,
        );
      }
    } finally {
      setSyncing(false);
      await refreshLocal();
    }
  }, [id, token, offlineCheckin, refreshLocal]);

  // Sync on reconnect and periodically while there is anything to send.
  useEffect(() => {
    if (!online || !offlineCheckin) return;
    void sync();
    const h = setInterval(() => void sync(), SYNC_INTERVAL_MS);
    return () => clearInterval(h);
  }, [online, offlineCheckin, sync]);

  const show = useCallback((v: Verdict) => {
    setVerdict(v);
    navigator.vibrate?.(v.kind === 'ok' ? 80 : [60, 60, 60]);
    setTimeout(() => {
      setVerdict(null);
      busy.current = false;
    }, RESULT_MS);
  }, []);

  const check = useCallback(
    async (text: string) => {
      if (busy.current || session.state !== 'ready') return;
      const now = Date.now();
      if (lastCode.current?.text === text && now - lastCode.current.at < SAME_CODE_COOLDOWN_MS)
        return;
      lastCode.current = { text, at: now };
      busy.current = true;
      const v = await checkIn(
        {
          eventId: id,
          token,
          keyset: session.event.keyset,
          offlineCheckin: session.event.offlineCheckin,
          offline: !navigator.onLine,
        },
        text,
      );
      if (v.kind === 'warn') lastCode.current = null;
      if (v.kind === 'ok' && v.counts) {
        setSession((s) => (s.state === 'ready' ? { ...s, event: { ...s.event, ...v.counts } } : s));
      }
      await refreshLocal();
      show(v);
    },
    [id, token, session, show, refreshLocal],
  );

  // Keep the latest callback for the camera loop without restarting the camera.
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  async function startCamera() {
    setCameraError(false);
    try {
      const { default: QrScanner } = await import('qr-scanner');
      if (!videoRef.current) return;
      const scanner = new QrScanner(videoRef.current, (r) => void checkRef.current(r.data), {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: 'environment',
        maxScansPerSecond: 8,
      });
      scannerRef.current = scanner;
      await scanner.start();
      setCameraOn(true);
    } catch {
      setCameraError(true);
    }
  }

  useEffect(() => () => scannerRef.current?.destroy(), []);

  if (session.state === 'loading') {
    return (
      <PageMessage title={t.app.loading}>
        <Spinner />
      </PageMessage>
    );
  }
  if (session.state === 'invalid') {
    return (
      <div className="p-6">
        <PageMessage title={t.scanner.invalidLink} />
      </div>
    );
  }

  const ev = session.event;

  return (
    <div className="flex min-h-dvh flex-col bg-black">
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t.scanner.title}</p>
          <p className="truncate font-semibold">{ev.title}</p>
        </div>
        <p
          className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm tabular-nums"
          data-testid="scanner-counter"
        >
          {t.scanner.counter(ev.redeemed, ev.issued)}
        </p>
      </header>

      {!online && (
        <div
          role="status"
          data-testid="offline-banner"
          className="flex gap-2 border-b border-warning/30 bg-warning/15 px-4 py-2 text-sm text-warning"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" />
          <span>{ev.offlineCheckin ? t.scanner.offlineBanner : t.scanner.offlineUnsupported}</span>
        </div>
      )}
      {online && session.cached && (
        <p className="border-b border-white/10 px-4 py-2 text-xs text-muted-foreground">
          {t.scanner.cached}
        </p>
      )}
      {ev.offlineCheckin && (pending > 0 || syncing) && (
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2 text-sm">
          <span data-testid="pending-count">{t.scanner.pending(pending)}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void sync()}
            disabled={!online || syncing}
          >
            <RefreshCw className={syncing ? 'animate-spin' : ''} />
            {t.scanner.syncNow}
          </Button>
        </div>
      )}
      {conflicts.length > 0 && (
        <div
          className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
          data-testid="conflicts"
        >
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="size-4" />
            {t.scanner.conflicts}: {conflicts.length}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t.scanner.conflictsHint}</p>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
            {conflicts.map((c) => (
              <li key={c.id}>
                {formatTime(c.scannedAt)} · …{c.y.slice(-8)}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1"
            onClick={async () => {
              await scannerStore.clearConflicts(id);
              await refreshLocal();
            }}
          >
            {t.scanner.clearConflicts}
          </Button>
        </div>
      )}

      <div className="relative flex-1">
        <video
          ref={videoRef}
          className={cn('h-full w-full object-cover', !cameraOn && 'hidden')}
          playsInline
          muted
        />
        {!cameraOn && (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <Button size="xl" onClick={startCamera}>
              <Camera />
              {t.scanner.startCamera}
            </Button>
            {cameraError && (
              <p className="max-w-sm text-sm text-warning">{t.scanner.cameraError}</p>
            )}
          </div>
        )}
      </div>

      <details className="border-t border-white/10 px-4 py-3">
        <summary className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Keyboard className="size-4" />
          {t.scanner.manual}
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder={t.scanner.manualPlaceholder}
            className="min-h-20 font-mono text-xs"
            aria-label={t.scanner.manual}
            spellCheck={false}
          />
          <Button
            onClick={() => {
              lastCode.current = null;
              void check(manual.trim());
            }}
            disabled={!manual.trim()}
          >
            {t.scanner.check}
          </Button>
        </div>
      </details>

      {verdict && (
        <button
          type="button"
          data-testid="scan-verdict"
          data-verdict={verdict.kind}
          onClick={() => {
            setVerdict(null);
            busy.current = false;
          }}
          className={cn(
            'fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6 text-center text-white',
            verdict.kind === 'ok' && 'bg-emerald-600',
            verdict.kind === 'bad' && 'bg-red-600',
            verdict.kind === 'warn' && 'bg-amber-600',
          )}
        >
          {verdict.kind === 'ok' ? (
            <CheckCircle2 className="size-32" strokeWidth={1.5} />
          ) : verdict.kind === 'bad' ? (
            <XCircle className="size-32" strokeWidth={1.5} />
          ) : (
            <WifiOff className="size-32" strokeWidth={1.5} />
          )}
          <span className="text-3xl font-bold text-balance">{verdictText(verdict)}</span>
          <span className="text-sm opacity-80">{t.scanner.tapToContinue}</span>
        </button>
      )}
    </div>
  );
}

import {
  decodeToken,
  toRedeemPayload,
  verifyProofOffline,
  type PublicKeyset,
  type Token,
} from '@kamen/core';
import { Camera, CheckCircle2, Keyboard, WifiOff, XCircle } from 'lucide-react';
import type QrScannerType from 'qr-scanner';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { PageMessage, Spinner } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { t } from '@/i18n';
import { api, ApiError, NetworkError } from '@/lib/api';
import { cn } from '@/lib/utils';

type Verdict = { kind: 'ok' | 'bad' | 'warn'; message: string };

const RESULT_MS = 1800;
const SAME_CODE_COOLDOWN_MS = 4000;

/**
 * Check-in scanner, opened from a link like /scan/<eventId>#<token>. The token sits in the URL
 * fragment, so it is never sent in requests' URLs or Referer headers.
 */
export function ScannerPage() {
  const { id = '' } = useParams();
  const token = useLocation().hash.replace(/^#/, '');
  const [session, setSession] = useState<
    | { state: 'loading' }
    | { state: 'invalid' }
    | { state: 'ready'; title: string; keyset: PublicKeyset | undefined }
  >({ state: 'loading' });
  const [counts, setCounts] = useState<{ redeemed: number; issued: number } | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [manual, setManual] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScannerType | null>(null);
  const busy = useRef(false);
  const lastCode = useRef<{ text: string; at: number } | null>(null);

  useEffect(() => {
    Promise.all([api.scannerSession(id, token), api.event(id)])
      .then(([s, ev]) => {
        setCounts({ redeemed: s.redeemed, issued: s.issued });
        setSession({
          state: 'ready',
          title: s.title,
          keyset: ev.keysets.find((k) => k.kind === 'ticket'),
        });
      })
      .catch(() => setSession({ state: 'invalid' }));
  }, [id, token]);

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
      if (
        lastCode.current &&
        lastCode.current.text === text &&
        now - lastCode.current.at < SAME_CODE_COOLDOWN_MS
      ) {
        return;
      }
      lastCode.current = { text, at: now };
      busy.current = true;

      let ticket: Token;
      try {
        ticket = decodeToken(text);
      } catch {
        return show({ kind: 'bad', message: t.scanner.unreadable });
      }
      if (ticket.kind !== 'ticket') return show({ kind: 'bad', message: t.scanner.unreadable });
      if (ticket.eventId !== id) return show({ kind: 'bad', message: t.scanner.otherEvent });
      // Offline check-in events put the DLEQ in the QR; verify it locally before anything else.
      if (ticket.dleq && (!session.keyset || !verifyProofOffline(ticket, session.keyset))) {
        return show({ kind: 'bad', message: t.scanner.invalid });
      }
      try {
        // The DLEQ (with its blinding factor) is stripped: the server must never see it.
        const res = await api.redeem(id, token, toRedeemPayload(ticket));
        setCounts({ redeemed: res.redeemed, issued: res.issued });
        show({ kind: 'ok', message: t.scanner.ok });
      } catch (e) {
        if (e instanceof NetworkError) {
          lastCode.current = null;
          return show({ kind: 'warn', message: t.scanner.network });
        }
        const code = e instanceof ApiError ? e.code : '';
        show({
          kind: 'bad',
          message:
            code === 'already_redeemed'
              ? t.scanner.used
              : code === 'event_cancelled'
                ? t.scanner.cancelled
                : t.scanner.invalid,
        });
      }
    },
    [id, token, session, show],
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

  return (
    <div className="flex min-h-dvh flex-col bg-black">
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t.scanner.title}</p>
          <p className="truncate font-semibold">{session.title}</p>
        </div>
        {counts && (
          <p
            className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm tabular-nums"
            data-testid="scanner-counter"
          >
            {t.scanner.counter(counts.redeemed, counts.issued)}
          </p>
        )}
      </header>

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
            'fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 text-white',
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
          <span className="text-4xl font-bold">{verdict.message}</span>
          <span className="text-sm opacity-80">{t.scanner.tapToContinue}</span>
        </button>
      )}
    </div>
  );
}

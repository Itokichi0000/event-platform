import { Check, Copy, ExternalLink, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QrCode } from '@/components/QrCode';
import { Spinner } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatSats, t } from '@/i18n';
import type { PendingQuote } from '@/lib/db';

export type PaymentPhase = 'waiting' | 'paid' | 'expired';

/** Lightning invoice for a paid ticket. The invoice is upper-cased so the QR uses alphanumeric mode. */
export function PaymentPanel({
  quote,
  phase,
  onRetry,
}: {
  quote: PendingQuote;
  phase: PaymentPhase;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(h);
  }, []);
  const minutes = Math.max(0, Math.ceil((quote.expiresAt - now) / 60_000));
  const uri = `lightning:${quote.invoice}`;

  return (
    <Card className="border-primary/40" data-testid="payment-panel">
      <CardContent className="flex flex-col items-center gap-3 pt-5 text-center">
        <h2 className="flex items-center gap-2 font-semibold">
          <Zap className="size-5 text-primary" />
          {t.event.pay.title} · {formatSats(quote.amountMsat)}
        </h2>
        {phase === 'expired' ? (
          <>
            <p className="text-sm text-muted-foreground">{t.event.pay.expired}</p>
            <Button onClick={onRetry}>{t.event.pay.retry}</Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t.event.pay.body}</p>
            <div className="rounded-xl bg-white p-2">
              <QrCode
                text={uri.toUpperCase()}
                size={280}
                className="max-w-[16rem]"
                label={t.event.pay.title}
              />
            </div>
            <div className="grid w-full grid-cols-2 gap-2">
              <Button asChild variant="secondary">
                <a href={uri}>
                  <ExternalLink />
                  {t.event.pay.openWallet}
                </a>
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(quote.invoice);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? t.event.pay.copied : t.event.pay.copy}
              </Button>
            </div>
            <p
              className="flex items-center gap-2 text-sm"
              aria-live="polite"
              data-testid="payment-status"
            >
              <Spinner />
              {phase === 'paid' ? t.event.pay.paid : t.event.pay.waiting}
            </p>
            {phase === 'waiting' && (
              <p className="text-xs text-muted-foreground">{t.event.pay.expiresIn(minutes)}</p>
            )}
            <p className="text-xs text-muted-foreground">{t.event.pay.keepOpen}</p>
            <p className="text-xs text-muted-foreground">{t.event.pay.noRefund}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

import { Stamp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { t } from '@/i18n';
import { stampStore, type StoredStamp } from '@/lib/db';
import { formatDate } from '@/lib/format';
import { shortNpub } from '@/lib/nostr';
import { MaskAvatar } from '@/rooms/MaskAvatar';

/** 御朱印帳: stamps grouped by host. Event names are known only to this device. */
export function StampsPage() {
  const [stamps, setStamps] = useState<StoredStamp[] | null>(null);
  useEffect(() => {
    stampStore.all().then(setStamps, () => setStamps([]));
  }, []);

  const byHost = new Map<string, StoredStamp[]>();
  for (const s of stamps ?? []) byHost.set(s.hostPubkey, [...(byHost.get(s.hostPubkey) ?? []), s]);

  return (
    <Layout>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Stamp className="size-6 text-primary" />
        {t.stamps.title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{t.stamps.body}</p>
      {stamps === null ? (
        <PageMessage title={t.app.loading}>
          <Spinner />
        </PageMessage>
      ) : stamps.length === 0 ? (
        <PageMessage title={t.stamps.empty} />
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          {[...byHost.entries()].map(([host, list]) => (
            <Card key={host} data-testid="stamp-host">
              <CardContent className="pt-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 font-mono text-sm">
                    <MaskAvatar pubkey={host} size={24} />
                    {shortNpub(host)}
                  </p>
                  <Badge data-testid="stamp-count">{t.stamps.count(list.length)}</Badge>
                </div>
                <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {list
                    .sort((a, b) => a.receivedAt - b.receivedAt)
                    .map((s) => (
                      <li
                        key={s.secret}
                        className="flex aspect-square flex-col items-center justify-center rounded-full border-2 border-destructive/60 p-2 text-center text-destructive"
                        style={{
                          transform: `rotate(${(parseInt(s.secret.slice(0, 2), 16) % 21) - 10}deg)`,
                        }}
                      >
                        <span className="line-clamp-2 text-[11px] font-semibold leading-tight">
                          {s.eventTitle ?? t.stamps.unknownEvent}
                        </span>
                        <span className="mt-1 text-[9px] opacity-80">
                          {formatDate(s.receivedAt)}
                        </span>
                      </li>
                    ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Layout>
  );
}

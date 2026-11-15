import { npubEncode } from 'nostr-tools/nip19';
import { Check, Copy, KeyRound, Plus, Trash2, UserPlus, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { QrCode } from '@/components/QrCode';
import { Spinner } from '@/components/Layout';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { t } from '@/i18n';
import { ApiError, type HostEvent, type InviteCode } from '@/lib/api';
import { hostJson, hostRequest, shortNpub } from '@/lib/nostr';

const M = t.host.manage;

function CopyText({ text, testId }: { text: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex w-full items-center gap-2">
      <code className="flex-1 break-all rounded bg-muted px-2 py-1 text-xs" data-testid={testId}>
        {text}
      </code>
      <Button
        size="icon"
        variant="ghost"
        className="size-8 shrink-0"
        aria-label={t.ticket.copy}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Owner-only: connect the NWC wallet that receives payments for paid tickets. */
export function WalletCard({ ev, onChange }: { ev: HostEvent; onChange: () => Promise<void> }) {
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSpend, setCanSpend] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await hostJson<{ warnings: string[] }>('PUT', `/api/events/${ev.id}/wallet`, {
        nwc: uri,
      });
      setCanSpend(res.warnings.includes('can_spend'));
      setUri('');
      await onChange();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(M.wallet.errors[code as keyof typeof M.wallet.errors] ?? M.wallet.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wallet className="size-4" />
          {M.wallet.title}
          {ev.walletConnected && (
            <Badge variant="success" data-testid="wallet-connected">
              <Check />
              {M.wallet.connected}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{M.wallet.body}</p>
        {!ev.walletConnected && <Alert variant="warning">{M.wallet.notConnected}</Alert>}
        {canSpend && <Alert variant="warning">{M.wallet.canSpend}</Alert>}
        <Input
          type="password"
          autoComplete="off"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder={M.wallet.placeholder}
          aria-label={M.wallet.title}
        />
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="flex gap-2">
          <Button onClick={connect} disabled={!uri.trim() || busy}>
            {busy && <Spinner />}
            {M.wallet.connect}
          </Button>
          {ev.walletConnected && (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={async () => {
                await hostJson('DELETE', `/api/events/${ev.id}/wallet`).catch(() => {});
                await onChange();
              }}
            >
              {M.wallet.disconnect}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Owner-only: invite codes. A code is shown once, together with an invite link (#invite=…). */
export function InviteCodesCard({ eventId }: { eventId: string }) {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [label, setLabel] = useState('');
  const [uses, setUses] = useState(10);
  const [custom, setCustom] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCodes(
      await hostRequest<InviteCode[]>(`/api/events/${eventId}/invite-codes`).catch(() => []),
    );
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);

  const link = fresh ? `${location.origin}/e/${eventId}#invite=${encodeURIComponent(fresh)}` : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <KeyRound className="size-4" />
          {M.invites.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{M.invites.body}</p>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={M.invites.label}
          maxLength={60}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="invite-uses" className="shrink-0">
            {M.invites.uses}
          </Label>
          <Input
            id="invite-uses"
            type="number"
            min={1}
            max={10000}
            value={uses}
            onChange={(e) => setUses(Number(e.target.value))}
            className="w-24"
          />
        </div>
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={M.invites.custom}
          aria-label={M.invites.custom}
          className="font-mono"
        />
        <Button
          variant="secondary"
          onClick={async () => {
            setError(null);
            try {
              const res = await hostJson<{ code: string }>(
                'POST',
                `/api/events/${eventId}/invite-codes`,
                {
                  label,
                  maxUses: uses,
                  ...(custom.trim() ? { code: custom.trim() } : {}),
                },
              );
              setFresh(res.code);
              setLabel('');
              setCustom('');
              await load();
            } catch (e) {
              const code = e instanceof ApiError ? e.code : '';
              setError(
                M.invites.errors[code as keyof typeof M.invites.errors] ?? M.invites.errors.generic,
              );
            }
          }}
        >
          <Plus />
          {M.invites.create}
        </Button>
        {error && <Alert variant="destructive">{error}</Alert>}
        {fresh && link && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs text-primary">{M.invites.once}</p>
            <p className="font-mono text-2xl tracking-widest" data-testid="invite-code">
              {fresh}
            </p>
            <QrCode text={link} size={200} className="max-w-[10rem]" />
            <p className="self-start text-xs text-muted-foreground">{M.invites.link}</p>
            <CopyText text={link} testId="invite-link" />
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {codes.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">{c.label || '—'}</p>
                <p className="text-xs text-muted-foreground">
                  {M.invites.remaining(c.usesLeft, c.maxUses)}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={M.invites.delete}
                onClick={async () => {
                  await hostJson('DELETE', `/api/events/${eventId}/invite-codes/${c.id}`).catch(
                    () => {},
                  );
                  await load();
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Owner-only: co-hosts by npub. */
export function CohostsCard({ eventId }: { eventId: string }) {
  const [list, setList] = useState<{ pubkey: string }[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList(
      await hostRequest<{ pubkey: string }[]>(`/api/events/${eventId}/cohosts`).catch(() => []),
    );
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <UserPlus className="size-4" />
          {M.cohosts.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{M.cohosts.body}</p>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={M.cohosts.placeholder}
            aria-label={M.cohosts.title}
            className="font-mono text-xs"
          />
          <Button
            variant="secondary"
            disabled={!input.trim()}
            onClick={async () => {
              setError(null);
              try {
                await hostJson('POST', `/api/events/${eventId}/cohosts`, { pubkey: input.trim() });
                setInput('');
                await load();
              } catch (e) {
                const code = e instanceof ApiError ? e.code : '';
                setError(
                  M.cohosts.errors[code as keyof typeof M.cohosts.errors] ??
                    M.cohosts.errors.generic,
                );
              }
            }}
          >
            {M.cohosts.add}
          </Button>
        </div>
        {error && <Alert variant="destructive">{error}</Alert>}
        <ul className="flex flex-col gap-2">
          {list.map((c) => (
            <li key={c.pubkey} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
              <span className="flex-1 truncate font-mono text-xs" title={npubEncode(c.pubkey)}>
                {shortNpub(c.pubkey)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={async () => {
                  await hostJson('DELETE', `/api/events/${eventId}/cohosts/${c.pubkey}`).catch(
                    () => {},
                  );
                  await load();
                }}
              >
                {M.cohosts.remove}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

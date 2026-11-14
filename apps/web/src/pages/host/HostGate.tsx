import { KeyRound, LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Layout, Spinner } from '@/components/Layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { t } from '@/i18n';
import { NetworkError } from '@/lib/api';
import {
  clearSession,
  getSession,
  hasNip07,
  login,
  shortNpub,
  type HostSession,
} from '@/lib/nostr';

/** Renders children only for a logged-in host; otherwise the NIP-07 login card. */
export function HostGate({ children }: { children: (session: HostSession) => ReactNode }) {
  const [session, setSession] = useState<HostSession | null>(() => getSession());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session) return <>{children(session)}</>;

  async function doLogin() {
    setBusy(true);
    setError(null);
    try {
      setSession(await login());
    } catch (e) {
      setError(
        e instanceof NetworkError
          ? t.app.networkError
          : e instanceof Error && e.message === 'no_nip07'
            ? t.host.noExtension
            : t.host.loginFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <Card className="mx-auto mt-10 max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" />
            {t.host.loginTitle}
          </CardTitle>
          <CardDescription>{t.host.loginBody}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!hasNip07() && <Alert variant="warning">{t.host.noExtension}</Alert>}
          {error && <Alert variant="destructive">{error}</Alert>}
          <Button size="lg" onClick={doLogin} disabled={busy}>
            {busy && <Spinner />}
            {t.host.login}
          </Button>
        </CardContent>
      </Card>
    </Layout>
  );
}

export function HostBar({ session }: { session: HostSession }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>
        {t.host.loggedInAs}:{' '}
        <span className="font-mono text-foreground">{shortNpub(session.pubkey)}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          clearSession();
          location.assign('/host');
        }}
      >
        <LogOut />
        {t.host.logout}
      </Button>
    </div>
  );
}

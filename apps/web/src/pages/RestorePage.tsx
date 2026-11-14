import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Layout, Spinner } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { t } from '@/i18n';
import { restoreTicket, RestoreError } from '@/lib/tickets';

export function RestorePage() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const ticket = await restoreTicket(text);
      navigate(`/t/${ticket.id}`);
    } catch (e) {
      setError(e instanceof RestoreError ? t.restore.errors[e.reason] : t.restore.errors.format);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <h1 className="text-2xl font-bold tracking-tight">{t.restore.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t.restore.body}</p>
      <Textarea
        className="mt-4 min-h-36 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t.restore.placeholder}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        aria-label={t.restore.title}
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button className="mt-4 w-full" size="lg" disabled={!text.trim() || busy} onClick={submit}>
        {busy && <Spinner />}
        {t.restore.submit}
      </Button>
    </Layout>
  );
}

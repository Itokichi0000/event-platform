import { ImagePlus, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Layout, PageMessage, Spinner } from '@/components/Layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { t } from '@/i18n';
import type { EventInput, HostEvent } from '@/lib/api';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { prepareCover } from '@/lib/image';
import { hostJson, hostRequest } from '@/lib/nostr';
import { HostBar, HostGate } from './HostGate';

const HOUR = 3600_000;

function defaults(): EventInput {
  const start = new Date(Date.now() + 7 * 24 * HOUR);
  start.setHours(19, 0, 0, 0);
  return {
    title: '',
    description: '',
    startsAt: start.getTime(),
    endsAt: start.getTime() + 2 * HOUR,
    location: '',
    locationVisibility: 'public',
    capacity: 30,
  };
}

export function EventFormPage() {
  return <HostGate>{(session) => <EventFormInner session={session} />}</HostGate>;
}

function EventFormInner({ session }: { session: Parameters<typeof HostBar>[0]['session'] }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [input, setInput] = useState<EventInput | null>(id ? null : defaults());
  const [cover, setCover] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    hostRequest<HostEvent>(`/api/host/events/${id}`).then(
      (ev) =>
        setInput({
          title: ev.title,
          description: ev.description,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          location: ev.location,
          locationVisibility: ev.locationVisibility,
          capacity: ev.capacity,
        }),
      () => setError(t.app.networkError),
    );
  }, [id]);

  useEffect(() => {
    if (!cover) return;
    const url = URL.createObjectURL(cover);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  if (!input) {
    return (
      <Layout>
        <PageMessage title={error ?? t.app.loading}>{!error && <Spinner />}</PageMessage>
      </Layout>
    );
  }

  const set = <K extends keyof EventInput>(k: K, v: EventInput[K]) =>
    setInput({ ...input, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!input) return;
    if (input.endsAt <= input.startsAt) return setError(t.host.form.errors.time);
    setBusy(true);
    setError(null);
    try {
      const ev = id
        ? await hostJson<HostEvent>('PATCH', `/api/events/${id}`, input)
        : await hostJson<HostEvent>('POST', '/api/events', input);
      if (cover) {
        let blob: Blob;
        try {
          blob = await prepareCover(cover);
        } catch {
          throw new Error('image');
        }
        await hostRequest(`/api/events/${ev.id}/cover`, {
          method: 'PUT',
          body: blob,
          headers: { 'content-type': blob.type },
        });
      }
      navigate(`/host/e/${ev.id}`);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'image'
          ? t.host.form.errors.image
          : t.host.form.errors.generic,
      );
      setBusy(false);
    }
  }

  return (
    <Layout>
      <HostBar session={session} />
      <h1 className="mb-6 text-2xl font-bold tracking-tight">
        {id ? t.host.form.editTitle : t.host.form.createTitle}
      </h1>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <label className="group relative grid aspect-[16/9] cursor-pointer place-items-center overflow-hidden rounded-2xl border border-dashed bg-card">
          {preview ? (
            <img src={preview} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <ImagePlus className="size-8" strokeWidth={1.4} />
              {t.host.form.cover}
            </span>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => setCover(e.target.files?.[0] ?? null)}
          />
        </label>
        <p className="-mt-3 text-xs text-muted-foreground">{t.host.form.coverHint}</p>

        <Field label={t.host.form.title} htmlFor="title">
          <Input
            id="title"
            required
            maxLength={120}
            value={input.title}
            onChange={(e) => set('title', e.target.value)}
            className="text-lg"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.host.form.startsAt} htmlFor="startsAt">
            <Input
              id="startsAt"
              type="datetime-local"
              required
              value={toLocalInput(input.startsAt)}
              onChange={(e) => {
                const startsAt = fromLocalInput(e.target.value);
                const len = input.endsAt - input.startsAt;
                setInput({ ...input, startsAt, endsAt: startsAt + Math.max(len, HOUR) });
              }}
            />
          </Field>
          <Field label={t.host.form.endsAt} htmlFor="endsAt">
            <Input
              id="endsAt"
              type="datetime-local"
              required
              value={toLocalInput(input.endsAt)}
              onChange={(e) => set('endsAt', fromLocalInput(e.target.value))}
            />
          </Field>
        </div>

        <Field label={t.host.form.location} htmlFor="location">
          <Input
            id="location"
            maxLength={500}
            value={input.location}
            onChange={(e) => set('location', e.target.value)}
          />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-primary)]"
              checked={input.locationVisibility === 'ticket_holders'}
              onChange={(e) =>
                set('locationVisibility', e.target.checked ? 'ticket_holders' : 'public')
              }
            />
            <Lock className="size-3.5 text-muted-foreground" />
            {t.host.form.locationHidden}
          </label>
        </Field>

        <Field label={t.host.form.capacity} htmlFor="capacity">
          <Input
            id="capacity"
            type="number"
            min={1}
            max={10000}
            required
            value={input.capacity}
            onChange={(e) => set('capacity', Number(e.target.value))}
            className="w-32"
          />
        </Field>

        <Field label={t.host.form.description} htmlFor="description">
          <Textarea
            id="description"
            maxLength={5000}
            rows={6}
            value={input.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>

        <Card>
          <CardContent className="flex flex-col gap-2 pt-5 text-sm">
            <p className="font-medium">{t.host.form.policy}</p>
            <label className="flex items-center gap-2">
              <input type="radio" checked readOnly className="accent-[var(--color-primary)]" />
              {t.host.form.policyPow}
            </label>
            <p className="text-xs text-muted-foreground">{t.host.form.policyNote}</p>
            <p className="mt-1 flex items-center gap-1.5 text-success">
              <ShieldCheck className="size-4" />
              {t.host.form.anonymity}
            </p>
          </CardContent>
        </Card>

        {error && <Alert variant="destructive">{error}</Alert>}
        <Button type="submit" size="lg" disabled={busy}>
          {busy && <Spinner />}
          {busy ? t.host.form.saving : id ? t.host.form.save : t.host.form.create}
        </Button>
      </form>
    </Layout>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

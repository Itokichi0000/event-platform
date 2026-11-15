import { Check, Gift, MessageCircleQuestion, Plus, UserCheck, Vote, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { api, type Application, type Draw, type Poll, type Question } from '@/lib/api';
import { hostJson, hostRequest, shortNpub } from '@/lib/nostr';

const M = t.host.manage;

function usePolling<T>(load: () => Promise<T>, initial: T, ms = 4000) {
  const [value, setValue] = useState<T>(initial);
  const initialRef = useRef(initial);
  const refresh = useCallback(
    async () => setValue(await load().catch(() => initialRef.current)),
    [load],
  );
  useEffect(() => {
    void refresh();
    const h = setInterval(() => void refresh(), ms);
    return () => clearInterval(h);
  }, [refresh, ms]);
  return [value, refresh] as const;
}

export function PollsCard({ eventId }: { eventId: string }) {
  const [polls, refresh] = usePolling(
    useCallback(() => api.polls(eventId), [eventId]),
    [] as Poll[],
  );
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Vote className="size-4" />
          {M.polls.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{M.polls.body}</p>
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={M.polls.question}
          aria-label={M.polls.question}
          maxLength={200}
        />
        {options.map((o, i) => (
          <Input
            key={i}
            value={o}
            onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={M.polls.option(i + 1)}
            aria-label={M.polls.option(i + 1)}
            maxLength={100}
          />
        ))}
        <div className="flex gap-2">
          {options.length < 8 && (
            <Button variant="ghost" size="sm" onClick={() => setOptions([...options, ''])}>
              <Plus />
              {M.polls.addOption}
            </Button>
          )}
          <Button
            size="sm"
            className="ml-auto"
            disabled={!question.trim() || options.filter((o) => o.trim()).length < 2}
            onClick={async () => {
              await hostJson('POST', `/api/events/${eventId}/polls`, {
                question,
                options: options.map((o) => o.trim()).filter(Boolean),
              }).catch(() => {});
              setQuestion('');
              setOptions(['', '']);
              await refresh();
            }}
          >
            {M.polls.create}
          </Button>
        </div>
        {polls.map((p) => {
          const total = p.counts.reduce((a, b) => a + b, 0);
          return (
            <div key={p.id} className="rounded-lg border p-3 text-sm" data-testid="host-poll">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{p.question}</p>
                {p.status === 'open' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await hostJson('POST', `/api/events/${eventId}/polls/${p.id}/close`).catch(
                        () => {},
                      );
                      await refresh();
                    }}
                  >
                    {M.polls.close}
                  </Button>
                ) : (
                  <Badge variant="secondary">{M.polls.closed}</Badge>
                )}
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {p.options.map((o, i) => (
                  <li key={o} className="relative overflow-hidden rounded border px-2 py-1">
                    <span
                      className="absolute inset-y-0 left-0 bg-primary/20"
                      style={{ width: total ? `${((p.counts[i] ?? 0) / total) * 100}%` : 0 }}
                    />
                    <span className="relative flex justify-between">
                      <span>{o}</span>
                      <span className="tabular-nums">{M.polls.votes(p.counts[i] ?? 0)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function QuestionsCard({ eventId }: { eventId: string }) {
  const [questions, refresh] = usePolling(
    useCallback(() => hostRequest<Question[]>(`/api/events/${eventId}/questions/all`), [eventId]),
    [] as Question[],
  );
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageCircleQuestion className="size-4" />
          {M.questions.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{M.questions.body}</p>
        {questions.length === 0 && (
          <p className="text-sm text-muted-foreground">{M.questions.empty}</p>
        )}
        {questions.map((q) => (
          <div
            key={q.id}
            className="flex items-start gap-2 rounded-lg border p-2 text-sm"
            data-testid="host-question"
          >
            <span className="w-8 shrink-0 text-center font-semibold tabular-nums">{q.upvotes}</span>
            <p
              className={
                q.hidden
                  ? 'flex-1 text-muted-foreground line-through'
                  : 'flex-1 whitespace-pre-wrap'
              }
            >
              {q.body}
            </p>
            {q.hidden ? (
              <Badge variant="secondary">{M.questions.hidden}</Badge>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await hostJson('POST', `/api/events/${eventId}/questions/${q.id}/hide`).catch(
                    () => {},
                  );
                  await refresh();
                }}
              >
                {M.questions.hide}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function DrawsCard({ eventId }: { eventId: string }) {
  const [draws, refresh] = usePolling(
    useCallback(() => api.draws(eventId), [eventId]),
    [] as Draw[],
  );
  const [title, setTitle] = useState('');
  const [winners, setWinners] = useState(1);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gift className="size-4" />
          {M.draws.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-warning">{M.draws.body}</p>
        <div className="flex gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={M.draws.name}
            aria-label={M.draws.name}
            maxLength={100}
          />
          <Input
            type="number"
            min={1}
            max={100}
            value={winners}
            onChange={(e) => setWinners(Number(e.target.value))}
            aria-label={M.draws.winners}
            className="w-20"
          />
          <Button
            size="sm"
            disabled={!title.trim()}
            onClick={async () => {
              await hostJson('POST', `/api/events/${eventId}/draws`, { title, winners }).catch(
                () => {},
              );
              setTitle('');
              await refresh();
            }}
          >
            {M.draws.create}
          </Button>
        </div>
        {draws.map((d) => (
          <div key={d.id} className="rounded-lg border p-3 text-sm" data-testid="host-draw">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">
                {d.title}{' '}
                <span className="text-xs text-muted-foreground">{M.draws.entries(d.entries)}</span>
              </p>
              {d.status === 'open' && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await hostJson('POST', `/api/events/${eventId}/draws/${d.id}/draw`).catch(
                      () => {},
                    );
                    await refresh();
                  }}
                >
                  {M.draws.draw}
                </Button>
              )}
            </div>
            {d.status === 'drawn' && (
              <p className="mt-2 text-xs">
                {M.draws.winningCodes}:{' '}
                <span className="font-mono text-base tracking-widest" data-testid="winning-codes">
                  {d.winningCodes.join(' ')}
                </span>
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ApplicationsCard({ eventId }: { eventId: string }) {
  const [apps, refresh] = usePolling(
    useCallback(() => hostRequest<Application[]>(`/api/events/${eventId}/applications`), [eventId]),
    [] as Application[],
  );
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <UserCheck className="size-4" />
          {M.applications.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{M.applications.body}</p>
        {apps.length === 0 && (
          <p className="text-sm text-muted-foreground">{M.applications.empty}</p>
        )}
        {apps.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-lg border p-2 text-sm"
            data-testid="application"
          >
            <span className="flex-1 truncate font-mono text-xs">{shortNpub(a.pubkey)}</span>
            <Badge
              variant={
                a.state === 'approved' || a.state === 'issued'
                  ? 'success'
                  : a.state === 'rejected'
                    ? 'destructive'
                    : 'secondary'
              }
            >
              {M.applications.state[a.state]}
            </Badge>
            {(a.state === 'pending' || a.state === 'rejected') && (
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={M.applications.approve}
                onClick={async () => {
                  await hostJson(
                    'POST',
                    `/api/events/${eventId}/applications/${a.id}/approve`,
                  ).catch(() => {});
                  await refresh();
                }}
              >
                <Check />
              </Button>
            )}
            {(a.state === 'pending' || a.state === 'approved') && (
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-destructive"
                aria-label={M.applications.reject}
                onClick={async () => {
                  await hostJson(
                    'POST',
                    `/api/events/${eventId}/applications/${a.id}/reject`,
                  ).catch(() => {});
                  await refresh();
                }}
              >
                <X />
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

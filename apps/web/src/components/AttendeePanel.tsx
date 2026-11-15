import { toRedeemPayload } from '@kamen/core';
import { Gift, MessageCircleQuestion, ThumbsUp, Vote } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { api, ApiError, type Draw, type Poll, type Question } from '@/lib/api';
import { putTicket, type StoredTicket } from '@/lib/db';
import { cn } from '@/lib/utils';

const A = t.attendee;

/**
 * Polls, questions and draws for checked-in attendees. Every action presents the check-in
 * credential (a blind-signed token from the door); the server stores only per-poll / per-draw
 * HMACs of it, so nobody can tell who voted, asked or entered.
 */
export function AttendeePanel({
  ticket,
  onTicket,
}: {
  ticket: StoredTicket;
  onTicket: (t: StoredTicket) => void;
}) {
  const eventId = ticket.token.eventId;
  const cred = ticket.voteCredential ? toRedeemPayload(ticket.voteCredential) : null;
  const [polls, setPolls] = useState<Poll[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [draws, setDraws] = useState<Draw[]>([]);
  const [voted, setVoted] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, q, d] = await Promise.all([
      api.polls(eventId).catch(() => []),
      api.questions(eventId).catch(() => []),
      api.draws(eventId).catch(() => []),
    ]);
    setPolls(p);
    setQuestions(q);
    setDraws(d);
  }, [eventId]);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(A.errors[code as keyof typeof A.errors] ?? A.errors.generic);
    }
    await load();
  };

  if (polls.length + questions.length + draws.length === 0 && cred) return null;

  return (
    <Card className="mt-4" data-testid="attendee-panel">
      <CardContent className="flex flex-col gap-5 pt-5">
        <div>
          <h2 className="font-semibold">{A.title}</h2>
          <p className="text-xs text-muted-foreground">{cred ? A.body : A.notCheckedIn}</p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}

        {polls.length > 0 && (
          <section className="flex flex-col gap-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Vote className="size-4" />
              {A.polls}
            </h3>
            {polls.map((p) => {
              const total = p.counts.reduce((a, b) => a + b, 0);
              const done = voted.has(p.id) || p.status === 'closed' || !cred;
              return (
                <div key={p.id} className="rounded-lg border p-3" data-testid="poll">
                  <p className="text-sm font-medium">
                    {p.question}{' '}
                    {p.status === 'closed' && (
                      <span className="text-xs text-muted-foreground">（{A.closed}）</span>
                    )}
                  </p>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {p.options.map((o, i) => (
                      <button
                        key={o}
                        type="button"
                        disabled={done}
                        onClick={() =>
                          act(async () => {
                            if (!cred) return;
                            try {
                              await api.vote(eventId, p.id, cred, i);
                            } finally {
                              setVoted((s) => new Set(s).add(p.id));
                            }
                          })
                        }
                        className={cn(
                          'relative overflow-hidden rounded-md border px-3 py-2 text-left text-sm',
                          !done && 'hover:bg-accent',
                        )}
                      >
                        {done && (
                          <span
                            className="absolute inset-y-0 left-0 bg-primary/20"
                            style={{ width: total ? `${((p.counts[i] ?? 0) / total) * 100}%` : 0 }}
                          />
                        )}
                        <span className="relative flex justify-between gap-2">
                          <span>{o}</span>
                          {done && (
                            <span className="tabular-nums text-muted-foreground">
                              {p.counts[i] ?? 0}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageCircleQuestion className="size-4" />
            {A.questions}
          </h3>
          {cred && (
            <form
              className="flex gap-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                const body = ask.trim();
                if (!body) return;
                void act(async () => {
                  await api.ask(eventId, cred, body);
                  setAsk('');
                });
              }}
            >
              <Input
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                placeholder={A.askPlaceholder}
                maxLength={500}
                aria-label={A.ask}
              />
              <Button type="submit" disabled={!ask.trim()}>
                {A.ask}
              </Button>
            </form>
          )}
          {questions.map((q) => (
            <div
              key={q.id}
              className="flex items-start gap-2 rounded-lg border p-2 text-sm"
              data-testid="question"
            >
              <p className="flex-1 whitespace-pre-wrap">{q.body}</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={!cred}
                onClick={() => cred && act(() => api.upvote(eventId, q.id, cred))}
                aria-label={A.upvote}
              >
                <ThumbsUp />
                {q.upvotes}
              </Button>
            </div>
          ))}
        </section>

        {draws.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Gift className="size-4" />
              {A.draws}
            </h3>
            {draws.map((d) => {
              const code = ticket.drawCodes?.[d.id];
              const won = code && d.winningCodes.includes(code);
              return (
                <div
                  key={d.id}
                  className={cn(
                    'rounded-lg border p-3 text-sm',
                    won && 'border-success bg-success/10',
                  )}
                  data-testid="draw"
                >
                  <p className="font-medium">{d.title}</p>
                  {d.status === 'drawn' && code ? (
                    won ? (
                      <div className="mt-2 text-center" data-testid="draw-won">
                        <p className="text-2xl font-bold text-success">{A.won}</p>
                        <p className="font-mono text-3xl tracking-widest">{code}</p>
                        <p className="text-xs text-muted-foreground">{A.wonBody}</p>
                      </div>
                    ) : (
                      <p className="mt-1 text-muted-foreground" data-testid="draw-lost">
                        {A.lost}
                      </p>
                    )
                  ) : code ? (
                    <p className="mt-1 text-muted-foreground">{A.entered(code)}</p>
                  ) : (
                    d.status === 'open' &&
                    cred && (
                      <Button
                        size="sm"
                        className="mt-2"
                        onClick={() =>
                          act(async () => {
                            const r = await api.enterDraw(eventId, d.id, cred);
                            const updated = {
                              ...ticket,
                              drawCodes: { ...(ticket.drawCodes ?? {}), [d.id]: r.code },
                            };
                            await putTicket(updated);
                            onTicket(updated);
                          })
                        }
                      >
                        {A.enter}
                      </Button>
                    )
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">{A.noValue}</p>
                </div>
              );
            })}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

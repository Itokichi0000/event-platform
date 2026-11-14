const locale = 'ja-JP';

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(ms);
}

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms);
}

export function formatRange(start: number, end: number): string {
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  return sameDay
    ? `${formatTime(start)} – ${formatTime(end)}`
    : `${formatTime(start)} – ${formatDate(end)} ${formatTime(end)}`;
}

export function monthDay(ms: number): { month: string; day: string } {
  const d = new Date(ms);
  return { month: `${d.getMonth() + 1}月`, day: String(d.getDate()) };
}

/** For <input type="datetime-local"> (local time). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}

import { VenetianMask } from 'lucide-react';
import { api } from '@/lib/api';
import { gradientFor } from '@/lib/image';
import { cn } from '@/lib/utils';

export function EventCover({
  id,
  coverVersion,
  className,
}: {
  id: string;
  coverVersion: number | null;
  className?: string;
}) {
  if (coverVersion !== null) {
    return (
      <img
        src={api.coverUrl(id, coverVersion)}
        alt=""
        className={cn('aspect-[16/9] w-full rounded-2xl object-cover', className)}
      />
    );
  }
  return (
    <div
      className={cn(
        'relative grid aspect-[16/9] w-full place-items-center overflow-hidden rounded-2xl',
        className,
      )}
      style={{ background: gradientFor(id) }}
      aria-hidden
    >
      <VenetianMask className="size-16 text-white/25" strokeWidth={1.2} />
    </div>
  );
}

export function DateBadge({ ms }: { ms: number }) {
  const d = new Date(ms);
  return (
    <div className="flex w-12 shrink-0 flex-col overflow-hidden rounded-lg border text-center">
      <span className="bg-muted py-0.5 text-[10px] font-medium text-muted-foreground">
        {d.getMonth() + 1}月
      </span>
      <span className="py-1 text-lg font-semibold leading-none">{d.getDate()}</span>
    </div>
  );
}

import { Ticket, VenetianMask } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

export function Layout({
  children,
  className,
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
        <div
          className={cn(
            'mx-auto flex h-14 items-center justify-between px-4',
            wide ? 'max-w-5xl' : 'max-w-2xl',
          )}
        >
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <VenetianMask className="size-5 text-primary" aria-hidden />
            {t.app.name}
          </Link>
          <Link
            to="/tickets"
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Ticket className="size-4" aria-hidden />
            {t.app.myTickets}
          </Link>
        </div>
      </header>
      <main className={cn('mx-auto px-4 py-6', wide ? 'max-w-5xl' : 'max-w-2xl', className)}>
        {children}
      </main>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent',
        className,
      )}
      aria-hidden
    />
  );
}

export function PageMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <p className="text-lg font-medium">{title}</p>
      {children}
    </div>
  );
}

import { AlertCircle, AlertTriangle, CheckCircle2, Inbox, Info, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useAdminI18n } from '../i18n/context';
import { cn } from '../lib/cn';
import { Button } from './button';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const badgeTones: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  info: 'bg-info/10 text-info border-info/20',
  success: 'bg-success/10 text-success border-success/20',
  warning: 'bg-warning/10 text-warning border-warning/25',
  danger: 'bg-destructive/10 text-destructive border-destructive/20',
};

export function StatusBadge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 break-all',
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const noticeTones: Record<Tone, { box: string; icon: ReactNode }> = {
  neutral: { box: 'border-border bg-muted/50', icon: <Info /> },
  info: { box: 'border-info/25 bg-info/5', icon: <Info className="text-info" /> },
  success: { box: 'border-success/25 bg-success/5', icon: <CheckCircle2 className="text-success" /> },
  warning: { box: 'border-warning/30 bg-warning/5', icon: <AlertTriangle className="text-warning" /> },
  danger: { box: 'border-destructive/25 bg-destructive/5', icon: <AlertCircle className="text-destructive" /> },
};

/** Inline message. Danger notices are announced as alerts. */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex min-w-0 flex-wrap items-start gap-3 rounded-lg border p-3 text-sm', noticeTones[tone].box, className)}
    >
      <span className="mt-0.5 [&_svg]:size-4" aria-hidden="true">
        {noticeTones[tone].icon}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium leading-5">{title}</p>}
        {children && <div className="leading-6 text-muted-foreground break-words">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const { t } = useAdminI18n();
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label ?? t('common.loading')}
    </div>
  );
}

export function EmptyState({ children, className }: { children?: ReactNode; className?: string }) {
  const { t } = useAdminI18n();
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground', className)}>
      <Inbox className="size-6" aria-hidden="true" />
      {children ?? t('common.empty')}
    </div>
  );
}

/** A failed read: says so explicitly and offers retry; never rendered as an empty result. */
export function ErrorState({ message, onRetry, className }: { message?: ReactNode; onRetry?: () => void; className?: string }) {
  const { t } = useAdminI18n();
  return (
    <Notice
      tone="danger"
      className={className}
      title={message ?? t('common.loadFailed')}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  );
}

/** Toast API (sonner); render `<AdminToaster />` once — the admin shell already does. */
export { toast } from 'sonner';

export function AdminToaster() {
  return <Toaster position="top-center" richColors closeButton />;
}

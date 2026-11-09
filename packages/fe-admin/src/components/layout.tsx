import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAdminI18n } from '../i18n/context';
import { cn } from '../lib/cn';

/** Page header (title, description, actions) and content column. */
export function PageContainer({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 space-y-5', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>}
            {description && <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  contentClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card text-card-foreground', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 md:px-5">
          {title && <h2 className="text-base font-medium leading-6">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('min-w-0 p-4 md:p-5', contentClassName)}>{children}</div>
    </section>
  );
}

export interface KeyValueItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
}

/** Definition list for record details; stacks label above value on narrow screens. */
export function KeyValueList({ items, columns = 1, className }: { items: KeyValueItem[]; columns?: 1 | 2 | 3; className?: string }) {
  return (
    <dl
      className={cn(
        'grid min-w-0 gap-x-6 gap-y-3',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((item, index) => (
        <div key={item.key ?? index} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 text-sm leading-6 break-words [overflow-wrap:anywhere]">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Read-only JSON with a copy action. Values are serialized, never rendered as HTML. */
export function JsonView({ value, className, label }: { value: unknown; className?: string; label?: string }) {
  const { t } = useAdminI18n();
  const [copied, setCopied] = useState(false);
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2) ?? 'undefined';
    } catch {
      return String(value);
    }
  })();
  return (
    <div className={cn('relative min-w-0', className)}>
      <pre
        aria-label={label ?? t('common.json')}
        tabIndex={0}
        className="max-h-96 overflow-auto rounded-lg border bg-muted/50 p-3 pr-12 font-mono text-xs leading-5"
      >
        {text}
      </pre>
      <button
        type="button"
        className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4"
        aria-label={copied ? t('common.copied') : t('common.copy')}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

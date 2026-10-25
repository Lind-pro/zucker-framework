import { useTranslations } from 'next-intl';
import { subscriptionStatus, type BillingSubscription } from './types';

export function subscriptionDate(value: string, locale: string): string {
  const date = Date.parse(value);
  return Number.isFinite(date) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date) : '—';
}
export function SubscriptionStatus({ subscription }: { subscription: BillingSubscription }) {
  const t = useTranslations('billing'), status = subscriptionStatus(subscription);
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${status === 'active'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : status === 'cancelPending'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}>
    {t(`subscriptionStatus.${status}`)}
  </span>;
}
export function subscriptionErrorKey(error: unknown, fallback: string): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 403) return 'subscriptionAccessDenied';
  if (status === 404) return 'subscriptionNotFound';
  if (status === 429) return 'tooManyRequests';
  return fallback;
}

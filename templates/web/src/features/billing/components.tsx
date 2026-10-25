import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { buttonClass, panelClass } from '@/app/[locale]/account/_components/AccountForm';
import { moneyLabel, orderStatus, providerLabel, type CheckoutOrder } from './types';

export { buttonClass, panelClass };
export const secondaryButtonClass = 'inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--color-card)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60';

export function FormMessage({ message, error = false }: { message: string; error?: boolean }) {
  return message ? <p role={error ? 'alert' : 'status'} className={`text-sm ${error ? 'text-red-300' : 'text-[var(--color-muted)]'}`}>{message}</p> : null;
}

export function BillingHeading({ title, description }: { title: string; description: string }) {
  const t = useTranslations('billing');
  return <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
    <div><h1 className="text-3xl font-bold tracking-tight">{title}</h1><p className="mt-3 max-w-2xl text-[var(--color-muted)]">{description}</p></div>
    <Link href="/billing/orders" className={secondaryButtonClass}>{t('myOrders')}</Link>
  </header>;
}
export function OrderStatus({ order }: { order: CheckoutOrder }) {
  const t = useTranslations('billing'); const status = orderStatus(order);
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${status === 'paid'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}>
    {t(`status.${status}`)}
  </span>;
}
export function OrderFacts({ order }: { order: CheckoutOrder }) {
  const t = useTranslations('billing'); const locale = useLocale();
  const created = Date.parse(order.createdAt);
  const facts = [
    [t('amount'), moneyLabel(order.money)], [t('paymentMethod'), providerLabel(order.providerId)],
    [t('purchaseType'), t(order.mode === 'subscription' ? 'subscription' : 'oneTime')],
    [t('createdAt'), Number.isFinite(created) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(created) : t('notAvailable')],
  ];
  if (order.refund && ['partial', 'full'].includes(order.refund.state)) facts.push([t('refundedAmount'), moneyLabel(order.refund.refundedMoney)]);
  if (order.refund?.pendingMoney) facts.push([t('pendingRefundAmount'), moneyLabel(order.refund.pendingMoney)]);
  return <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
    {facts.map(([label, value]) => <div key={label}><dt className="text-sm text-[var(--color-muted)]">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}
    <div className="sm:col-span-2"><dt className="text-sm text-[var(--color-muted)]">{t('orderId')}</dt><dd className="mt-1 break-all font-mono text-xs">{order.id}</dd></div>
    {order.refund?.needsAttention && <div className="sm:col-span-2"><p role="status" className="text-sm text-amber-300">{t('refundNeedsAttention')}</p></div>}
  </dl>;
}

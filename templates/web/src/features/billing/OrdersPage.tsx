'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { billingApi } from './api';
import { FormMessage, OrderStatus, buttonClass, panelClass, secondaryButtonClass } from './components';
import { billingErrorKey, moneyLabel, providerLabel, type CheckoutOrderPage } from './types';

export default function OrdersPage() {
  const query = useSearchParams(), locale = useLocale();
  const requested = Number(query.get('page') ?? 1);
  const page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 10000 ? requested : 1;
  return <OrderList key={`${locale}:${page}`} page={page} />;
}

function OrderList({ page }: { page: number }) {
  const t = useTranslations('billing'), locale = useLocale();
  const [result, setResult] = useState<CheckoutOrderPage | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void billingApi.orders(page).then(data => { if (active) setResult(data); })
      .catch(failure => { if (active) setError(t(billingErrorKey(failure, 'ordersFailed'))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, revision, t]);
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  return <div className="mx-auto max-w-5xl space-y-7 px-6 py-10">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
      <div><h1 className="text-3xl font-bold tracking-tight">{t('ordersTitle')}</h1><p className="mt-3 text-[var(--color-muted)]">{t('ordersDescription')}</p></div>
      <div className="flex flex-wrap gap-3"><Link href="/billing/subscriptions" className={secondaryButtonClass}>{t('mySubscriptions')}</Link>
        <Link href="/pricing" className={secondaryButtonClass}>{t('viewPlans')}</Link></div>
    </header>
    {loading && <FormMessage message={t('loadingOrders')} />}
    {error && <section className={`${panelClass} space-y-4`}><FormMessage message={error} error />
      <button className={buttonClass} onClick={() => { setLoading(true); setError(''); setRevision(value => value + 1); }}>{t('retry')}</button></section>}
    {result && <>
      {result.data.length ? <ul className="space-y-4">{result.data.map(order => <li key={order.id}>
        <article className={`${panelClass} grid gap-5 sm:grid-cols-[1fr_auto]`}>
          <div className="min-w-0 space-y-2"><h2 className="text-lg font-semibold">{order.title}</h2>
            <p className="text-sm text-[var(--color-muted)]">{providerLabel(order.providerId)} · {t(order.mode === 'subscription' ? 'subscription' : 'oneTime')}</p>
            <p className="break-all font-mono text-xs text-[var(--color-muted)]">{order.id}</p>
            <time className="block text-xs text-[var(--color-muted)]" dateTime={order.createdAt}>{Number.isFinite(Date.parse(order.createdAt))
              ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(order.createdAt)) : t('notAvailable')}</time>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 sm:flex-col sm:items-end"><p className="text-xl font-semibold tabular-nums">{moneyLabel(order.amountDue ?? order.money)}</p><OrderStatus order={order} />
            <Link href={{ pathname: '/billing/return', query: { order: order.id } }} className="text-sm font-medium text-primary-400 underline-offset-4 hover:underline focus-visible:outline-2">{t('viewOrder')}</Link>
            {order.mode === 'subscription' && order.state === 'paid' && <Link href={`/billing/subscriptions/${encodeURIComponent(order.id)}`} className="text-sm font-medium text-primary-400 underline-offset-4 hover:underline focus-visible:outline-2">{t('viewSubscription')}</Link>}</div>
        </article>
      </li>)}</ul> : <section className={`${panelClass} space-y-3`}><h2 className="text-xl font-semibold">{t(page > 1 ? 'pageEmpty' : 'ordersEmpty')}</h2><p className="text-sm text-[var(--color-muted)]">{t('ordersEmptyDescription')}</p></section>}
      <nav aria-label={t('pagination')} className="flex flex-wrap items-center justify-between gap-4">
        {page > 1 ? <Link className={secondaryButtonClass} href={{ pathname: '/billing/orders', query: { page: page - 1 } }}>{t('previous')}</Link> : <button disabled className={secondaryButtonClass}>{t('previous')}</button>}
        <p className="text-sm text-[var(--color-muted)]">{t('pageOf', { page: result.page, pages, total: result.total })}</p>
        {page < pages ? <Link className={secondaryButtonClass} href={{ pathname: '/billing/orders', query: { page: page + 1 } }}>{t('next')}</Link> : <button disabled className={secondaryButtonClass}>{t('next')}</button>}
      </nav>
    </>}
    <Link href="/account" className="inline-block text-sm text-primary-400 underline-offset-4 hover:underline">{t('backToAccount')}</Link>
  </div>;
}

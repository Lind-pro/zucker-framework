'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { billingApi } from './api';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from './components';
import { SubscriptionStatus, subscriptionDate, subscriptionErrorKey } from './subscription-components';
import { moneyLabel, providerLabel, type SubscriptionPage } from './types';

export default function SubscriptionsPage() {
  const query = useSearchParams(), locale = useLocale();
  const requested = Number(query.get('page') ?? 1);
  const page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 10000 ? requested : 1;
  return <SubscriptionList key={`${locale}:${page}`} page={page} />;
}
function SubscriptionList({ page }: { page: number }) {
  const t = useTranslations('billing'), locale = useLocale();
  const [result, setResult] = useState<SubscriptionPage | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void billingApi.subscriptions(page).then(data => {
      if (!Array.isArray(data.data)) throw new Error('Invalid subscription page');
      if (active) setResult(data);
    }).catch(failure => { if (active) setError(t(subscriptionErrorKey(failure, 'subscriptionsFailed'))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, revision, t]);
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  return <div className="mx-auto max-w-5xl space-y-7 px-6 py-10">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
      <div><h1 className="text-3xl font-bold tracking-tight">{t('subscriptionsTitle')}</h1><p className="mt-3 max-w-xl text-[var(--color-muted)]">{t('subscriptionsDescription')}</p></div>
      <div className="flex flex-wrap gap-3"><Link href="/billing/orders" className={secondaryButtonClass}>{t('myOrders')}</Link><Link href="/pricing" className={secondaryButtonClass}>{t('viewPlans')}</Link></div>
    </header>
    {loading && <FormMessage message={t('loadingSubscriptions')} />}
    {error && <section className={`${panelClass} space-y-4`}><FormMessage message={error} error /><button className={buttonClass} onClick={() => { setError(''); setLoading(true); setRevision(value => value + 1); }}>{t('retry')}</button></section>}
    {result && <>
      {result.data.length ? <ul className="space-y-4">{result.data.map(subscription => <li key={subscription.id}>
        <article className={`${panelClass} grid gap-5 sm:grid-cols-[1fr_auto]`}>
          <div className="min-w-0 space-y-3"><h2 className="text-xl font-semibold">{subscription.title}</h2>
            <p className="text-sm text-[var(--color-muted)]">{providerLabel(subscription.providerId)} · {t(subscription.grantBasis === 'payment' ? 'paymentBased' : 'periodBased')}</p>
            {subscription.currentPeriod && <p className="text-sm text-[var(--color-muted)]">{t('periodEnds', { date: subscriptionDate(subscription.currentPeriod.end, locale) })}</p>}
            {subscription.reconcileStatus === 'attention' ? <p className="text-sm text-amber-300">{t('subscriptionNeedsCheck')}</p>
              : !subscription.initialFulfilledAt && <p className="text-sm text-amber-300">{t('subscriptionCreditsProcessing')}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 sm:flex-col sm:items-end"><p className="text-xl font-semibold tabular-nums">{moneyLabel(subscription.money)}</p><SubscriptionStatus subscription={subscription} />
            <Link href={`/billing/subscriptions/${encodeURIComponent(subscription.id)}`} className="text-sm font-medium text-primary-400 underline-offset-4 hover:underline focus-visible:outline-2">{t('viewSubscription')}</Link></div>
        </article>
      </li>)}</ul> : <section className={`${panelClass} space-y-3`}><h2 className="text-xl font-semibold">{t(page > 1 ? 'subscriptionsPageEmpty' : 'subscriptionsEmpty')}</h2><p className="text-sm text-[var(--color-muted)]">{t('subscriptionsEmptyDescription')}</p></section>}
      <nav aria-label={t('subscriptionPages')} className="flex flex-wrap items-center justify-between gap-4">
        {page > 1 ? <Link className={secondaryButtonClass} href={{ pathname: '/billing/subscriptions', query: { page: page - 1 } }}>{t('previous')}</Link> : <button disabled className={secondaryButtonClass}>{t('previous')}</button>}
        <p className="text-sm text-[var(--color-muted)]">{t('subscriptionPageOf', { page: result.page, pages, total: result.total })}</p>
        {page < pages ? <Link className={secondaryButtonClass} href={{ pathname: '/billing/subscriptions', query: { page: page + 1 } }}>{t('next')}</Link> : <button disabled className={secondaryButtonClass}>{t('next')}</button>}
      </nav>
    </>}
    <Link href="/account" className="inline-block text-sm text-primary-400 underline-offset-4 hover:underline">{t('backToAccount')}</Link>
  </div>;
}

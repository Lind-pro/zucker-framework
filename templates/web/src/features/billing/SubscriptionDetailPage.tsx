'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { billingApi } from './api';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from './components';
import { SubscriptionStatus, subscriptionDate, subscriptionErrorKey } from './subscription-components';
import { moneyLabel, providerLabel, safeBillingUrl, type BillingSubscription, type SubscriptionCancelMode, type SubscriptionReceiptPage } from './types';

export default function SubscriptionDetailPage() {
  const params = useParams<{ id: string }>(), query = useSearchParams(), locale = useLocale();
  const requested = Number(query.get('page') ?? 1);
  const page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 10000 ? requested : 1;
  return <SubscriptionView key={`${locale}:${params.id}`} id={params.id} page={page} />;
}
function SubscriptionView({ id, page }: { id: string; page: number }) {
  const t = useTranslations('billing'), locale = useLocale();
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0), [receiptRevision, setReceiptRevision] = useState(0);
  const [busy, setBusy] = useState<'refresh' | 'cancel' | 'portal' | null>(null), [confirmMode, setConfirmMode] = useState<SubscriptionCancelMode | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false), mounted = useRef(true), confirmation = useRef<HTMLHeadingElement>(null), wasConfirming = useRef(false);
  const accept = (data: BillingSubscription) => {
    if (data.id !== id) throw new Error('Subscription identity mismatch');
    if (mounted.current) setSubscription(data);
  };
  useEffect(() => {
    let active = true; mounted.current = true;
    void billingApi.subscription(id).then(data => {
      if (data.id !== id) throw new Error('Subscription identity mismatch');
      if (active) setSubscription(data);
    }).catch(failure => { if (active) setError(t(subscriptionErrorKey(failure, 'subscriptionLoadFailed'))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [id, revision, t]);
  useEffect(() => { if (confirmMode && !wasConfirming.current) confirmation.current?.focus(); wasConfirming.current = Boolean(confirmMode); }, [confirmMode]);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy('refresh'); setError(''); setNotice('');
    try {
      const data = await billingApi.refreshSubscription(id); accept(data);
      if (mounted.current) { setUncertain(false); setReceiptRevision(value => value + 1); setNotice(t('subscriptionChecked')); }
    } catch (failure) { if (mounted.current) setError(t(subscriptionErrorKey(failure, 'subscriptionCheckFailed'))); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  const cancel = async () => {
    if (!confirmMode || inFlight.current) return;
    const mode = confirmMode; inFlight.current = true; setBusy('cancel'); setConfirmMode(null); setError(''); setNotice('');
    try { const data = await billingApi.cancelSubscription(id, mode); accept(data); if (mounted.current) setUncertain(data.cancelState === 'submitting'); }
    catch (failure) {
      if (mounted.current) { setUncertain(true); setError(t(subscriptionErrorKey(failure, 'subscriptionCancelUnknown'))); }
      try { accept(await billingApi.subscription(id)); } catch { /* Keep the uncertain request visible until an explicit status check succeeds. */ }
    } finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  const pending = uncertain || subscription?.cancelState === 'submitting';
  const canCancel = subscription && !pending && subscription.status !== 'canceled' && subscription.cancelState === 'idle' && subscription.capabilities.cancel.length > 0;
  return <div className="mx-auto max-w-6xl space-y-7 px-6 py-10">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
      <div><p className="mb-2 text-sm text-[var(--color-muted)]">{t('subscriptionDetails')}</p><h1 className="text-3xl font-bold tracking-tight">{subscription?.title ?? t('subscriptionDetails')}</h1></div>
      <Link href="/billing/subscriptions" className={secondaryButtonClass}>{t('allSubscriptions')}</Link>
    </header>
    {loading && <FormMessage message={t('loadingSubscription')} />}
    <FormMessage message={error} error /><FormMessage message={notice} />
    {!subscription && !loading && <button className={buttonClass} onClick={() => { setError(''); setLoading(true); setRevision(value => value + 1); }}>{t('retry')}</button>}
    {subscription && <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-6">
        <section className={`${panelClass} space-y-6`} aria-labelledby="subscription-summary">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="subscription-summary" className="text-xl font-semibold">{t('subscriptionSummary')}</h2><SubscriptionStatus subscription={subscription} /></div>
          {!subscription.initialFulfilledAt && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-relaxed text-amber-300">{t('subscriptionCreditsProcessing')}</p>}
          {subscription.reconcileStatus === 'attention' && <p role="status" className="text-sm leading-relaxed text-amber-300">{t('subscriptionNeedsCheck')}</p>}
          <dl className="grid gap-5 sm:grid-cols-2">
            <div><dt className="text-sm text-[var(--color-muted)]">{t('subscriptionAmount')}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{moneyLabel(subscription.money)}</dd></div>
            <div><dt className="text-sm text-[var(--color-muted)]">{t('paymentMethod')}</dt><dd className="mt-2 font-medium">{providerLabel(subscription.providerId)}</dd></div>
            {subscription.currentPeriod && <div className="sm:col-span-2"><dt className="text-sm text-[var(--color-muted)]">{t('currentPeriod')}</dt><dd className="mt-2 font-medium">{subscriptionDate(subscription.currentPeriod.start, locale)} – {subscriptionDate(subscription.currentPeriod.end, locale)}</dd></div>}
            <div><dt className="text-sm text-[var(--color-muted)]">{t('createdAt')}</dt><dd className="mt-2 text-sm">{subscriptionDate(subscription.createdAt, locale)}</dd></div>
            <div><dt className="text-sm text-[var(--color-muted)]">{t('lastChecked')}</dt><dd className="mt-2 text-sm">{subscription.observedAt ? subscriptionDate(subscription.observedAt, locale) : t('notChecked')}</dd></div>
          </dl>
          <p className="border-t border-[var(--color-border)] pt-5 text-sm leading-relaxed text-[var(--color-muted)]">{t(subscription.grantBasis === 'payment' ? 'paymentPolicyExplanation' : 'periodPolicyExplanation')}</p>
          <Link href={{ pathname: '/billing/return', query: { order: subscription.id } }} className="inline-block text-sm text-primary-400 underline-offset-4 hover:underline">{t('viewInitialOrder')}</Link>
        </section>
      </div>
      <aside className={`${panelClass} space-y-5 lg:col-start-2 lg:row-start-1 lg:row-span-2`} aria-labelledby="subscription-actions">
        <h2 id="subscription-actions" className="text-xl font-semibold">{t('subscriptionActions')}</h2>
        {pending && <p role="status" className="text-sm leading-relaxed text-amber-300">{t('cancellationPendingDescription')}</p>}
        {subscription.cancelState === 'confirmed' && <p role="status" className="text-sm leading-relaxed text-[var(--color-muted)]">{t(subscription.status === 'canceled' ? 'cancellationConfirmed' : 'scheduledCancellationConfirmed')}</p>}
        {subscription.capabilities.refresh && <button className={`${secondaryButtonClass} w-full bg-[var(--color-background)]`} disabled={Boolean(busy)} onClick={() => void refresh()}>{busy === 'refresh' ? t('checkingSubscription') : pending ? t('checkCancellation') : t('refreshSubscription')}</button>}
        {subscription.capabilities.billingPortal && <button className={`${secondaryButtonClass} w-full bg-[var(--color-background)]`} disabled={Boolean(busy)} onClick={async () => {
          if (inFlight.current) return; inFlight.current = true; setBusy('portal'); setError(''); setNotice('');
          try { const response = await billingApi.subscriptionPortal(id), url = safeBillingUrl(response.url); if (!url) throw new Error('Invalid portal URL'); if (mounted.current) window.location.assign(url); }
          catch (failure) { if (mounted.current) setError(t(subscriptionErrorKey(failure, 'portalFailed'))); }
          finally { inFlight.current = false; if (mounted.current) setBusy(null); }
        }}>{busy === 'portal' ? t('openingPortal') : t('openBillingPortal')}</button>}
        {canCancel && !confirmMode && <button className={`${secondaryButtonClass} w-full bg-[var(--color-background)]`} disabled={Boolean(busy)} onClick={() => setConfirmMode(subscription.capabilities.cancel.includes('period_end') ? 'period_end' : 'immediate')}>{t('cancelSubscription')}</button>}
        {confirmMode && canCancel && <section className="space-y-4 border-t border-[var(--color-border)] pt-5" aria-labelledby="cancel-confirm-title">
          <h3 ref={confirmation} tabIndex={-1} id="cancel-confirm-title" className="font-semibold focus-visible:outline-2">{t('confirmCancellationTitle')}</h3>
          <fieldset className="space-y-4"><legend className="mb-3 text-sm text-[var(--color-muted)]">{t('cancellationTiming')}</legend>
            {subscription.capabilities.cancel.map(mode => <label key={mode} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
              <input type="radio" name="cancellation-mode" value={mode} checked={confirmMode === mode} onChange={() => setConfirmMode(mode)} className="mt-1 shrink-0 accent-primary-500" />
              <span><span className="block font-medium">{t(mode === 'period_end' ? 'cancelAtPeriodEnd' : 'cancelImmediately')}</span><span className="mt-1 block text-[var(--color-muted)]">{t(mode === 'period_end' ? 'cancelAtPeriodEndDescription' : 'cancelImmediatelyDescription')}</span></span>
            </label>)}
          </fieldset>
          <p className="text-xs leading-relaxed text-[var(--color-muted)]">{t('cancellationCreditNote')}</p>
          <button className={`${buttonClass} w-full`} disabled={Boolean(busy)} onClick={() => void cancel()}>{t('confirmCancellation')}</button>
          <button className={`${secondaryButtonClass} w-full`} disabled={Boolean(busy)} onClick={() => setConfirmMode(null)}>{t('keepSubscription')}</button>
        </section>}
        {busy === 'cancel' && <FormMessage message={t('cancelingSubscription')} />}
      </aside>
      <div className="min-w-0 lg:col-start-1"><SubscriptionReceipts key={`${id}:${page}`} id={id} page={page} basis={subscription.grantBasis} revision={receiptRevision} /></div>
    </div>}
  </div>;
}
function SubscriptionReceipts({ id, page, basis, revision }: { id: string; page: number; basis: 'period' | 'payment'; revision: number }) {
  const t = useTranslations('billing'), locale = useLocale();
  const [result, setResult] = useState<SubscriptionReceiptPage | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void billingApi.subscriptionReceipts(id, page).then(data => {
      if (!Array.isArray(data.data)) throw new Error('Invalid subscription receipts');
      if (active) { setResult(data); setError(''); }
    }).catch(failure => { if (active) setError(t(subscriptionErrorKey(failure, 'receiptsFailed'))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, page, revision, retry, t]);
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  return <section className={`${panelClass} space-y-5`} aria-labelledby="subscription-receipts">
    <div><h2 id="subscription-receipts" className="text-xl font-semibold">{t('paymentHistory')}</h2><p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">{t(basis === 'payment' ? 'receiptHistoryDescription' : 'periodHistoryDescription')}</p></div>
    {loading && <FormMessage message={t('loadingReceipts')} />}
    {error && <div className="space-y-3"><FormMessage message={error} error /><button className={secondaryButtonClass} onClick={() => { setLoading(true); setError(''); setRetry(value => value + 1); }}>{t('retry')}</button></div>}
    {result && <>
      {result.data.length ? <ul className="divide-y divide-[var(--color-border)]">{result.data.map(receipt => {
        const url = safeBillingUrl(receipt.url);
        return <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-4 py-5 first:pt-0">
          <div className="min-w-0 space-y-2"><p className="font-medium">{moneyLabel(receipt.paidMoney)} <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">{t(receipt.initial ? 'initialPayment' : 'renewalPayment')}</span></p>
            <p className="text-sm text-[var(--color-muted)]">{t('paidOn', { date: subscriptionDate(receipt.paidAt, locale) })}</p>
            {receipt.period && <p className="text-xs text-[var(--color-muted)]">{t('paidPeriod', { start: subscriptionDate(receipt.period.start, locale), end: subscriptionDate(receipt.period.end, locale) })}</p>}
          </div>
          {url && <a href={url} target="_blank" rel="noopener noreferrer" className={`${secondaryButtonClass} bg-[var(--color-background)]`}>{t('viewInvoice')}</a>}
        </li>;
      })}</ul> : <p className="text-sm text-[var(--color-muted)]">{t(page > 1 ? 'receiptsPageEmpty' : 'receiptsEmpty')}</p>}
      <nav aria-label={t('receiptPages')} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-5">
        {page > 1 ? <Link className={secondaryButtonClass} href={{ pathname: `/billing/subscriptions/${encodeURIComponent(id)}`, query: { page: page - 1 } }}>{t('previous')}</Link> : <button disabled className={secondaryButtonClass}>{t('previous')}</button>}
        <p className="text-xs text-[var(--color-muted)]">{t('receiptPageOf', { page: result.page, pages, total: result.total })}</p>
        {page < pages ? <Link className={secondaryButtonClass} href={{ pathname: `/billing/subscriptions/${encodeURIComponent(id)}`, query: { page: page + 1 } }}>{t('next')}</Link> : <button disabled className={secondaryButtonClass}>{t('next')}</button>}
      </nav>
    </>}
  </section>;
}

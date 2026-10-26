'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, CreditCard } from 'lucide-react';
import { readBrowserReferral } from '@zucker-framework/fe-site';
import { getPathname } from '@/i18n/navigation';
import { AccountLink } from '@/components/AccountLink';
import { inputClass } from '@/app/[locale]/account/_components/AccountForm';
import { billingApi } from './api';
import { checkoutAttempt, rememberCheckoutOrder } from './checkout-attempt';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from './components';
import { billingErrorKey, moneyLabel, providerLabel, safeCheckoutUrl, type BillingOffer } from './types';

function OfferCard({ offer }: { offer: BillingOffer }) {
  const t = useTranslations('billing'), locale = useLocale();
  const [providerId, setProviderId] = useState(offer.providers[0]?.id ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const provider = offer.providers.find(value => value.id === providerId);
  return <article className={`${panelClass} flex flex-col`} aria-labelledby={`offer-${offer.id}`}>
    <div className="mb-5 flex items-center justify-between gap-3"><CreditCard aria-hidden className="h-5 w-5 text-primary-400" />
      <span className="text-xs text-[var(--color-muted)]">{t(offer.mode === 'subscription' ? 'subscription' : 'oneTime')}</span></div>
    <h2 id={`offer-${offer.id}`} className="text-xl font-semibold">{offer.title}</h2>
    <p className="mt-5 break-words text-3xl font-semibold tracking-tight">{moneyLabel(offer.money)}</p>
    {offer.mode === 'subscription' && <p className="mt-2 text-xs text-[var(--color-muted)]">{t('initialCharge')}</p>}
    <dl className="my-6 space-y-3 border-y border-[var(--color-border)] py-5 text-sm">
      <div className="flex justify-between gap-4"><dt className="text-[var(--color-muted)]">{t('credits')}</dt><dd className="font-medium tabular-nums">{new Intl.NumberFormat(locale).format(offer.credits)}</dd></div>
      <div className="flex justify-between gap-4"><dt className="text-[var(--color-muted)]">{t('validity')}</dt><dd>{offer.expiresInDays === null ? t('noExpiry') : t('validDays', { days: offer.expiresInDays })}</dd></div>
    </dl>
    <form className="mt-auto space-y-4" onSubmit={async event => {
      event.preventDefault(); if (!provider || inFlight.current) return;
      inFlight.current = true; setBusy(true); setError('');
      try {
        const identity = await billingApi.identity();
        if (typeof identity.id !== 'string' || !identity.id) throw new Error('Authenticated identity is unavailable');
        const referral = provider.referralProviders.map(vendor => readBrowserReferral(vendor, { enabledProviders: provider.referralProviders })).find(Boolean);
        const attempt = checkoutAttempt(identity.id, {
          offerId: offer.id, providerId, ...(referral ? { referral } : {}),
        });
        const permittedReferral = attempt.referral && provider.referralProviders.includes(attempt.referral.provider) ? attempt.referral : undefined;
        const order = await billingApi.create({ offerId: offer.id, providerId, ...(permittedReferral ? { referral: permittedReferral } : {}) }, attempt.key);
        rememberCheckoutOrder(attempt, order.id);
        const destination = safeCheckoutUrl(order.checkoutUrl);
        // Leaving public pages always starts a fresh document, including the local billing fallback.
        window.location.assign(destination ?? getPathname({ locale, href: { pathname: '/billing/return', query: { order: order.id } } }));
      } catch (failure) { setError(t(billingErrorKey(failure, 'checkoutFailed'))); }
      finally { inFlight.current = false; setBusy(false); }
    }}>
      <div><label htmlFor={`provider-${offer.id}`} className="mb-2 block text-sm font-medium">{t('paymentMethod')}</label>
        <select id={`provider-${offer.id}`} value={providerId} disabled={busy} className={inputClass} onChange={event => { setProviderId(event.target.value); setError(''); }}>
          {offer.providers.map(value => <option key={value.id} value={value.id}>{providerLabel(value.id)}</option>)}
        </select></div>
      {offer.mode === 'subscription' && provider?.grantBasis && <p className="text-sm leading-relaxed text-[var(--color-muted)]">
        {t(provider.grantBasis === 'payment' ? 'creditsPerPayment' : 'creditsPerPeriod', { credits: new Intl.NumberFormat(locale).format(offer.credits) })}</p>}
      <FormMessage message={error} error />
      <button type="submit" disabled={busy || !provider} className={`${buttonClass} flex w-full items-center justify-center gap-2`}>
        {busy ? t('openingCheckout') : t('continueToCheckout')}<ArrowRight aria-hidden className="h-4 w-4" />
      </button>
    </form>
  </article>;
}

export default function PricingPage() {
  const t = useTranslations('billing');
  const [offers, setOffers] = useState<BillingOffer[] | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void billingApi.catalog().then(data => { if (!Array.isArray(data)) throw new Error('Invalid catalog response'); if (active) setOffers(data); })
      .catch(() => { if (active) setError(t('catalogFailed')); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, t]);
  return <div className="mx-auto max-w-6xl space-y-8 px-6 py-12">
    <header className="flex flex-wrap items-start justify-between gap-5 border-b border-[var(--color-border)] pb-8">
      <div><h1 className="text-4xl font-bold tracking-tight">{t('pricingTitle')}</h1><p className="mt-3 max-w-2xl text-[var(--color-muted)]">{t('pricingDescription')}</p></div>
      <AccountLink href="/billing/orders" className={secondaryButtonClass}>{t('myOrders')}</AccountLink>
    </header>
    {loading ? <FormMessage message={t('loadingCatalog')} /> : error ? <section className={`${panelClass} space-y-4`}>
      <FormMessage message={error} error /><button className={buttonClass} onClick={() => { setError(''); setLoading(true); setRevision(value => value + 1); }}>{t('retry')}</button>
    </section> : offers?.length ? <div className="grid items-stretch gap-6 md:grid-cols-2 lg:grid-cols-3">{offers.map(offer => <OfferCard key={`${offer.id}:${offer.providers.map(value => value.id).join(',')}`} offer={offer} />)}</div>
      : <section className={`${panelClass} space-y-3`}><h2 className="text-xl font-semibold">{t('catalogEmpty')}</h2><p className="text-sm text-[var(--color-muted)]">{t('catalogEmptyDescription')}</p></section>}
  </div>;
}

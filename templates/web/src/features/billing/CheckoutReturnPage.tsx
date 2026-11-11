'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { billingApi } from './api';
import { completeCheckoutAttempt } from './checkout-attempt';
import { BillingHeading, FormMessage, OrderFacts, OrderStatus, buttonClass, panelClass, secondaryButtonClass } from './components';
import { billingErrorKey, moneyLabel, orderStatus, type CheckoutOrder } from './types';

export default function CheckoutReturnPage() {
  const query = useSearchParams(), locale = useLocale();
  const orderId = query.get('order') ?? '';
  return <OrderView key={`${locale}:${orderId}`} orderId={orderId}
    stripeHint={query.get('session_id')} paypalHint={query.get('token')} creemHint={query.get('checkout_id')} />;
}

function OrderView({ orderId, stripeHint, paypalHint, creemHint }: { orderId: string; stripeHint: string | null; paypalHint: string | null; creemHint: string | null }) {
  const t = useTranslations('billing');
  const validOrderId = !!orderId && orderId.length <= 200 && !/[\u0000-\u001f]/.test(orderId);
  const [order, setOrder] = useState<CheckoutOrder | null>(null), [loading, setLoading] = useState(validOrderId);
  const [error, setError] = useState(validOrderId ? '' : t('missingOrder')), [busy, setBusy] = useState<'confirm' | 'capture' | null>(null);
  const [captureAttempted, setCaptureAttempted] = useState(false);
  const inFlight = useRef(false), mounted = useRef(true);
  const hint = (providerId: string) => {
    const value = providerId === 'stripe' ? stripeHint : providerId === 'paypal' ? paypalHint : providerId === 'creem' ? creemHint : null;
    return value && value.length <= 255 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
  };
  const accept = (data: CheckoutOrder) => {
    if (data.id !== orderId) throw new Error('Order identity mismatch');
    if (!mounted.current) return;
    setOrder(data);
    if (data.state === 'unpaid' || data.state === 'paid' && data.fulfilledAt) completeCheckoutAttempt(data.id);
  };
  useEffect(() => {
    let active = true; mounted.current = true;
    if (!validOrderId) return () => { mounted.current = false; };
    void (async () => {
      try {
        const known = await billingApi.order(orderId);
        if (known.id !== orderId) throw new Error('Order identity mismatch');
        if (!active) return;
        setOrder(known);
        if (known.state === 'paid' && known.fulfilledAt) completeCheckoutAttempt(known.id);
        else {
          // Provider reconciliation is read-only. Capturing is a separate, explicit user action below.
          const value = known.providerId === 'stripe' ? stripeHint : known.providerId === 'paypal' ? paypalHint : known.providerId === 'creem' ? creemHint : null;
          const checkoutId = value && value.length <= 255 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
          const checked = await billingApi.confirm(orderId, checkoutId);
          if (checked.id !== orderId) throw new Error('Order identity mismatch');
          if (active) {
            setOrder(checked);
            if (checked.state === 'unpaid' || checked.state === 'paid' && checked.fulfilledAt) completeCheckoutAttempt(checked.id);
          }
        }
      } catch (failure) { if (active) setError(t(billingErrorKey(failure, 'verificationFailed'))); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; mounted.current = false; };
  }, [orderId, validOrderId, stripeHint, paypalHint, creemHint, t]);

  const check = async () => {
    if (inFlight.current || !validOrderId) return;
    inFlight.current = true; setBusy('confirm'); setError('');
    try {
      const known = order ?? await billingApi.order(orderId);
      if (known.id !== orderId) throw new Error('Order identity mismatch');
      const checked = await billingApi.confirm(orderId, hint(known.providerId));
      accept(checked);
      // A fresh server/provider check may prove that the previous request never claimed capture.
      if (mounted.current && checked.state === 'requires_capture' && checked.captureState === 'idle') setCaptureAttempted(false);
    }
    catch (failure) { if (mounted.current) setError(t(billingErrorKey(failure, 'verificationFailed'))); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  const status = order ? orderStatus(order) : null;
  const canCapture = order?.mode === 'payment' && order.providerId === 'paypal' && order.state === 'requires_capture' && order.captureState === 'idle' && !captureAttempted && !error;
  return <div className="mx-auto max-w-4xl space-y-7 px-6 py-10">
    <BillingHeading title={t('returnTitle')} description={t('returnDescription')} />
    {loading && <FormMessage message={t('checkingPayment')} />}
    {busy === 'capture' && <FormMessage message={t('confirmingPayment')} />}
    <FormMessage message={error} error />
    {order && <section className={`${panelClass} space-y-6`} aria-labelledby="checkout-title">
      <div className="flex flex-wrap items-start justify-between gap-4"><h2 id="checkout-title" className="text-2xl font-semibold">{order.title}</h2><OrderStatus order={order} /></div>
      <p role="status" className="text-sm leading-relaxed text-[var(--color-muted)]">{t(`statusDescription.${status}`)}</p>
      <OrderFacts order={order} />
      {canCapture && !loading && <div className="space-y-4 border-t border-[var(--color-border)] pt-6">
        <p className="text-sm">{t('captureExplanation', { amount: moneyLabel(order.amountDue ?? order.money) })}</p>
        <button className={buttonClass} disabled={Boolean(busy)} onClick={async () => {
          if (inFlight.current) return;
          inFlight.current = true; setCaptureAttempted(true); setBusy('capture'); setError('');
          try { accept(await billingApi.capture(order.id)); }
          catch (failure) {
            if (mounted.current) setError(t(billingErrorKey(failure, 'captureUnknown')));
            try { accept(await billingApi.order(order.id)); } catch { /* Keep the unknown attempt visible; do not submit another capture. */ }
          } finally { inFlight.current = false; if (mounted.current) setBusy(null); }
        }}>{busy === 'capture' ? t('confirmingPayment') : t('payWithPayPal', { amount: moneyLabel(order.amountDue ?? order.money) })}</button>
      </div>}
      <div className="flex flex-wrap gap-3">{status === 'paid' || status === 'refunded' ? <Link href="/account" className={secondaryButtonClass}>{t('backToAccount')}</Link>
        : <button className={secondaryButtonClass} disabled={loading || Boolean(busy)} onClick={() => void check()}>{busy === 'confirm' ? t('checkingPayment') : t('checkStatus')}</button>}
        {order.mode === 'subscription' && order.state === 'paid' && <Link href={`/billing/subscriptions/${encodeURIComponent(order.id)}`} className={secondaryButtonClass}>{t('viewSubscription')}</Link>}
      </div>
    </section>}
    {!order && !loading && validOrderId && <button className={buttonClass} disabled={Boolean(busy)} onClick={() => void check()}>{busy ? t('checkingPayment') : t('retry')}</button>}
    <Link href="/pricing" className="inline-block text-sm text-primary-400 underline-offset-4 hover:underline focus-visible:outline-2">{t('viewPlans')}</Link>
  </div>;
}

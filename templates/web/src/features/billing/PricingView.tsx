'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { readBrowserReferral, type ReferralProvider } from '@zucker-framework/fe-site';
import { inputClass } from '@/app/[locale]/account/_components/AccountForm';
import { useAuthStore } from '@/lib/stores/auth-store';
import { shellClient, useAuthHydrated } from '@/lib/site/session';
import { isLocale } from '@/lib/site/locales';
import { localizedPath } from '@/lib/site/url';
import { billingApi } from './api';
import { checkoutAttempt, rememberCheckoutOrder } from './checkout-attempt';
import { pricingCopy, type PricingCopy } from './copy';
import {
  buildPricingView,
  checkoutProviders,
  formatMoney,
  isPlanInterval,
  parsePricingCatalog,
  planEntitlements,
  type CheckoutPolicy,
  type EntitlementCatalog,
  type PlanInterval,
  type PricingCatalog,
  type PricingPack,
  type PricingPackPrice,
  type PricingPlan,
  type PricingPlanPrice,
} from './pricing';
import { billingErrorKey, PROMO_CODE, providerLabel, safeCheckoutUrl } from './types';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from './components';

const REFERRAL_PROVIDERS: ReferralProvider[] = ['affonso', 'promotekit'];
const CURRENCY_PARAM = /^[A-Z]{3}$/;

function pathFor(locale: string, path: string): string {
  return isLocale(locale) ? localizedPath(locale, path) : path;
}

/**
 * Identity of the current session, or null when signed out. An empty client store is not proof of a
 * guest (a new tab may hold only the HttpOnly refresh cookie): the read goes through the shell client,
 * whose 401 handling performs the shared cookie refresh once and retries. Only a rejected refresh
 * ends in 401 here; other failures (network, 5xx) are thrown so the form can explain them.
 */
async function sessionIdentity(): Promise<{ id: string } | null> {
  try {
    return await shellClient.get<{ id: string }>('/authorize/me', undefined, { _hideError: true });
  } catch (failure) {
    if (failure && typeof failure === 'object' && 'status' in failure && failure.status === 401) return null;
    throw failure;
  }
}

/**
 * Starts (or resumes) checkout for one offer. Guests go to login and come back to the pricing page.
 * The idempotency key comes from checkoutAttempt, so a retry of the same selection resumes the same
 * order. The Server filters the referral by provider.
 */
async function startCheckout(locale: string, offerId: string, providerId: string, returnPath: string, promoCode?: string): Promise<void> {
  const identity = await sessionIdentity();
  if (!identity) {
    window.location.assign(pathFor(locale, `/login?redirect=${encodeURIComponent(returnPath)}`));
    return;
  }
  if (typeof identity.id !== 'string' || !identity.id) throw new Error('Authenticated identity is unavailable');
  const referral = REFERRAL_PROVIDERS.map((vendor) => readBrowserReferral(vendor, { enabledProviders: REFERRAL_PROVIDERS })).find(Boolean);
  const attempt = checkoutAttempt(identity.id, { offerId, providerId, ...(referral ? { referral } : {}), ...(promoCode ? { promoCode } : {}) });
  const order = await billingApi.create(
    { offerId, providerId, ...(attempt.referral ? { referral: attempt.referral } : {}), ...(attempt.promoCode ? { promoCode: attempt.promoCode } : {}) },
    attempt.key,
  );
  rememberCheckoutOrder(attempt, order.id);
  const destination = safeCheckoutUrl(order.checkoutUrl);
  // Leaving public pages always starts a fresh document, including the local billing fallback.
  window.location.assign(destination ?? pathFor(locale, `/billing/return?order=${encodeURIComponent(order.id)}`));
}

function CheckoutForm({
  id,
  locale,
  copy,
  offerId,
  providers,
  policy,
  label,
  returnPath,
  disabled,
}: {
  id: string;
  locale: string;
  copy: PricingCopy;
  offerId: string | null;
  providers: string[];
  policy: CheckoutPolicy;
  label: string;
  returnPath: string;
  disabled?: boolean;
}) {
  const offered = checkoutProviders(providers, policy);
  // A pick belongs to the default it was made against: when the signed-in catalog arrives with a
  // different checkout policy than the cached server render, the selection resets to the new default.
  const [pick, setPick] = useState<{ base: string | null; value: string }>({ base: offered.selected, value: offered.selected ?? '' });
  const providerId = pick.base === offered.selected ? pick.value : (offered.selected ?? '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [promoCode, setPromoCode] = useState('');
  const inFlight = useRef(false);
  const promo = policy.promoCodes === 'alias' ? promoCode.trim() : '';
  const provider = offered.providers.includes(providerId) ? providerId : offered.selected;
  if (!offerId || !provider)
    return (
      <button type="button" disabled className={`${secondaryButtonClass} mt-auto w-full`}>
        {copy.notPurchasable}
      </button>
    );
  return (
    <form
      className="mt-auto space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current || disabled) return;
        if (promo && !PROMO_CODE.test(promo)) {
          setError(copy.promoCodeFormat);
          return;
        }
        inFlight.current = true;
        setBusy(true);
        setError('');
        try {
          await startCheckout(locale, offerId, provider, returnPath, promo || undefined);
        } catch (failure) {
          const key = billingErrorKey(failure, 'checkoutFailed');
          setError(key === 'tooManyRequests' ? copy.tooManyRequests : key === 'promoInvalid' ? copy.promoInvalid : copy.checkoutFailed);
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }}
    >
      {offered.choice && (
        <div>
          <label htmlFor={`provider-${id}`} className="mb-1.5 block text-xs font-medium text-[var(--color-muted)]">
            {copy.paymentMethod}
          </label>
          <select
            id={`provider-${id}`}
            value={provider}
            disabled={busy}
            className={inputClass}
            onChange={(event) => {
              setPick({ base: offered.selected, value: event.target.value });
              setError('');
            }}
          >
            {offered.providers.map((value) => (
              <option key={value} value={value}>
                {providerLabel(value)}
              </option>
            ))}
          </select>
        </div>
      )}
      {policy.promoCodes === 'alias' && (
        <div>
          <label htmlFor={`promo-${id}`} className="mb-1.5 block text-xs font-medium text-[var(--color-muted)]">
            {copy.promoCode} <span className="font-normal">({copy.promoCodeOptional})</span>
          </label>
          <input
            id={`promo-${id}`}
            value={promoCode}
            disabled={busy}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className={`${inputClass} uppercase`}
            onChange={(event) => {
              setPromoCode(event.target.value);
              setError('');
            }}
          />
        </div>
      )}
      <FormMessage message={error} error />
      <button
        type="submit"
        disabled={busy || disabled}
        data-offer-id={offerId}
        className={`${buttonClass} flex w-full items-center justify-center gap-2`}
      >
        {busy ? copy.openingCheckout : label}
        <ArrowRight aria-hidden className="h-4 w-4" />
      </button>
    </form>
  );
}

function priceNote(copy: PricingCopy, price: PricingPlanPrice): string {
  if (price.interval === 'one_time' && price.termDays) return copy.termDays(price.termDays);
  if (price.interval === 'lifetime') return copy.lifetimeAccess;
  return '';
}
function creditExpiryText(copy: PricingCopy, price: PricingPlanPrice): string {
  if (price.creditExpiry === 'period') return copy.creditsExpirePeriod;
  if (typeof price.creditExpiry === 'number') return copy.creditsExpireDays(price.creditExpiry);
  return copy.creditsNeverExpire;
}

function PlanCard({
  plan,
  price,
  locale,
  copy,
  policy,
  entitlements,
  returnPath,
}: {
  plan: PricingPlan;
  price: PricingPlanPrice;
  locale: string;
  copy: PricingCopy;
  policy: CheckoutPolicy;
  entitlements: EntitlementCatalog | null;
  returnPath: string;
}) {
  const number = new Intl.NumberFormat(locale);
  const features = planEntitlements(plan, entitlements);
  const note = priceNote(copy, price);
  const badge = plan.current ? copy.currentPlan : plan.badge ?? (plan.featured ? copy.featured : null);
  return (
    <article
      aria-labelledby={`plan-${plan.id}`}
      data-plan={plan.slug}
      data-current={plan.current || undefined}
      className={`${panelClass} relative flex flex-col ${plan.featured ? 'border-primary-500 ring-2 ring-primary-500/40' : ''}`}
    >
      {badge && (
        <span
          className={`absolute -top-3 left-6 rounded-full px-3 py-1 text-xs font-semibold ${plan.current ? 'bg-emerald-600 text-white' : 'bg-primary-600 text-white'}`}
        >
          {badge}
        </span>
      )}
      <h3 id={`plan-${plan.id}`} className="text-xl font-semibold">
        {plan.name}
      </h3>
      {plan.description && <p className="mt-2 text-sm text-[var(--color-muted)]">{plan.description}</p>}
      <p className="mt-5 flex flex-wrap items-baseline gap-x-2">
        <span className="break-words text-4xl font-semibold tracking-tight tabular-nums">
          {formatMoney(price.amount, price.currency, locale)}
        </span>
        {copy.perInterval[price.interval] && (
          <span className="text-sm text-[var(--color-muted)]">{copy.perInterval[price.interval]}</span>
        )}
      </p>
      {note && <p className="mt-1 text-xs text-[var(--color-muted)]">{note}</p>}
      <ul className="my-6 space-y-2.5 border-t border-[var(--color-border)] pt-5 text-sm">
        {price.credits > 0 && (
          <li className="flex gap-2">
            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
            <span>
              <strong className="font-semibold">{copy.credits(number.format(price.credits))}</strong>{' '}
              {copy.creditsPerInterval[price.interval]}
              <span className="block text-xs text-[var(--color-muted)]">{creditExpiryText(copy, price)}</span>
            </span>
          </li>
        )}
        {plan.highlights.map((highlight, index) => (
          <li key={`h-${index}`} className="flex gap-2">
            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
            <span>{highlight}</span>
          </li>
        ))}
        {features.map((feature) => (
          <li key={feature.key} className="flex gap-2">
            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
            <span>
              {feature.label}
              {feature.limit !== undefined && (
                <span className="text-[var(--color-muted)]">
                  {' · '}
                  {feature.limit < 0 ? copy.unlimited : `${number.format(feature.limit)} ${feature.unit ?? ''}`.trim()}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {plan.current ? (
        <button type="button" disabled className={`${secondaryButtonClass} mt-auto w-full`}>
          {copy.currentPlan}
        </button>
      ) : (
        <CheckoutForm
          id={`${plan.id}-${price.interval}-${price.currency}`}
          locale={locale}
          copy={copy}
          offerId={price.purchasable ? price.offerId : null}
          providers={price.providers}
          policy={policy}
          label={price.interval === 'month' || price.interval === 'year' ? copy.subscribe : copy.choosePlan}
          returnPath={returnPath}
        />
      )}
    </article>
  );
}

function PackCard({
  pack,
  price,
  locale,
  copy,
  policy,
  returnPath,
}: {
  pack: PricingPack;
  price: PricingPackPrice;
  locale: string;
  copy: PricingCopy;
  policy: CheckoutPolicy;
  returnPath: string;
}) {
  return (
    <article aria-labelledby={`pack-${pack.id}`} data-pack={pack.slug} className={`${panelClass} flex flex-col`}>
      <h3 id={`pack-${pack.id}`} className="text-lg font-semibold">
        {pack.title}
      </h3>
      {pack.description && <p className="mt-2 text-sm text-[var(--color-muted)]">{pack.description}</p>}
      <p className="mt-4 text-3xl font-semibold tracking-tight tabular-nums">
        {formatMoney(price.amount, price.currency, locale)}
      </p>
      <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-sm font-medium tabular-nums">
        {copy.packCredits(new Intl.NumberFormat(locale).format(pack.credits))}
      </p>
      <p className="mb-5 mt-1 text-xs text-[var(--color-muted)]">
        {pack.expiresInDays === null ? copy.packNoExpiry : copy.packValidDays(pack.expiresInDays)}
      </p>
      <CheckoutForm
        id={`${pack.id}-${price.currency}`}
        locale={locale}
        copy={copy}
        offerId={price.purchasable ? price.offerId : null}
        providers={price.providers}
        policy={policy}
        label={copy.buy}
        returnPath={returnPath}
      />
    </article>
  );
}

type Selection = { interval?: PlanInterval | null; currency?: string | null };
const subscribeNever = () => () => {};
const readSearch = () => window.location.search;
const readNoSearch = () => '';
function selectionFromSearch(search: string): Selection {
  const params = new URLSearchParams(search);
  const interval = params.get('interval'),
    currency = params.get('currency');
  return {
    interval: isPlanInterval(interval) ? interval : null,
    currency: currency && CURRENCY_PARAM.test(currency) ? currency : null,
  };
}

export interface PricingViewProps {
  locale: string;
  /** Anonymous catalog rendered on the server; `null` when the API was unavailable then. */
  initial: PricingCatalog | null;
  entitlements: EntitlementCatalog | null;
  /** Plan slugs to show (pricing block) or `'all'` (pricing page). */
  plans?: 'all' | readonly string[];
  showPacks?: boolean;
  /** Pricing page: reads/writes `?interval=&currency=` and shows the page header. */
  standalone?: boolean;
}

/**
 * Plans and credit packs. The server renders the anonymous catalog (cacheable HTML); in the browser a
 * signed-in visitor's catalog is re-read with their session so the current plan is marked.
 */
export function PricingView({ locale, initial, entitlements, plans = 'all', showPacks = true, standalone = false }: PricingViewProps) {
  const copy = pricingCopy(locale);
  const [catalog, setCatalog] = useState<PricingCatalog | null>(initial);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // The URL query is read after hydration (the server HTML is query-independent and cacheable).
  const search = useSyncExternalStore(subscribeNever, readSearch, readNoSearch);
  const fromUrl = useMemo(() => (standalone ? selectionFromSearch(search) : {}), [search, standalone]);
  const [picked, setPicked] = useState<Selection>({});
  const selection = useMemo(() => ({ ...fromUrl, ...picked }), [fromUrl, picked]);
  const hydrated = useAuthHydrated();
  const token = useAuthStore((state) => state.token);
  const signedIn = hydrated && !!token;

  // Signed-in visitors re-read with their session (marks `current`); guests only when SSR had no data.
  useEffect(() => {
    if (!hydrated || (!signedIn && initial && retry === 0)) return;
    let active = true;
    const read = signedIn ? shellClient.get<unknown>('/billing/plans', { locale }) : billingApi.plans(locale);
    void read
      .then((value) => {
        if (!active) return;
        setCatalog(parsePricingCatalog(value));
        setFailed(false);
      })
      .catch(() => {
        // Keep the server-rendered catalog when only the personalised read failed.
        if (active && !catalog) setFailed(true);
      });
    return () => {
      active = false;
    };
    // `catalog` is intentionally not a dependency: it is the result of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, signedIn, locale, retry, initial]);

  const view = useMemo(
    () => (catalog ? buildPricingView(catalog, { ...selection, plans }) : null),
    [catalog, selection, plans],
  );

  const choose = (next: Selection) => {
    const merged = { ...selection, ...next };
    setPicked(merged);
    if (!standalone) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(merged)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, '', url);
  };

  const query = new URLSearchParams();
  if (view?.interval) query.set('interval', view.interval);
  if (view?.currency) query.set('currency', view.currency);
  const returnPath = `/pricing${query.size ? `?${query}` : ''}`;

  let body: ReactNode;
  if (!view) {
    body = failed ? (
      <div className={`${panelClass} space-y-4`}>
        <FormMessage message={copy.failed} error />
        <button
          className={buttonClass}
          onClick={() => {
            setFailed(false);
            setRetry((value) => value + 1);
          }}
        >
          {copy.retry}
        </button>
      </div>
    ) : (
      <FormMessage message={copy.loading} />
    );
  } else if (!view.plans.length && !view.packs.length && !view.intervals.length) {
    body = (
      <div className={`${panelClass} space-y-3`}>
        <h2 className="text-xl font-semibold">{copy.empty}</h2>
        <p className="text-sm text-[var(--color-muted)]">{copy.emptyDescription}</p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-10">
        {(view.intervals.length > 1 || view.currencies.length > 1) && (
          <div className="flex flex-wrap items-center justify-center gap-4">
            {view.intervals.length > 1 && (
              <div role="radiogroup" aria-label={copy.billingInterval} className="inline-flex rounded-full border border-[var(--color-border)] p-1">
                {view.intervals.map((interval) => (
                  <button
                    key={interval}
                    type="button"
                    role="radio"
                    aria-checked={view.interval === interval}
                    data-interval={interval}
                    onClick={() => choose({ interval })}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${view.interval === interval ? 'bg-primary-600 text-white' : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
                  >
                    {copy.intervals[interval]}
                  </button>
                ))}
              </div>
            )}
            {view.currencies.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-[var(--color-muted)]">{copy.currency}</span>
                <select
                  value={view.currency ?? ''}
                  data-testid="pricing-currency"
                  onChange={(event) => choose({ currency: event.target.value })}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5"
                >
                  {view.currencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {view.plans.length ? (
          <div className="grid items-stretch gap-6 pt-3 md:grid-cols-2 lg:grid-cols-3">
            {view.plans.map(({ plan, price }) => (
              <PlanCard
                key={`${plan.id}:${price.interval}:${price.currency}:${price.providers.join(',')}`}
                plan={plan}
                price={price}
                locale={locale}
                copy={copy}
                policy={catalog!.checkout}
                entitlements={entitlements}
                returnPath={returnPath}
              />
            ))}
          </div>
        ) : (
          view.intervals.length > 0 && <p className="text-center text-sm text-[var(--color-muted)]">{copy.noPlansInView}</p>
        )}
        {showPacks && view.packs.length > 0 && (
          <section aria-labelledby="credit-packs" className="space-y-5">
            <div>
              <h2 id="credit-packs" className="text-2xl font-semibold tracking-tight">
                {copy.packsTitle}
              </h2>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{copy.packsDescription}</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {view.packs.map(({ pack, price }) => (
                <PackCard
                  key={`${pack.id}:${price.currency}:${price.providers.join(',')}`}
                  pack={pack}
                  price={price}
                  locale={locale}
                  copy={copy}
                  policy={catalog!.checkout}
                  returnPath={returnPath}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (!standalone) return <div data-testid="pricing-block">{body}</div>;
  return (
    <div className="mx-auto max-w-6xl space-y-10 px-6 py-12 md:py-16" data-testid="pricing-page">
      <header className="flex flex-wrap items-end justify-between gap-5 border-b border-[var(--color-border)] pb-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">{copy.title}</h1>
          <p className="mt-3 max-w-2xl text-[var(--color-muted)]">{copy.description}</p>
        </div>
        {signedIn && (
          <a href={pathFor(locale, '/billing/orders')} className={secondaryButtonClass}>
            {copy.myOrders}
          </a>
        )}
      </header>
      {body}
    </div>
  );
}

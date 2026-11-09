import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import {
  PLAN_PRICE_INTERVALS,
  type PlanPrice,
  type PlanPriceInterval,
  type SubscriptionPlan,
  type SubscriptionPlanWriteBody,
} from '@zucker-framework/fe-types/back-office';
import { Button } from '../components/button';
import { Dialog, ConfirmButton } from '../components/dialog';
import { ErrorState, LoadingState, Notice, StatusBadge, toast } from '../components/feedback';
import { Checkbox, Field, Input, Select, Switch, Textarea } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { DataTable } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n, type Translate } from '../i18n/context';
import type { MessageParams } from '../i18n/format';
import type { AdminMessageKey } from '../i18n/zh-CN';
import { errorBody, errorStatus } from '../lib/format';
import { useEntitlementCatalog, type EntitlementCatalog } from './entitlements';
import { DeleteAction, enc } from './shared';

export type { PlanPrice, SubscriptionPlan };

/** Editable price row; numeric inputs stay strings until validated. */
export interface PlanPriceDraft {
  interval: PlanPriceInterval;
  currency: string;
  amount: string;
  /** Days of access; used only for `one_time`. */
  termDays: string;
  /** Provider id → reference text ('' = none). */
  providerRefs: Record<string, string>;
}

/** Editable form state; numeric inputs stay strings until validated. */
export interface PlanDraft {
  slug: string;
  name: string;
  description: string;
  order: string;
  status: boolean;
  prices: PlanPriceDraft[];
  features: Record<string, boolean>;
  /** Counter key → '' (omit), '-1' (unlimited) or a non-negative integer. */
  quotas: Record<string, string>;
}

/** `POST /management/plans` body; PUT adds `expectedRevision`. */
export type PlanWrite = Required<Pick<SubscriptionPlanWriteBody, 'slug' | 'name' | 'description' | 'order' | 'status' | 'prices' | 'features' | 'quotas'>>;

export interface PlanValidationMessage {
  key: AdminMessageKey;
  params?: MessageParams;
}
/** Keyed by field: `slug`, `prices.<index>.amount`, `features.<key>`, `quotas.<key>` … */
export type PlanValidationErrors = Partial<Record<string, PlanValidationMessage>>;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;
const STRIPE_PRICE = /^price_[A-Za-z0-9]{1,250}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
export const DEFAULT_PAYMENT_PROVIDERS: readonly string[] = ['stripe', 'paypal', 'creem'];

export function emptyPriceDraft(interval: PlanPriceInterval = 'month', currency = 'USD'): PlanPriceDraft {
  return { interval, currency, amount: '', termDays: '', providerRefs: {} };
}

export function emptyPlanDraft(): PlanDraft {
  return { slug: '', name: '', description: '', order: '0', status: false, prices: [], features: {}, quotas: {} };
}

export function planToDraft(plan: SubscriptionPlan): PlanDraft {
  return {
    slug: plan.slug,
    name: plan.name,
    description: plan.description ?? '',
    order: String(plan.order ?? 0),
    status: plan.status === true,
    prices: (plan.prices ?? []).map((price) => ({
      interval: price.interval,
      currency: price.currency,
      amount: String(price.amount ?? ''),
      termDays: price.termDays == null ? '' : String(price.termDays),
      providerRefs: { ...(price.providerRefs ?? {}) },
    })),
    features: { ...(plan.features ?? {}) },
    quotas: Object.fromEntries(Object.entries(plan.quotas ?? {}).map(([key, value]) => [key, String(value)])),
  };
}

/**
 * Client-side check mirroring the server's plan write validation (RFC §8.2): slug format, prices
 * (decimal string amounts, 3-letter currency, unique interval + currency, `termDays` only and always
 * for one-time prices, provider references, Stripe Price ID format), feature booleans and quota
 * values (`-1` or a non-negative integer) with every key declared in the entitlement catalog. The
 * server remains authoritative (it also checks currency precision and cross-plan uniqueness).
 */
export function validatePlanDraft(
  draft: PlanDraft,
  catalog: EntitlementCatalog,
): { errors: PlanValidationErrors; payload: PlanWrite | null } {
  const errors: PlanValidationErrors = {};
  const slug = draft.slug.trim();
  if (!SLUG.test(slug)) errors.slug = { key: 'plans.error.slug' };
  const name = draft.name.trim();
  if (!name || name.length > 100) errors.name = { key: 'common.required', params: { label: 'name' } };
  const order = Number(draft.order);
  if (!draft.order.trim() || !Number.isSafeInteger(order) || Math.abs(order) > 1_000_000) errors.order = { key: 'plans.error.order' };
  const prices: PlanPrice[] = [];
  const seen = new Set<string>();
  const refs = new Map<string, number>();
  draft.prices.forEach((row, index) => {
    const at = (field: string) => `prices.${index}.${field}`;
    if (!(PLAN_PRICE_INTERVALS as readonly string[]).includes(row.interval)) errors[at('interval')] = { key: 'plans.error.interval' };
    const currency = row.currency.trim();
    if (!/^[A-Z]{3}$/.test(currency)) errors[at('currency')] = { key: 'plans.error.currency' };
    const amount = row.amount.trim();
    if (!DECIMAL.test(amount)) errors[at('amount')] = { key: 'plans.error.price' };
    const identity = `${row.interval}:${currency}`;
    if (seen.has(identity)) errors[at('currency')] = { key: 'plans.error.duplicatePrice' };
    seen.add(identity);
    let termDays: number | null = null;
    if (row.interval === 'one_time') {
      const days = Number(row.termDays.trim());
      if (!/^\d+$/.test(row.termDays.trim()) || !Number.isSafeInteger(days) || days < 1 || days > 36500)
        errors[at('termDays')] = { key: 'plans.error.termDays' };
      else termDays = days;
    }
    const providerRefs: Record<string, string> = {};
    for (const [provider, raw] of Object.entries(row.providerRefs)) {
      const ref = raw.trim();
      if (!ref) continue;
      const field = at(`providerRefs.${provider}`);
      if (!PROVIDER.test(provider) || ref.length > 255 || CONTROL.test(ref)) errors[field] = { key: 'plans.error.providerRef' };
      else if (provider === 'stripe' && !STRIPE_PRICE.test(ref)) errors[field] = { key: 'plans.error.priceId' };
      else if (refs.has(`${provider}:${ref}`)) errors[field] = { key: 'plans.error.duplicateRef' };
      else {
        refs.set(`${provider}:${ref}`, index);
        providerRefs[provider] = ref;
      }
    }
    prices.push({ interval: row.interval, currency, amount, termDays, providerRefs });
  });
  const featureKeys = new Set(catalog.features.map((feature) => feature.key));
  const counterKeys = new Set(catalog.counters.map((counter) => counter.key));
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(draft.features)) {
    if (!featureKeys.has(key) || typeof value !== 'boolean') errors[`features.${key}`] = { key: 'plans.error.feature', params: { key } };
    else features[key] = value;
  }
  const quotas: Record<string, number> = {};
  for (const [key, raw] of Object.entries(draft.quotas)) {
    const text = raw.trim();
    if (!counterKeys.has(key)) {
      errors[`quotas.${key}`] = { key: 'plans.error.quotaKey', params: { key } };
      continue;
    }
    if (text === '') continue;
    const value = Number(text);
    if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value) || (value < 0 && value !== -1))
      errors[`quotas.${key}`] = { key: 'plans.error.quota', params: { key } };
    else quotas[key] = value;
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return {
    errors,
    payload: { slug, name, description: draft.description.trim() || null, order, status: draft.status, prices, features, quotas },
  };
}

function parsePlans(value: unknown): SubscriptionPlan[] {
  const list = Array.isArray(value) ? value : (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Error('Unexpected plans response');
  return (list as SubscriptionPlan[]).filter((plan) => plan && typeof plan.id === 'string');
}

/** Compact price text for tables: "USD 19.90 / 月". */
export function priceText(t: Translate, price: Pick<PlanPrice, 'interval' | 'currency' | 'amount' | 'termDays'>): string {
  const per =
    price.interval === 'one_time'
      ? t('plans.intervalShort.one_time', { days: price.termDays ?? '?' })
      : t(`plans.intervalShort.${price.interval}`);
  return `${price.currency} ${price.amount} / ${per}`;
}

/** Save failure text: the server's validation `issues`, or the conflict message with a reload hint. */
function saveFailure(t: Translate, error: unknown): string {
  const status = errorStatus(error);
  const body = errorBody(error);
  if (status === 400) return body.issues?.join('；') || body.message || t('common.saveFailed');
  if (status === 409) return t('plans.conflict', { detail: body.message ?? '' });
  return t('common.saveFailed');
}

/** One editable price row. Accessible names carry the row number (`金额 1`, `Amount 1`). */
function PriceRow({
  row,
  index,
  providers,
  errors,
  disabled,
  message,
  onChange,
  onRemove,
}: {
  row: PlanPriceDraft;
  index: number;
  providers: readonly string[];
  errors: PlanValidationErrors;
  disabled: boolean;
  message: (error?: PlanValidationMessage) => string | undefined;
  onChange: (next: PlanPriceDraft, field: string) => void;
  onRemove: () => void;
}) {
  const { t } = useAdminI18n();
  const n = index + 1;
  const at = (field: string) => `prices.${index}.${field}`;
  const input = (field: 'currency' | 'amount' | 'termDays', label: string, extra: { inputMode?: 'decimal' | 'numeric'; placeholder?: string } = {}) => (
    <Field label={label} required error={message(errors[at(field)])}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          name={at(field)}
          data-field={at(field)}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required
          inputMode={extra.inputMode}
          placeholder={extra.placeholder}
          disabled={disabled}
          value={row[field]}
          onChange={(event) => onChange({ ...row, [field]: field === 'currency' ? event.target.value.toUpperCase() : event.target.value }, field)}
        />
      )}
    </Field>
  );
  return (
    <li className="rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t('plans.priceInterval', { n })} required error={message(errors[at('interval')])}>
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              name={at('interval')}
              data-field={at('interval')}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-required
              disabled={disabled}
              value={row.interval}
              options={PLAN_PRICE_INTERVALS.map((interval) => ({ value: interval, label: t(`plans.interval.${interval}`) }))}
              onChange={(event) => {
                const interval = event.target.value as PlanPriceInterval;
                onChange({ ...row, interval, termDays: interval === 'one_time' ? row.termDays : '' }, 'interval');
              }}
            />
          )}
        </Field>
        {input('currency', t('plans.priceCurrency', { n }), { placeholder: 'USD' })}
        {input('amount', t('plans.priceAmount', { n }), { inputMode: 'decimal', placeholder: '19.90' })}
        {row.interval === 'one_time' && input('termDays', t('plans.priceTermDays', { n }), { inputMode: 'numeric', placeholder: '30' })}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {providers.map((provider) => {
          const field = at(`providerRefs.${provider}`);
          return (
            <Field key={provider} label={t('plans.priceProviderRef', { provider, n })} error={message(errors[field])}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  name={field}
                  data-field={field}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  placeholder={provider === 'stripe' ? 'price_…' : undefined}
                  disabled={disabled}
                  value={row.providerRefs[provider] ?? ''}
                  onChange={(event) => onChange({ ...row, providerRefs: { ...row.providerRefs, [provider]: event.target.value } }, `providerRefs.${provider}`)}
                />
              )}
            </Field>
          );
        })}
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" className="text-destructive" icon={<Trash2 />} disabled={disabled} onClick={onRemove}>
          {t('plans.removePrice', { n })}
        </Button>
      </div>
    </li>
  );
}

/** Catalog-driven editor for plan features and quotas plus the plan's prices. */
export function PlanEditor({
  plan,
  catalog,
  onClose,
  onSaved,
}: {
  plan: SubscriptionPlan | null;
  catalog: EntitlementCatalog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const formId = useId();
  const providers = config.paymentProviders;
  const [draft, setDraft] = useState<PlanDraft>(() => (plan ? planToDraft(plan) : emptyPlanDraft()));
  const [errors, setErrors] = useState<PlanValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
  };
  const message = (error?: PlanValidationMessage) =>
    error ? t(error.key, error.key === 'common.required' ? { label: t('plans.name') } : error.params) : undefined;
  const featureKeys = new Set(catalog.features.map((feature) => feature.key));
  const counterKeys = new Set(catalog.counters.map((counter) => counter.key));
  const unknown = [
    ...Object.keys(draft.features).filter((key) => !featureKeys.has(key)),
    ...Object.keys(draft.quotas).filter((key) => !counterKeys.has(key)),
  ];
  async function save(form: HTMLFormElement) {
    const result = validatePlanDraft(draft, catalog);
    setErrors(result.errors);
    if (!result.payload) {
      const first = Object.keys(result.errors)[0];
      if (first) form.querySelector<HTMLElement>(`[data-field="${CSS.escape(first)}"]`)?.focus();
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      // The revision read with this plan detects a concurrent edit (409) instead of overwriting it.
      if (plan) await api.put(`${config.endpoints.plans}/${enc(plan.id)}`, { ...result.payload, expectedRevision: plan.revision });
      else await api.post(config.endpoints.plans, result.payload);
      toast.success(t('common.saved'));
      onSaved();
    } catch (error) {
      setFailure(saveFailure(t, error));
    } finally {
      setSaving(false);
    }
  }
  const text = (key: 'slug' | 'name' | 'order', label: string, extra: { required?: boolean; inputMode?: 'decimal' | 'numeric'; placeholder?: string } = {}) => (
    <Field label={label} required={extra.required} error={message(errors[key])}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          name={key}
          data-field={key}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required={extra.required || undefined}
          inputMode={extra.inputMode}
          placeholder={extra.placeholder}
          disabled={saving}
          value={draft[key]}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </Field>
  );
  const updatePrice = (index: number, next: PlanPriceDraft, field: string) => {
    setDraft((previous) => ({ ...previous, prices: previous.prices.map((row, position) => (position === index ? next : row)) }));
    setErrors((previous) => ({ ...previous, [`prices.${index}.${field}`]: undefined }));
  };
  const removePrice = (index: number) => {
    setDraft((previous) => ({ ...previous, prices: previous.prices.filter((_, position) => position !== index) }));
    // Error keys are positional; revalidate on the next save instead of shifting them.
    setErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith('prices.'))));
  };
  const periodLabel = (period: string) =>
    period === 'month' ? t('plans.counterPeriod.month') : period === 'day' ? t('plans.counterPeriod.day') : t('plans.counterPeriod.lifetime');
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={860}
      title={plan ? t('plans.edit') : t('plans.create')}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {/* Submits the form below, so Enter in any field saves as well. */}
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void save(event.currentTarget);
        }}
      >
        {failure && <Notice tone="danger" title={failure} />}
        <fieldset className="grid gap-4 sm:grid-cols-2">
          {text('name', t('plans.name'), { required: true })}
          {text('slug', t('plans.slug'), { required: true, placeholder: 'pro' })}
          {text('order', t('plans.order'), { required: true, inputMode: 'numeric' })}
          <Field label={t('plans.status')} inline>
            {({ id }) => <Switch id={id} data-field="status" checked={draft.status} disabled={saving} onCheckedChange={(checked) => set('status', checked)} />}
          </Field>
          <Field label={t('common.description')} className="sm:col-span-2">
            {({ id }) => (
              <Textarea id={id} name="description" rows={2} maxLength={2000} disabled={saving} value={draft.description} onChange={(event) => set('description', event.target.value)} />
            )}
          </Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('plans.prices')}</legend>
          <p className="text-xs text-muted-foreground">{t('plans.pricesHint')}</p>
          {draft.prices.length === 0 && <p className="text-sm text-muted-foreground">{t('plans.noPrices')}</p>}
          <ul className="space-y-3">
            {draft.prices.map((row, index) => (
              <PriceRow
                // Rows have no server identity; position is the identity while editing.
                key={index}
                row={row}
                index={index}
                providers={providers}
                errors={errors}
                disabled={saving}
                message={message}
                onChange={(next, field) => updatePrice(index, next, field)}
                onRemove={() => removePrice(index)}
              />
            ))}
          </ul>
          <Button
            size="sm"
            icon={<Plus />}
            disabled={saving}
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                prices: [...previous.prices, emptyPriceDraft(previous.prices.some((row) => row.interval === 'month') ? 'year' : 'month', previous.prices[0]?.currency || 'USD')],
              }))
            }
          >
            {t('plans.addPrice')}
          </Button>
        </fieldset>
        {unknown.length > 0 && (
          <Notice
            tone="warning"
            title={t('plans.unknownKeys', { keys: unknown.join(', ') })}
            action={
              <Button
                size="sm"
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    features: Object.fromEntries(Object.entries(previous.features).filter(([key]) => featureKeys.has(key))),
                    quotas: Object.fromEntries(Object.entries(previous.quotas).filter(([key]) => counterKeys.has(key))),
                  }))
                }
              >
                {t('plans.removeUnknown')}
              </Button>
            }
          />
        )}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('plans.features')}</legend>
          {catalog.features.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('plans.catalogEmpty')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {catalog.features.map((feature) => (
                <li key={feature.key}>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      name={`features.${feature.key}`}
                      data-field={`features.${feature.key}`}
                      checked={draft.features[feature.key] === true}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        setDraft((previous) => ({ ...previous, features: { ...previous.features, [feature.key]: checked } }))
                      }
                    />
                    <span className="min-w-0">
                      <span className="block">
                        {feature.label}{' '}
                        <StatusBadge tone={feature.category === 'metered' ? 'info' : 'neutral'}>
                          {feature.category === 'metered' ? t('plans.metered') : t('plans.benefit')}
                        </StatusBadge>
                      </span>
                      {feature.description && <span className="block text-xs text-muted-foreground">{feature.description}</span>}
                      {errors[`features.${feature.key}`] && (
                        <span role="alert" className="block text-xs text-destructive">
                          {message(errors[`features.${feature.key}`])}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('plans.quotas')}</legend>
          <p className="text-xs text-muted-foreground">{t('plans.unlimitedHint')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {catalog.counters.map((counter) => {
              const value = draft.quotas[counter.key] ?? '';
              return (
                <Field
                  key={counter.key}
                  label={`${counter.label}（${periodLabel(counter.period)}${counter.unit ? ` · ${counter.unit}` : ''}）`}
                  error={message(errors[`quotas.${counter.key}`])}
                >
                  {({ id, describedBy, invalid }) => (
                    <div className="flex items-center gap-3">
                      <Input
                        id={id}
                        name={`quotas.${counter.key}`}
                        data-field={`quotas.${counter.key}`}
                        inputMode="numeric"
                        aria-describedby={describedBy}
                        aria-invalid={invalid || undefined}
                        disabled={saving || value === '-1'}
                        value={value === '-1' ? '' : value}
                        placeholder={value === '-1' ? t('common.unlimited') : undefined}
                        onChange={(event) => {
                          setDraft((previous) => ({ ...previous, quotas: { ...previous.quotas, [counter.key]: event.target.value } }));
                          setErrors((previous) => ({ ...previous, [`quotas.${counter.key}`]: undefined }));
                        }}
                      />
                      <label className="flex shrink-0 items-center gap-1.5 text-sm">
                        <Checkbox
                          aria-label={t('plans.unlimitedFor', { label: counter.label })}
                          checked={value === '-1'}
                          disabled={saving}
                          onCheckedChange={(checked) =>
                            setDraft((previous) => ({ ...previous, quotas: { ...previous.quotas, [counter.key]: checked ? '-1' : '' } }))
                          }
                        />
                        <span aria-hidden="true">{t('common.unlimited')}</span>
                      </label>
                    </div>
                  )}
                </Field>
              );
            })}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function PlansPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.plans;
  const catalog = useEntitlementCatalog();
  const plans = useResource(async (signal) => parsePlans(await api.get(config.endpoints.plans, undefined, { signal })), []);
  const [editing, setEditing] = useState<SubscriptionPlan | 'new' | null>(null);
  const label = (kind: 'feature' | 'counter', key: string) =>
    (kind === 'feature' ? catalog.data?.features : catalog.data?.counters)?.find((item) => item.key === key)?.label ?? key;
  const rows = [...(plans.data ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <PageContainer
      title={t('page.plans')}
      description={t('plans.description')}
      actions={
        can(codes.add) && (
          <Button variant="primary" icon={<Plus />} disabled={!catalog.data} onClick={() => setEditing('new')}>
            {t('plans.create')}
          </Button>
        )
      }
    >
      {catalog.error && <ErrorState message={t('plans.catalogFailed')} onRetry={catalog.reload} />}
      <DataTable<SubscriptionPlan>
        label={t('page.plans')}
        rows={rows}
        rowKey={(row) => row.id}
        loading={plans.loading}
        error={plans.error}
        onRetry={plans.reload}
        columns={[
          { key: 'name', title: t('plans.name'), render: (row) => <span className="font-medium">{row.name}</span> },
          { key: 'slug', title: t('plans.slug'), field: 'slug' },
          {
            key: 'prices',
            title: t('plans.prices'),
            render: (row) =>
              row.prices?.length ? (
                <span className="flex flex-col gap-0.5 whitespace-nowrap">
                  {row.prices.map((price) => (
                    <span key={`${price.interval}:${price.currency}`}>{priceText(t, price)}</span>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('plans.noPrices')}</span>
              ),
          },
          {
            key: 'features',
            title: t('plans.features'),
            render: (row) => (
              <span className="flex flex-wrap gap-1">
                {Object.entries(row.features ?? {})
                  .filter(([, enabled]) => enabled)
                  .map(([key]) => (
                    <StatusBadge key={key} tone="info">
                      {label('feature', key)}
                    </StatusBadge>
                  ))}
              </span>
            ),
          },
          {
            key: 'quotas',
            title: t('plans.quotas'),
            hideOnMobile: true,
            render: (row) =>
              Object.entries(row.quotas ?? {})
                .map(([key, value]) => `${label('counter', key)}: ${value === -1 ? t('common.unlimited') : value}`)
                .join('；') || '—',
          },
          {
            key: 'status',
            title: t('plans.status'),
            render: (row) => <StatusBadge tone={row.status ? 'success' : 'neutral'}>{row.status ? t('plans.listed') : t('plans.unlisted')}</StatusBadge>,
          },
          { key: 'order', title: t('plans.order'), field: 'order', hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {can(codes.update) && (
              <>
                <Button size="sm" variant="ghost" disabled={!catalog.data} onClick={() => setEditing(row)}>
                  {t('common.edit')}
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  title={row.status ? t('plans.unlist') : t('plans.list')}
                  description={row.name}
                  onConfirm={async () => {
                    try {
                      await api.patch(`${config.endpoints.plans}/${enc(row.id)}/status`, { status: !row.status });
                      toast.success(t('plans.statusChanged'));
                      plans.reload();
                    } catch (error) {
                      toast.error(t('common.saveFailed'));
                      throw error;
                    }
                  }}
                >
                  {row.status ? t('plans.unlist') : t('plans.list')}
                </ConfirmButton>
              </>
            )}
            {can(codes.delete) && (
              <DeleteAction
                title={t('plans.deleteConfirm', { name: row.name })}
                description={t('plans.deleteConfirmDescription')}
                onDelete={async () => {
                  await api.delete(`${config.endpoints.plans}/${enc(row.id)}`);
                  plans.reload();
                }}
              />
            )}
          </>
        )}
      />
      {editing && catalog.data && (
        <PlanEditor
          key={editing === 'new' ? 'new' : editing.id}
          plan={editing === 'new' ? null : editing}
          catalog={catalog.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            plans.reload();
          }}
        />
      )}
      {editing && !catalog.data && catalog.loading && <LoadingState />}
    </PageContainer>
  );
}

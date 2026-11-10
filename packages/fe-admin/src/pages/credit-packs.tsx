import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  MAX_CREDIT_EXPIRY_DAYS,
  MAX_PLAN_PRICE_CREDITS,
  type CreditPack,
  type CreditPackPrice,
  type CreditPackWriteBody,
  type LocalizedText,
} from '@zucker-framework/fe-types/back-office';
import { Button } from '../components/button';
import { ConfirmButton, Dialog } from '../components/dialog';
import { Notice, StatusBadge, toast } from '../components/feedback';
import { Field, Input, Switch, Textarea } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { DataTable } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n, type Translate } from '../i18n/context';
import type { AdminMessageKey } from '../i18n/zh-CN';
import type { MessageParams } from '../i18n/format';
import { errorBody, errorStatus } from '../lib/format';
import { DeleteAction, enc } from './shared';

export type { CreditPack };

/** Editable price row; the amount stays a string (exact decimal) until validated. */
export interface CreditPackPriceDraft {
  currency: string;
  amount: string;
  /** Provider id → reference text ('' = none). */
  providerRefs: Record<string, string>;
}
/** Editable form state; numeric inputs stay strings until validated. */
export interface CreditPackDraft {
  slug: string;
  title: string;
  description: string;
  credits: string;
  /** '' = never expires. */
  expiresInDays: string;
  order: string;
  status: boolean;
  prices: CreditPackPriceDraft[];
  /** JSON `{ titleI18n, descriptionI18n }`; '' keeps no translations. */
  translations: string;
}
export interface CreditPackValidationMessage {
  key: AdminMessageKey;
  params?: MessageParams;
}
/** Keyed by field: `slug`, `credits`, `prices.<index>.amount`, `prices.<index>.providerRefs.<id>` … */
export type CreditPackValidationErrors = Partial<Record<string, CreditPackValidationMessage>>;
/** `POST /management/credit-packs` body; PUT adds `expectedRevision`. */
export type CreditPackWrite = Required<Omit<CreditPackWriteBody, 'expectedRevision'>>;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;
const STRIPE_PRICE = /^price_[A-Za-z0-9]{1,250}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TRANSLATION_KEYS = ['titleI18n', 'descriptionI18n'] as const;

export function emptyCreditPackDraft(): CreditPackDraft {
  return {
    slug: '',
    title: '',
    description: '',
    credits: '',
    expiresInDays: '',
    order: '0',
    status: false,
    prices: [],
    translations: '',
  };
}

export function creditPackToDraft(pack: CreditPack): CreditPackDraft {
  const translated = TRANSLATION_KEYS.some((key) => Object.keys(pack[key] ?? {}).length);
  return {
    slug: pack.slug,
    title: pack.title,
    description: pack.description ?? '',
    credits: String(pack.credits),
    expiresInDays: pack.expiresInDays == null ? '' : String(pack.expiresInDays),
    order: String(pack.order ?? 0),
    status: pack.status === true,
    prices: (pack.prices ?? []).map((price) => ({
      currency: price.currency,
      amount: String(price.amount),
      providerRefs: { ...(price.providerRefs ?? {}) },
    })),
    translations: translated
      ? JSON.stringify(
          Object.fromEntries(TRANSLATION_KEYS.map((key) => [key, pack[key] ?? {}])),
          null,
          2,
        )
      : '',
  };
}

/**
 * Client-side check mirroring the server's credit pack write validation (slug, title, credits,
 * expiry days, one price per currency with exact decimal amounts, provider reference format and
 * uniqueness). The server stays authoritative: it also checks currency precision, translation
 * locales and cross-pack reference uniqueness and reports those as `issues`.
 */
export function validateCreditPackDraft(draft: CreditPackDraft): {
  errors: CreditPackValidationErrors;
  payload: CreditPackWrite | null;
} {
  const errors: CreditPackValidationErrors = {};
  const slug = draft.slug.trim();
  if (!SLUG.test(slug)) errors.slug = { key: 'plans.error.slug' };
  const title = draft.title.trim();
  if (!title || title.length > 100 || CONTROL.test(title))
    errors.title = { key: 'creditPacks.error.title' };
  const description = draft.description.trim();
  if (description.length > 2000) errors.description = { key: 'creditPacks.error.summary' };
  const creditsText = draft.credits.trim();
  const credits = Number(creditsText);
  if (
    !/^\d+$/.test(creditsText) ||
    !Number.isSafeInteger(credits) ||
    credits < 1 ||
    credits > MAX_PLAN_PRICE_CREDITS
  )
    errors.credits = { key: 'creditPacks.error.credits' };
  const expiryText = draft.expiresInDays.trim();
  let expiresInDays: number | null = null;
  if (expiryText) {
    const days = Number(expiryText);
    if (!/^\d+$/.test(expiryText) || days < 1 || days > MAX_CREDIT_EXPIRY_DAYS)
      errors.expiresInDays = { key: 'creditPacks.error.expiresInDays' };
    else expiresInDays = days;
  }
  const order = Number(draft.order);
  if (!draft.order.trim() || !Number.isSafeInteger(order) || Math.abs(order) > 1_000_000)
    errors.order = { key: 'plans.error.order' };
  const prices: CreditPackPrice[] = [];
  const currencies = new Set<string>();
  const refs = new Set<string>();
  draft.prices.forEach((row, index) => {
    const at = (field: string) => `prices.${index}.${field}`;
    const currency = row.currency.trim();
    if (!/^[A-Z]{3}$/.test(currency)) errors[at('currency')] = { key: 'plans.error.currency' };
    else if (currencies.has(currency))
      errors[at('currency')] = { key: 'creditPacks.error.duplicateCurrency' };
    currencies.add(currency);
    const amount = row.amount.trim();
    if (!DECIMAL.test(amount)) errors[at('amount')] = { key: 'plans.error.price' };
    const providerRefs: Record<string, string> = {};
    for (const [provider, raw] of Object.entries(row.providerRefs)) {
      const ref = raw.trim();
      if (!ref) continue;
      const field = at(`providerRefs.${provider}`);
      if (!PROVIDER.test(provider) || ref.length > 255 || CONTROL.test(ref))
        errors[field] = { key: 'plans.error.providerRef' };
      else if (provider === 'stripe' && !STRIPE_PRICE.test(ref))
        errors[field] = { key: 'plans.error.priceId' };
      else if (refs.has(`${provider}:${ref}`)) errors[field] = { key: 'plans.error.duplicateRef' };
      else {
        refs.add(`${provider}:${ref}`);
        providerRefs[provider] = ref;
      }
    }
    prices.push({ currency, amount, providerRefs });
  });
  let translations: Record<(typeof TRANSLATION_KEYS)[number], LocalizedText> = {
    titleI18n: {},
    descriptionI18n: {},
  };
  if (draft.translations.trim()) {
    try {
      const parsed: unknown = JSON.parse(draft.translations);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).some((key) => !(TRANSLATION_KEYS as readonly string[]).includes(key))
      )
        throw new Error('shape');
      // Locale tags and lengths stay with the server, which reports them as issues.
      translations = { ...translations, ...(parsed as typeof translations) };
    } catch {
      errors.translations = { key: 'creditPacks.error.translations' };
    }
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return {
    errors,
    payload: {
      slug,
      title,
      description: description || null,
      credits,
      expiresInDays,
      order,
      status: draft.status,
      prices,
      ...translations,
    },
  };
}

function parsePacks(value: unknown): CreditPack[] {
  const list = Array.isArray(value) ? value : (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Error('Unexpected credit packs response');
  return (list as CreditPack[]).filter((pack) => pack && typeof pack.id === 'string');
}

function saveFailure(t: Translate, error: unknown): string {
  const status = errorStatus(error);
  const body = errorBody(error);
  if (status === 400) return body.issues?.join('；') || body.message || t('common.saveFailed');
  if (status === 409) return t('creditPacks.conflict', { detail: body.message ?? '' });
  return t('common.saveFailed');
}

/** Create/edit dialog. PUT carries the revision that was read so a concurrent edit returns 409. */
export function CreditPackEditor({
  pack,
  onClose,
  onSaved,
}: {
  pack: CreditPack | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const providers = config.paymentProviders;
  const [draft, setDraft] = useState<CreditPackDraft>(() =>
    pack ? creditPackToDraft(pack) : emptyCreditPackDraft(),
  );
  const [errors, setErrors] = useState<CreditPackValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const message = (error?: CreditPackValidationMessage) =>
    error ? t(error.key, error.params) : undefined;
  const set = <K extends keyof CreditPackDraft>(key: K, value: CreditPackDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
  };
  const updatePrice = (index: number, next: CreditPackPriceDraft, field: string) => {
    setDraft((previous) => ({
      ...previous,
      prices: previous.prices.map((row, position) => (position === index ? next : row)),
    }));
    setErrors((previous) => ({ ...previous, [`prices.${index}.${field}`]: undefined }));
  };
  async function save(form: HTMLFormElement) {
    const result = validateCreditPackDraft(draft);
    setErrors(result.errors);
    if (!result.payload) {
      const first = Object.keys(result.errors)[0];
      if (first) form.querySelector<HTMLElement>(`[data-field="${CSS.escape(first)}"]`)?.focus();
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      if (pack)
        await api.put(`${config.endpoints.creditPacks}/${enc(pack.id)}`, {
          ...result.payload,
          expectedRevision: pack.revision,
        });
      else await api.post(config.endpoints.creditPacks, result.payload);
      toast.success(t('common.saved'));
      onSaved();
    } catch (error) {
      setFailure(saveFailure(t, error));
    } finally {
      setSaving(false);
    }
  }
  const input = (
    key: 'slug' | 'title' | 'credits' | 'expiresInDays' | 'order',
    label: string,
    extra: {
      required?: boolean;
      inputMode?: 'numeric';
      placeholder?: string;
      description?: string;
    } = {},
  ) => (
    <Field
      label={label}
      required={extra.required}
      description={extra.description}
      error={message(errors[key])}
    >
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
  const formId = 'credit-pack-editor';
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={820}
      title={pack ? t('creditPacks.edit') : t('creditPacks.create')}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void save(event.currentTarget);
        }}
      >
        {failure && <Notice tone="danger" title={failure} />}
        <div className="grid gap-4 sm:grid-cols-2">
          {input('title', t('creditPacks.title'), { required: true })}
          {input('slug', t('plans.slug'), { required: true, placeholder: 'starter' })}
          {input('credits', t('creditPacks.credits'), {
            required: true,
            inputMode: 'numeric',
            placeholder: '1000',
          })}
          {input('expiresInDays', t('creditPacks.expiresInDays'), {
            inputMode: 'numeric',
            placeholder: t('creditPacks.neverExpires'),
            description: t('creditPacks.expiresHint'),
          })}
          {input('order', t('plans.order'), { required: true, inputMode: 'numeric' })}
          <Field label={t('plans.status')} inline description={t('creditPacks.listedHint')}>
            {({ id }) => (
              <Switch
                id={id}
                data-field="status"
                checked={draft.status}
                disabled={saving}
                onCheckedChange={(checked) => set('status', checked)}
              />
            )}
          </Field>
          <Field
            label={t('creditPacks.summary')}
            className="sm:col-span-2"
            error={message(errors.description)}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                name="description"
                data-field="description"
                rows={2}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                disabled={saving}
                value={draft.description}
                onChange={(event) => set('description', event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('plans.translations')}
            className="sm:col-span-2"
            error={message(errors.translations)}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                name="translations"
                data-field="translations"
                rows={3}
                spellCheck={false}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                placeholder={t('creditPacks.translationsHint')}
                disabled={saving}
                value={draft.translations}
                onChange={(event) => set('translations', event.target.value)}
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('plans.prices')}</legend>
          <p className="text-xs text-muted-foreground">{t('creditPacks.pricesHint')}</p>
          {draft.prices.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('plans.noPrices')}</p>
          )}
          <ul className="space-y-3">
            {draft.prices.map((row, index) => {
              const n = index + 1;
              const at = (field: string) => `prices.${index}.${field}`;
              const cell = (
                field: string,
                label: string,
                value: string,
                onChange: (value: string) => void,
                extra: { placeholder?: string; inputMode?: 'decimal'; required?: boolean } = {},
              ) => (
                <Field
                  key={field}
                  label={label}
                  required={extra.required}
                  error={message(errors[at(field)])}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      name={at(field)}
                      data-field={at(field)}
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      aria-required={extra.required || undefined}
                      inputMode={extra.inputMode}
                      placeholder={extra.placeholder}
                      disabled={saving}
                      value={value}
                      onChange={(event) => onChange(event.target.value)}
                    />
                  )}
                </Field>
              );
              return (
                // Price rows have no server identity; position is the identity while editing.
                <li key={index} className="rounded-lg border p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {cell(
                      'currency',
                      t('plans.priceCurrency', { n }),
                      row.currency,
                      (value) =>
                        updatePrice(index, { ...row, currency: value.toUpperCase() }, 'currency'),
                      { placeholder: 'USD', required: true },
                    )}
                    {cell(
                      'amount',
                      t('plans.priceAmount', { n }),
                      row.amount,
                      (value) => updatePrice(index, { ...row, amount: value }, 'amount'),
                      { placeholder: '9.90', inputMode: 'decimal', required: true },
                    )}
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {providers.map((provider) =>
                      cell(
                        `providerRefs.${provider}`,
                        t('plans.priceProviderRef', { provider, n }),
                        row.providerRefs[provider] ?? '',
                        (value) =>
                          updatePrice(
                            index,
                            { ...row, providerRefs: { ...row.providerRefs, [provider]: value } },
                            `providerRefs.${provider}`,
                          ),
                        { placeholder: provider === 'stripe' ? 'price_…' : undefined },
                      ),
                    )}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      icon={<Trash2 />}
                      disabled={saving}
                      onClick={() => {
                        setDraft((previous) => ({
                          ...previous,
                          prices: previous.prices.filter((_, position) => position !== index),
                        }));
                        // Error keys are positional; revalidate on the next save instead of shifting them.
                        setErrors((previous) =>
                          Object.fromEntries(
                            Object.entries(previous).filter(([key]) => !key.startsWith('prices.')),
                          ),
                        );
                      }}
                    >
                      {t('plans.removePrice', { n })}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <Button
            size="sm"
            icon={<Plus />}
            disabled={saving}
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                prices: [
                  ...previous.prices,
                  { currency: previous.prices.length ? '' : 'USD', amount: '', providerRefs: {} },
                ],
              }))
            }
          >
            {t('plans.addPrice')}
          </Button>
        </fieldset>
      </form>
    </Dialog>
  );
}

/** Credit pack catalog over `/management/credit-packs` (plan permissions). */
export function CreditPacksPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.plans;
  const packs = useResource(
    async (signal) =>
      parsePacks(await api.get(config.endpoints.creditPacks, undefined, { signal })),
    [],
  );
  const [editing, setEditing] = useState<CreditPack | 'new' | null>(null);
  const rows = [...(packs.data ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <PageContainer
      title={t('page.creditPacks')}
      description={t('creditPacks.description')}
      actions={
        can(codes.add) && (
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
            {t('creditPacks.create')}
          </Button>
        )
      }
    >
      <DataTable<CreditPack>
        label={t('page.creditPacks')}
        rows={rows}
        rowKey={(row) => row.id}
        loading={packs.loading}
        error={packs.error}
        onRetry={packs.reload}
        columns={[
          {
            key: 'title',
            title: t('creditPacks.title'),
            render: (row) => <span className="font-medium">{row.title}</span>,
          },
          { key: 'slug', title: t('plans.slug'), field: 'slug' },
          {
            key: 'credits',
            title: t('creditPacks.credits'),
            render: (row) => row.credits.toLocaleString(),
          },
          {
            key: 'expiresInDays',
            title: t('creditPacks.expiresInDays'),
            render: (row) =>
              row.expiresInDays == null
                ? t('creditPacks.neverExpires')
                : t('creditPacks.expiresAfter', { days: row.expiresInDays }),
          },
          {
            key: 'prices',
            title: t('plans.prices'),
            render: (row) =>
              row.prices?.length ? (
                <span className="flex flex-col gap-0.5 whitespace-nowrap">
                  {row.prices.map((price) => (
                    <span key={price.currency}>
                      {price.currency} {price.amount}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('plans.noPrices')}</span>
              ),
          },
          {
            key: 'status',
            title: t('plans.status'),
            render: (row) => (
              <StatusBadge tone={row.status ? 'success' : 'neutral'}>
                {row.status ? t('plans.listed') : t('plans.unlisted')}
              </StatusBadge>
            ),
          },
          { key: 'order', title: t('plans.order'), field: 'order', hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {can(codes.update) && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                  {t('common.edit')}
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  title={row.status ? t('plans.unlist') : t('plans.list')}
                  description={row.title}
                  onConfirm={async () => {
                    try {
                      await api.patch(`${config.endpoints.creditPacks}/${enc(row.id)}/status`, {
                        status: !row.status,
                      });
                      toast.success(t('creditPacks.statusChanged'));
                      packs.reload();
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
                title={t('creditPacks.deleteConfirm', { name: row.title })}
                description={t('creditPacks.deleteConfirmDescription')}
                onDelete={async () => {
                  await api.delete(`${config.endpoints.creditPacks}/${enc(row.id)}`);
                  packs.reload();
                }}
              />
            )}
          </>
        )}
      />
      {editing && (
        <CreditPackEditor
          key={editing === 'new' ? 'new' : editing.id}
          pack={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            packs.reload();
          }}
        />
      )}
    </PageContainer>
  );
}

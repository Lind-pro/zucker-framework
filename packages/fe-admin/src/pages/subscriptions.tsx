import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../components/button';
import { ConfirmButton, Drawer } from '../components/dialog';
import { EmptyState, ErrorState, LoadingState, StatusBadge, toast, type Tone } from '../components/feedback';
import {
  FormDialog,
  FormFields,
  isoToLocalDateTime,
  localDateTimeToIso,
  type FieldSpec,
  type FormErrors,
  type FormState,
  type FormValues,
} from '../components/form';
import { KeyValueList, PageContainer } from '../components/layout';
import { DataTable, ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { errorBody, errorStatus, formatDateTime, readPath } from '../lib/format';
import { counterLabel, useEntitlementCatalog } from './entitlements';
import { enc, pageLoader } from './shared';
import {
  USER_SUBSCRIPTION_ACTIVITY,
  USER_SUBSCRIPTION_CYCLES,
  USER_SUBSCRIPTION_STATUSES,
  type PendingPaymentDetails,
  type QuotaSnapshot,
  type SubscriptionPlan,
  type UserSubscriptionAssignmentBody,
  type UserSubscriptionCycle,
  type UserSubscriptionDetail,
  type UserSubscriptionRow,
  type UserSubscriptionStatus,
} from '@zucker-framework/fe-types/back-office';

export const SUBSCRIPTION_STATUSES = USER_SUBSCRIPTION_STATUSES;
export const BILLING_CYCLES = USER_SUBSCRIPTION_CYCLES;
export type { QuotaSnapshot, UserSubscriptionDetail, UserSubscriptionRow };
/** @deprecated Use `UserSubscriptionAssignmentBody` from `@zucker-framework/fe-types`. */
export type SubscriptionAssignmentBody = UserSubscriptionAssignmentBody;

/** Localized billing cycle / source, falling back to the stored value for unknown entries. */
function cycleText(t: ReturnType<typeof useAdminI18n>['t'], cycle: string): string {
  return (BILLING_CYCLES as readonly string[]).includes(cycle) ? t(`subscriptions.cycle.${cycle as UserSubscriptionCycle}`) : cycle;
}
function sourceText(t: ReturnType<typeof useAdminI18n>['t'], source: unknown): string {
  return source === 'admin' ? t('subscriptions.source.admin') : source === 'payment' ? t('subscriptions.source.payment') : String(source ?? '—');
}

function activityBadge(t: ReturnType<typeof useAdminI18n>['t'], active: boolean) {
  return <StatusBadge tone={active ? 'success' : 'neutral'}>{t(active ? 'subscriptions.activity.active' : 'subscriptions.activity.inactive')}</StatusBadge>;
}

const statusTone = (status: string): Tone => (status === 'ACTIVE' ? 'success' : status === 'CANCELED' ? 'warning' : 'neutral');

/** Values of the assign/modify form; dates are `datetime-local` strings in the browser's zone. */
export interface AssignmentFormValues extends Record<string, unknown> {
  userId: string;
  planSlug: string;
  billingCycle: UserSubscriptionCycle;
  status: UserSubscriptionStatus;
  startDate: string;
  endDate: string;
}

export function assignmentInitialValues(row: UserSubscriptionRow | null): AssignmentFormValues {
  return {
    userId: row?.userId ?? '',
    planSlug: row?.plan?.slug ?? '',
    billingCycle: row?.billingCycle ?? 'MONTHLY',
    status: row?.status ?? 'ACTIVE',
    startDate: isoToLocalDateTime(row?.startDate),
    endDate: row?.billingCycle === 'LIFETIME' ? '' : isoToLocalDateTime(row?.endDate),
  };
}

/** A new finite ONE_TIME term cannot be derived on the server; it needs an explicit end. */
function needsExplicitEnd(values: AssignmentFormValues, initial: AssignmentFormValues, existing: boolean): boolean {
  if (values.billingCycle !== 'ONE_TIME') return false;
  const keepsTerm = existing && initial.billingCycle === 'ONE_TIME' && initial.planSlug === String(values.planSlug ?? '').trim();
  return !keepsTerm;
}

/**
 * `PUT /management/subscriptions/:userId` body. Dates are sent only when the administrator changed
 * them, at the precision entered (an untouched paid term keeps its exact start and end); a LIFETIME
 * term never sends an end date.
 */
export function assignmentPayload(values: AssignmentFormValues, initial: AssignmentFormValues): UserSubscriptionAssignmentBody {
  const body: UserSubscriptionAssignmentBody = {
    planSlug: String(values.planSlug ?? '').trim(),
    billingCycle: values.billingCycle,
    status: values.status,
  };
  const start = values.startDate !== initial.startDate ? localDateTimeToIso(values.startDate) : null;
  if (start) body.startDate = start;
  if (values.billingCycle !== 'LIFETIME' && values.endDate !== initial.endDate) {
    const end = localDateTimeToIso(values.endDate);
    if (end) body.endDate = end;
    // A cleared end date is sent explicitly so the server rejects it (a finite term needs an end)
    // instead of silently keeping the stored date while the dialog reports success.
    else if (!String(values.endDate ?? '').trim() && initial.endDate) body.endDate = null;
  }
  return body;
}

/** The message for a rejected assignment, naming the billing record that blocks it (409 pending_payment). */
function assignmentError(t: ReturnType<typeof useAdminI18n>['t'], error: unknown): string {
  const body = errorBody(error);
  const blocking = (body.details as Partial<PendingPaymentDetails> | undefined)?.blocking;
  if (body.reason === 'pending_payment' && blocking && typeof blocking.id === 'string')
    return t('subscriptions.pendingPayment', {
      kind: blocking.kind === 'subscription' ? t('subscriptions.kind.subscription') : t('subscriptions.kind.order'),
      id: blocking.id,
      state: String(blocking.state ?? ''),
    });
  return body.issues?.join('；') || body.message || t('subscriptions.assignFailed');
}

/** Assign or modify a user's subscription (`PUT /management/subscriptions/:userId`). */
function AssignDialog({
  row,
  onClose,
  onSaved,
}: {
  row: UserSubscriptionRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const canListPlans = can(config.permissions.plans.query);
  const plans = useResource(
    async (signal) => {
      const value = await api.get<unknown>(config.endpoints.plans, undefined, { signal });
      const list = Array.isArray(value) ? value : (value as { data?: unknown })?.data;
      if (!Array.isArray(list)) throw new Error('Unexpected plans response');
      return list as Array<Pick<SubscriptionPlan, 'slug' | 'name' | 'status'>>;
    },
    [],
    { enabled: canListPlans },
  );
  const initial = assignmentInitialValues(row);
  const planField: FieldSpec =
    canListPlans && plans.data
      ? {
          name: 'planSlug',
          label: t('subscriptions.plan'),
          type: 'select',
          required: true,
          options: plans.data.map((plan) => ({
            value: plan.slug,
            label: `${plan.name} (${plan.slug})${plan.status === false ? ` · ${t('plans.unlisted')}` : ''}`,
          })),
        }
      : { name: 'planSlug', label: t('subscriptions.planSlug'), required: true };
  const fields: FieldSpec[] = [
    { name: 'userId', label: t('common.userId'), required: true, disabled: Boolean(row) },
    planField,
    {
      name: 'billingCycle',
      label: t('subscriptions.billingCycle'),
      type: 'select',
      required: true,
      options: BILLING_CYCLES.map((cycle) => ({ value: cycle, label: t(`subscriptions.cycle.${cycle}`) })),
    },
    {
      name: 'status',
      label: t('subscriptions.status'),
      type: 'select',
      required: true,
      options: SUBSCRIPTION_STATUSES.map((status) => ({ value: status, label: status })),
    },
  ];
  if (canListPlans && plans.loading && !plans.data) return null;
  return (
    <FormDialog<AssignmentFormValues>
      open
      onOpenChange={(open) => !open && onClose()}
      title={row ? t('subscriptions.modify') : t('subscriptions.assign')}
      description={t('subscriptions.datesHint')}
      columns={2}
      failureMessage={t('subscriptions.assignFailed')}
      initialValues={initial}
      fields={fields}
      validate={(values) => {
        const errors: FormErrors = {};
        const start = localDateTimeToIso(values.startDate);
        const end = values.billingCycle === 'LIFETIME' ? null : localDateTimeToIso(values.endDate);
        if (start && end && end <= start) errors.endDate = t('subscriptions.error.dateOrder');
        if (!end && needsExplicitEnd(values, initial, Boolean(row))) errors.endDate = t('subscriptions.error.oneTimeEnd');
        return errors;
      }}
      onSubmit={async (values) => {
        try {
          await api.put(`${config.endpoints.userSubscriptions}/${enc(String(values.userId).trim())}`, assignmentPayload(values, initial));
        } catch (error) {
          if (errorStatus(error) === 409 || errorStatus(error) === 400) toast.error(assignmentError(t, error));
          throw error;
        }
        toast.success(t('subscriptions.assigned'));
        onSaved();
      }}
    >
      {(form) => (
        <FormFields
          columns={2}
          form={form as unknown as FormState<FormValues>}
          fields={[
            { name: 'startDate', label: t('subscriptions.startDate'), type: 'datetime' },
            // A lifetime term has no end; the field is hidden and never sent.
            {
              name: 'endDate',
              label: t('subscriptions.endDate'),
              type: 'datetime',
              hidden: form.values.billingCycle === 'LIFETIME',
              required: needsExplicitEnd(form.values, initial, Boolean(row)),
            },
          ]}
        />
      )}
    </FormDialog>
  );
}

/** Subscription detail with the user's counter snapshot (`GET /management/subscriptions/:userId`). */
function SubscriptionDetail({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const catalog = useEntitlementCatalog();
  const detail = useResource(
    async (signal) => {
      try {
        return await api.get<UserSubscriptionDetail>(`${config.endpoints.userSubscriptions}/${enc(userId)}`, undefined, { signal });
      } catch (error) {
        if (errorStatus(error) === 404) return null;
        throw error;
      }
    },
    [userId],
  );
  const subscription = detail.data ?? null;
  const plan = subscription?.plan ?? null;
  const quotas = Object.entries(detail.data?.quotas ?? {});
  const amount = (value: number) => (value === -1 ? t('common.unlimited') : String(value));
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()} title={t('common.recordDetails', { name: userId })}>
      {detail.loading ? (
        <LoadingState />
      ) : detail.error ? (
        <ErrorState message={t('subscriptions.snapshotFailed')} onRetry={detail.reload} />
      ) : !subscription ? (
        <EmptyState>{t('subscriptions.noSubscription')}</EmptyState>
      ) : (
        <div className="space-y-6">
          <KeyValueList
            columns={2}
            items={[
              { label: t('subscriptions.plan'), value: plan ? `${plan.name} (${plan.slug})` : '—' },
              { label: t('subscriptions.status'), value: <StatusBadge tone={statusTone(subscription.status)}>{subscription.status}</StatusBadge> },
              { label: t('subscriptions.activity'), value: activityBadge(t, subscription.active) },
              { label: t('subscriptions.billingCycle'), value: cycleText(t, subscription.billingCycle) },
              { label: t('subscriptions.source'), value: sourceText(t, subscription.source) },
              { label: t('subscriptions.startDate'), value: formatDateTime(subscription.startDate, locale) },
              { label: t('subscriptions.endDate'), value: subscription.billingCycle === 'LIFETIME' ? t('subscriptions.cycle.LIFETIME') : formatDateTime(subscription.endDate, locale) },
              { label: t('subscriptions.cancelAtPeriodEnd'), value: subscription.cancelAtPeriodEnd ? t('common.yes') : t('common.no') },
            ]}
          />
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('subscriptions.quotaSnapshot')}</h3>
            <DataTable
              label={t('subscriptions.quotaSnapshot')}
              rows={quotas}
              rowKey={([key]) => key}
              columns={[
                { key: 'counter', title: t('quota.counter'), render: ([key]) => counterLabel(catalog.data, key) },
                { key: 'limit', title: t('subscriptions.limit'), render: ([, quota]) => amount(quota.limit) },
                { key: 'used', title: t('subscriptions.used'), render: ([, quota]) => quota.used },
                { key: 'reserved', title: t('subscriptions.reserved'), render: ([, quota]) => quota.reserved },
                { key: 'remaining', title: t('subscriptions.remaining'), render: ([, quota]) => amount(quota.remaining) },
                { key: 'period', title: t('subscriptions.period'), render: ([, quota]) => quota.period },
              ]}
            />
          </section>
        </div>
      )}
    </Drawer>
  );
}

export function UserSubscriptionsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const canUpdate = can(config.permissions.subscriptions.update);
  const table = useRef<ResourceTableHandle>(null);
  const [assigning, setAssigning] = useState<UserSubscriptionRow | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <PageContainer
      title={t('page.userSubscriptions')}
      description={t('subscriptions.description')}
      actions={
        canUpdate && (
          <Button variant="primary" icon={<Plus />} onClick={() => setAssigning('new')}>
            {t('subscriptions.assign')}
          </Button>
        )
      }
    >
      <ResourceTable<UserSubscriptionRow>
        ref={table}
        label={t('page.userSubscriptions')}
        load={pageLoader(api, config.endpoints.userSubscriptions)}
        rowKey={(row) => row.id ?? row.userId}
        filters={[
          { name: 'userId', label: t('common.userId') },
          { name: 'planSlug', label: t('subscriptions.planSlug') },
          {
            name: 'status',
            label: t('subscriptions.status'),
            type: 'select',
            options: SUBSCRIPTION_STATUSES.map((status) => ({ value: status, label: status })),
          },
          {
            name: 'active',
            label: t('subscriptions.activity'),
            type: 'select',
            options: USER_SUBSCRIPTION_ACTIVITY.map((value) => ({ value, label: t(`subscriptions.activity.${value}`) })),
          },
        ]}
        columns={[
          {
            key: 'user',
            title: t('subscriptions.user'),
            render: (row) => (
              <span>
                <span className="block font-medium">{row.user?.username ?? row.userId}</span>
                {row.user?.email && <span className="block text-xs text-muted-foreground">{row.user.email}</span>}
              </span>
            ),
          },
          { key: 'plan', title: t('subscriptions.plan'), render: (row) => row.plan?.name ?? row.plan?.slug ?? '—' },
          {
            key: 'billingCycle',
            title: t('subscriptions.billingCycle'),
            render: (row) => cycleText(t, row.billingCycle),
          },
          { key: 'status', title: t('subscriptions.status'), render: (row) => <StatusBadge tone={statusTone(row.status)}>{row.status}</StatusBadge> },
          { key: 'active', title: t('subscriptions.activity'), render: (row) => activityBadge(t, row.active) },
          {
            key: 'endDate',
            title: t('subscriptions.endDate'),
            render: (row) => (row.billingCycle === 'LIFETIME' ? t('subscriptions.cycle.LIFETIME') : formatDateTime(row.endDate, locale)),
          },
          {
            key: 'source',
            title: t('subscriptions.source'),
            hideOnMobile: true,
            render: (row) => sourceText(t, readPath(row, 'source')),
          },
        ]}
        actions={(row) => (
          <>
            <Button size="sm" variant="ghost" onClick={() => setViewing(row.userId)}>
              {t('common.details')}
            </Button>
            {canUpdate && (
              <Button size="sm" variant="ghost" onClick={() => setAssigning(row)}>
                {t('subscriptions.modify')}
              </Button>
            )}
            {canUpdate && row.status === 'ACTIVE' && row.billingCycle !== 'LIFETIME' && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                className="text-destructive"
                destructive
                title={t('subscriptions.cancelConfirm', { user: row.user?.username ?? row.userId })}
                description={t('subscriptions.cancelConfirmDescription')}
                onConfirm={async () => {
                  try {
                    await api.delete(`${config.endpoints.userSubscriptions}/${enc(row.userId)}`);
                    toast.success(t('subscriptions.cancelled'));
                    table.current?.reload();
                  } catch (error) {
                    toast.error(assignmentError(t, error));
                    throw error;
                  }
                }}
              >
                {t('subscriptions.cancel')}
              </ConfirmButton>
            )}
            {/* A lifetime term has no period end to cancel at; revoking ends it now (status EXPIRED). */}
            {canUpdate && row.status !== 'EXPIRED' && row.billingCycle === 'LIFETIME' && row.plan && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                className="text-destructive"
                destructive
                title={t('subscriptions.revokeConfirm', { user: row.user?.username ?? row.userId })}
                description={t('subscriptions.revokeConfirmDescription')}
                onConfirm={async () => {
                  try {
                    const body: UserSubscriptionAssignmentBody = { planSlug: row.plan?.slug ?? '', billingCycle: 'LIFETIME', status: 'EXPIRED' };
                    await api.put(`${config.endpoints.userSubscriptions}/${enc(row.userId)}`, body);
                    toast.success(t('subscriptions.revoked'));
                    table.current?.reload();
                  } catch (error) {
                    toast.error(assignmentError(t, error));
                    throw error;
                  }
                }}
              >
                {t('subscriptions.revoke')}
              </ConfirmButton>
            )}
          </>
        )}
      />
      {assigning && (
        <AssignDialog
          row={assigning === 'new' ? null : assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => table.current?.reload()}
        />
      )}
      {viewing && <SubscriptionDetail userId={viewing} onClose={() => setViewing(null)} />}
    </PageContainer>
  );
}

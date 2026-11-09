import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, buttonClass } from '../components/button';
import { Dialog, Drawer } from '../components/dialog';
import { ErrorState, LoadingState, Notice, StatusBadge, toast, type Tone } from '../components/feedback';
import { Field, Input } from '../components/inputs';
import { KeyValueList, PageContainer, Panel } from '../components/layout';
import { ResourceTable, assertPage, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { errorStatus, formatDateTime, moneyText, type Money } from '../lib/format';
import { clearOperationAttempt, findOperationAttempt, operationAttempt } from '../lib/operation-attempt';
import { confirmActor, enc } from './shared';

export type RefundTargetType = 'order' | 'cycle';
export type RefundState =
  | 'prepared'
  | 'submitting'
  | 'pending'
  | 'requires_action'
  | 'unknown'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'attention';
const REFUND_STATES: readonly RefundState[] = ['prepared', 'submitting', 'pending', 'requires_action', 'unknown', 'succeeded', 'failed', 'canceled', 'attention'];
type CreditState = 'held' | 'settled' | 'released' | 'suppressed' | 'attention';

export interface RefundView {
  id: string;
  targetType: RefundTargetType;
  targetId: string;
  ownerId?: string;
  orderId: string;
  cycleId?: string | null;
  title: string;
  money: Money;
  reason: string | null;
  state: RefundState;
  cashState: string;
  reconcileStatus: 'idle' | 'pending' | 'attention';
  confirmationBasis?: 'receipt' | 'payment_total' | null;
  creditState: CreditState;
  creditImpact: { held: number; revoked: number; expired: number; suppressed: number; shortfall: number };
  createdAt: string;
  updatedAt: string;
  canCheck: boolean;
}
export interface RefundTarget {
  targetType: RefundTargetType;
  targetId: string;
  ownerId?: string;
  orderId: string;
  title: string;
  paidMoney: Money;
  refundedMoney: Money;
  pendingMoney: Money;
  remainingMoney: Money;
  totalCredits: number;
  recoveredCredits: number;
  activeRequestId?: string | null;
  attention: boolean;
  cashEvidencePending: boolean;
  capabilities: { partial: boolean; canCreate: boolean; canCheck: boolean };
}
interface RefundCycle {
  id: string;
  paidMoney: Money;
  paidAt: string;
}

/** Canonical decimal spelling for an intent hash; never rounds or uses floating point. */
export function canonicalRefundAmount(value: string): string {
  const amount = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) throw new Error('Invalid refund amount');
  const [whole, fraction = ''] = amount.split('.');
  const decimals = fraction.replace(/0+$/, '');
  return `${(whole ?? '').replace(/^0+(?=\d)/, '')}${decimals ? `.${decimals}` : ''}`;
}

function refundBody(type: RefundTargetType, id: string, amount: string, reason?: string | null) {
  const note = reason?.trim();
  return { targetType: type, targetId: id, amount: canonicalRefundAmount(amount), ...(note ? { reason: note } : {}) };
}

const stateTone = (state: RefundState): Tone =>
  state === 'succeeded' ? 'success' : state === 'attention' || state === 'unknown' ? 'warning' : state === 'failed' ? 'danger' : 'neutral';

function useRefundLabels() {
  const { t } = useAdminI18n();
  return {
    state: (state: string) => (REFUND_STATES.includes(state as RefundState) ? t(`refunds.state.${state as RefundState}`) : state),
    credit: (state: string) =>
      (['held', 'settled', 'released', 'suppressed', 'attention'] as const).includes(state as CreditState)
        ? t(`refunds.credit.${state as CreditState}`)
        : state,
  };
}

function RefundRequestDialog({
  target,
  type,
  id,
  initial,
  onClose,
  onCreated,
}: {
  target: RefundTarget;
  type: RefundTargetType;
  id: string;
  initial: { amount: string; reason: string };
  onClose: () => void;
  onCreated: (row: RefundView) => void;
}) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const [amount, setAmount] = useState(initial.amount);
  const [reason, setReason] = useState(initial.reason);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const path = config.endpoints.refunds;
  async function submit() {
    const valid = /^\d+(?:\.\d+)?$/.test(amount.trim()) && /[1-9]/.test(amount);
    if (!valid) {
      setError(t('refunds.invalidAmount'));
      return;
    }
    setSubmitting(true);
    try {
      const body = refundBody(type, id, amount, reason);
      const actor = await confirmActor(api, config.endpoints.me);
      const attempt = await operationAttempt('refund', actor, body);
      if (!attempt.persisted) toast.warning(t('refunds.noPersistence'));
      let recovered: RefundView | null = null;
      if (attempt.existing) {
        try {
          recovered = await api.get<RefundView>(`${path}/requests/${enc(attempt.key)}`);
        } catch (failure) {
          if (errorStatus(failure) !== 404) throw failure;
        }
      }
      const result =
        recovered && recovered.cashState !== 'prepared'
          ? recovered
          : await api.post<RefundView>(path, body, { headers: { 'Idempotency-Key': attempt.key } });
      if (result.cashState === 'prepared') {
        toast.warning(t('refunds.preparedOnly'));
        return;
      }
      clearOperationAttempt('refund', actor, attempt.key);
      toast.success(recovered && recovered.cashState !== 'prepared' ? t('refunds.recovered') : t('refunds.created'));
      onCreated(result);
    } catch (failure) {
      const status = errorStatus(failure);
      toast.error(status === 400 || status === 409 ? t('refunds.rejected') : t('refunds.unconfirmed'));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={submitting}
      title={t('refunds.confirmTitle')}
      footer={
        <>
          <Button disabled={submitting} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={submitting} onClick={() => void submit()}>
            {t('refunds.submit')}
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Notice tone="warning" title={t('refunds.confirmNotice')}>
          {t('refunds.confirmNoticeDescription', { order: target.orderId, amount: moneyText(target.remainingMoney) })}
        </Notice>
        <Field label={t('refunds.amountLabel', { currency: target.remainingMoney.currency })} required error={error}>
          {({ id: inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              name="amount"
              inputMode="decimal"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              disabled={submitting || !target.capabilities.partial}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(undefined);
              }}
            />
          )}
        </Field>
        <Field label={t('refunds.reasonLabel')}>
          {({ id: inputId }) => (
            <Input id={inputId} name="reason" maxLength={255} disabled={submitting} value={reason} onChange={(event) => setReason(event.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function TargetPanel({ type, id, version, onCreated }: { type: RefundTargetType; id: string; version: number; onCreated: (row: RefundView) => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const path = config.endpoints.refunds;
  const target = useResource((signal) => api.get<RefundTarget>(`${path}/targets/${type}/${enc(id)}`, undefined, { signal }), [type, id, version]);
  const [checking, setChecking] = useState(false);
  const [draft, setDraft] = useState<{ amount: string; reason: string } | null>(null);
  const data = target.data;
  return (
    <Panel title={type === 'order' ? t('refunds.targetOrder') : t('refunds.targetCycle')}>
      {target.loading && !data ? (
        <LoadingState />
      ) : target.error ? (
        <ErrorState onRetry={target.reload} />
      ) : (
        data && (
          <div className="space-y-4">
            <KeyValueList
              columns={3}
              items={[
                { label: t('refunds.title'), value: data.title },
                { label: t('refunds.owner'), value: data.ownerId ?? '—' },
                { label: t('refunds.localOrder'), value: data.orderId },
                { label: t('refunds.localTarget'), value: id },
                { label: t('refunds.paid'), value: moneyText(data.paidMoney) },
                {
                  label: data.cashEvidencePending ? t('refunds.lastCheckedRefunded') : t('refunds.refunded'),
                  value: moneyText(data.refundedMoney),
                },
                { label: t('refunds.pending'), value: moneyText(data.pendingMoney) },
                {
                  label: data.cashEvidencePending ? t('refunds.lastCheckedRemaining') : t('refunds.remaining'),
                  value: moneyText(data.remainingMoney),
                },
                { label: t('refunds.credits'), value: `${data.recoveredCredits} / ${data.totalCredits}` },
              ]}
            />
            {data.cashEvidencePending && (
              <Notice tone="warning" title={t('refunds.cashEvidencePending')}>
                {t('refunds.cashEvidencePendingDescription')}
              </Notice>
            )}
            {data.attention && !data.cashEvidencePending && <Notice tone="warning" title={t('refunds.targetAttention')} />}
            <div className="flex flex-wrap gap-2">
              <Button
                loading={checking}
                disabled={!data.capabilities.canCheck}
                onClick={async () => {
                  setChecking(true);
                  try {
                    target.setData(await api.post<RefundTarget>(`${path}/targets/${type}/${enc(id)}/check`, {}));
                    toast.success(t('refunds.targetChecked'));
                  } catch {
                    toast.error(t('refunds.targetCheckFailed'));
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                {t('refunds.checkTarget')}
              </Button>
              <Button
                variant="primary"
                disabled={!data.capabilities.canCreate || data.cashEvidencePending || checking}
                onClick={() => setDraft({ amount: data.remainingMoney.amount, reason: '' })}
              >
                {t('refunds.request')}
              </Button>
              {data.activeRequestId && (
                <Button
                  onClick={async () => {
                    try {
                      const row = await api.get<RefundView>(`${path}/${enc(data.activeRequestId ?? '')}`);
                      if (row.cashState === 'prepared') {
                        const actor = await confirmActor(api, config.endpoints.me);
                        const existing = await findOperationAttempt('refund', actor, refundBody(type, id, row.money.amount, row.reason));
                        if (existing) {
                          setDraft({ amount: row.money.amount, reason: row.reason ?? '' });
                          toast.info(t('refunds.preparedResume'));
                          return;
                        }
                      }
                      onCreated(row);
                    } catch {
                      toast.error(t('refunds.existingFailed'));
                    }
                  }}
                >
                  {t('refunds.viewExisting')}
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{t('refunds.serverNotice')}</p>
            {draft && (
              <RefundRequestDialog
                target={data}
                type={type}
                id={id}
                initial={draft}
                onClose={() => setDraft(null)}
                onCreated={(row) => {
                  setDraft(null);
                  target.reload();
                  onCreated(row);
                }}
              />
            )}
          </div>
        )
      )}
    </Panel>
  );
}

function RefundDetails({ id, onClose, onChecked }: { id: string; onClose: () => void; onChecked: () => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const labels = useRefundLabels();
  const detail = useResource((signal) => api.get<RefundView>(`${config.endpoints.refunds}/${enc(id)}`, undefined, { signal }), [id]);
  const [checking, setChecking] = useState(false);
  const row = detail.data;
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()} title={t('refunds.detailTitle')}>
      {detail.error ? (
        <ErrorState onRetry={detail.reload} />
      ) : !row ? (
        <LoadingState />
      ) : (
        <div className="space-y-5">
          <StatusBadge tone={stateTone(row.state)}>{labels.state(row.state)}</StatusBadge>
          {row.state === 'attention' && (
            <Notice
              tone="warning"
              title={
                row.creditState === 'attention'
                  ? t('refunds.attention.credit')
                  : row.reconcileStatus === 'attention'
                    ? t('refunds.attention.reconcile')
                    : t('refunds.attention.general')
              }
            >
              {t('refunds.attentionDescription')}
            </Notice>
          )}
          <KeyValueList
            items={[
              { label: t('refunds.id'), value: row.id },
              { label: t('refunds.owner'), value: row.ownerId ?? '—' },
              { label: t('refunds.orderId'), value: row.orderId },
              { label: t('refunds.title'), value: row.title },
              { label: t('refunds.requestedAmount'), value: moneyText(row.money) },
              { label: t('refunds.cash'), value: labels.state(row.cashState) },
              { label: t('refunds.creditHandling'), value: labels.credit(row.creditState) },
              { label: t('refunds.reconcile'), value: t(`refunds.reconcile.${row.reconcileStatus}`) },
              {
                label: t('refunds.basis'),
                value:
                  row.confirmationBasis === 'receipt'
                    ? t('refunds.basis.receipt')
                    : row.confirmationBasis === 'payment_total'
                      ? t('refunds.basis.payment_total')
                      : t('refunds.basis.none'),
              },
              { label: t('refunds.impact.held'), value: row.creditImpact.held },
              { label: t('refunds.impact.revoked'), value: row.creditImpact.revoked },
              { label: t('refunds.impact.expired'), value: row.creditImpact.expired },
              { label: t('refunds.impact.suppressed'), value: row.creditImpact.suppressed },
              { label: t('refunds.impact.shortfall'), value: row.creditImpact.shortfall },
              { label: t('refunds.reason'), value: row.reason || '—' },
              { label: t('common.updatedAt'), value: formatDateTime(row.updatedAt, locale) },
            ]}
          />
          <Button
            loading={checking}
            disabled={!row.canCheck}
            onClick={async () => {
              setChecking(true);
              try {
                detail.setData(await api.post<RefundView>(`${config.endpoints.refunds}/${enc(id)}/check`, {}));
                onChecked();
                toast.success(t('refunds.checked'));
              } catch {
                toast.error(t('refunds.checkFailed'));
              } finally {
                setChecking(false);
              }
            }}
          >
            {t('refunds.check')}
          </Button>
        </div>
      )}
    </Drawer>
  );
}

/**
 * Refund administration (`/billing/refunds*`): order or subscription-cycle targets, idempotent
 * creation with recovery of unknown results, and separate cash / credit / reconciliation states.
 */
export function RefundsPage() {
  const { config, pages } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const labels = useRefundLabels();
  const [query, setQuery] = useSearchParams();
  const table = useRef<ResourceTableHandle>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const type = query.get('targetType');
  const id = query.get('targetId');
  const subscriptionId = query.get('subscriptionId');
  const path = config.endpoints.refunds;
  const link = (key: string) => pages.find((page) => page.key === key);
  return (
    <PageContainer title={t('page.refunds')} description={t('refunds.description')}>
      <div className="flex flex-wrap gap-2">
        {(['orders', 'billingSubscriptions'] as const).map((key) => {
          const page = link(key);
          return (
            page && (
              <Link key={key} to={page.path} className={buttonClass('outline', 'sm')}>
                {t(key === 'orders' ? 'page.orders' : 'page.billingSubscriptions')}
              </Link>
            )
          );
        })}
        {(id || subscriptionId) && (
          <Button size="sm" onClick={() => setQuery({})}>
            {t('refunds.back')}
          </Button>
        )}
      </div>
      {(type === 'order' || type === 'cycle') && id && (
        <TargetPanel
          key={`${type}:${id}`}
          type={type}
          id={id}
          version={version}
          onCreated={(row) => {
            setDetail(row.id);
            table.current?.reload();
          }}
        />
      )}
      {subscriptionId && (
        <Panel title={t('refunds.cycles')}>
          <ResourceTable<RefundCycle>
            key={subscriptionId}
            label={t('refunds.cycles')}
            load={async ({ page, signal }) =>
              assertPage<RefundCycle>(await api.get(`${path}/subscriptions/${enc(subscriptionId)}/cycles`, { page }, { signal }))
            }
            rowKey={(row) => row.id}
            columns={[
              { key: 'id', title: t('refunds.cycleId'), field: 'id' },
              { key: 'paid', title: t('refunds.paid'), render: (row) => moneyText(row.paidMoney) },
              { key: 'paidAt', title: t('refunds.paidAt'), render: (row) => formatDateTime(row.paidAt, locale) },
            ]}
            actions={(row) => (
              <Button size="sm" variant="ghost" onClick={() => setQuery({ targetType: 'cycle', targetId: row.id })}>
                {t('refunds.viewTarget')}
              </Button>
            )}
          />
        </Panel>
      )}
      <ResourceTable<RefundView>
        ref={table}
        label={t('page.refunds')}
        load={async ({ page, filters, signal }) =>
          assertPage<RefundView>(await api.get(path, { page, ...(filters.state ? { state: filters.state } : {}) }, { signal }))
        }
        rowKey={(row) => row.id}
        filters={[
          { name: 'state', label: t('refunds.state'), type: 'select', options: REFUND_STATES.map((state) => ({ value: state, label: labels.state(state) })) },
        ]}
        minWidth={1000}
        columns={[
          { key: 'id', title: t('refunds.id'), field: 'id' },
          { key: 'orderId', title: t('refunds.orderId'), field: 'orderId' },
          { key: 'title', title: t('refunds.title'), field: 'title' },
          { key: 'money', title: t('refunds.amount'), render: (row) => moneyText(row.money) },
          { key: 'state', title: t('refunds.state'), render: (row) => <StatusBadge tone={stateTone(row.state)}>{labels.state(row.state)}</StatusBadge> },
          { key: 'cashState', title: t('refunds.cashState'), render: (row) => labels.state(row.cashState), hideOnMobile: true },
          { key: 'creditState', title: t('refunds.creditState'), render: (row) => labels.credit(row.creditState), hideOnMobile: true },
          { key: 'createdAt', title: t('common.createdAt'), render: (row) => formatDateTime(row.createdAt, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <Button size="sm" variant="ghost" onClick={() => setDetail(row.id)}>
            {t('common.details')}
          </Button>
        )}
      />
      {detail && (
        <RefundDetails
          key={detail}
          id={detail}
          onChecked={() => {
            setVersion((value) => value + 1);
            table.current?.reload();
          }}
          onClose={() => {
            setDetail(null);
            table.current?.reload();
          }}
        />
      )}
    </PageContainer>
  );
}

import { useRef, useState } from 'react';
import { Button } from '../components/button';
import { Drawer } from '../components/dialog';
import { ErrorState, LoadingState, Notice, StatusBadge, toast } from '../components/feedback';
import { FormDialog, localDateTimeToIso } from '../components/form';
import { KeyValueList, PageContainer } from '../components/layout';
import { ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { errorStatus, formatDateTime } from '../lib/format';
import { clearOperationAttempt, operationAttempt } from '../lib/operation-attempt';
import { confirmActor, enc, pageLoader } from './shared';

const CREDIT_TYPES = ['GRANT', 'CONSUME', 'REFUND', 'EXPIRE', 'TRANSFER_IN', 'TRANSFER_OUT', 'FREEZE', 'UNFREEZE'] as const;
type CreditType = (typeof CREDIT_TYPES)[number];
const LOT_STATUSES = ['available', 'consumed', 'expired', 'held', 'refund_pending'] as const;
type LotStatus = (typeof LOT_STATUSES)[number];

interface CreditRecord {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balance: number;
  description?: string;
  createdAt: string;
}
interface Balance {
  available: number;
  frozen: number;
  refundBlocked?: number;
  expired: number;
  bookBalance: number;
  pendingExpiry: number;
}
interface Lot {
  id: string;
  source?: string;
  amount: number;
  availableAmount: number;
  frozenAmount?: number;
  refundBlockedAmount?: number;
  status: string;
}

function AccountDrawer({ ownerId, onClose }: { ownerId: string; onClose: () => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const base = `${config.endpoints.credits}/${enc(ownerId)}`;
  const balance = useResource((signal) => api.get<Balance>(`${base}/balance`, undefined, { signal }), [base]);
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()} title={t('credits.account')} description={t('credits.accountLabel', { id: ownerId })}>
      <div className="space-y-5">
        {balance.error ? (
          <ErrorState message={t('credits.balanceFailed')} onRetry={balance.reload} />
        ) : !balance.data ? (
          <LoadingState />
        ) : (
          <>
            <KeyValueList
              columns={2}
              items={[
                { label: t('credits.available'), value: balance.data.available },
                { label: t('credits.balance'), value: balance.data.bookBalance },
                { label: t('credits.frozen'), value: balance.data.frozen },
                { label: t('credits.refundBlocked'), value: balance.data.refundBlocked ?? 0 },
                { label: t('credits.expired'), value: balance.data.expired },
                { label: t('credits.pendingExpiry'), value: balance.data.pendingExpiry },
              ]}
            />
            <Notice tone="info" title={t('credits.refundBlockedNotice')}>
              {t('credits.refundBlockedNoticeDescription')}
            </Notice>
          </>
        )}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('credits.lots')}</h3>
          <ResourceTable<Lot>
            label={t('credits.lots')}
            load={pageLoader(api, `${base}/lots`)}
            rowKey={(row) => row.id}
            columns={[
              { key: 'source', title: t('credits.lot.source'), field: 'source' },
              { key: 'amount', title: t('credits.lot.amount'), field: 'amount', align: 'right' },
              { key: 'available', title: t('credits.lot.available'), field: 'availableAmount', align: 'right' },
              { key: 'frozen', title: t('credits.lot.frozen'), render: (row) => row.frozenAmount ?? 0, align: 'right' },
              { key: 'refundBlocked', title: t('credits.lot.refundBlocked'), render: (row) => row.refundBlockedAmount ?? 0, align: 'right' },
              {
                key: 'status',
                title: t('common.status'),
                render: (row) =>
                  (LOT_STATUSES as readonly string[]).includes(row.status) ? t(`credits.lot.status.${row.status as LotStatus}`) : row.status,
              },
            ]}
          />
        </section>
      </div>
    </Drawer>
  );
}

/**
 * Credit ledger (`/management/credits*`): transactions, per-account balance and lots, and positive
 * manual grants with an idempotency key that survives refresh and unknown results.
 */
export function CreditsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const table = useRef<ResourceTableHandle>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  // The unconfirmed grant of this dialog session. Its key is reused only to retry that same attempt;
  // dismissing the dialog ends the attempt, so a later identical grant is a new operation.
  const unconfirmed = useRef<{ actor: string; key: string } | null>(null);
  const setGrantingOpen = (open: boolean) => {
    if (!open && unconfirmed.current) {
      clearOperationAttempt('credit-grant', unconfirmed.current.actor, unconfirmed.current.key);
      unconfirmed.current = null;
    }
    setGranting(open);
  };
  const typeLabel = (type: string) => ((CREDIT_TYPES as readonly string[]).includes(type) ? t(`credits.type.${type as CreditType}`) : type);
  return (
    <PageContainer
      title={t('page.credits')}
      description={t('credits.description')}
      actions={
        can(config.permissions.credit.grant) && (
          <Button variant="primary" onClick={() => setGranting(true)}>
            {t('credits.grant')}
          </Button>
        )
      }
    >
      <Notice tone="info" title={t('credits.scope')}>
        {t('credits.scopeDescription')}
      </Notice>
      <ResourceTable<CreditRecord>
        ref={table}
        label={t('page.credits')}
        load={pageLoader(api, config.endpoints.credits)}
        rowKey={(row) => row.id}
        filters={[
          { name: 'ownerId', label: t('records.filterOwner') },
          { name: 'status', label: t('credits.type'), type: 'select', options: CREDIT_TYPES.map((type) => ({ value: type, label: typeLabel(type) })) },
        ]}
        columns={[
          { key: 'userId', title: t('common.userId'), field: 'userId' },
          { key: 'type', title: t('credits.type'), render: (row) => <StatusBadge>{typeLabel(row.type)}</StatusBadge> },
          { key: 'amount', title: t('credits.amount'), field: 'amount', align: 'right' },
          { key: 'balance', title: t('credits.balance'), field: 'balance', align: 'right' },
          { key: 'description', title: t('credits.note'), field: 'description', hideOnMobile: true },
          { key: 'createdAt', title: t('credits.time'), render: (row) => formatDateTime(row.createdAt, locale) },
        ]}
        actions={(row) => (
          <Button size="sm" variant="ghost" onClick={() => setOwner(row.userId)}>
            {t('credits.inspect')}
          </Button>
        )}
      />
      {owner && <AccountDrawer key={owner} ownerId={owner} onClose={() => setOwner(null)} />}
      <FormDialog
        open={granting}
        onOpenChange={setGrantingOpen}
        title={t('credits.grant')}
        description={t('credits.grantNotice')}
        submitText={t('credits.grantConfirm')}
        failureMessage={t('credits.grantUnconfirmed')}
        initialValues={{ ownerId: '', amount: '', description: '', expiresAt: '' }}
        fields={[
          { name: 'ownerId', label: t('common.userId'), required: true },
          { name: 'amount', label: t('credits.grantAmount'), type: 'integer', required: true, min: 1, max: 2147483647 },
          { name: 'description', label: t('credits.grantReason'), required: true, maxLength: 500 },
          { name: 'expiresAt', label: t('credits.grantExpiresAt'), type: 'datetime' },
        ]}
        onSubmit={async (values) => {
          const ownerId = String(values.ownerId).trim();
          const body = {
            amount: Number(values.amount),
            description: String(values.description).trim(),
            expiresAt: localDateTimeToIso(values.expiresAt),
          };
          const actor = await confirmActor(api, config.endpoints.me);
          const attempt = await operationAttempt('credit-grant', actor, { ownerId, ...body });
          if (!attempt.persisted) toast.warning(t('refunds.noPersistence'));
          unconfirmed.current = { actor, key: attempt.key };
          try {
            await api.post(`${config.endpoints.credits}/${enc(ownerId)}/grants`, body, { headers: { 'Idempotency-Key': attempt.key } });
          } catch (error) {
            toast.error(errorStatus(error) === 409 ? t('credits.grantConflict') : t('credits.grantUnconfirmed'));
            throw error;
          }
          clearOperationAttempt('credit-grant', actor, attempt.key);
          unconfirmed.current = null;
          toast.success(t('credits.granted'));
          table.current?.reload();
        }}
      />
    </PageContainer>
  );
}

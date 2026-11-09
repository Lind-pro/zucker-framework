import { useRef } from 'react';
import { ConfirmButton } from '../components/dialog';
import { StatusBadge, toast, type Tone } from '../components/feedback';
import { PageContainer } from '../components/layout';
import { ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import { counterLabel, useEntitlementCatalog } from './entitlements';
import { enc, pageLoader } from './shared';
import {
  QUOTA_RESERVATION_STATES,
  type QuotaReservationActionResult,
  type QuotaReservationRow,
  type QuotaUsageRow,
} from '@zucker-framework/fe-types/back-office';

export const QUOTA_RESERVATION_STATUSES = QUOTA_RESERVATION_STATES;

const reservationTone = (status: string): Tone =>
  status === 'RESERVED' ? 'warning' : status === 'CONFIRMED' ? 'success' : 'neutral';

/** Per-counter usage (`GET /management/quota-usage`, RFC §8.4). */
export function QuotaUsagePage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const catalog = useEntitlementCatalog();
  const counters = catalog.data?.counters ?? [];
  return (
    <PageContainer title={t('page.quotaUsage')} description={t('quota.usageDescription')}>
      <ResourceTable<QuotaUsageRow>
        label={t('page.quotaUsage')}
        load={pageLoader(api, config.endpoints.quotaUsage)}
        rowKey={(row) => `${row.userId}:${row.counter}:${row.period}`}
        filters={[
          { name: 'userId', label: t('common.userId') },
          counters.length
            ? { name: 'counter', label: t('quota.counter'), type: 'select', options: counters.map((counter) => ({ value: counter.key, label: counter.label })) }
            : { name: 'counter', label: t('quota.counter') },
          { name: 'period', label: t('quota.period'), placeholder: '2026-11' },
        ]}
        columns={[
          { key: 'userId', title: t('common.userId'), field: 'userId' },
          { key: 'counter', title: t('quota.counter'), render: (row) => counterLabel(catalog.data, row.counter) },
          { key: 'period', title: t('quota.period'), field: 'period' },
          { key: 'used', title: t('quota.used'), field: 'used', align: 'right' },
          {
            key: 'limit',
            title: t('quota.limit'),
            align: 'right',
            render: (row) => (row.limit === -1 ? t('common.unlimited') : (row.limit ?? '—')),
          },
          { key: 'updatedAt', title: t('common.updatedAt'), render: (row) => formatDateTime(row.updatedAt, locale), hideOnMobile: true },
        ]}
      />
    </PageContainer>
  );
}

/** Reservations with manual release/confirm through the durable state machine (RFC §8.4). */
export function QuotaReservationsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const catalog = useEntitlementCatalog();
  const table = useRef<ResourceTableHandle>(null);
  const canUpdate = can(config.permissions.quota.update);
  const counters = catalog.data?.counters ?? [];
  const act = async (row: QuotaReservationRow, action: 'release' | 'confirm') => {
    try {
      const result = await api.post<QuotaReservationActionResult>(`${config.endpoints.quotaReservations}/${enc(row.id)}/${action}`, {});
      // `changed: false`: another actor (or expiry) already settled it; nothing was done here.
      if (result?.changed === false) toast.info(t('quota.unchanged'));
      else toast.success(action === 'release' ? t('quota.released') : t('quota.confirmed'));
    } catch (error) {
      toast.error(t('quota.actionFailed'));
      throw error;
    } finally {
      table.current?.reload();
    }
  };
  return (
    <PageContainer title={t('page.quotaReservations')} description={t('quota.reservationsDescription')}>
      <ResourceTable<QuotaReservationRow>
        ref={table}
        label={t('page.quotaReservations')}
        load={pageLoader(api, config.endpoints.quotaReservations)}
        rowKey={(row) => row.id}
        filters={[
          { name: 'userId', label: t('common.userId') },
          counters.length
            ? { name: 'counter', label: t('quota.counter'), type: 'select', options: counters.map((counter) => ({ value: counter.key, label: counter.label })) }
            : { name: 'counter', label: t('quota.counter') },
          {
            name: 'status',
            label: t('quota.status'),
            type: 'select',
            options: QUOTA_RESERVATION_STATUSES.map((status) => ({ value: status, label: status })),
          },
          { name: 'resourceType', label: t('quota.resourceType') },
        ]}
        columns={[
          { key: 'userId', title: t('common.userId'), field: 'userId' },
          { key: 'counter', title: t('quota.counter'), render: (row) => counterLabel(catalog.data, row.counter) },
          { key: 'amount', title: t('quota.amount'), field: 'amount', align: 'right' },
          { key: 'status', title: t('quota.status'), render: (row) => <StatusBadge tone={reservationTone(row.status)}>{row.status}</StatusBadge> },
          {
            key: 'resource',
            title: t('quota.resourceType'),
            render: (row) => (row.resourceType ? `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ''}` : '—'),
          },
          { key: 'expiresAt', title: t('quota.expiresAt'), render: (row) => formatDateTime(row.expiresAt, locale), hideOnMobile: true },
          { key: 'createdAt', title: t('common.createdAt'), render: (row) => formatDateTime(row.createdAt, locale), hideOnMobile: true },
        ]}
        actions={(row) =>
          canUpdate && row.status === 'RESERVED' ? (
            <>
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('quota.releaseConfirm')}
                description={t('quota.releaseConfirmDescription')}
                onConfirm={() => act(row, 'release')}
              >
                {t('quota.release')}
              </ConfirmButton>
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('quota.confirmConfirm')}
                description={t('quota.confirmConfirmDescription')}
                onConfirm={() => act(row, 'confirm')}
              >
                {t('quota.confirm')}
              </ConfirmButton>
            </>
          ) : null
        }
      />
    </PageContainer>
  );
}

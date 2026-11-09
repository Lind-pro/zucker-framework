import { useState } from 'react';
import { Link } from 'react-router';
import { buttonClass, Button } from '../components/button';
import { Drawer } from '../components/dialog';
import { StatusBadge } from '../components/feedback';
import { KeyValueList, PageContainer } from '../components/layout';
import { ResourceTable, type FilterSpec } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import type { AdminEndpoints } from '../app/config';
import { useAdminI18n, type Translate } from '../i18n/context';
import type { AdminMessageKey } from '../i18n/zh-CN';
import { displayValue, formatDateTime } from '../lib/format';
import { pageLoader } from './shared';

type FieldKind = 'text' | 'dateTime' | 'status' | 'money' | 'refund';
type FieldKey = Extract<AdminMessageKey, `records.field.${string}`> extends `records.field.${infer K}` ? K : never;

export interface RecordDefinition {
  titleKey: AdminMessageKey;
  descriptionKey: AdminMessageKey;
  endpoint: keyof AdminEndpoints;
  /** Supports the `ownerId` filter. */
  owner?: boolean;
  statuses?: readonly string[];
  columns: ReadonlyArray<readonly [FieldKey, FieldKind?]>;
}

/** Read-only management projections served by the server template's `ManagementModule`. */
export const recordDefinitions = {
  orders: {
    titleKey: 'page.orders',
    descriptionKey: 'records.orders.description',
    endpoint: 'orders',
    owner: true,
    statuses: ['unknown', 'pending', 'requires_capture', 'paid', 'unpaid'],
    columns: [
      ['id'],
      ['ownerId'],
      ['title'],
      ['money', 'money'],
      ['providerId'],
      ['state', 'status'],
      ['refund', 'refund'],
      ['creationState'],
      ['captureState'],
      ['fulfilledAt', 'dateTime'],
      ['createdAt', 'dateTime'],
    ],
  },
  billingSubscriptions: {
    titleKey: 'page.billingSubscriptions',
    descriptionKey: 'records.billingSubscriptions.description',
    endpoint: 'billingSubscriptions',
    owner: true,
    statuses: ['unknown', 'active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'],
    columns: [
      ['id'],
      ['ownerId'],
      ['providerId'],
      ['title'],
      ['money', 'money'],
      ['status', 'status'],
      ['grantBasis'],
      ['initialFulfilledAt', 'dateTime'],
      ['cancelState'],
      ['currentPeriodEnd', 'dateTime'],
      ['observedAt', 'dateTime'],
    ],
  },
  jobs: {
    titleKey: 'page.jobs',
    descriptionKey: 'records.jobs.description',
    endpoint: 'jobs',
    owner: true,
    statuses: ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'],
    columns: [['id'], ['userId'], ['kind'], ['status', 'status'], ['stage'], ['progress'], ['attempt'], ['errorCode'], ['createdAt', 'dateTime']],
  },
  deliveries: {
    titleKey: 'page.deliveries',
    descriptionKey: 'records.deliveries.description',
    endpoint: 'deliveries',
    statuses: ['PENDING', 'PROCESSING', 'RETRYING', 'DELIVERED', 'DEAD'],
    columns: [['id'], ['channel'], ['status', 'status'], ['attempt'], ['errorCode'], ['deliveredAt', 'dateTime'], ['createdAt', 'dateTime']],
  },
  files: {
    titleKey: 'page.files',
    descriptionKey: 'records.files.description',
    endpoint: 'files',
    owner: true,
    statuses: ['pending', 'ready', 'deleted'],
    columns: [['id'], ['ownerId'], ['fileName'], ['size'], ['mimeType'], ['state', 'status'], ['cleanupStatus'], ['createdAt', 'dateTime']],
  },
  apiKeys: {
    titleKey: 'page.apiKeys',
    descriptionKey: 'records.apiKeys.description',
    endpoint: 'apiKeys',
    owner: true,
    statuses: ['active', 'revoked', 'expired', 'disabled'],
    columns: [
      ['id'],
      ['username'],
      ['userId'],
      ['name'],
      ['keyPrefix'],
      ['status', 'status'],
      ['expiresAt', 'dateTime'],
      ['lastUsedAt', 'dateTime'],
      ['createdAt', 'dateTime'],
    ],
  },
  accessLogs: {
    titleKey: 'page.accessLogs',
    descriptionKey: 'records.accessLogs.description',
    endpoint: 'accessLogs',
    owner: true,
    columns: [['id'], ['userId'], ['module'], ['action'], ['method'], ['requestUrl'], ['responseTime'], ['requestTime', 'dateTime']],
  },
  operationLogs: {
    titleKey: 'page.operationLogs',
    descriptionKey: 'records.operationLogs.description',
    endpoint: 'operationLogs',
    owner: true,
    statuses: ['SUCCESS', 'FAILED', 'PENDING'],
    columns: [['id'], ['userId'], ['module'], ['action'], ['status', 'status'], ['targetId'], ['targetType'], ['createdAt', 'dateTime']],
  },
} satisfies Record<string, RecordDefinition>;

export type RecordResource = keyof typeof recordDefinitions;

function refundSummary(value: unknown, t: Translate): string {
  if (!value || typeof value !== 'object' || !('state' in value)) return t('records.refundSummary.unchecked');
  const summary = value as { state: string; needsAttention?: boolean; refundedMoney?: { amount: string; currency: string } };
  const state = (['none', 'pending', 'partial', 'full'] as const).includes(summary.state as 'none')
    ? t(`records.refundSummary.${summary.state as 'none' | 'pending' | 'partial' | 'full'}`)
    : t('common.unknown');
  const money = summary.refundedMoney ? ` · ${summary.refundedMoney.amount} ${summary.refundedMoney.currency}` : '';
  return `${state}${money}${summary.needsAttention ? t('records.refundSummary.attention') : ''}`;
}

function cell(kind: FieldKind | undefined, value: unknown, t: Translate, locale: string) {
  if (kind === 'dateTime') return formatDateTime(value, locale);
  if (kind === 'status') return value == null ? '—' : <StatusBadge>{String(value)}</StatusBadge>;
  if (kind === 'refund') return refundSummary(value, t);
  return displayValue(value);
}

type Row = Record<string, unknown> & { id?: string };

/** Generic paginated management list with owner/status/id filters and a detail drawer. */
export function RecordsPage({ resource }: { resource: RecordResource }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const definition: RecordDefinition = recordDefinitions[resource];
  const [selected, setSelected] = useState<Row | null>(null);
  const canRefund = can(config.permissions.billing.refund);
  const filters: FilterSpec[] = [{ name: 'id', label: t('records.filterId') }];
  if (definition.owner) filters.push({ name: 'ownerId', label: t('records.filterOwner') });
  if (definition.statuses)
    filters.push({
      name: 'status',
      label: t('records.filterStatus'),
      type: 'select',
      options: definition.statuses.map((status) => ({ value: status, label: status })),
    });
  const refundLinks = (row: Row) => {
    if (!canRefund) return null;
    if (resource === 'orders' && row.state === 'paid' && row.mode !== 'subscription')
      return (
        <Link className={buttonClass('ghost', 'sm')} to={`/refunds?targetType=order&targetId=${encodeURIComponent(String(row.id))}`}>
          {t('records.refund')}
        </Link>
      );
    const subscriptionId = resource === 'orders' ? row.subscriptionRecordId : resource === 'billingSubscriptions' ? row.id : undefined;
    if (typeof subscriptionId === 'string' && (resource === 'billingSubscriptions' || row.mode === 'subscription'))
      return (
        <Link className={buttonClass('ghost', 'sm')} to={`/refunds?subscriptionId=${encodeURIComponent(subscriptionId)}`}>
          {t('records.paymentCycles')}
        </Link>
      );
    return null;
  };
  return (
    <PageContainer title={t(definition.titleKey)} description={t(definition.descriptionKey)}>
      <ResourceTable<Row>
        key={resource}
        label={t(definition.titleKey)}
        load={pageLoader(api, config.endpoints[definition.endpoint])}
        rowKey={(row) => String(row.id ?? JSON.stringify(row))}
        filters={filters}
        minWidth={900}
        columns={definition.columns.map(([field, kind], index) => ({
          key: field,
          title: t(`records.field.${field}` as AdminMessageKey),
          render: (row: Row) => cell(kind, row[field], t, locale),
          hideOnMobile: index > 4,
        }))}
        actions={(row) => (
          <>
            <Button size="sm" variant="ghost" onClick={() => setSelected(row)}>
              {t('common.details')}
            </Button>
            {refundLinks(row)}
          </>
        )}
      />
      <Drawer
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title={t('common.recordDetails', { name: t(definition.titleKey) })}
      >
        {selected && (
          <KeyValueList
            items={definition.columns.map(([field, kind]) => ({
              key: field,
              label: t(`records.field.${field}` as AdminMessageKey),
              value: cell(kind, selected[field], t, locale),
            }))}
          />
        )}
      </Drawer>
    </PageContainer>
  );
}

export const OrdersPage = () => <RecordsPage resource="orders" />;
export const BillingSubscriptionsPage = () => <RecordsPage resource="billingSubscriptions" />;
export const JobsPage = () => <RecordsPage resource="jobs" />;
export const DeliveriesPage = () => <RecordsPage resource="deliveries" />;
export const FilesPage = () => <RecordsPage resource="files" />;
export const ApiKeysPage = () => <RecordsPage resource="apiKeys" />;
export const AccessLogsPage = () => <RecordsPage resource="accessLogs" />;
export const OperationLogsPage = () => <RecordsPage resource="operationLogs" />;

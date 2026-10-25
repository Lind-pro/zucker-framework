import { useAdminI18n } from '@/i18n';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { Alert, Button, Drawer, Space, Tag, Typography } from 'antd';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';

function display(value: unknown, t: (text: string) => string): string {
  if (value && typeof value === 'object' && 'refundedMoney' in value && 'state' in value) {
    const summary = value as {
      state: string;
      refundedMoney: { amount: string; currency: string };
      needsAttention: boolean;
    };
    return `${({ none: t('本地无退款'), pending: t('退款处理中'), partial: t('部分退款'), full: t('全额退款') } as Record<string, string>)[summary.state] ?? t('未知')} · ${t('已退款')} ${summary.refundedMoney.amount} ${summary.refundedMoney.currency}${summary.needsAttention ? t(' · 需要处理') : ''}`;
  }
  if (value && typeof value === 'object' && 'amount' in value && 'currency' in value)
    return `${String(value.amount)} ${String(value.currency)}`;
  return value === null || value === undefined ? '—' : String(value);
}
const definitions: Record<
  string,
  {
    title: string;
    description: string;
    owner?: boolean;
    columns: Array<[string, string, ('dateTime' | 'text')?]>;
    statuses?: string[];
  }
> = {
  'api-keys': {
    title: 'API 密钥',
    description:
      '查看账户的密钥名称、可识别前缀与有效状态；不会显示完整密钥或哈希。此处不创建或撤销密钥。',
    owner: true,
    columns: [
      ['id', '记录ID'],
      ['username', '用户'],
      ['userId', '账户ID'],
      ['name', '名称'],
      ['keyPrefix', '密钥前缀'],
      ['status', '状态'],
      ['expiresAt', '到期时间', 'dateTime'],
      ['lastUsedAt', '最近使用', 'dateTime'],
      ['createdAt', '创建时间', 'dateTime'],
    ],
    statuses: ['active', 'revoked', 'expired', 'disabled'],
  },
  orders: {
    title: '订单',
    description: '按账户与供应商状态查询真实订单；未核实付款不会显示为已完成。',
    owner: true,
    columns: [
      ['id', '订单ID'],
      ['ownerId', '账户ID'],
      ['title', '套餐'],
      ['money', '金额'],
      ['providerId', '支付渠道'],
      ['state', '付款状态'],
      ['refund', '退款记录'],
      ['creationState', '创建状态'],
      ['captureState', '扣款状态'],
      ['fulfilledAt', '履约时间', 'dateTime'],
      ['createdAt', '创建时间', 'dateTime'],
    ],
    statuses: ['unknown', 'pending', 'requires_capture', 'paid', 'unpaid'],
  },
  subscriptions: {
    title: '订阅',
    description: '供应商观察与本地核对状态；此处不自动取消、扣款或授予额度。',
    owner: true,
    columns: [
      ['id', '订阅ID'],
      ['ownerId', '账户ID'],
      ['providerId', '渠道'],
      ['title', '套餐'],
      ['money', '金额'],
      ['status', '状态'],
      ['grantBasis', '发放依据'],
      ['initialFulfilledAt', '首次额度生效', 'dateTime'],
      ['cancelState', '取消状态'],
      ['currentPeriodEnd', '当前周期结束', 'dateTime'],
      ['observedAt', '最近核对', 'dateTime'],
    ],
    statuses: ['unknown', 'active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'],
  },
  jobs: {
    title: '任务',
    description: '通用持久任务生命周期，不展示输入、结果正文或提供者凭据。',
    owner: true,
    columns: [
      ['id', '任务ID'],
      ['userId', '账户ID'],
      ['kind', '类型'],
      ['status', '状态'],
      ['stage', '阶段'],
      ['progress', '进度'],
      ['attempt', '尝试次数'],
      ['errorCode', '错误码'],
      ['createdAt', '创建时间', 'dateTime'],
    ],
    statuses: [
      'QUEUED',
      'PROCESSING',
      'WAITING_PROVIDER',
      'RETRYING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ],
  },
  deliveries: {
    title: '通知投递',
    description: '持久投递状态与失败码；不展示收件人、邮件正文或令牌。',
    columns: [
      ['id', '投递ID'],
      ['channel', '渠道'],
      ['status', '状态'],
      ['attempt', '尝试次数'],
      ['errorCode', '错误码'],
      ['deliveredAt', '确认送达', 'dateTime'],
      ['createdAt', '创建时间', 'dateTime'],
    ],
    statuses: ['PENDING', 'PROCESSING', 'RETRYING', 'DELIVERED', 'DEAD'],
  },
  files: {
    title: '文件资产',
    description: '私有文件元数据与清理状态；管理查询不授予内容下载或删除权限。',
    owner: true,
    columns: [
      ['id', '资产ID'],
      ['ownerId', '账户ID'],
      ['fileName', '文件名'],
      ['size', '大小（字节）'],
      ['mimeType', '类型'],
      ['state', '状态'],
      ['cleanupStatus', '清理状态'],
      ['createdAt', '创建时间', 'dateTime'],
    ],
    statuses: ['pending', 'ready', 'deleted'],
  },
  'access-logs': {
    title: '访问日志',
    description: '读取数据库中的访问记录；不回显请求体、响应体或认证信息。',
    owner: true,
    columns: [
      ['id', '记录ID'],
      ['userId', '用户ID'],
      ['module', '模块'],
      ['action', '动作'],
      ['method', '方法'],
      ['requestUrl', '路径'],
      ['responseTime', '耗时（毫秒）'],
      ['requestTime', '访问时间', 'dateTime'],
    ],
  },
  'operation-logs': {
    title: '操作审计',
    description: '查询持久操作审计；敏感参数与私有记录不在列表或详情中展示。',
    owner: true,
    columns: [
      ['id', '记录ID'],
      ['userId', '操作者'],
      ['module', '模块'],
      ['action', '操作'],
      ['status', '状态'],
      ['targetId', '目标ID'],
      ['targetType', '目标类型'],
      ['createdAt', '操作时间', 'dateTime'],
    ],
    statuses: ['SUCCESS', 'FAILED', 'PENDING'],
  },
};
export default function RecordsPage({ resource: explicit }: { resource?: string }) {
  const { t } = useAdminI18n();
  const { resource } = useParams(),
    key = explicit ?? resource ?? '',
    definition = definitions[key];
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null),
    [failed, setFailed] = useState(false);
  if (!definition) return <Alert type="error" message={t('未注册的管理资源')} />;
  const columns: ProColumns<Record<string, unknown>>[] = definition.columns.map(
    ([dataIndex, title, valueType]) => ({
      dataIndex,
      title: t(title),
      valueType: valueType ?? 'text',
      search: dataIndex === 'id',
      ellipsis: true,
      ...(dataIndex === 'money' ? { renderText: (value: unknown) => display(value, t) } : {}),
      ...(dataIndex === 'refund'
        ? {
            renderText: (value: unknown) => {
              if (!value || typeof value !== 'object' || !('state' in value)) return t('未核对');
              const summary = value as { state: string; needsAttention: boolean };
              return `${({ none: t('本地无退款'), pending: t('退款处理中'), partial: t('部分退款'), full: t('全额退款') } as Record<string, string>)[summary.state] ?? t('未知')}${summary.needsAttention ? t(' · 需要处理') : ''}`;
            },
          }
        : {}),
      ...(dataIndex === 'status' || dataIndex === 'state'
        ? {
            render: (_: unknown, row: Record<string, unknown>) => (
              <Tag>{String(row[dataIndex] ?? t('未知'))}</Tag>
            ),
          }
        : {}),
    }),
  );
  if (definition.owner)
    columns.unshift({ title: t('账户ID筛选'), dataIndex: 'ownerId', hideInTable: true });
  if (definition.statuses)
    columns.unshift({
      title: t('状态筛选'),
      dataIndex: 'status',
      hideInTable: true,
      valueType: 'select',
      valueEnum: Object.fromEntries(definition.statuses.map((value) => [value, value])),
    });
  columns.push({
    title: t('操作'),
    fixed: 'right',
    width: key === 'orders' || key === 'subscriptions' ? 150 : 70,
    valueType: 'option',
    render: (_, row) => (
      <Space>
        <a onClick={() => setSelected(row)}>{t('详情')}</a>
        {key === 'orders' && row.state === 'paid' && row.mode !== 'subscription' && (
          <PermissionGuard permission="billing:refund">
            <Link to={`/refunds?targetType=order&targetId=${encodeURIComponent(String(row.id))}`}>
              {t('退款')}
            </Link>
          </PermissionGuard>
        )}
        {key === 'orders' &&
          row.mode === 'subscription' &&
          typeof row.subscriptionRecordId === 'string' && (
            <PermissionGuard permission="billing:refund">
              <Link to={`/refunds?subscriptionId=${encodeURIComponent(row.subscriptionRecordId)}`}>
                {t('付款周期')}
              </Link>
            </PermissionGuard>
          )}
        {key === 'subscriptions' && (
          <PermissionGuard permission="billing:refund">
            <Link to={`/refunds?subscriptionId=${encodeURIComponent(String(row.id))}`}>
              {t('付款周期')}
            </Link>
          </PermissionGuard>
        )}
      </Space>
    ),
  });
  return (
    <PageContainer title={t(definition.title)}>
      <Typography.Paragraph type="secondary">{t(definition.description)}</Typography.Paragraph>
      {failed && (
        <Alert
          type="error"
          showIcon
          message={t('数据加载失败')}
          description={t('无法读取不代表没有记录，可使用表格刷新重试。')}
          style={{ marginBottom: 16 }}
        />
      )}
      <ProTable<Record<string, unknown>>
        key={key}
        rowKey="id"
        columns={columns}
        request={async (params) => {
          const query = {
            page: params.current ?? 1,
            pageSize: params.pageSize ?? 20,
            ...(params.id ? { id: params.id } : {}),
            ...(params.ownerId ? { ownerId: params.ownerId } : {}),
            ...(params.status ? { status: params.status } : {}),
          };
          try {
            const result = await httpClient.get<{ data: Record<string, unknown>[]; total: number }>(
              `/management/${key}`,
              query,
            );
            setFailed(false);
            return { ...result, success: true };
          } catch (error) {
            setFailed(true);
            throw error;
          }
        }}
        scroll={{ x: 1100 }}
      />
      <Drawer
        title={t('{name}详情', '{name} details', { name: t(definition.title) })}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        width={560}
      >
        {selected && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {definition.columns.map(([field, label]) => (
              <div key={field}>
                <Typography.Text type="secondary">{t(label)}</Typography.Text>
                <Typography.Paragraph
                  copyable={typeof selected[field] === 'string'}
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {display(selected[field], t)}
                </Typography.Paragraph>
              </div>
            ))}
            <Button onClick={() => setSelected(null)}>{t('关闭')}</Button>
          </Space>
        )}
      </Drawer>
    </PageContainer>
  );
}

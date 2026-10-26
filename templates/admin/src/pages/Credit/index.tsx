import { useAdminI18n } from '@/i18n';
import { useRef, useState } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormDigit,
  ProFormDateTimePicker,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Alert, App, Button, Descriptions, Drawer, Space, Tag } from 'antd';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { grantAttempt, clearGrantAttempt } from '@/features/credits/grant-attempt';
interface CreditRecord {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balance: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  description: string;
  createdAt: string;
}
interface Balance {
  available: number;
  frozen: number;
  refundBlocked: number;
  expired: number;
  bookBalance: number;
  pendingExpiry: number;
}
const types = {
  GRANT: '发放',
  CONSUME: '消费',
  REFUND: '退回',
  EXPIRE: '过期',
  TRANSFER_IN: '转入',
  TRANSFER_OUT: '转出',
  FREEZE: '保留',
  UNFREEZE: '释放',
};
export default function CreditPage() {
  const { t } = useAdminI18n();
  const { message } = App.useApp(),
    ref = useRef<ActionType>(null);
  const [owner, setOwner] = useState<string | null>(null),
    [balance, setBalance] = useState<Balance | null>(null),
    [balanceError, setBalanceError] = useState(false),
    [failed, setFailed] = useState(false);
  async function inspect(userId: string) {
    setOwner(userId);
    setBalance(null);
    setBalanceError(false);
    try {
      setBalance(
        await httpClient.get<Balance>(`/management/credits/${encodeURIComponent(userId)}/balance`),
      );
    } catch {
      setBalanceError(true);
    }
  }
  const columns: ProColumns<CreditRecord>[] = [
    { title: t('账户ID'), dataIndex: 'userId', copyable: true, search: false },
    { title: t('账户ID筛选'), dataIndex: 'ownerId', hideInTable: true },
    {
      title: t('类型'),
      dataIndex: 'status',
      hideInTable: true,
      valueEnum: Object.fromEntries(Object.entries(types).map(([key, label]) => [key, t(label)])),
    },
    {
      title: t('流水类型'),
      dataIndex: 'type',
      search: false,
      render: (_, row) => <Tag>{t(types[row.type as keyof typeof types] ?? row.type)}</Tag>,
    },
    { title: t('变动'), dataIndex: 'amount', search: false },
    { title: t('账面余额'), dataIndex: 'balance', search: false },
    { title: t('说明'), dataIndex: 'description', search: false },
    { title: t('时间'), dataIndex: 'createdAt', valueType: 'dateTime', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, row) => <a onClick={() => void inspect(row.userId)}>{t('查看账户额度')}</a>,
    },
  ];
  return (
    <PageContainer title={t('积分流水')}>
      <p style={{ marginTop: 0, marginBottom: 20, opacity: 0.75 }}>
        {t('查看积分流水与可用额度。人工发放记录操作人，并防止重复发放。')}
      </p>
      <Alert
        type="info"
        showIcon
        message={t('额度操作范围')}
        description={t(
          '这里只提供正向人工发放。退款保留额度由退款流程处理，此处不提供负向调整或手动冻结。',
        )}
        style={{ marginBottom: 16 }}
      />
      {failed && (
        <Alert type="error" message={t('流水加载失败，可刷新重试')} style={{ marginBottom: 16 }} />
      )}
      <ProTable<CreditRecord>
        actionRef={ref}
        rowKey="id"
        columns={columns}
        scroll={{ x: 1000 }}
        request={async (params) => {
          try {
            const result = await httpClient.get<{ data: CreditRecord[]; total: number }>(
              '/management/credits',
              {
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
                ...(params.ownerId ? { ownerId: params.ownerId } : {}),
                ...(params.status ? { status: params.status } : {}),
              },
            );
            setFailed(false);
            return { ...result, success: true };
          } catch (error) {
            setFailed(true);
            throw error;
          }
        }}
        toolBarRender={() => [
          <PermissionGuard key="grant" permission="credit:grant">
            <ModalForm
              name="credit-grant"
              title={t('发放积分')}
              trigger={<Button type="primary">{t('发放积分')}</Button>}
              submitter={{ searchConfig: { submitText: t('确认发放') } }}
              onFinish={async (values) => {
                const expiresAt = values.expiresAt
                  ? new Date(String(values.expiresAt)).toISOString()
                  : null;
                const ownerId = String(values.ownerId).trim();
                const body = {
                  amount: values.amount,
                  description: String(values.description).trim(),
                  expiresAt,
                };
                try {
                  const actor = await httpClient.get<{ id: string }>('/authorize/me');
                  const attempt = await grantAttempt(actor.id, { ownerId, ...body });
                  if (!attempt.persisted)
                    message.warning(t('浏览器无法保存重试记录，确认结果前请勿刷新或关闭页面。'));
                  await httpClient.post(
                    `/management/credits/${encodeURIComponent(ownerId)}/grants`,
                    body,
                    undefined,
                    { headers: { 'Idempotency-Key': attempt.key } },
                  );
                  message.success(t('积分已发放'));
                  clearGrantAttempt(actor.id, attempt.key);
                  ref.current?.reload();
                  return true;
                } catch (error) {
                  message.error(
                    (error as { status?: number }).status === 409
                      ? t('请求编号已绑定其他内容，请重新核对')
                      : t('结果未确认；保持表单内容不变重试会复用同一请求编号'),
                  );
                  return false;
                }
              }}
            >
              <ProFormText name="ownerId" label={t('账户ID')} rules={[{ required: true }]} />
              <ProFormDigit
                name="amount"
                label={t('积分数量')}
                min={1}
                max={2147483647}
                fieldProps={{ precision: 0 }}
                rules={[{ required: true }]}
              />
              <ProFormText
                name="description"
                label={t('发放原因')}
                rules={[{ required: true, max: 500 }]}
              />
              <ProFormDateTimePicker name="expiresAt" label={t('到期时间（可选）')} />
              <Alert
                type="info"
                message={t('确认前核对账户、数量和原因。结果未确认时不要修改表单，重试同一请求。')}
              />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
      <Drawer
        title={t('账户额度')}
        open={Boolean(owner)}
        onClose={() => setOwner(null)}
        width="min(600px, 100vw)"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            {t('账户：')}
            {owner}
          </div>
          {balanceError ? (
            <Alert
              type="error"
              message={t('账户额度读取失败')}
              action={<Button onClick={() => owner && void inspect(owner)}>{t('重试')}</Button>}
            />
          ) : balance ? (
            <Descriptions
              column={1}
              items={[
                { key: 'available', label: t('可用额度'), children: balance.available },
                { key: 'balance', label: t('账面余额'), children: balance.bookBalance },
                { key: 'frozen', label: t('保留额度'), children: balance.frozen },
                {
                  key: 'refundBlocked',
                  label: t('退款待处理额度'),
                  children: balance.refundBlocked ?? 0,
                },
                { key: 'expired', label: t('已过期额度'), children: balance.expired },
                { key: 'pending', label: t('待记账过期'), children: balance.pendingExpiry },
              ]}
            />
          ) : (
            <div>{t('正在读取…')}</div>
          )}
          {balance && (
            <Alert
              type="info"
              showIcon
              message={t('退款待处理额度已从可用额度中排除')}
              description={t(
                '这部分额度正在等待退款回收处理，不与保留额度重复计算。账面余额不是当前可消费额度。',
              )}
            />
          )}
          {owner && (
            <ProTable<Record<string, unknown>>
              key={owner}
              rowKey="id"
              search={false}
              toolBarRender={false}
              columns={[
                { title: t('来源'), dataIndex: 'source' },
                { title: t('发放'), dataIndex: 'amount' },
                { title: t('可用'), dataIndex: 'availableAmount' },
                { title: t('保留'), dataIndex: 'frozenAmount', renderText: (value) => value ?? 0 },
                {
                  title: t('退款待处理'),
                  dataIndex: 'refundBlockedAmount',
                  renderText: (value) => value ?? 0,
                },
                {
                  title: t('状态'),
                  dataIndex: 'status',
                  valueEnum: {
                    available: t('可用'),
                    consumed: t('已用完'),
                    expired: t('已过期'),
                    held: t('已保留'),
                    refund_pending: t('退款待处理'),
                  },
                },
              ]}
              scroll={{ x: 650 }}
              request={async (params) => ({
                ...(await httpClient.get<{ data: Record<string, unknown>[]; total: number }>(
                  `/management/credits/${encodeURIComponent(owner)}/lots`,
                  { page: params.current ?? 1, pageSize: params.pageSize ?? 20 },
                )),
                success: true,
              })}
            />
          )}
        </Space>
      </Drawer>
    </PageContainer>
  );
}

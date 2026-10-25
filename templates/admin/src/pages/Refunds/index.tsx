import { useAdminI18n } from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { PageContainer, ProTable, ModalForm, ProFormText } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Alert, App, Button, Card, Descriptions, Drawer, Space, Tag, Typography } from 'antd';
import httpClient from '@/lib/http-client';
import {
  adminOperationAttempt,
  clearAdminOperationAttempt,
  findAdminOperationAttempt,
} from '@/lib/admin-operation-attempt';
import { refundsApi } from '@/features/refunds/api';
import {
  canonicalRefundAmount,
  creditStates,
  moneyText,
  refundStates,
  type RefundCycle,
  type RefundState,
  type RefundTarget,
  type RefundTargetType,
  type RefundView,
} from '@/features/refunds/types';

function refundBody(type: RefundTargetType, id: string, amount: string, reason?: string | null) {
  const note = reason?.trim();
  return {
    targetType: type,
    targetId: id,
    amount: canonicalRefundAmount(amount),
    ...(note ? { reason: note } : {}),
  };
}
function RefundStateTag({ row }: { row: RefundView }) {
  const { t } = useAdminI18n();
  return (
    <Tag
      color={
        row.state === 'succeeded'
          ? 'success'
          : row.state === 'attention' || row.state === 'unknown'
            ? 'warning'
            : row.state === 'failed'
              ? 'error'
              : 'default'
      }
    >
      {t(refundStates[row.state])}
    </Tag>
  );
}
function Failure({
  retry,
  message = '读取失败，请确认权限和服务连接后重试。',
}: {
  retry: () => void;
  message?: string;
}) {
  const { t } = useAdminI18n();
  return (
    <Alert
      type="error"
      showIcon
      message={t(message)}
      action={<Button onClick={retry}>{t('重试')}</Button>}
    />
  );
}

function TargetPanel({
  type,
  id,
  onCreated,
  refreshVersion,
}: {
  type: RefundTargetType;
  id: string;
  onCreated: (row: RefundView) => void;
  refreshVersion: number;
}) {
  const { t } = useAdminI18n();
  const { message } = App.useApp();
  const [target, setTarget] = useState<RefundTarget | null>(null),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [checking, setChecking] = useState(false),
    [retry, setRetry] = useState(0),
    [open, setOpen] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [draft, setDraft] = useState({ amount: '', reason: '' });
  useEffect(() => {
    let active = true;
    void refundsApi
      .target(type, id)
      .then((result) => {
        if (active) {
          setTarget(result);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [type, id, retry, refreshVersion]);
  const reload = () => {
    setLoading(true);
    setRetry((value) => value + 1);
  };
  return (
    <Card
      title={type === 'order' ? t('订单退款概况') : t('付款周期退款概况')}
      loading={loading}
      style={{ marginBottom: 20 }}
    >
      {error ? (
        <Failure retry={reload} />
      ) : (
        target && (
          <>
            <Descriptions
              column={{ xs: 1, sm: 2, lg: 3 }}
              items={[
                { key: 'title', label: t('套餐'), children: target.title },
                { key: 'owner', label: t('账户ID'), children: target.ownerId ?? '—' },
                { key: 'order', label: t('本地订单'), children: target.orderId },
                { key: 'target', label: t('本地目标'), children: id },
                { key: 'paid', label: t('已付款'), children: moneyText(target.paidMoney) },
                {
                  key: 'refunded',
                  label: target.cashEvidencePending ? t('上次已核对退款') : t('已退款'),
                  children: moneyText(target.refundedMoney),
                },
                {
                  key: 'pending',
                  label: t('退款处理中'),
                  children: moneyText(target.pendingMoney),
                },
                {
                  key: 'remaining',
                  label: target.cashEvidencePending ? t('上次已核对可退金额') : t('当前可退金额'),
                  children: moneyText(target.remainingMoney),
                },
                {
                  key: 'credits',
                  label: t('已回收 / 原额度'),
                  children: `${target.recoveredCredits} / ${target.totalCredits}`,
                },
              ]}
            />
            {target.cashEvidencePending && (
              <Alert
                type="warning"
                showIcon
                message={t('现金证明待核对，金额尚未更新')}
                description={t(
                  '上述金额是上次已核对的记录，不能据此判断尚未退款。请先核对渠道记录，再处理后续退款。',
                )}
                style={{ marginBottom: 16 }}
              />
            )}
            {target.attention && !target.cashEvidencePending && (
              <Alert
                type="warning"
                showIcon
                message={t('此付款需要先处理现有退款或额度问题。')}
                style={{ marginBottom: 16 }}
              />
            )}
            <Space wrap>
              <Button
                loading={checking}
                disabled={!target.capabilities.canCheck}
                onClick={async () => {
                  setChecking(true);
                  try {
                    setTarget(await refundsApi.checkTarget(type, id));
                    message.success(t('渠道退款事实已核对'));
                  } catch {
                    message.error(t('渠道核对未完成，当前金额保持原记录'));
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                {t('核对渠道记录')}
              </Button>
              <Button
                type="primary"
                disabled={!target.capabilities.canCreate || target.cashEvidencePending || checking}
                onClick={() => {
                  setDraft({ amount: target.remainingMoney.amount, reason: '' });
                  setOpen(true);
                }}
              >
                {t('申请退款')}
              </Button>
              {target.activeRequestId && (
                <Button
                  onClick={async () => {
                    try {
                      const row = await refundsApi.detail(target.activeRequestId!);
                      if (row.cashState === 'prepared') {
                        const actor = await httpClient.get<{ id: string }>('/authorize/me');
                        const existing = await findAdminOperationAttempt(
                          'refund',
                          actor.id,
                          refundBody(type, id, row.money.amount, row.reason),
                        );
                        if (existing) {
                          setDraft({ amount: row.money.amount, reason: row.reason ?? '' });
                          setOpen(true);
                          message.info(t('申请已保存，确认将继续同一申请的首次提交。'));
                          return;
                        }
                      }
                      onCreated(row);
                    } catch {
                      message.error(t('现有退款记录读取失败'));
                    }
                  }}
                >
                  {t('查看现有退款')}
                </Button>
              )}
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
              {t(
                '可退金额和额度处理依据由服务端核对。核对操作不会再次发起退款；现金退款成功与额度处理完成分别显示。',
              )}
            </Typography.Paragraph>
            {open && (
              <ModalForm
                name="admin-refund-create"
                title={t('确认退款申请')}
                open
                disabled={submitting}
                modalProps={{
                  destroyOnHidden: true,
                  maskClosable: false,
                  closable: !submitting,
                  onCancel: () => {
                    if (!submitting) setOpen(false);
                  },
                }}
                initialValues={draft}
                submitter={{
                  searchConfig: { submitText: t('确认退款') },
                  resetButtonProps: { disabled: submitting },
                }}
                onFinish={async (values) => {
                  setSubmitting(true);
                  try {
                    const body = refundBody(
                      type,
                      id,
                      String(values.amount),
                      String(values.reason ?? ''),
                    );
                    const actor = await httpClient.get<{ id: string }>('/authorize/me');
                    const attempt = await adminOperationAttempt('refund', actor.id, body);
                    if (!attempt.persisted)
                      message.warning(t('浏览器无法保存重试记录，确认结果前请勿刷新或关闭页面。'));
                    let recovered: RefundView | null = null;
                    if (attempt.existing) {
                      try {
                        recovered = await refundsApi.recover(attempt.key);
                      } catch (failure) {
                        if ((failure as { status?: number }).status !== 404) throw failure;
                      }
                    }
                    const result =
                      recovered && recovered.cashState !== 'prepared'
                        ? recovered
                        : await refundsApi.create(body, attempt.key);
                    if (result.cashState === 'prepared') {
                      message.warning(
                        t('申请已保存，尚未提交渠道。请保留当前内容并重试同一申请。'),
                      );
                      return false;
                    }
                    clearAdminOperationAttempt('refund', actor.id, attempt.key);
                    setOpen(false);
                    onCreated(result);
                    reload();
                    message.success(
                      recovered && recovered.cashState !== 'prepared'
                        ? t('已恢复上次申请，没有再次发起退款。')
                        : t('退款申请已记录，请查看现金与额度处理状态'),
                    );
                    return true;
                  } catch (failure) {
                    const status = (failure as { status?: number }).status;
                    message.error(
                      status === 400 || status === 409
                        ? t('申请未完成，请核对金额、当前可退状态或已有申请。')
                        : t('结果未确认。请保持申请内容不变重试，或先查看退款记录。'),
                    );
                    return false;
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                <Alert
                  type="warning"
                  showIcon
                  message={t('确认前核对退款目标和金额')}
                  description={t(
                    '订单 {order}；当前可退 {amount}。申请将由服务器处理退款及相应额度，提交后不能通过修改状态撤回。',
                    'Order {order}; currently refundable {amount}. The server processes cash and credits. Changing a status cannot withdraw a submitted refund.',
                    { order: target.orderId, amount: moneyText(target.remainingMoney) },
                  )}
                  style={{ marginBottom: 20 }}
                />
                <ProFormText
                  name="amount"
                  label={t('退款金额（{currency}）', 'Refund amount ({currency})', {
                    currency: target.remainingMoney.currency,
                  })}
                  disabled={!target.capabilities.partial}
                  fieldProps={{ inputMode: 'decimal' }}
                  rules={[
                    { required: true },
                    {
                      validator: (_, value) =>
                        typeof value === 'string' &&
                        /^\d+(?:\.\d+)?$/.test(value.trim()) &&
                        /[1-9]/.test(value)
                          ? Promise.resolve()
                          : Promise.reject(new Error(t('请输入正数十进制金额'))),
                    },
                  ]}
                />
                <ProFormText
                  name="reason"
                  label={t('退款原因（可选）')}
                  fieldProps={{ maxLength: 255 }}
                  rules={[{ max: 255 }]}
                />
              </ModalForm>
            )}
          </>
        )
      )}
    </Card>
  );
}

function RefundDetails({
  id,
  close,
  onChecked,
}: {
  id: string;
  close: () => void;
  onChecked: () => void;
}) {
  const { t, localeTag } = useAdminI18n();
  const { message } = App.useApp();
  const [row, setRow] = useState<RefundView | null>(null),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [checking, setChecking] = useState(false);
  useEffect(() => {
    let active = true;
    void refundsApi
      .detail(id)
      .then((result) => {
        if (active) {
          setRow(result);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, retry]);
  return (
    <Drawer title={t('退款详情')} open onClose={close} width={620}>
      {error ? (
        <Failure retry={() => setRetry((value) => value + 1)} />
      ) : !row ? (
        <Card loading />
      ) : (
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <RefundStateTag row={row} />
          {row.state === 'attention' && (
            <Alert
              type="warning"
              showIcon
              message={
                row.creditState === 'attention'
                  ? t('额度处理需要人工核对')
                  : row.reconcileStatus === 'attention'
                    ? t('自动核对需要处理')
                    : t('退款需要处理')
              }
              description={t(
                '现金退款、额度处理和自动核对分别显示。请核对未完成事项后处理；状态核对不会再次发起退款。',
              )}
            />
          )}
          <Descriptions
            column={1}
            items={[
              { key: 'id', label: t('退款ID'), children: row.id },
              { key: 'owner', label: t('账户ID'), children: row.ownerId ?? '—' },
              { key: 'order', label: t('订单ID'), children: row.orderId },
              { key: 'title', label: t('套餐'), children: row.title },
              { key: 'money', label: t('申请金额'), children: moneyText(row.money) },
              {
                key: 'cash',
                label: t('现金退款'),
                children: t(refundStates[row.cashState as RefundState] ?? row.cashState),
              },
              { key: 'credit', label: t('额度处理'), children: t(creditStates[row.creditState]) },
              {
                key: 'reconcile',
                label: t('自动核对'),
                children: {
                  idle: t('暂无待核对操作'),
                  pending: t('等待核对'),
                  attention: t('需要人工核对'),
                }[row.reconcileStatus],
              },
              {
                key: 'basis',
                label: t('现金确认依据'),
                children:
                  row.confirmationBasis === 'receipt'
                    ? t('退款凭证')
                    : row.confirmationBasis === 'payment_total'
                      ? t('付款累计退款金额')
                      : t('尚未确认'),
              },
              { key: 'held', label: t('保留额度'), children: row.creditImpact.held },
              { key: 'revoked', label: t('已回收额度'), children: row.creditImpact.revoked },
              { key: 'expired', label: t('过期额度'), children: row.creditImpact.expired },
              {
                key: 'suppressed',
                label: t('阻止发放额度'),
                children: row.creditImpact.suppressed,
              },
              {
                key: 'shortfall',
                label: t('待处理额度差额'),
                children: row.creditImpact.shortfall,
              },
              { key: 'reason', label: t('原因'), children: row.reason || '—' },
              {
                key: 'time',
                label: t('更新时间'),
                children: new Date(row.updatedAt).toLocaleString(localeTag),
              },
            ]}
          />
          <Button
            loading={checking}
            disabled={!row.canCheck}
            onClick={async () => {
              setChecking(true);
              try {
                setRow(await refundsApi.check(id));
                onChecked();
                message.success(t('退款状态已核对'));
              } catch {
                message.error(t('核对失败，当前状态保持原记录'));
              } finally {
                setChecking(false);
              }
            }}
          >
            {t('核对退款状态')}
          </Button>
        </Space>
      )}
    </Drawer>
  );
}

function RefundCycles({ id, select }: { id: string; select: (id: string) => void }) {
  const { t } = useAdminI18n();
  const [failed, setFailed] = useState(false);
  const columns: ProColumns<RefundCycle>[] = [
    { title: t('本地周期ID'), dataIndex: 'id', copyable: true },
    { title: t('已付款'), dataIndex: 'paidMoney', render: (_, row) => moneyText(row.paidMoney) },
    { title: t('付款时间'), dataIndex: 'paidAt', valueType: 'dateTime' },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, row) => (
        <Button type="link" onClick={() => select(row.id)}>
          {t('查看退款概况')}
        </Button>
      ),
    },
  ];
  return (
    <Card title={t('订阅付款周期')} style={{ marginBottom: 20 }}>
      {failed && (
        <Alert
          type="error"
          showIcon
          message={t('付款周期读取失败，请使用表格刷新重试。')}
          style={{ marginBottom: 16 }}
        />
      )}
      <ProTable<RefundCycle>
        rowKey="id"
        columns={columns}
        search={false}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        request={async (params) => {
          try {
            const result = await refundsApi.cycles(id, params.current ?? 1);
            setFailed(false);
            return { ...result, success: true };
          } catch (error) {
            setFailed(true);
            throw error;
          }
        }}
      />
    </Card>
  );
}

export default function RefundsPage() {
  const { t } = useAdminI18n();
  const [query, setQuery] = useSearchParams(),
    ref = useRef<ActionType>(null),
    [detail, setDetail] = useState<string | null>(null),
    [refreshVersion, setRefreshVersion] = useState(0),
    [failed, setFailed] = useState(false);
  const type = query.get('targetType'),
    id = query.get('targetId'),
    subscriptionId = query.get('subscriptionId');
  const columns: ProColumns<RefundView>[] = [
    { title: t('退款ID'), dataIndex: 'id', search: false, copyable: true },
    { title: t('订单ID'), dataIndex: 'orderId', search: false },
    { title: t('套餐'), dataIndex: 'title', search: false },
    {
      title: t('金额'),
      dataIndex: 'money',
      search: false,
      render: (_, row) => moneyText(row.money),
    },
    {
      title: t('整体状态'),
      dataIndex: 'state',
      valueEnum: Object.fromEntries(
        Object.entries(refundStates).map(([key, label]) => [key, t(label)]),
      ),
      render: (_, row) => <RefundStateTag row={row} />,
    },
    {
      title: t('现金状态'),
      dataIndex: 'cashState',
      search: false,
      renderText: (value) => t(refundStates[value as RefundState] ?? value),
    },
    {
      title: t('额度状态'),
      dataIndex: 'creditState',
      search: false,
      renderText: (value) => t(creditStates[value as RefundView['creditState']] ?? value),
    },
    { title: t('创建时间'), dataIndex: 'createdAt', valueType: 'dateTime', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      width: 70,
      fixed: 'right',
      render: (_, row) => <a onClick={() => setDetail(row.id)}>{t('详情')}</a>,
    },
  ];
  return (
    <PageContainer title={t('退款管理')}>
      <Typography.Paragraph type="secondary">
        {t('从订单或订阅付款周期进入退款概况。现金退款和额度处理分开核对，未知结果保持待处理。')}
      </Typography.Paragraph>
      <Space style={{ marginBottom: 20 }}>
        <Link to="/records/orders">{t('订单')}</Link>
        <Link to="/records/subscriptions">{t('订阅')}</Link>
        {(id || subscriptionId) && (
          <Button onClick={() => setQuery({})}>{t('返回退款记录')}</Button>
        )}
      </Space>
      {(type === 'order' || type === 'cycle') && id && (
        <TargetPanel
          key={`${type}:${id}`}
          type={type}
          id={id}
          refreshVersion={refreshVersion}
          onCreated={(row) => {
            setDetail(row.id);
            ref.current?.reload();
          }}
        />
      )}
      {subscriptionId && (
        <RefundCycles
          key={subscriptionId}
          id={subscriptionId}
          select={(id) => setQuery({ targetType: 'cycle', targetId: id })}
        />
      )}
      {failed && (
        <Alert
          type="error"
          showIcon
          message={t('退款记录读取失败，请使用表格刷新重试。')}
          style={{ marginBottom: 16 }}
        />
      )}
      <ProTable<RefundView>
        actionRef={ref}
        rowKey="id"
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1200 }}
        request={async (params) => {
          try {
            const result = await refundsApi.list(
              params.current ?? 1,
              params.state as RefundState | undefined,
            );
            setFailed(false);
            return { ...result, success: true };
          } catch (error) {
            setFailed(true);
            throw error;
          }
        }}
      />
      {detail && (
        <RefundDetails
          key={detail}
          id={detail}
          onChecked={() => {
            setRefreshVersion((value) => value + 1);
            ref.current?.reload();
          }}
          close={() => {
            setDetail(null);
            ref.current?.reload();
          }}
        />
      )}
    </PageContainer>
  );
}

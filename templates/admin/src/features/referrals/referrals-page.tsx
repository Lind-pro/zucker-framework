import {
  ConfirmButton,
  PageContainer,
  ResourceTable,
  StatusBadge,
  errorStatus,
  formatDateTime,
  pageLoader,
  toast,
  useAdminApi,
  useAdminI18n,
  usePermissionCheck,
  type ResourceTableHandle,
  type Tone,
} from '@zucker-framework/fe-admin';
import { useRef } from 'react';
import { useText } from '../../text';

export const REFERRAL_REWARD_STATUSES = ['pending', 'granted', 'skipped'] as const;

/** One row of `GET /management/referrals` (`{ data, total, page, pageSize }`). */
export interface ReferralRow {
  refereeId: string;
  referrerId: string;
  code: string;
  boundAt: string;
  rewardStatus: (typeof REFERRAL_REWARD_STATUSES)[number];
  skipReason: string | null;
  orderId: string | null;
  referrerCredits: number | null;
  refereeCredits: number | null;
  rewardedAt: string | null;
  codeDisabled: boolean;
}

const tone = (status: string): Tone => (status === 'granted' ? 'success' : status === 'skipped' ? 'neutral' : 'info');
const SKIP_REASONS: Record<string, [string, string]> = {
  refunded: ['订单已退款', 'Order refunded'],
  'prior-order': ['邀请前已有订单', 'Ordered before the invitation'],
  'cap-reached': ['已达邀请人上限', 'Referrer limit reached'],
  'code-disabled': ['邀请码已停用', 'Code disabled'],
  'referrer-unavailable': ['邀请人账户不可用', 'Referrer account unavailable'],
  'referee-unavailable': ['受邀人账户不可用', 'Referred account unavailable'],
};

/**
 * Referral bindings with their reward decision. Disabling a referrer's code (`referrals:update`,
 * audited on the server) stops new claims and skips that referrer's pending rewards.
 */
export function ReferralsPage() {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const can = usePermissionCheck();
  const table = useRef<ResourceTableHandle>(null);
  const editable = can('referrals:update');
  const statusLabel = (status: string) =>
    status === 'granted' ? tx('已奖励', 'Granted') : status === 'skipped' ? tx('已跳过', 'Skipped') : tx('待首单', 'Pending');
  async function setDisabled(row: ReferralRow, disabled: boolean) {
    try {
      await api.patch(`/management/referrals/codes/${encodeURIComponent(row.referrerId)}`, { disabled });
      toast.success(disabled ? tx('邀请码已停用', 'Code disabled') : tx('邀请码已启用', 'Code enabled'));
      table.current?.reload();
    } catch (error) {
      toast.error(errorStatus(error) === 403 ? tx('没有权限', 'Permission denied') : tx('操作失败', 'Update failed'));
    }
  }
  const title = tx('邀请返利', 'Referrals');
  return (
    <PageContainer title={title} description={tx('受邀用户及其奖励状态。积分在首单满延迟期且未退款后发放。', 'Referred users and their reward state. Credits are granted after the first order passes the delay without a refund.')}>
      <ResourceTable<ReferralRow>
        ref={table}
        label={title}
        load={pageLoader(api, '/management/referrals')}
        rowKey={(row) => row.refereeId}
        minWidth={960}
        filters={[
          { name: 'referrerId', label: tx('邀请人 ID', 'Referrer id') },
          { name: 'refereeId', label: tx('受邀人 ID', 'Referred user id') },
          { name: 'code', label: tx('邀请码', 'Code') },
          { name: 'status', label: tx('状态', 'Status'), type: 'select', options: REFERRAL_REWARD_STATUSES.map((value) => ({ value, label: statusLabel(value) })) },
        ]}
        columns={[
          { key: 'boundAt', title: tx('绑定时间', 'Bound'), render: (row) => formatDateTime(row.boundAt, locale) },
          { key: 'referrerId', title: tx('邀请人', 'Referrer'), render: (row) => row.referrerId },
          { key: 'refereeId', title: tx('受邀人', 'Referred user'), render: (row) => row.refereeId },
          { key: 'code', title: tx('邀请码', 'Code'), render: (row) => <span className="font-mono">{row.code}{row.codeDisabled ? ` (${tx('已停用', 'disabled')})` : ''}</span> },
          { key: 'rewardStatus', title: tx('状态', 'Status'), render: (row) => <StatusBadge tone={tone(row.rewardStatus)}>{statusLabel(row.rewardStatus)}</StatusBadge> },
          { key: 'credits', title: tx('奖励积分', 'Credits'), hideOnMobile: true,
            render: (row) => row.rewardStatus === 'granted' ? `${row.referrerCredits ?? 0} / ${row.refereeCredits ?? 0}` : '—' },
          { key: 'skipReason', title: tx('跳过原因', 'Skip reason'), hideOnMobile: true,
            render: (row) => (row.skipReason ? tx(...(SKIP_REASONS[row.skipReason] ?? [row.skipReason, row.skipReason])) : '—') },
          { key: 'orderId', title: tx('订单', 'Order'), hideOnMobile: true, render: (row) => row.orderId ?? '—' },
          { key: 'rewardedAt', title: tx('决定时间', 'Decided'), hideOnMobile: true, render: (row) => (row.rewardedAt ? formatDateTime(row.rewardedAt, locale) : '—') },
        ]}
        actions={editable ? (row) => (
          <ConfirmButton
            size="sm"
            variant="ghost"
            destructive={!row.codeDisabled}
            title={row.codeDisabled ? tx('启用邀请码？', 'Enable this code?') : tx('停用邀请码？', 'Disable this code?')}
            description={row.codeDisabled
              ? tx('邀请人的链接将重新可用。', "The referrer's link works again.")
              : tx('新的绑定将被拒绝，该邀请人待发放的奖励将被跳过。', "New claims are refused and this referrer's pending rewards are skipped.")}
            onConfirm={() => setDisabled(row, !row.codeDisabled)}
          >
            {row.codeDisabled ? tx('启用邀请码', 'Enable code') : tx('停用邀请码', 'Disable code')}
          </ConfirmButton>
        ) : undefined}
      />
    </PageContainer>
  );
}

import type { AdminPageDefinition } from '@zucker-framework/fe-admin';
import { Gift } from 'lucide-react';
import { ReferralsPage } from './referrals-page';

/**
 * Back-office page of the referral programme. The programme itself (on/off, amounts, delay, cap) is
 * the `referral` policy on the generic policies page. Register with `...referralPages` in
 * `features/index.ts`; the menu entry comes from the server's menu records.
 */
export const referralPages: AdminPageDefinition[] = [
  {
    key: 'referrals',
    path: '/referrals',
    title: { 'zh-CN': '邀请返利', 'en-US': 'Referrals' },
    permission: 'referrals:query',
    component: ReferralsPage,
    icon: Gift,
  },
];

export { ReferralsPage, REFERRAL_REWARD_STATUSES, type ReferralRow } from './referrals-page';

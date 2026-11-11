import { Gift } from 'lucide-react';
import type { ConsoleNavItem } from '@/lib/site/console-nav';

/** Registered in lib/site/console-nav.ts by the integration WP (`...referralConsoleNav`). */
export const referralConsoleNav: readonly ConsoleNavItem[] = [
  { id: 'referrals', href: '/account/referrals', label: { en: 'Invite friends', zh: '邀请好友' }, icon: Gift, order: 55 },
];

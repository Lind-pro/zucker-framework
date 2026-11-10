import type { ComponentType } from 'react';
import { CreditCard, Coins, FolderOpen, KeyRound, Receipt, ShieldCheck, UserRound } from 'lucide-react';
import type { Locale } from './locales';

export interface ConsoleNavItem {
  /** Stable id, unique across features (also the React key and `data-console-nav` attribute). */
  id: string;
  /** Locale-free path, optionally with a #fragment, e.g. "/account/tasks". */
  href: string;
  /** Copy lives with the feature that registers the item. */
  label: Record<Locale, string>;
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
  /** Ascending; core items use multiples of 10 so features can slot in between. */
  order: number;
  /** `prefix` (default) marks the item current for sub-paths too; `exact` only for the path itself. */
  match?: 'exact' | 'prefix';
}

/** Core console sections. Existing URLs are kept; Security and API keys are sections of /account. */
export const coreConsoleNav: readonly ConsoleNavItem[] = [
  { id: 'profile', href: '/account', label: { en: 'Profile', zh: '个人资料' }, icon: UserRound, order: 10, match: 'exact' },
  { id: 'security', href: '/account#security', label: { en: 'Security', zh: '安全' }, icon: ShieldCheck, order: 20 },
  { id: 'billing', href: '/billing/subscriptions', label: { en: 'Billing', zh: '订阅' }, icon: CreditCard, order: 30 },
  { id: 'orders', href: '/billing/orders', label: { en: 'Orders', zh: '订单' }, icon: Receipt, order: 40 },
  { id: 'credits', href: '/account/credits', label: { en: 'Credits', zh: '积分' }, icon: Coins, order: 50 },
  { id: 'files', href: '/account/files', label: { en: 'Files', zh: '文件' }, icon: FolderOpen, order: 60 },
  { id: 'api-keys', href: '/account#api-keys', label: { en: 'API keys', zh: 'API 密钥' }, icon: KeyRound, order: 70 },
];

/**
 * Registration point. A feature exports `ConsoleNavItem[]` from its own folder (for example
 * `features/ai/console-nav.ts`) and the integration WP adds one spread line below. The sidebar
 * and the header account menu both render this list.
 */
export const consoleNav: readonly ConsoleNavItem[] = [
  ...coreConsoleNav,
  // ...aiConsoleNav,
].sort((a, b) => a.order - b.order);

/** Active item for a locale-free pathname; fragments never decide the match. */
export function isConsoleNavActive(item: ConsoleNavItem, pathname: string): boolean {
  if (item.href.includes('#')) return false;
  if (item.match === 'exact') return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

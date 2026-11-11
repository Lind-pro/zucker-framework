import { Bell } from 'lucide-react';
import type { ConsoleNavItem } from '@/lib/site/console-nav';

/** Registered in lib/site/console-nav.ts by the integration WP (`...inboxConsoleNav`). */
export const inboxConsoleNav: readonly ConsoleNavItem[] = [
  { id: 'notifications', href: '/account/notifications', label: { en: 'Notifications', zh: '通知' }, icon: Bell, order: 75 },
];

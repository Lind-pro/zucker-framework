import { MessageSquareText } from 'lucide-react';
import type { ConsoleNavItem } from '@/lib/site/console-nav';

/** Registered in lib/site/console-nav.ts by the integration WP (`...feedbackConsoleNav`). */
export const feedbackConsoleNav: readonly ConsoleNavItem[] = [
  { id: 'feedback', href: '/account/feedback', label: { en: 'Feedback', zh: '反馈' }, icon: MessageSquareText, order: 80 },
];

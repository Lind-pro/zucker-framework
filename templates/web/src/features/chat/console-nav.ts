import { MessagesSquare } from 'lucide-react';
import type { ConsoleNavItem } from '@/lib/site/console-nav';

/** Registered in lib/site/console-nav.ts by the integration WP (`...chatConsoleNav`). */
export const chatConsoleNav: readonly ConsoleNavItem[] = [
  { id: 'chats', href: '/account/chats', label: { en: 'Chats', zh: '对话' }, icon: MessagesSquare, order: 64 },
];

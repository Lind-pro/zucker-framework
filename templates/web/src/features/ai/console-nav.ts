import { Sparkles } from 'lucide-react';
import type { ConsoleNavItem } from '@/lib/site/console-nav';

/** Registered in lib/site/console-nav.ts by the integration WP (`...aiConsoleNav`). */
export const aiConsoleNav: readonly ConsoleNavItem[] = [
  { id: 'ai-tasks', href: '/account/tasks', label: { en: 'AI tasks', zh: 'AI 任务' }, icon: Sparkles, order: 62 },
];

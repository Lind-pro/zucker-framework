import type { AdminPageDefinition } from '@zucker-framework/fe-admin';
import { aiPages } from './ai';
import { feedbackPages } from './feedback';
import { insightPages } from './insights';
import { promotionPages } from './promotions';
import { referralPages } from './referrals';

/**
 * Registration point for feature-owned back-office pages.
 *
 * Each feature keeps its pages in its own file (for example `features/ai-tasks.ts` exporting
 * `aiTaskPages: AdminPageDefinition[]`) and adds one import plus one spread below, so features do
 * not edit `admin.tsx`. Every page needs a unique `key` and `path` and should declare the server
 * permission it requires; the menu entry itself comes from the server's menu records.
 */
export const extraPages: readonly AdminPageDefinition[] = [
  ...aiPages,
  ...promotionPages,
  ...referralPages,
  ...feedbackPages,
  ...insightPages,
];

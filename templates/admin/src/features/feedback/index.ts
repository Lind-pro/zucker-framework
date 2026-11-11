import type { AdminPageDefinition } from '@zucker-framework/fe-admin';
import { MessageSquareText } from 'lucide-react';
import { FeedbackPage } from './feedback-page';

/**
 * Back-office feedback triage (WP 3.1). Register with `...feedbackPages` in `features/index.ts`; the
 * menu entry comes from the server's menu records (`/feedback`, `feedback:query`). Replies and status
 * changes need `feedback:update`; the form is read-only without it.
 */
export const feedbackPages: AdminPageDefinition[] = [
  {
    key: 'feedback',
    path: '/feedback',
    title: { 'zh-CN': '用户反馈', 'en-US': 'Feedback' },
    permission: 'feedback:query',
    component: FeedbackPage,
    icon: MessageSquareText,
  },
];

export { FeedbackPage, feedbackPatch, FEEDBACK_PATH, FEEDBACK_STATUSES, FEEDBACK_TYPES, FEEDBACK_TEXT_MAX, type FeedbackRecord } from './feedback-page';

/** Shapes of the server's `/feedback` endpoints (owner projection only). */
import type { FeedbackType } from './form-state';

export { FEEDBACK_MESSAGE_MAX, FEEDBACK_TYPES, type FeedbackType } from './form-state';
export type FeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface FeedbackItem {
  id: string;
  type: FeedbackType;
  message: string;
  status: FeedbackStatus;
  /** Staff answer, plain text. */
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
}

export interface FeedbackPage {
  data: FeedbackItem[];
  total: number;
}

export interface FeedbackSubmit {
  type: FeedbackType;
  message: string;
  pagePath?: string;
  locale?: string;
}

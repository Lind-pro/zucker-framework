import { accountPublicClient, httpClient } from '@/lib/http-client';
import type { FeedbackItem, FeedbackPage, FeedbackSubmit } from './types';

/** Errors are explained inline by the page; never a global toast. */
const quiet = { _hideError: true } as const;

export const feedbackApi = {
  submit: (body: FeedbackSubmit, idempotencyKey: string) =>
    httpClient.post<FeedbackItem>('/feedback', body, undefined, { ...quiet, headers: { 'Idempotency-Key': idempotencyKey } }),
  mine: (query: { page?: number; pageSize?: number } = {}, signal?: AbortSignal) =>
    httpClient.get<FeedbackPage>('/feedback/mine', query, { ...quiet, signal }),
  /** Public policy projection; only `feedback.enabled` is read from it. */
  publicConfig: () => accountPublicClient.get<unknown>('/site/public/config', undefined, quiet),
};

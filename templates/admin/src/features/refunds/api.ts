import httpClient from '@/lib/http-client';
import type {
  RefundCycle,
  RefundPage,
  RefundState,
  RefundTarget,
  RefundTargetType,
  RefundView,
} from './types';
export const refundsApi = {
  list: (page: number, state?: RefundState) =>
    httpClient.get<RefundPage<RefundView>>('/billing/refunds', {
      page,
      ...(state ? { state } : {}),
    }),
  recover: (key: string) =>
    httpClient.get<RefundView>(`/billing/refunds/requests/${encodeURIComponent(key)}`),
  detail: (id: string) => httpClient.get<RefundView>(`/billing/refunds/${encodeURIComponent(id)}`),
  check: (id: string) =>
    httpClient.post<RefundView>(`/billing/refunds/${encodeURIComponent(id)}/check`, {}),
  target: (type: RefundTargetType, id: string) =>
    httpClient.get<RefundTarget>(`/billing/refunds/targets/${type}/${encodeURIComponent(id)}`),
  checkTarget: (type: RefundTargetType, id: string) =>
    httpClient.post<RefundTarget>(
      `/billing/refunds/targets/${type}/${encodeURIComponent(id)}/check`,
      {},
    ),
  create: (
    body: { targetType: RefundTargetType; targetId: string; amount: string; reason?: string },
    key: string,
  ) =>
    httpClient.post<RefundView>('/billing/refunds', body, undefined, {
      headers: { 'Idempotency-Key': key },
    }),
  cycles: (id: string, page: number) =>
    httpClient.get<RefundPage<RefundCycle>>(
      `/billing/refunds/subscriptions/${encodeURIComponent(id)}/cycles`,
      { page },
    ),
};

import { httpClient } from '@/lib/http-client';
import type { FilePage, PrivateFile } from '@/features/files/types';
import type { AICatalog, AIMediaKind, AITaskStatus, AITaskSubmit, AITaskView, CursorPage, OutputTicket } from './types';

const id = (value: string) => encodeURIComponent(value);
/** Errors are explained inline by the pages; never a global toast. */
const quiet = { _hideError: true } as const;

export const aiApi = {
  catalog: () => httpClient.get<AICatalog>('/ai/catalog', undefined, quiet),
  submit: (body: AITaskSubmit, idempotencyKey: string) =>
    httpClient.post<AITaskView>('/ai/tasks', body, undefined, { ...quiet, headers: { 'Idempotency-Key': idempotencyKey } }),
  list: (query: { limit?: number; before?: string; kind?: AIMediaKind; status?: AITaskStatus }, signal?: AbortSignal) =>
    httpClient.get<CursorPage<AITaskView>>('/ai/tasks', query, { ...quiet, signal }),
  get: (taskId: string, signal?: AbortSignal) => httpClient.get<AITaskView>(`/ai/tasks/${id(taskId)}`, undefined, { ...quiet, signal }),
  cancel: (taskId: string) => httpClient.post<AITaskView>(`/ai/tasks/${id(taskId)}/cancel`, {}, undefined, quiet),
  outputTicket: (taskId: string, index: number) =>
    httpClient.get<OutputTicket>(`/ai/tasks/${id(taskId)}/outputs/${index}`, undefined, quiet),
  balance: () => httpClient.get<{ available?: unknown }>('/credits/balance', undefined, quiet).then(value =>
    typeof value?.available === 'number' && Number.isFinite(value.available) ? value.available : null),
};

/** Reference images the server accepts: the caller's own ready PNG/JPEG files up to 4 MiB. */
export const REFERENCE_MAX_BYTES = 4 * 1024 * 1024;
export function isReferenceCandidate(file: PrivateFile): boolean {
  return file.state === 'ready' && ['image/png', 'image/jpeg'].includes(file.mimeType) && file.size > 0 && file.size <= REFERENCE_MAX_BYTES;
}
export async function referenceCandidates(): Promise<PrivateFile[]> {
  const page = await httpClient.get<FilePage>('/files', { page: 1 }, quiet);
  return (page?.data ?? []).filter(isReferenceCandidate);
}

export { CREDITS_CHANGED_EVENT, announceCreditsChanged } from '@/lib/site/credit-events';

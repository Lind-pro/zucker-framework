/**
 * Maps API failures to the few outcomes the AI and chat pages explain. Works with errors from
 * `httpClient` and `fetchStream` (both carry `status`, `code` and `response.data`). Only `AI_*`
 * codes from the server are trusted; transport codes (ERR_*) are ignored. Pure: node tests load it.
 */
export type AIFailureKind =
  | 'credits'
  | 'costChanged'
  | 'conflict'
  | 'busy'
  | 'notOffered'
  | 'reference'
  | 'invalid'
  | 'notFound'
  | 'rateLimited'
  | 'unavailable'
  | 'providerFailed'
  | 'uncertain';

export function failureInfo(error: unknown): { status?: number; code?: string } {
  const value = (error ?? {}) as { status?: unknown; _httpStatus?: unknown; code?: unknown; response?: { data?: { code?: unknown } } };
  const status = typeof value.status === 'number' ? value.status : typeof value._httpStatus === 'number' ? value._httpStatus : undefined;
  const raw = value.response?.data?.code ?? value.code;
  const code = typeof raw === 'string' && /^AI_[A-Z_]{1,60}$/.test(raw) ? raw : undefined;
  return { status, code };
}

export function aiFailureKind(error: unknown): AIFailureKind {
  const { status, code } = failureInfo(error);
  if (code === 'AI_TASK_INSUFFICIENT_CREDITS' || status === 402) return 'credits';
  if (code === 'AI_TASK_COST_CHANGED') return 'costChanged';
  if (code === 'AI_TASK_IDEMPOTENCY_CONFLICT') return 'conflict';
  if (code === 'AI_CHAT_BUSY') return 'busy';
  if (code === 'AI_MODEL_NOT_OFFERED') return 'notOffered';
  if (code === 'AI_TASK_REFERENCE_INVALID') return 'reference';
  if (code === 'AI_PROVIDER_UNAVAILABLE' || code === 'AI_CHAT_UNAVAILABLE' || status === 503) return 'unavailable';
  if (code === 'AI_PROVIDER_FAILED' || status === 502) return 'providerFailed';
  if (status === 409) return 'busy';
  if (status === 400 || status === 413) return 'invalid';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  return 'uncertain';
}

/**
 * Whether the server certainly did not create anything, so a new Idempotency-Key may be used for
 * the next submit. Network errors, 5xx and timeouts are uncertain: the same key is reused so a
 * retry can never start (and charge) a second task.
 */
export function isDefiniteRejection(error: unknown): boolean {
  const { status } = failureInfo(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

export interface SubmitAttempt {
  key: string;
  fingerprint: string;
}

/** Same request after an uncertain outcome keeps its key; any change of the request gets a new one. */
export function nextSubmitAttempt(
  previous: SubmitAttempt | null,
  fingerprint: string,
  createKey: () => string = () => `ai-${crypto.randomUUID()}`,
): SubmitAttempt {
  return previous && previous.fingerprint === fingerprint ? previous : { key: createKey(), fingerprint };
}

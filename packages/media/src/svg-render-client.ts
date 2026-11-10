export interface SvgRenderRequest {
  url: string;
  spec: Record<string, unknown>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  /** Response bodies larger than this are refused. Default 20 MiB. */
  maxResponseBytes?: number;
}

export const SVG_RENDER_DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * Read a response body as UTF-8 text, refusing bodies above `maxBytes` without
 * buffering more than that. Error bodies use the same bound.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SvgRenderRequestError('invalid_response', `response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SvgRenderRequestError('invalid_response', `response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export interface SvgRenderResponse<T> {
  data: T & { svg: string };
  durationMs: number;
}

export class SvgRenderRequestError extends Error {
  constructor(
    readonly stage: 'transport' | 'http' | 'invalid_response',
    readonly detail?: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(`SVG render request failed: ${stage}`, options);
    this.name = 'SvgRenderRequestError';
  }
}

/**
 * POST a structured render spec and require a nonempty SVG in the JSON response.
 * Endpoints, URL authorization and error presentation belong to the consumer.
 * Abort errors retain their identity; HTTP error detail is bounded to 300 chars.
 */
export async function requestSvgRender<T extends Record<string, unknown>>({
  url,
  spec,
  signal,
  fetcher = fetch,
  maxResponseBytes = SVG_RENDER_DEFAULT_MAX_RESPONSE_BYTES,
}: SvgRenderRequest): Promise<SvgRenderResponse<T>> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SvgRenderRequestError('transport', undefined, undefined, { cause: error });
  }
  if (!response.ok) {
    throw new SvgRenderRequestError(
      'http',
      (await readBoundedResponseText(response, maxResponseBytes)).substring(0, 300),
      response.status,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(await readBoundedResponseText(response, maxResponseBytes));
  } catch (error) {
    if (error instanceof SvgRenderRequestError || signal?.aborted) throw error;
    throw new SvgRenderRequestError('invalid_response', 'response is not JSON', response.status, { cause: error });
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('svg' in data) ||
    typeof data.svg !== 'string' ||
    !data.svg
  ) {
    throw new SvgRenderRequestError('invalid_response');
  }
  return { data: data as T & { svg: string }, durationMs: Date.now() - startedAt };
}

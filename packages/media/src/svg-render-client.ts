export interface SvgRenderRequest {
  url: string;
  spec: Record<string, unknown>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
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
      (await response.text()).substring(0, 300),
      response.status,
    );
  }
  const data: unknown = await response.json();
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

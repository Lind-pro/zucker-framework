import {
  SVG_RENDER_DEFAULT_MAX_RESPONSE_BYTES,
  SvgRenderRequestError,
  readBoundedResponseText,
} from './svg-render-client';
import { normalizeMermaidSvgText } from './mermaid/svg-text';

export interface KrokiSvgRequest {
  url: string;
  source: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  /** Response bodies larger than this are refused. Default 20 MiB. */
  maxResponseBytes?: number;
}

/** Transport for an explicitly selected Kroki SVG endpoint. */
export async function requestKrokiSvg({
  url,
  source,
  signal,
  fetcher = fetch,
  maxResponseBytes = SVG_RENDER_DEFAULT_MAX_RESPONSE_BYTES,
}: KrokiSvgRequest): Promise<{ svg: string; durationMs: number }> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: source,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SvgRenderRequestError('transport', undefined, undefined, { cause: error });
  }
  const durationMs = Date.now() - startedAt;
  const svg = await readBoundedResponseText(response, maxResponseBytes);
  if (!response.ok) throw new SvgRenderRequestError('http', svg.substring(0, 300), response.status);
  return {
    svg: /(?:^|\/)mermaid\/svg(?:[?#]|$)/i.test(url) ? normalizeMermaidSvgText(svg) : svg,
    durationMs,
  };
}

import { SvgRenderRequestError } from './svg-render-client';
import { normalizeMermaidSvgText } from './mermaid/svg-text';

export interface KrokiSvgRequest {
  url: string;
  source: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

/** Transport for an explicitly selected Kroki SVG endpoint. */
export async function requestKrokiSvg({
  url,
  source,
  signal,
  fetcher = fetch,
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
  const svg = await response.text();
  if (!response.ok) throw new SvgRenderRequestError('http', svg.substring(0, 300), response.status);
  return {
    svg: /(?:^|\/)mermaid\/svg(?:[?#]|$)/i.test(url) ? normalizeMermaidSvgText(svg) : svg,
    durationMs,
  };
}

import { useEffect, useRef, useState } from 'react';
import type { FormDefinition } from './types';

interface State {
  definition: FormDefinition | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads a definition. Receives the encoded request path and an abort signal; may resolve either the
 * definition itself or the framework response envelope (`{ status, code, message, result }`).
 */
export type FormDefinitionFetcher = (url: string, signal?: AbortSignal) => Promise<unknown>;

export interface UseFormDefinitionOptions {
  /** Path prefix for the default request URL. Defaults to `/api`. */
  basePath?: string;
}

function isDefinition(value: unknown): value is FormDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<FormDefinition>;
  return typeof candidate.id === 'string' && Array.isArray(candidate.fields);
}

/**
 * Accepts a definition or a framework envelope carrying one in `result` (TransformInterceptor) or
 * `data`. Anything else is rejected so a malformed payload surfaces as a load error instead of a
 * render crash in `definition.fields.map`.
 */
export function unwrapFormDefinition(value: unknown): FormDefinition {
  if (isDefinition(value)) return value;
  if (value && typeof value === 'object') {
    const envelope = value as { result?: unknown; data?: unknown };
    if (isDefinition(envelope.result)) return envelope.result;
    if (isDefinition(envelope.data)) return envelope.data;
  }
  throw new Error('Invalid form definition response');
}

const defaultFetcher: FormDefinitionFetcher = (url, signal) =>
  fetch(url, { credentials: 'same-origin', signal }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  });

/**
 * Loads `GET {basePath}/form/definition/:id`.
 *
 * The server endpoint requires authentication (`JwtAuthGuard` + `form:query`), so pass an
 * authenticated `httpGet` (for example a fe-http-client `get` that attaches the bearer token).
 * The bare `fetch` fallback only works with cookie/session authentication on the same origin.
 * A response superseded by a newer `formId` (or by unmount) is ignored.
 */
export function useFormDefinition(
  formId?: string,
  httpGet?: FormDefinitionFetcher | ((url: string) => Promise<FormDefinition>),
  options: UseFormDefinitionOptions = {},
): State {
  const [state, setState] = useState<State>({ definition: null, loading: false, error: null });
  // Read the fetcher through a ref so an inline lambda does not re-trigger the request every render.
  const fetcherRef = useRef(httpGet);
  fetcherRef.current = httpGet;
  const basePath = (options.basePath ?? '/api').replace(/\/+$/, '');

  useEffect(() => {
    if (!formId) {
      setState({ definition: null, loading: false, error: null });
      return;
    }
    let active = true;
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    setState({ definition: null, loading: true, error: null });

    const fetcher = (fetcherRef.current ?? defaultFetcher) as FormDefinitionFetcher;
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(fetcher(`${basePath}/form/definition/${encodeURIComponent(formId)}`, controller?.signal));
    } catch (err) {
      request = Promise.reject(err);
    }
    request
      .then((value) => {
        if (active) setState({ definition: unwrapFormDefinition(value), loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : '未知错误';
        setState({ definition: null, loading: false, error: msg });
      });
    return () => {
      active = false;
      controller?.abort();
    };
  }, [formId, basePath]);

  return state;
}

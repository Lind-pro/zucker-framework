export interface ProxyHttpRequestOptions {
  /** Retry only transport failures of GET/HEAD requests; mutations are never replayed. */
  retryDelaysMs?: readonly number[];
  fetcher?: typeof fetch;
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds) as ReturnType<typeof setTimeout> & { unref?: () => void };
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}

/**
 * Forward a Web Request to a consumer-selected upstream without buffering its
 * response. The consumer owns URL selection and the final failure response.
 */
export async function proxyHttpRequest(
  request: Request,
  targetUrl: string,
  options: ProxyHttpRequestOptions = {},
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('host');
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  const body = isRead ? undefined : await request.arrayBuffer();
  const retryDelays = isRead ? (options.retryDelaysMs ?? []) : [];
  const fetcher = options.fetcher ?? fetch;

  let upstream: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      upstream = await fetcher(targetUrl, {
        method: request.method,
        headers,
        body: body?.byteLength ? body : undefined,
        signal: request.signal,
      });
      break;
    } catch (error) {
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined || request.signal.aborted) throw error;
      await waitForRetry(retryDelay, request.signal);
    }
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set('X-Accel-Buffering', 'no');
  responseHeaders.delete('transfer-encoding');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

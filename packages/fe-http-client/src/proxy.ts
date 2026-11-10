export interface ProxyHttpRequestOptions {
  /** Retry only transport failures of GET/HEAD requests; mutations are never replayed. */
  retryDelaysMs?: readonly number[];
  fetcher?: typeof fetch;
  /**
   * Client address taken from the trusted connection (e.g. the socket address, or the
   * header your own edge proxy overwrites). It is sent upstream as `X-Forwarded-For` /
   * `X-Real-IP`. Client-supplied forwarding headers are never forwarded as-is.
   */
  clientIp?: string;
  /**
   * Keep the incoming `X-Forwarded-For` chain and append `clientIp` to it. Enable this only
   * when every request reaches this proxy through an edge that overwrites the header.
   * Default false: the chain starts at this proxy.
   */
  trustForwardedFor?: boolean;
}

/** Hop-by-hop headers (RFC 9110 §7.6.1) and headers this proxy recomputes. */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** Client-controlled forwarding headers that would let a caller choose its own IP. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'cf-connecting-ip'];

function stripHopByHop(headers: Headers): void {
  const listed = headers.get('connection');
  if (listed) {
    for (const name of listed.split(',')) {
      const trimmed = name.trim();
      if (trimmed) headers.delete(trimmed);
    }
  }
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
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
  const incomingForwardedFor = headers.get('x-forwarded-for');
  headers.delete('host');
  headers.delete('content-length');
  stripHopByHop(headers);
  for (const name of FORWARDING_HEADERS) headers.delete(name);
  const clientIp = options.clientIp?.trim();
  const chain = [
    ...(options.trustForwardedFor && incomingForwardedFor ? [incomingForwardedFor] : []),
    ...(clientIp ? [clientIp] : []),
  ];
  if (chain.length) headers.set('x-forwarded-for', chain.join(', '));
  if (clientIp) headers.set('x-real-ip', clientIp);
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
  stripHopByHop(responseHeaders);
  // fetch() transparently decodes gzip/br/deflate bodies but keeps the upstream headers;
  // relabelling decoded bytes as compressed (or with the compressed length) breaks clients.
  const encoding = responseHeaders.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

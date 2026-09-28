export type SseEvent = {
  event: string;
  data: string;
  id?: string;
  retry?: number;
  isComment: boolean;
};

export type SseStreamOptions = {
  onEvent: (event: SseEvent) => void | boolean | Promise<void | boolean>;
  onChunk?: () => void;
  idleTimeoutMs?: number;
};

export type SseConnectionOptions = {
  url: string;
  headers?: Record<string, string>;
  onOpen?: (response: Response) => void | Promise<void>;
  onEvent?: (event: SseEvent) => void | boolean | Promise<void | boolean>;
  onError?: (error: Error) => void;
  openWhenHidden?: boolean;
  maxRetries?: number;
  initialRetryDelay?: number;
  maxRetryDelay?: number;
  fatalStatusCodes?: readonly number[];
  fetcher?: typeof fetch;
};

export function parseSseEventBlock(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return null;
  if (lines.every((line) => line === '' || line.startsWith(':'))) {
    return { event: '', data: '', isComment: true };
  }

  let event = 'message';
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex);
    const value = colonIndex < 0 ? '' : line.slice(colonIndex + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }

  if (dataLines.length === 0 && event === 'message' && !id && retry === undefined) {
    return null;
  }
  return { event, data: dataLines.join('\n'), id, retry, isComment: false };
}

export async function readSseStream(response: Response, options: SseStreamOptions): Promise<void> {
  if (!response.body) throw new Error('SSE response has no readable body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastChunkAt = Date.now();
  let idleError: Error | null = null;
  const idleTimeoutMs = options.idleTimeoutMs;
  const idleTimer = idleTimeoutMs
    ? setInterval(
        () => {
          if (Date.now() - lastChunkAt <= idleTimeoutMs || idleError) return;
          idleError = new Error(`SSE connection idle for ${idleTimeoutMs / 1_000}s`);
          void reader.cancel(idleError);
        },
        Math.min(5_000, idleTimeoutMs),
      )
    : null;

  const processBuffer = async (flush: boolean): Promise<boolean> => {
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary || boundary.index === undefined) break;
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const event = parseSseEventBlock(raw);
      if (event && (await options.onEvent(event)) === false) return false;
    }

    if (flush && buffer.trim()) {
      const event = parseSseEventBlock(buffer);
      buffer = '';
      if (event && (await options.onEvent(event)) === false) return false;
    }
    return true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (idleError) throw idleError;
        buffer += decoder.decode();
        await processBuffer(true);
        return;
      }
      lastChunkAt = Date.now();
      options.onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      if (!(await processBuffer(false))) {
        await reader.cancel();
        return;
      }
    }
  } catch (error) {
    // A parser/consumer failure must not leave the upstream connection running.
    // Cancellation failure cannot replace the original application error.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    if (idleTimer) clearInterval(idleTimer);
    reader.releaseLock();
  }
}

export function connectSse(options: SseConnectionOptions): { close: () => void } {
  const {
    url,
    headers,
    onOpen,
    onEvent,
    onError,
    openWhenHidden = false,
    maxRetries = Infinity,
    initialRetryDelay = 1_000,
    maxRetryDelay = 30_000,
    fatalStatusCodes = [401, 403, 404],
    fetcher = fetch,
  } = options;
  const fatalStatuses = new Set(fatalStatusCodes);
  const controller = new AbortController();
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    controller.abort();
    activeController?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (!openWhenHidden && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };

  const scheduleRetry = () => {
    if (closed || retryCount >= maxRetries) return;
    const delay = Math.min(initialRetryDelay * 2 ** retryCount, maxRetryDelay);
    retryCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void startConnection();
    }, delay);
  };

  const startConnection = async () => {
    if (closed) return;
    const connectionController = new AbortController();
    activeController = connectionController;
    const onGlobalAbort = () => connectionController.abort();
    controller.signal.addEventListener('abort', onGlobalAbort, { once: true });

    try {
      const response = await fetcher(url, {
        headers,
        signal: connectionController.signal,
      });
      if (!response.ok) {
        const error = new Error(`SSE connection failed (${response.status})`);
        onError?.(error);
        if (fatalStatuses.has(response.status)) cleanup();
        else scheduleRetry();
        return;
      }

      await onOpen?.(response);
      retryCount = 0;
      await readSseStream(response, {
        onEvent: async (event) => onEvent?.(event),
      });
      if (!closed) scheduleRetry();
    } catch (error) {
      if (closed || connectionController.signal.aborted) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
      scheduleRetry();
    } finally {
      controller.signal.removeEventListener('abort', onGlobalAbort);
      if (activeController === connectionController) activeController = null;
    }
  };

  function handleVisibilityChange() {
    if (closed || typeof document === 'undefined') return;
    if (document.hidden) {
      activeController?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    } else {
      retryCount = 0;
      void startConnection();
    }
  }

  if (!openWhenHidden && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  void startConnection();
  return { close: cleanup };
}

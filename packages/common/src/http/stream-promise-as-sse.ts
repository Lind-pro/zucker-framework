import type { Response } from 'express';

export interface StreamPromiseSseOptions<T> {
  task: (signal: AbortSignal, events: { emit(event: string, data: unknown): void }) => Promise<T>;
  heartbeatMs?: number;
  /** Optional caller budget. No deadline is imposed by default; task must honor cancellation. */
  hardTimeoutMs?: number;
  logger?: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  label?: string;
  /**
   * Maps a task failure to the client-visible `error` event payload. By default only
   * client errors (HTTP/business exceptions with a 4xx status) keep their message; any other
   * failure is reported as a generic message so provider/ORM diagnostics are not streamed out.
   */
  formatError?: (error: unknown) => { message: string } & Record<string, unknown>;
}

const GENERIC_SSE_ERROR = '服务器内部错误';

function clientSafeStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as { getStatus?: () => unknown; status?: unknown };
  const status = typeof candidate.getStatus === 'function' ? candidate.getStatus() : candidate.status;
  return typeof status === 'number' ? status : undefined;
}

function defaultSseError(error: unknown): { message: string; code?: string } {
  const status = clientSafeStatus(error);
  if (status !== undefined && status >= 400 && status < 500) {
    const code = (error as { code?: unknown }).code;
    return { message: (error as Error).message, ...(typeof code === 'string' ? { code } : {}) };
  }
  return { message: GENERIC_SSE_ERROR };
}

/** A one-result SSE response with progress events, heartbeat and cancellation. */
export async function streamPromiseAsSSE<T>(
  res: Response,
  options: StreamPromiseSseOptions<T>,
): Promise<void> {
  const { task, heartbeatMs = 5000, hardTimeoutMs, logger, label = 'sse' } = options;
  const abortController = new AbortController();
  const startedAt = Date.now();
  let disconnected = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const writable = () => !disconnected && !res.destroyed && !res.writableEnded;
  const clearTimers = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (hardTimer) clearTimeout(hardTimer);
  };
  const onClientClose = () => {
    disconnected = true;
    clearTimers();
    if (!res.writableEnded && !abortController.signal.aborted) {
      logger?.log(`[SSE:${label}] Client disconnected; cancelling task`);
      abortController.abort();
    }
  };
  const events = {
    emit: (event: string, data: unknown) => {
      if (!writable()) return;
      if (/[\r\n]/.test(event)) throw new Error('SSE event name must not contain line breaks');
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
  res.on('close', onClientClose);
  try {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    if (!writable()) return;
    res.write('retry: 5000\n\n');
    res.write(': connection established\n\n');
    heartbeatTimer = setInterval(() => {
      if (writable()) res.write(`: heartbeat ${Date.now() - startedAt}ms\n\n`);
    }, heartbeatMs);
    if (hardTimeoutMs && hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => {
        logger?.warn(`[SSE:${label}] Hard timeout (${hardTimeoutMs}ms); cancelling task`);
        timedOut = true;
        abortController.abort();
      }, hardTimeoutMs);
    }
    const result = await task(abortController.signal, events);
    if (!writable()) return;
    events.emit('result', result);
    logger?.log(`[SSE:${label}] Completed (${Date.now() - startedAt}ms)`);
  } catch (error) {
    if (!writable()) return;
    const message = error instanceof Error ? error.message : String(error);
    const payload = timedOut
      ? { message: 'aborted' }
      : (options.formatError ?? defaultSseError)(error);
    events.emit('error', payload);
    logger?.error(`[SSE:${label}] Task failed: ${message}`);
  } finally {
    clearTimers();
    res.off('close', onClientClose);
    if (writable()) res.end();
  }
}

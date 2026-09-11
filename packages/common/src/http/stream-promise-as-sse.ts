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
    events.emit('error', { message });
    logger?.error(`[SSE:${label}] Task failed: ${message}`);
  } finally {
    clearTimers();
    res.off('close', onClientClose);
    if (writable()) res.end();
  }
}

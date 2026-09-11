import type { Response } from 'express';

export interface SseSubscriptionSource<T> {
  subscribe(observer: {
    next: (payload: T) => void;
    error: (error: unknown) => void;
    complete: () => void;
  }): { unsubscribe(): void };
}

export interface SubscriptionSseOptions<T, TWire = T> {
  source?: SseSubscriptionSource<T>;
  snapshot?: () => T | Promise<T>;
  isTerminal: (payload: T) => boolean;
  shouldSend?: (payload: T, previous: T | undefined) => boolean;
  transform?: (payload: T) => TWire | Promise<TWire>;
  heartbeatMs?: number;
  heartbeatComment?: string;
  onError?: (error: unknown) => void;
}

/**
 * Attach SSE to an existing event source. Disconnect only disposes this
 * subscription; it never cancels durable work. Snapshot/event transforms are
 * serialized, and source completion cannot overtake an in-flight final event.
 * Resolves after initial snapshot delivery; the subscription owns later events.
 */
export async function streamSubscriptionAsSSE<T, TWire = T>(
  res: Response,
  options: SubscriptionSseOptions<T, TWire>,
): Promise<void> {
  let closed = false;
  let initialized = false;
  let sourceEnded = false;
  let previous: T | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let delivery = Promise.resolve();
  const writable = () => !closed && !res.destroyed && !res.writableEnded;
  const close = (end: boolean) => {
    const canEnd = writable();
    closed = true;
    subscription?.unsubscribe();
    subscription = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    res.off('close', onClientClose);
    if (end && canEnd) res.end();
  };
  const onClientClose = () => close(false);
  const fail = (error: unknown) => {
    close(true);
    try {
      options.onError?.(error);
    } catch {
      // Reporting must not reject a detached event handler after cleanup.
    }
  };
  const send = (payload: T) => {
    delivery = delivery
      .then(async () => {
        if (!writable() || options.shouldSend?.(payload, previous) === false) return;
        const wire = options.transform ? await options.transform(payload) : payload;
        if (!writable()) return;
        previous = payload;
        res.write(`data: ${JSON.stringify(wire)}\n\n`);
        if (options.isTerminal(payload)) close(true);
      })
      .catch(fail);
    return delivery;
  };
  const complete = () => {
    sourceEnded = true;
    if (initialized) delivery = delivery.then(() => close(true)).catch(fail);
  };

  res.on('close', onClientClose);
  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    if (!writable()) {
      close(false);
      return;
    }
    subscription = options.source?.subscribe({
      next: (payload) => {
        void send(payload);
      },
      error: fail,
      complete,
    });
    // Sources may synchronously error/close before subscribe returns its handle.
    if (closed) subscription?.unsubscribe();
    if (!closed && options.snapshot) await send(await options.snapshot());
    initialized = true;
    if (sourceEnded) complete();
    await delivery;
    if (writable() && options.heartbeatMs) {
      heartbeat = setInterval(() => {
        if (writable()) res.write(`: ${options.heartbeatComment ?? 'heartbeat'}\n\n`);
      }, options.heartbeatMs);
    }
  } catch (error) {
    fail(error);
  }
}

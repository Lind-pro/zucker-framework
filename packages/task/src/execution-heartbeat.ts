export class ExecutionHeartbeatError extends Error {
  constructor(
    readonly consecutiveFailures: number,
    options?: ErrorOptions,
  ) {
    super(`Execution heartbeat failed ${consecutiveFailures} consecutive times`, options);
    this.name = 'ExecutionHeartbeatError';
  }
}

export interface ExecutionHeartbeatOptions {
  signal?: AbortSignal;
  intervalMs: number;
  failureThreshold: number;
  heartbeat: () => Promise<void>;
}

/**
 * A single execution's heartbeat and cancellation scope. No lease, persistent
 * state transition or retry policy is implied. Heartbeats never overlap; the
 * final in-flight heartbeat settles before this scope returns. Work must honor
 * its signal, and a heartbeat abort cannot be reported as successful work.
 */
export async function runWithExecutionHeartbeat<T>(
  options: ExecutionHeartbeatOptions,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs <= 0 ||
    !Number.isSafeInteger(options.failureThreshold) ||
    options.failureThreshold < 1
  ) {
    throw new RangeError('Heartbeat interval and failure threshold must be positive');
  }
  const controller = new AbortController();
  let stopped = false;
  let failures = 0;
  let heartbeatFailure: ExecutionHeartbeatError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();

  const schedule = () => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      inFlight = tick();
    }, options.intervalMs);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped || controller.signal.aborted) return;
    try {
      await options.heartbeat();
      failures = 0;
    } catch (error) {
      if (!stopped && !controller.signal.aborted) {
        failures++;
        if (failures >= options.failureThreshold) {
          heartbeatFailure = new ExecutionHeartbeatError(failures, { cause: error });
          controller.abort(heartbeatFailure);
        }
      }
    } finally {
      schedule();
    }
  };

  try {
    controller.signal.throwIfAborted();
    schedule();
    let result: T;
    try {
      result = await work(controller.signal);
    } catch (error) {
      throw heartbeatFailure ?? error;
    }
    if (heartbeatFailure) throw heartbeatFailure;
    controller.signal.throwIfAborted();
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await inFlight;
  }
}

/**
 * Subscriber errors are isolated by default: `DefaultTopicEventBus.publish()` logs them and keeps
 * dispatching, so fire-and-forget subscribers cannot break the publisher.
 *
 * A subscriber that must STOP the operation (e.g. entity validation in the PREPARE phase) marks its
 * error with {@link vetoEvent}. Marked errors abort dispatch and are re-thrown from `publish()`.
 */
export const EVENT_VETO = Symbol.for('zucker.event.veto');

/** Error type for vetoes that do not wrap an existing error. */
export class EventVetoError extends Error {
  readonly [EVENT_VETO] = true;
  constructor(message: string) {
    super(message);
    this.name = 'EventVetoError';
  }
}

/** Mark `error` so the event bus propagates it to the publisher. Returns the same error object. */
export function vetoEvent<E>(error: E): E extends Error ? E : EventVetoError {
  if (error instanceof Error) {
    Object.defineProperty(error, EVENT_VETO, { value: true, enumerable: false, configurable: true });
    return error as E extends Error ? E : EventVetoError;
  }
  return new EventVetoError(String(error)) as E extends Error ? E : EventVetoError;
}

/** Whether `error` was marked with {@link vetoEvent}. */
export function isEventVeto(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[EVENT_VETO] === true;
}

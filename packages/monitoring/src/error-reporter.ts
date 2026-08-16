/**
 * Vendor-neutral context attached to an error report.
 *
 * Applications should pass identifiers and low-cardinality diagnostics only.
 * Product text, prompts, credentials, and other sensitive payloads must be
 * removed by the application or provider adapter before transmission.
 */
export interface ErrorContext {
  requestId?: string;
  userId?: string;
  resourceId?: string;
  [key: string]: unknown;
}

export interface ErrorReporterUser {
  id: string;
  email?: string;
}

/** Stable Nest injection token, including when duplicate package copies exist. */
export const ERROR_REPORTER = Symbol.for('@zucker/monitoring/error-reporter');

/**
 * Provider-neutral error reporting port.
 *
 * Sentry, Datadog, Rollbar, or an internal collector belongs behind this port;
 * the framework intentionally does not depend on any vendor SDK.
 */
export interface ErrorReporter {
  captureException(error: unknown, context?: ErrorContext): void;
  captureMessage(message: string, context?: ErrorContext): void;
  setUser(user: ErrorReporterUser | null): void;
}

/** Safe default for disabled or unconfigured production integrations. */
export class NoopErrorReporter implements ErrorReporter {
  captureException(): void {}
  captureMessage(): void {}
  setUser(): void {}
}

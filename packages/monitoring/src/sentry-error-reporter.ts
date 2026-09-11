import { redactFields } from '@zucker-framework/core/privacy';
import type { ErrorContext, ErrorReporter, ErrorReporterUser } from './error-reporter';

export type SentryEvent = Record<string, unknown>;
export interface SentryScopeContext {
  tags?: Record<string, string>;
  user?: ErrorReporterUser | null;
  extra?: Record<string, unknown>;
}
export interface SentryScopePort {
  setTag(key: string, value: string): unknown;
  setUser(user: ErrorReporterUser | null): unknown;
  setExtra(key: string, value: unknown): unknown;
}
/** The adapter only relies on this subset of the optional Node SDK. */
export interface SentrySdkPort {
  init(options: {
    dsn: string;
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
    beforeSend(event: SentryEvent): SentryEvent | null;
  }): unknown;
  withScope(callback: (scope: SentryScopePort) => void): unknown;
  captureException(error: unknown): unknown;
  captureMessage(message: string): unknown;
  setUser(user: ErrorReporterUser | null): unknown;
}
export interface SentryErrorReporterOptions {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
  /** Application field/section selection; traversal never changes the source event. */
  redaction?: {
    fields: readonly string[];
    sections: readonly string[];
    replacement?: string;
  };
  beforeSend?: (event: SentryEvent) => SentryEvent | null;
  mapContext?: (context: ErrorContext, kind: 'exception' | 'message') => SentryScopeContext;
  loadSdk?: () => Promise<SentrySdkPort>;
  onUnavailable?: () => void;
  onInitialized?: () => void;
}

/** Configured once by the application. Importing monitoring does not load Sentry. */
export class SentryErrorReporter implements ErrorReporter {
  private sdk?: SentrySdkPort;
  private initializing?: Promise<void>;
  constructor(private readonly options: SentryErrorReporterOptions) {}

  onModuleInit(): Promise<void> {
    return (this.initializing ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    if (!this.options.dsn) {
      this.options.onUnavailable?.();
      return;
    }
    const sdk = await (this.options.loadSdk?.() ??
      import('@sentry/node').then((module) => module as unknown as SentrySdkPort));
    sdk.init({
      dsn: this.options.dsn,
      environment: this.options.environment,
      release: this.options.release,
      tracesSampleRate: this.options.tracesSampleRate,
      beforeSend: (event) => {
        const redaction = this.options.redaction;
        let safe = event;
        if (redaction) {
          safe = { ...event };
          for (const section of redaction.sections) {
            const value = event[section];
            if (value !== null && typeof value === 'object') {
              safe[section] = redactFields(value, redaction.fields, redaction.replacement);
            }
          }
        }
        return this.options.beforeSend ? this.options.beforeSend(safe) : safe;
      },
    });
    this.sdk = sdk;
    this.options.onInitialized?.();
  }

  captureException(error: unknown, context?: ErrorContext): void {
    const sdk = this.sdk;
    if (!sdk) return;
    sdk.withScope((scope) => {
      this.applyContext(scope, context, 'exception');
      sdk.captureException(error);
    });
  }

  captureMessage(message: string, context?: ErrorContext): void {
    const sdk = this.sdk;
    if (!sdk) return;
    sdk.withScope((scope) => {
      this.applyContext(scope, context, 'message');
      sdk.captureMessage(message);
    });
  }

  setUser(user: ErrorReporterUser | null): void {
    this.sdk?.setUser(user);
  }

  private applyContext(
    scope: SentryScopePort,
    context: ErrorContext | undefined,
    kind: 'exception' | 'message',
  ): void {
    if (!context) return;
    const mapped = this.options.mapContext?.(context, kind) ?? {
      tags: context.requestId ? { requestId: context.requestId } : undefined,
      user: context.userId ? { id: context.userId } : undefined,
    };
    for (const [key, value] of Object.entries(mapped.tags ?? {})) scope.setTag(key, value);
    if (mapped.user !== undefined) scope.setUser(mapped.user);
    for (const [key, value] of Object.entries(mapped.extra ?? {})) scope.setExtra(key, value);
  }
}

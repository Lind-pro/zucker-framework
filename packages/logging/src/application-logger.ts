import { ConsoleLogger, Inject, Injectable, Scope } from '@nestjs/common';
import { LogSanitizer } from './log-sanitizer';
import { WinstonLogSink } from './winston-log-sink';

const ROUTINE_NEST_STARTUP_CONTEXTS = new Set([
  'InstanceLoader',
  'NestApplication',
  'NestFactory',
  'RoutesResolver',
  'RouterExplorer',
]);
/** Per-injection context with a single shared transport/lifecycle owner. */
@Injectable({ scope: Scope.TRANSIENT })
export class ApplicationLogger extends ConsoleLogger {
  constructor(
    @Inject(WinstonLogSink) private readonly sink: WinstonLogSink,
    @Inject(LogSanitizer) private readonly logSanitizer: LogSanitizer,
  ) {
    super();
  }
  setContext(context: string) {
    const safeContext = this.logSanitizer.sanitizeText(context);
    super.setContext(safeContext);
    this.context = safeContext;
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    const { context, meta } = this.resolveArguments(optionalParams);
    const safeMessage = this.logSanitizer.sanitizeText(message);
    const safeMeta = this.toMetadata(meta);
    const level =
      (context && ROUTINE_NEST_STARTUP_CONTEXTS.has(context)) || safeMessage.startsWith('Mapped {')
        ? 'debug'
        : 'info';
    this.sink.write(level, safeMessage, {
      context: context || this.context,
      ...safeMeta,
    });
  }

  error(message: unknown, trace?: unknown, ...optionalParams: unknown[]) {
    const { context, meta } = this.resolveArguments(optionalParams);
    const safeMessage = this.logSanitizer.sanitizeText(message);
    const safeTrace = trace ? this.logSanitizer.sanitizeText(trace) : undefined;
    const safeMeta = this.toMetadata(meta);
    this.sink.write('error', safeMessage, {
      context: context || this.context,
      trace: safeTrace,
      ...safeMeta,
    });
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    const { context, meta } = this.resolveArguments(optionalParams);
    const safeMessage = this.logSanitizer.sanitizeText(message);
    const safeMeta = this.toMetadata(meta);
    this.sink.write('warn', safeMessage, {
      context: context || this.context,
      ...safeMeta,
    });
  }

  debug(message: unknown, ...optionalParams: unknown[]) {
    const { context, meta } = this.resolveArguments(optionalParams);
    const safeMessage = this.logSanitizer.sanitizeText(message);
    const safeMeta = this.toMetadata(meta);
    this.sink.write('debug', safeMessage, {
      context: context || this.context,
      ...safeMeta,
    });
  }

  verbose(message: unknown, ...optionalParams: unknown[]) {
    const { context, meta } = this.resolveArguments(optionalParams);
    const safeMessage = this.logSanitizer.sanitizeText(message);
    const safeMeta = this.toMetadata(meta);
    this.sink.write('verbose', safeMessage, {
      context: context || this.context,
      ...safeMeta,
    });
  }

  private resolveArguments(optionalParams: unknown[]): {
    context?: string;
    meta: unknown[];
  } {
    const last = optionalParams.at(-1);
    if (typeof last !== 'string') {
      return { meta: optionalParams };
    }
    return {
      context: this.logSanitizer.sanitizeText(last),
      meta: optionalParams.slice(0, -1),
    };
  }

  private toMetadata(meta: unknown[]): Record<string, unknown> {
    if (meta.length === 0) return {};
    const safeMeta = this.logSanitizer.sanitizeValue(meta);
    if (
      safeMeta.length === 1 &&
      safeMeta[0] !== null &&
      typeof safeMeta[0] === 'object' &&
      !Array.isArray(safeMeta[0])
    ) {
      return safeMeta[0] as Record<string, unknown>;
    }
    return { metadata: safeMeta };
  }
}

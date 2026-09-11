import Transport, { type TransportStreamOptions } from 'winston-transport';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { LogSanitizer } from './log-sanitizer';

export interface DatabaseLogTransportOptions extends TransportStreamOptions {
  database: DatabaseAdapter;
  model?: string;
  sanitizer?: LogSanitizer;
}
/** Best-effort system logging, with callbacks awaiting persistence so shutdown can drain. */
export class DatabaseLogTransport extends Transport {
  private readonly sanitizer: LogSanitizer;
  constructor(private readonly options: DatabaseLogTransportOptions) {
    super(options);
    this.sanitizer = options.sanitizer ?? new LogSanitizer();
  }
  log(info: Record<string, unknown>, callback: () => void) {
    void this.persist(info).finally(callback);
  }
  private async persist(info: Record<string, unknown>) {
    try {
      const { level, message, context, timestamp, ...metadata } = info;
      const date = new Date((timestamp as string | number | Date) ?? Date.now());
      const safeMetadata = JSON.parse(
        JSON.stringify(this.sanitizer.sanitizeValue(metadata), (_key, value: unknown) => {
          if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
          if (typeof value === 'function') return '[Function]';
          return value;
        }),
      );
      await this.options.database.model(this.options.model ?? 'systemLog').create({
        data: {
          level: typeof level === 'string' ? level : 'info',
          message: this.sanitizer.sanitizeText(message),
          context: this.sanitizer.sanitizeText(context || 'Default'),
          timestamp: Number.isFinite(date.getTime()) ? date : new Date(),
          metadata: Object.keys(safeMetadata).length ? safeMetadata : undefined,
        },
      });
      this.emit('logged', info);
    } catch (error) {
      // Do not feed transport failures back through the same logger.
      process.stderr.write(
        `[DatabaseLogTransport] ${this.sanitizer.sanitizeText(error instanceof Error ? error.message : error)}\n`,
      );
    }
  }
}

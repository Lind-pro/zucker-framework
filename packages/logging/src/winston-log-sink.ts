import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createLogger, format, transports, type Logger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { DatabaseLogTransport } from './database-log-transport';
import { LogSanitizer } from './log-sanitizer';

export interface WinstonLogSinkOptions {
  level?: string;
  database?: { adapter: DatabaseAdapter; model?: string; level?: string };
  files?: { directory: string; maxSize?: string; maxFiles?: string };
  colorize?: boolean;
}
@Injectable()
export class WinstonLogSink implements OnModuleDestroy {
  readonly logger: Logger;
  private closing?: Promise<void>;
  private acceptingWrites = true;
  constructor(options: WinstonLogSinkOptions, private readonly sanitizer: LogSanitizer) {
    const render = format.printf(
      ({ timestamp, level, message, context, ...meta }) =>
        `${timestamp} [${level.toUpperCase()}] [${context || 'Default'}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)) : ''}`,
    );
    const configured: Logger['transports'] = [
      new transports.Console({
        format: format.combine(
          ...(options.colorize !== false ? [format.colorize()] : []),
          format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          render,
        ),
      }),
    ];
    if (options.database)
      configured.push(
        new DatabaseLogTransport({
          database: options.database.adapter,
          model: options.database.model,
          level: options.database.level ?? 'warn',
          sanitizer,
        }),
      );
    if (options.files)
      for (const [filename, level] of [
        ['application', 'info'],
        ['error', 'error'],
      ])
        configured.push(
          new DailyRotateFile({
            dirname: options.files.directory,
            filename: `${filename}-%DATE%.log`,
            datePattern: 'YYYY-MM-DD',
            maxSize: options.files.maxSize ?? '20m',
            maxFiles: options.files.maxFiles ?? '14d',
            level,
          }),
        );
    const level = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'].includes(
      options.level ?? '',
    )
      ? options.level
      : 'info';
    this.logger = createLogger({
      level,
      format: format.combine(format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), render),
      transports: configured,
    });
  }

  write(level: string, message: string, metadata: Record<string, unknown>): void {
    if (this.acceptingWrites) {
      this.logger.log(level, message, metadata);
      return;
    }
    // Nest can report another provider's shutdown failure after this sink has
    // ended. Preserve that diagnostic without reopening transports or writing
    // into Winston's closed stream, and keep the same redaction boundary.
    if (!this.logger.isLevelEnabled(level)) return;
    const diagnostic = JSON.stringify(
      this.sanitizer.sanitizeValue({ ...metadata, level, message }),
      (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
    );
    process.stderr.write(
      `[WinstonLogSink:shutdown] ${diagnostic}\n`,
    );
  }

  onModuleDestroy(): Promise<void> {
    this.acceptingWrites = false;
    return (this.closing ??= new Promise((resolve) => {
      this.logger.once('finish', () => {
        this.logger.close();
        resolve();
      });
      this.logger.end();
    }));
  }
}

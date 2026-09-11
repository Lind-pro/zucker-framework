import { createHash } from 'node:crypto';
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';

export interface TrackedError {
  id: string;
  message: string;
  stack?: string;
  category: string;
  count: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
  metadata?: Record<string, unknown>;
}

export interface ErrorTrackerOptions {
  /** Fixed aggregation window from the first occurrence; omitted retains existing unbounded history. */
  retentionMs?: number;
  logEntries?: boolean;
  fingerprint?: (error: Error, category: string, metadata?: Record<string, unknown>) => string;
  sanitizeText?: (value: string) => string;
  sanitizeMetadata?: (value: Record<string, unknown>) => Record<string, unknown>;
  onNewError?: (error: Error, record: TrackedError) => void;
}
export const ERROR_TRACKER_OPTIONS = Symbol('ERROR_TRACKER_OPTIONS');

/** Fingerprint without retaining raw stack locations or request paths as cache keys. */
export function errorFingerprint(error: Error, endpoint = ''): string {
  return createHash('sha256')
    .update(
      [error.name, error.message, error.stack?.split('\n')[1]?.trim() ?? '', endpoint].join('::'),
    )
    .digest('hex');
}

@Injectable()
export class ErrorTracker {
  private readonly logger = new Logger(ErrorTracker.name);
  private errors = new Map<string, TrackedError>();
  private counter = 0;
  constructor(
    @Optional() @Inject(ERROR_TRACKER_OPTIONS) private readonly options: ErrorTrackerOptions = {},
  ) {
    if (
      options.retentionMs !== undefined &&
      (!Number.isFinite(options.retentionMs) || options.retentionMs <= 0)
    )
      throw new Error('Invalid error retention window');
  }
  private prune(): void {
    if (this.options.retentionMs === undefined) return;
    const cutoff = Date.now() - this.options.retentionMs;
    for (const [key, record] of this.errors)
      if (record.firstOccurrence.getTime() <= cutoff) this.errors.delete(key);
  }

  track(error: Error, category = 'unknown', metadata?: Record<string, unknown>): void {
    this.prune();
    const key =
      this.options.fingerprint?.(error, category, metadata) ?? `${category}:${error.message}`;
    const safeMetadata = metadata
      ? (this.options.sanitizeMetadata?.(metadata) ?? metadata)
      : undefined;
    const existing = this.errors.get(key);

    if (existing) {
      existing.count++;
      existing.lastOccurrence = new Date();
      if (safeMetadata) {
        existing.metadata = { ...existing.metadata, ...safeMetadata };
      }
    } else {
      const record: TrackedError = {
        id: `err_${++this.counter}`,
        message: this.options.sanitizeText?.(error.message) ?? error.message,
        stack: error.stack ? (this.options.sanitizeText?.(error.stack) ?? error.stack) : undefined,
        category,
        count: 1,
        firstOccurrence: new Date(),
        lastOccurrence: new Date(),
        metadata: safeMetadata,
      };
      this.errors.set(key, record);
      this.options.onNewError?.(error, record);
    }

    if (this.options.logEntries !== false) {
      const record = this.errors.get(key)!;
      this.logger.warn(`[${category}] ${record.message} (count: ${record.count})`);
    }
  }

  getErrors(): TrackedError[] {
    this.prune();
    return Array.from(this.errors.values());
  }

  getErrorsByCategory(category: string): TrackedError[] {
    return this.getErrors().filter((e) => e.category === category);
  }

  getTopErrors(limit = 10): TrackedError[] {
    return this.getErrors()
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  clear(): void {
    this.errors.clear();
  }

  clearCategory(category: string): void {
    for (const [key, error] of this.errors) {
      if (error.category === category) {
        this.errors.delete(key);
      }
    }
  }
}

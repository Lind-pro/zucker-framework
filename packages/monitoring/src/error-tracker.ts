import { Injectable, Logger } from '@nestjs/common';

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

@Injectable()
export class ErrorTracker {
  private readonly logger = new Logger(ErrorTracker.name);
  private errors = new Map<string, TrackedError>();
  private counter = 0;

  track(error: Error, category = 'unknown', metadata?: Record<string, unknown>): void {
    const key = `${category}:${error.message}`;
    const existing = this.errors.get(key);

    if (existing) {
      existing.count++;
      existing.lastOccurrence = new Date();
      if (metadata) {
        existing.metadata = { ...existing.metadata, ...metadata };
      }
    } else {
      this.errors.set(key, {
        id: `err_${++this.counter}`,
        message: error.message,
        stack: error.stack,
        category,
        count: 1,
        firstOccurrence: new Date(),
        lastOccurrence: new Date(),
        metadata,
      });
    }

    this.logger.warn(`[${category}] ${error.message} (count: ${this.errors.get(key)!.count})`);
  }

  getErrors(): TrackedError[] {
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

import { PiiFilter, type PiiFilterOptions } from './pii-filter';

/** Serialization and redaction shared by persistent log writers. */
export class LogSanitizer {
  private readonly filter: PiiFilter;

  constructor(options: PiiFilterOptions = {}) {
    this.filter = new PiiFilter(options);
  }

  sanitizeText(value: unknown): string {
    if (typeof value === 'string') return this.filter.sanitize(value);
    const sanitized = this.filter.sanitizeValue(value);
    try {
      return this.filter.sanitize(JSON.stringify(sanitized) ?? String(sanitized));
    } catch {
      return this.filter.sanitize(String(sanitized));
    }
  }

  sanitizeValue<T>(value: T): T {
    return this.filter.sanitizeValue(value) as T;
  }
}

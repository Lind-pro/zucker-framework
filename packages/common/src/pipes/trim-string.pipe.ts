import { PipeTransform, Injectable } from '@nestjs/common';

const MAX_DEPTH = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Pipe that recursively trims whitespace from string values in plain objects and arrays.
 * Arrays stay arrays; Dates, Buffers, class instances and other non-plain values are kept as-is.
 */
@Injectable()
export class TrimStringPipe implements PipeTransform {
  transform(value: unknown) {
    return this.trim(value, 0);
  }

  private trim(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return value.trim();
    if (depth >= MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map((item) => this.trim(item, depth + 1));
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = this.trim(item, depth + 1);
      return result;
    }
    return value;
  }
}

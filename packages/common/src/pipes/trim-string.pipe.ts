import { PipeTransform, Injectable } from '@nestjs/common';

/** Pipe that recursively trims whitespace from all string values in the input. */
@Injectable()
export class TrimStringPipe implements PipeTransform {
  transform(value: unknown) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && value !== null) {
      return this.trimObject(value as Record<string, unknown>);
    }
    return value;
  }

  private trimObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = typeof value === 'string' ? value.trim() : value;
    }
    return result;
  }
}

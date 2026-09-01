import { createHash } from 'node:crypto';

function serialize(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Task fingerprint input cannot contain non-finite numbers');
      }
      return JSON.stringify(value);
    case 'undefined':
      return undefined;
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Task fingerprint input cannot contain ${typeof value}`);
    case 'object':
      break;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (seen.has(value))
    throw new TypeError('Task fingerprint input cannot contain circular references');
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serialize(entry, seen) ?? 'null').join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Task fingerprint input must contain only JSON-compatible objects');
    }

    const entries = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const serialized = serialize((value as Record<string, unknown>)[key], seen);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** Produces a deterministic SHA-256 fingerprint for a JSON-compatible task request. */
export function createTaskFingerprint(value: unknown): string {
  const canonical = serialize(value, new Set());
  if (canonical === undefined) {
    throw new TypeError('Task fingerprint input cannot be undefined');
  }
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

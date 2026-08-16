const sensitiveKey =
  /prompt|messages?|content|document|claims?|specification|technicaldescription|apikey|access.?token|secret|password|email|phone|rawinput|rawoutput/i;
const MAX_STRING_LENGTH = 280;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 4;

export function sanitizeAIObserverMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return sanitizeObject(metadata, 0, new WeakSet());
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (seen.has(value)) return { circular: '[REDACTED]' };
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = sensitiveKey.test(key) ? '[REDACTED]' : sanitizeValue(child, depth + 1, seen);
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((child) => sanitizeValue(child, depth + 1, seen));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>, depth, seen);
  }
  return `[${typeof value}]`;
}

export function sanitizeAIObserverError(error: Error): Error {
  const sanitized = new Error(error.message.slice(0, MAX_STRING_LENGTH));
  sanitized.name = error.name;
  return sanitized;
}

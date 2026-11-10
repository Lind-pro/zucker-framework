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

/** Credential shapes that providers echo back in error text. All patterns are linear. */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi,
      '$1[REDACTED]',
    );
}

export function sanitizeAIObserverError(error: Error): Error {
  // Truncate first so redaction work is bounded; every pattern is linear (no nested quantifiers).
  const sanitized = new Error(redactSecrets(error.message.slice(0, MAX_STRING_LENGTH)));
  sanitized.name = error.name;
  return sanitized;
}

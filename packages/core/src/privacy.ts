/** Redact explicitly selected keys throughout JSON-like data without mutating the input. */
export function redactFields<T>(
  value: T,
  sensitiveFields: readonly string[],
  replacement = '[Redacted]',
): T {
  const fields = new Set(sensitiveFields);
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.map(visit);
    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => [
        key,
        fields.has(key) ? replacement : visit(child),
      ]),
    );
  };
  return visit(value) as T;
}

export interface ExtractErrorMessageOptions {
  fallback: string;
  separator?: string;
}

/** Prefer a server response message over the transport error, preserving nonempty string values. */
export function extractErrorMessage(
  error: unknown,
  { fallback, separator = '; ' }: ExtractErrorMessageOptions,
): string {
  const normalize = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
      const messages = value.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
      if (messages.length > 0) return messages.join(separator);
    }
    return null;
  };
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const source = error as {
      message?: unknown;
      response?: { data?: { message?: unknown } };
    };
    return normalize(source.response?.data?.message) ?? normalize(source.message) ?? fallback;
  }
  return fallback;
}

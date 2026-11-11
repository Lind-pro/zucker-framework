/**
 * Logical model key → adapter model name (the name passed to `DatabaseAdapter.model()` or, for raw
 * SQL, resolved to a table through the host's mapping). Hosts never hard-code a model or table name;
 * they declare defaults and let the consumer rename any of them.
 */
export type ModelNames<K extends string> = Readonly<Record<K, string>>;

const MODEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Merge a host's default model names with consumer overrides. Unknown keys and non-identifier
 * names are rejected at module construction, so a typo fails at startup instead of at first query,
 * and a mapped name can be quoted safely as an SQL identifier.
 */
export function resolveModelNames<K extends string>(
  host: string,
  defaults: ModelNames<K>,
  overrides: Partial<Record<K, string>> | undefined,
): ModelNames<K> {
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new TypeError(`[back-office/${host}] models must be an object of model names`);
  }
  const resolved: Record<string, string> = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      throw new TypeError(`[back-office/${host}] unknown model key "${key}"`);
    }
    if (value === undefined) continue;
    if (typeof value !== 'string' || !MODEL_NAME.test(value)) {
      throw new TypeError(`[back-office/${host}] model "${key}" must be an identifier, got "${String(value)}"`);
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved) as ModelNames<K>;
}

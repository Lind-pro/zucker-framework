/**
 * ValueObject — 类型化属性访问
 * 参考: jetlinks ValueObject.java
 */

/**
 * Type-safe wrapper for accessing properties from a plain object.
 * Provides typed getters with optional default values.
 *
 * @example
 * ```ts
 * const vo = ValueObject.of({ name: 'Alice', age: '30' });
 * vo.getString('name'); // 'Alice'
 * vo.getInt('age');     // 30
 * ```
 */
export class ValueObject {
  constructor(private readonly values: Record<string, unknown>) {}

  /**
   * Create a ValueObject from a plain record.
   * @param values - The underlying key-value map
   * @returns A new ValueObject instance
   */
  static of(values: Record<string, unknown>): ValueObject {
    return new ValueObject(values);
  }

  /**
   * Get a raw value by key.
   * @param key - The property name
   * @returns The value, or undefined if not present
   */
  get(key: string): unknown | undefined {
    return this.values[key];
  }

  /**
   * Get a string value by key, with optional default.
   * @param key - The property name
   * @param defaultValue - Fallback value if the key is missing or null
   * @returns The string value, or the default
   */
  getString(key: string, defaultValue?: string): string | undefined {
    const val = this.values[key];
    if (val === undefined || val === null) return defaultValue;
    return String(val);
  }

  /**
   * Get an integer value by key, parsing from string if necessary.
   * @param key - The property name
   * @param defaultValue - Fallback value if parsing fails or key is missing
   * @returns The integer value, or the default
   */
  getInt(key: string, defaultValue?: number): number | undefined {
    const val = this.values[key];
    if (val === undefined || val === null) return defaultValue;
    const n = typeof val === 'number' ? Math.trunc(val) : parseInt(String(val), 10);
    return Number.isNaN(n) ? defaultValue : n;
  }

  /**
   * Get a floating-point number by key, parsing from string if necessary.
   * @param key - The property name
   * @param defaultValue - Fallback value if parsing fails or key is missing
   * @returns The number value, or the default
   */
  getNumber(key: string, defaultValue?: number): number | undefined {
    const val = this.values[key];
    if (val === undefined || val === null) return defaultValue;
    const n = typeof val === 'number' ? val : parseFloat(String(val));
    return Number.isNaN(n) ? defaultValue : n;
  }

  /**
   * Get a boolean value by key, parsing 'true'/'1'/'yes' as true.
   * @param key - The property name
   * @param defaultValue - Fallback value if parsing fails or key is missing
   * @returns The boolean value, or the default
   */
  getBoolean(key: string, defaultValue?: boolean): boolean | undefined {
    const val = this.values[key];
    if (val === undefined || val === null) return defaultValue;
    if (typeof val === 'boolean') return val;
    const s = String(val).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    return defaultValue;
  }

  /**
   * Get a Date value by key, parsing from string or number if necessary.
   * @param key - The property name
   * @returns The Date value, or undefined if not parseable
   */
  getDate(key: string): Date | undefined {
    const val = this.values[key];
    if (val === undefined || val === null) return undefined;
    if (val instanceof Date) return val;
    const d = new Date(val as string | number);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  /**
   * Get an array value by key.
   * @param key - The property name
   * @returns The array value, or an empty array if not an array
   */
  getArray<T = unknown>(key: string): T[] {
    const val = this.values[key];
    if (Array.isArray(val)) return val as T[];
    return [];
  }

  /**
   * Get a nested object value by key.
   * @param key - The property name
   * @returns The object value, or undefined if not a plain object
   */
  getObject<T = Record<string, unknown>>(key: string): T | undefined {
    const val = this.values[key];
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) return val as T;
    return undefined;
  }

  /**
   * Get a value by key, throwing if missing or null.
   * @param key - The property name
   * @returns The value
   * @throws Error if the value is null or undefined
   */
  getOrThrow(key: string): unknown {
    const val = this.values[key];
    if (val === undefined || val === null) {
      throw new Error(`Required value "${key}" is missing`);
    }
    return val;
  }

  /**
   * Check if a non-null, non-undefined value exists for the key.
   * @param key - The property name
   * @returns True if the value is present and non-null
   */
  has(key: string): boolean {
    return this.values[key] !== undefined && this.values[key] !== null;
  }

  /**
   * Convert to a plain record (shallow copy).
   * @returns A shallow copy of the underlying values
   */
  toRecord(): Record<string, unknown> {
    return { ...this.values };
  }
}

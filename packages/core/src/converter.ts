/**
 * 类型转换系统
 * 参考: hsweb-framework Converter.java, FastBeanCopier.DefaultConverter
 *
 * 对比 hsweb DefaultConverter:
 * - 增加 null 处理（hsweb convert(null) 返回 null）
 * - 增加 boolean->number 和 date->number 转换
 * - 增加数组/集合类型转换（string->array 以逗号分隔）
 * - ConverterRegistry 增加 unregister 和 has 方法
 */

/**
 * Type converter interface for converting between source and target types.
 * @template S - Source type
 * @template T - Target type
 */
export interface Converter<S = unknown, T = unknown> {
  /**
   * Convert a source value to the target type.
   * @param source - The value to convert
   * @returns The converted value
   */
  convert(source: S): T;
}

type ConverterKey = string;

function makeKey(sourceType: string, targetType: string): ConverterKey {
  return `${sourceType}->${targetType}`;
}

class ConverterRegistryImpl {
  private readonly converters = new Map<ConverterKey, Converter>();

  register<S, T>(sourceType: string, targetType: string, converter: Converter<S, T>): void {
    this.converters.set(makeKey(sourceType, targetType), converter as Converter);
  }

  unregister(sourceType: string, targetType: string): boolean {
    return this.converters.delete(makeKey(sourceType, targetType));
  }

  has(sourceType: string, targetType: string): boolean {
    return this.converters.has(makeKey(sourceType, targetType));
  }

  get(sourceType: string, targetType: string): Converter | undefined {
    return this.converters.get(makeKey(sourceType, targetType));
  }

  convert<T>(value: unknown, targetType: string): T {
    // 参考 hsweb: if (source == null) return null;
    if (value === null || value === undefined) {
      return value as unknown as T;
    }

    const sourceType = detectType(value);
    if (sourceType === targetType) return value as T;

    const converter = this.get(sourceType, targetType);
    if (converter) return converter.convert(value) as T;

    // fallback: try any->targetType
    const anyConverter = this.get('any', targetType);
    if (anyConverter) return anyConverter.convert(value) as T;

    throw new Error(`No converter registered for ${sourceType} -> ${targetType}`);
  }
}

function detectType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  return 'any';
}

export const ConverterRegistry = new ConverterRegistryImpl();

// ---- Built-in converters ----

// string -> number
ConverterRegistry.register<string, number>('string', 'number', {
  convert(source: string): number {
    const n = Number(source);
    if (Number.isNaN(n)) throw new Error(`Cannot convert "${source}" to number`);
    return n;
  },
});

// number -> string
ConverterRegistry.register<number, string>('number', 'string', {
  convert(source: number): string {
    return String(source);
  },
});

// string -> Date
ConverterRegistry.register<string, Date>('string', 'date', {
  convert(source: string): Date {
    const d = new Date(source);
    if (Number.isNaN(d.getTime())) throw new Error(`Cannot convert "${source}" to Date`);
    return d;
  },
});

// Date -> string (参考 hsweb: DateFormatter.toString with "yyyy-MM-dd HH:mm:ss")
ConverterRegistry.register<Date, string>('date', 'string', {
  convert(source: Date): string {
    return source.toISOString();
  },
});

// Date -> number (参考 hsweb: source instanceof Date => ((Date) source).getTime())
ConverterRegistry.register<Date, number>('date', 'number', {
  convert(source: Date): number {
    return source.getTime();
  },
});

// string -> boolean
ConverterRegistry.register<string, boolean>('string', 'boolean', {
  convert(source: string): boolean {
    const lower = source.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
    throw new Error(`Cannot convert "${source}" to boolean`);
  },
});

// boolean -> string
ConverterRegistry.register<boolean, string>('boolean', 'string', {
  convert(source: boolean): string {
    return String(source);
  },
});

// boolean -> number (参考 hsweb 数值转换完整性)
ConverterRegistry.register<boolean, number>('boolean', 'number', {
  convert(source: boolean): number {
    return source ? 1 : 0;
  },
});

// any -> string
ConverterRegistry.register<unknown, string>('any', 'string', {
  convert(source: unknown): string {
    return String(source);
  },
});

// number -> boolean
ConverterRegistry.register<number, boolean>('number', 'boolean', {
  convert(source: number): boolean {
    return source !== 0;
  },
});

// number -> date
ConverterRegistry.register<number, Date>('number', 'date', {
  convert(source: number): Date {
    // 参考 hsweb: 自动判断秒级/毫秒级时间戳
    if (source < 1e12) {
      return new Date(source * 1000);
    }
    return new Date(source);
  },
});

// string -> array（参考 hsweb: source instanceof String => stringValue.split(",")）
ConverterRegistry.register<string, unknown[]>('string', 'array', {
  convert(source: string): unknown[] {
    if (source.trim() === '') return [];
    return source.split(',').map((s) => s.trim());
  },
});

/**
 * Convert a value to the specified target type using registered converters.
 * @param value - The value to convert
 * @param targetType - The target type name (e.g., 'string', 'number', 'date')
 * @returns The converted value
 * @throws Error if no suitable converter is registered
 *
 * @example
 * ```ts
 * convert<number>('42', 'number'); // 42
 * convert<Date>(1700000000, 'date'); // Date object
 * ```
 */
export function convert<T>(value: unknown, targetType: string): T {
  return ConverterRegistry.convert<T>(value, targetType);
}

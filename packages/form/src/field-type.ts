/**
 * Field types for dynamic forms.
 *
 * Reference: jetlinks community form component
 */

export enum FieldType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  DATE = 'date',
  DATETIME = 'datetime',
  ENUM = 'enum',
  RELATION = 'relation',
  FILE = 'file',
  JSON = 'json',
  ARRAY = 'array',
}

/**
 * Configuration spec for creating a field type instance.
 *
 * Reference: jetlinks FieldTypeSpec
 */
export interface FieldTypeSpec {
  /** The field type provider name */
  name: string;
  /** Column/field length */
  length?: number;
  /** Decimal scale */
  scale?: number;
  /** Additional configuration properties */
  configuration?: Record<string, unknown>;
}

/**
 * SPI for extending field types.
 */
export interface FieldTypeProvider {
  getType(): string;
  getTypeName?(): string;
  getDefaultLength?(): number;
  validate(value: unknown): string | null;
  serialize(value: unknown): unknown;
  deserialize(value: unknown): unknown;
  /** Create a configured field type from a spec (factory pattern) */
  createFromSpec?(spec: FieldTypeSpec): FieldTypeProvider;
}

/**
 * Registry for field type providers.
 */
export class FieldTypeRegistry {
  private static readonly providers = new Map<string, FieldTypeProvider>();

  static register(provider: FieldTypeProvider): void {
    this.providers.set(provider.getType(), provider);
  }

  static get(type: string): FieldTypeProvider | undefined {
    return this.providers.get(type);
  }

  static has(type: string): boolean {
    return this.providers.has(type);
  }

  static getAll(): FieldTypeProvider[] {
    return Array.from(this.providers.values());
  }

  static unregister(type: string): boolean {
    return this.providers.delete(type);
  }

  static clear(): void {
    this.providers.clear();
  }

  /**
   * Create a field type from a FieldTypeSpec using the registered provider.
   *
   * Reference: jetlinks FieldTypeProvider.createType()
   */
  static createFromSpec(spec: FieldTypeSpec): FieldTypeProvider | undefined {
    const provider = this.providers.get(spec.name);
    if (!provider) return undefined;
    if (provider.createFromSpec) {
      return provider.createFromSpec(spec);
    }
    return provider;
  }
}

// Register built-in validators
const builtInProviders: FieldTypeProvider[] = [
  {
    getType: () => FieldType.STRING,
    validate: (v) => (typeof v === 'string' ? null : 'Expected string'),
    serialize: (v) => v,
    deserialize: (v) => v,
  },
  {
    getType: () => FieldType.NUMBER,
    validate: (v) => (typeof v === 'number' && !isNaN(v as number) ? null : 'Expected number'),
    serialize: (v) => v,
    deserialize: (v) => (typeof v === 'string' ? Number(v) : v),
  },
  {
    getType: () => FieldType.BOOLEAN,
    validate: (v) => (typeof v === 'boolean' ? null : 'Expected boolean'),
    serialize: (v) => v,
    deserialize: (v) => {
      if (typeof v === 'string') return v === 'true' || v === '1';
      return Boolean(v);
    },
  },
  {
    getType: () => FieldType.DATE,
    validate: (v) => {
      if (v instanceof Date) return null;
      if (typeof v === 'string' && !isNaN(Date.parse(v))) return null;
      return 'Expected date';
    },
    serialize: (v) => (v instanceof Date ? v.toISOString().split('T')[0] : v),
    deserialize: (v) => (typeof v === 'string' ? new Date(v) : v),
  },
  {
    getType: () => FieldType.DATETIME,
    validate: (v) => {
      if (v instanceof Date) return null;
      if (typeof v === 'string' && !isNaN(Date.parse(v))) return null;
      return 'Expected datetime';
    },
    serialize: (v) => (v instanceof Date ? v.toISOString() : v),
    deserialize: (v) => (typeof v === 'string' ? new Date(v) : v),
  },
  {
    getType: () => FieldType.JSON,
    validate: (v) => (typeof v === 'object' ? null : 'Expected object'),
    serialize: (v) => v,
    deserialize: (v) => {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return null; }
    },
  },
  {
    getType: () => FieldType.ARRAY,
    validate: (v) => (Array.isArray(v) ? null : 'Expected array'),
    serialize: (v) => v,
    deserialize: (v) => {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return []; }
    },
  },
];

for (const p of builtInProviders) {
  FieldTypeRegistry.register(p);
}

/**
 * EnumFieldTypeProvider — handles enum fields with dictionary-like encode/decode.
 *
 * Reference: jetlinks EnumFieldType
 */
export interface EnumFieldTypeOptions {
  /** Whether multiple values can be selected */
  multiple?: boolean;
  /** Available enum options */
  options: Array<{ value: string | number; label: string }>;
  /** Separator for multiple values in serialized form */
  separator?: string;
}

export class EnumFieldTypeProvider implements FieldTypeProvider {
  private readonly options: EnumFieldTypeOptions;

  constructor(options: EnumFieldTypeOptions) {
    this.options = {
      separator: ',',
      ...options,
    };
  }

  getType(): string {
    return FieldType.ENUM;
  }

  getTypeName(): string {
    return 'Enum';
  }

  getDefaultLength(): number {
    return 64;
  }

  validate(value: unknown): string | null {
    const validValues = this.options.options.map((o) => o.value);
    if (this.options.multiple) {
      if (!Array.isArray(value)) return 'Expected array for multiple enum';
      for (const v of value) {
        if (!validValues.includes(v as string | number)) {
          return `Invalid enum value: ${String(v)}`;
        }
      }
      return null;
    }
    if (!validValues.includes(value as string | number)) {
      return `Invalid enum value: ${String(value)}`;
    }
    return null;
  }

  /**
   * Encode: convert value(s) to storage format.
   * Multiple values are joined by separator.
   */
  serialize(value: unknown): unknown {
    if (this.options.multiple && Array.isArray(value)) {
      return value.map(String).join(this.options.separator);
    }
    return value;
  }

  /**
   * Decode: convert stored format back to value(s).
   */
  deserialize(value: unknown): unknown {
    if (this.options.multiple && typeof value === 'string') {
      return value.split(this.options.separator!);
    }
    return value;
  }

  createFromSpec(spec: FieldTypeSpec): FieldTypeProvider {
    const config = spec.configuration ?? {};
    const options = (config['options'] as Array<{ value: string | number; label: string }>) ?? this.options.options;
    const multiple = (config['multiple'] as boolean) ?? this.options.multiple;
    return new EnumFieldTypeProvider({ options, multiple });
  }
}

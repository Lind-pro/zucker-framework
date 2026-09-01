import { Logger } from '@nestjs/common';

/**
 * Data-mapping action — mirrors jetlinks DataMappingTaskExecutorProvider.
 *
 * Transforms data by mapping source fields to target fields with optional
 * type conversion, supporting expression-based source references.
 */
export interface DataMapping {
  /** Target field name in output. */
  target: string;
  /** Source field name or expression (supports ${expr} interpolation). */
  source: string;
  /** Optional type coercion: 'string' | 'number' | 'boolean' | 'integer' | 'decimal'. */
  type?: string;
}

export interface DataMappingActionConfig {
  /** Field mappings. */
  mappings: DataMapping[];
  /** Whether to keep all source data and merge mappings on top. */
  keepSourceData?: boolean;
}

type TypeConverter = (value: unknown) => unknown;

const TYPE_CONVERTERS: Record<string, TypeConverter> = {
  string: (v) => String(v),
  number: (v) => Number(v),
  integer: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  },
  decimal: (v) => Number(v),
  boolean: (v) => {
    if (typeof v === 'string') {
      return v === 'true' || v === '1';
    }
    return Boolean(v);
  },
  date: (v) => {
    if (v instanceof Date) return v;
    const d = new Date(v as string | number);
    return Number.isNaN(d.getTime()) ? null : d;
  },
};

export class DataMappingAction {
  private readonly logger = new Logger(DataMappingAction.name);

  execute(
    config: DataMappingActionConfig,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (Array.isArray(data)) {
      return data.map((item) =>
        this.doMapping(config, item as Record<string, unknown>),
      ) as unknown as Record<string, unknown>;
    }
    return this.doMapping(config, data);
  }

  private doMapping(
    config: DataMappingActionConfig,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = config.keepSourceData
      ? { ...source }
      : {};

    for (const mapping of config.mappings) {
      let value = this.resolveSource(mapping.source, source);
      if (value === undefined || value === null) continue;

      if (mapping.type) {
        const converter = TYPE_CONVERTERS[mapping.type.toLowerCase()];
        if (converter) {
          value = converter(value);
        }
      }
      result[mapping.target] = value;
    }

    return result;
  }

  private resolveSource(source: string, data: Record<string, unknown>): unknown {
    // Direct field lookup
    if (data[source] !== undefined) {
      return data[source];
    }

    // Expression interpolation: ${fieldName}
    if (source.includes('${')) {
      const interpolated = source.replace(/\$\{(\w+)}/g, (_, key) => {
        const val = data[key];
        return val !== undefined ? String(val) : '';
      });
      return interpolated;
    }

    // Nested field access: a.b.c
    if (source.includes('.')) {
      return this.getNestedValue(data, source);
    }

    return undefined;
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}

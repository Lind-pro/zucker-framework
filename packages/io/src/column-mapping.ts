/**
 * Column mapping for import/export operations.
 *
 * Mirrors jetlinks ExcelHeader with key/text/dataType + converter options.
 */

export interface ColumnMapping {
  /** Property name on the entity */
  field: string;
  /** Display header text in the Excel file */
  header: string;
  /** Column width in characters */
  width?: number;
  /** Whether this field is required during import */
  required?: boolean;
  /** Column sort order (lower = first) */
  order?: number;
  /** Whether to include in import/export */
  ignoreRead?: boolean;
  ignoreWrite?: boolean;
  /** Value converters for import/export transformation */
  converter?: {
    import?: (value: unknown) => unknown;
    export?: (value: unknown) => unknown;
  };
}

export interface ExcelColumnOptions {
  width?: number;
  required?: boolean;
  order?: number;
  /** Exclude from import */
  ignoreRead?: boolean;
  /** Exclude from export */
  ignoreWrite?: boolean;
  converter?: ColumnMapping['converter'];
}

const columnMappingsRegistry = new Map<Function, ColumnMapping[]>();

/**
 * @ExcelColumn(header, options?) property decorator.
 *
 * Marks a class property for Excel import/export mapping.
 * Mirrors jetlinks @ExcelHeader annotation.
 */
export function ExcelColumn(
  header: string,
  options?: ExcelColumnOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = target.constructor;
    const existing = columnMappingsRegistry.get(ctor) ?? [];
    existing.push({
      field: String(propertyKey),
      header,
      width: options?.width,
      required: options?.required,
      order: options?.order,
      ignoreRead: options?.ignoreRead,
      ignoreWrite: options?.ignoreWrite,
      converter: options?.converter,
    });
    columnMappingsRegistry.set(ctor, existing);
  };
}

/**
 * Extract column mappings from a class decorated with @ExcelColumn.
 * Returns sorted by order, then by registration order.
 */
export function getColumnMappings(target: Function): ColumnMapping[] {
  const mappings = columnMappingsRegistry.get(target) ?? [];
  return [...mappings].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
}

/**
 * Get column mappings filtered for reading (import).
 * Mirrors jetlinks ExcelUtils.getHeadersForRead().
 */
export function getReadMappings(target: Function): ColumnMapping[] {
  return getColumnMappings(target).filter((m) => !m.ignoreRead);
}

/**
 * Get column mappings filtered for writing (export).
 * Mirrors jetlinks ExcelUtils.getHeadersForWrite().
 */
export function getWriteMappings(target: Function): ColumnMapping[] {
  return getColumnMappings(target).filter((m) => !m.ignoreWrite);
}

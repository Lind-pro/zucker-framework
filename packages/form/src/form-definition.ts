import { FieldType } from './field-type';

/**
 * Dynamic form definition.
 *
 * Reference: jetlinks community form component
 */

export interface FieldValidator {
  type: string;
  message: string;
  params?: Record<string, unknown>;
}

export interface FieldOption {
  label: string;
  value: string | number;
}

export interface FieldDefinition {
  key: string;
  name: string;
  type: FieldType | string;
  required?: boolean;
  defaultValue?: unknown;
  options?: FieldOption[];
  validators?: FieldValidator[];
  description?: string;
  /** For RELATION type: the related entity/resource id */
  relationTarget?: string;
  /** For ARRAY type: the element type */
  elementType?: FieldType | string;
  /** Custom properties for UI rendering */
  extra?: Record<string, unknown>;
}

export interface FormLayout {
  columns?: number;
  labelWidth?: string;
  labelPosition?: 'top' | 'left' | 'right';
}

export interface FormDefinition {
  id: string;
  name: string;
  fields: FieldDefinition[];
  layout?: FormLayout;
  description?: string;
  version?: number;
  /** Set by the database when the table has these columns (the server template does). */
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/**
 * Generate a FormDefinition from a JSON Schema (subset).
 */
export function fromJsonSchema(
  id: string,
  name: string,
  schema: {
    properties?: Record<
      string,
      {
        type?: string;
        title?: string;
        description?: string;
        default?: unknown;
        enum?: unknown[];
        items?: { type?: string };
        format?: string;
      }
    >;
    required?: string[];
  },
): FormDefinition {
  const requiredSet = new Set(schema.required ?? []);
  const fields: FieldDefinition[] = [];

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let fieldType: FieldType | string = FieldType.STRING;

    switch (prop.type) {
      case 'string':
        if (prop.format === 'date') fieldType = FieldType.DATE;
        else if (prop.format === 'date-time') fieldType = FieldType.DATETIME;
        else if (prop.enum) fieldType = FieldType.ENUM;
        else fieldType = FieldType.STRING;
        break;
      case 'number':
      case 'integer':
        fieldType = FieldType.NUMBER;
        break;
      case 'boolean':
        fieldType = FieldType.BOOLEAN;
        break;
      case 'object':
        fieldType = FieldType.JSON;
        break;
      case 'array':
        fieldType = FieldType.ARRAY;
        break;
    }

    const field: FieldDefinition = {
      key,
      name: prop.title ?? key,
      type: fieldType,
      required: requiredSet.has(key),
      defaultValue: prop.default,
      description: prop.description,
    };

    if (prop.enum) {
      field.options = prop.enum.map((v) => ({
        label: String(v),
        value: v as string | number,
      }));
    }

    if (prop.items?.type) {
      field.elementType =
        prop.items.type === 'number' || prop.items.type === 'integer'
          ? FieldType.NUMBER
          : prop.items.type === 'boolean'
            ? FieldType.BOOLEAN
            : FieldType.STRING;
    }

    fields.push(field);
  }

  return { id, name, fields };
}

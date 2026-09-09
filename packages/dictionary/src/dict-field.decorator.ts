export const DICT_FIELD_KEY = 'zucker:dict:field';
export const DICT_FIELDS_KEY = 'zucker:dict:fields';

export interface DictFieldOptions {
  /** Dictionary ID */
  dictId: string;
  /** Dictionary alias */
  alias?: string;
  /** Description / comments */
  comments?: string;
  /** Field name (stores the value) */
  valueField?: string;
  /** Text field name (stores display text) */
  textField?: string;
}

/** Stored per-field entry including the property name */
export interface DictFieldEntry extends DictFieldOptions {
  propertyKey: string;
}

/**
 * @DictField decorator
 *
 * Marks an entity field as associated with a dictionary, used for
 * automatic dictionary text population.
 *
 * Uses Reflect.defineMetadata (not NestJS SetMetadata) because this is a
 * PropertyDecorator — SetMetadata only works for class/method targets.
 *
 * Also collects all decorated fields into a class-level DICT_FIELDS_KEY array
 * so consumers can enumerate all dict fields on an entity.
 *
 * Usage:
 * ```typescript
 * @DictField({ dictId: 'status', textField: 'statusText' })
 * status: string;
 *
 * // or shorthand:
 * @DictField('status')
 * status: string;
 * ```
 */
export const DictField = (options: string | DictFieldOptions): PropertyDecorator => {
  const metadata: DictFieldOptions =
    typeof options === 'string' ? { dictId: options } : options;

  return (target: object, propertyKey: string | symbol) => {
    // Store per-field metadata
    Reflect.defineMetadata(DICT_FIELD_KEY, metadata, target, propertyKey);

    // Collect all dict fields on the class prototype for enumeration
    const existing: DictFieldEntry[] =
      Reflect.getMetadata(DICT_FIELDS_KEY, target.constructor) ?? [];
    const entry: DictFieldEntry = { ...metadata, propertyKey: String(propertyKey) };
    Reflect.defineMetadata(DICT_FIELDS_KEY, [...existing, entry], target.constructor);
  };
};

/**
 * Get all @DictField entries from a class.
 */
export function getDictFields(target: Function): DictFieldEntry[] {
  return Reflect.getMetadata(DICT_FIELDS_KEY, target) ?? [];
}

/**
 * Get the @DictField metadata for a specific property.
 */
export function getDictFieldOptions(target: object, propertyKey: string | symbol): DictFieldOptions | undefined {
  return Reflect.getMetadata(DICT_FIELD_KEY, target, propertyKey);
}

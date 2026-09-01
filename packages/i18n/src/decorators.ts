const i18nRegistry = new Map<string, string>();

function makeKey(target: object, propertyKey: string | symbol): string {
  const ctorName = (target as { constructor: { name: string } }).constructor?.name ?? 'Unknown';
  return `${ctorName}.${String(propertyKey)}`;
}

/**
 * @I18n(code) -- marks a field/property for i18n text resolution.
 *
 * When applied, the field value is treated as an i18n message code
 * that should be resolved through the MessageSource at display time.
 */
export function I18n(code: string): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    i18nRegistry.set(makeKey(target, propertyKey), code);
  };
}

/**
 * Get the i18n code associated with a property.
 */
export function getI18nCode(
  target: object,
  propertyKey: string | symbol,
): string | undefined {
  return i18nRegistry.get(makeKey(target, propertyKey));
}

/**
 * Check if a property has an i18n code.
 */
export function hasI18n(
  target: object,
  propertyKey: string | symbol,
): boolean {
  return i18nRegistry.has(makeKey(target, propertyKey));
}

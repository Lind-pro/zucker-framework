export type MessageParams = Record<string, string | number>;

/** Replace `{name}` placeholders. Unknown placeholders are kept so missing data is visible. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

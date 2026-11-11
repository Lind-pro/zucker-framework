/**
 * Plain-data connection descriptors for mail delivery (SMTP or Resend): profile id, environment keys, field types,
 * English display text and stable translation keys. It has no runtime dependency; an application turns
 * it into a saved connection profile with `localizeConnectionDescriptor` from
 * `@zucker-framework/config/connections` (matched structurally) and adds its own validation.
 * Ids and environment keys are a storage contract: saved configuration is keyed by them, so never rename one.
 */
export type NotificationConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface NotificationConnectionDescriptorField {
  readonly key: string; readonly label: string; readonly labelKey: string; readonly type: NotificationConnectionFieldType;
  readonly options?: readonly string[]; readonly defaultValue?: string; readonly description?: string; readonly min?: number; readonly max?: number;
}
export interface NotificationConnectionDescriptor {
  readonly profile: {
    readonly id: string; readonly name: string; readonly labelKey: string; readonly category: string; readonly categoryKey: string;
    readonly fields: readonly NotificationConnectionDescriptorField[];
  };
}

/** Account and transactional mail: `MAIL_PROVIDER` selects SMTP or Resend; `SMTP_FROM` is the sender for both. */
export const ACCOUNT_EMAIL_CONNECTION_DESCRIPTOR: NotificationConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'account-email', name: 'Account email', labelKey: 'connections.account-email', category: 'Mail', categoryKey: 'connections.category.mail',
    fields: Object.freeze<NotificationConnectionDescriptorField[]>([
      { key: 'MAIL_PROVIDER', label: 'Provider', labelKey: 'connections.field.MAIL_PROVIDER', type: 'select', options: ['smtp', 'resend'], defaultValue: 'smtp' },
      { key: 'SMTP_FROM', label: 'Sender', labelKey: 'connections.field.SMTP_FROM', type: 'text' },
      { key: 'SMTP_HOST', label: 'SMTP host', labelKey: 'connections.field.SMTP_HOST', type: 'text' },
      { key: 'SMTP_PORT', label: 'Port', labelKey: 'connections.field.SMTP_PORT', type: 'number', defaultValue: '587', min: 1, max: 65535 },
      { key: 'SMTP_SECURE', label: 'Use TLS', labelKey: 'connections.field.SMTP_SECURE', type: 'boolean', defaultValue: 'false' },
      { key: 'SMTP_USER', label: 'SMTP username', labelKey: 'connections.field.SMTP_USER', type: 'text' },
      { key: 'SMTP_PASSWORD', label: 'SMTP password', labelKey: 'connections.field.SMTP_PASSWORD', type: 'secret' },
      { key: 'MAIL_RESEND_API_KEY', label: 'Resend API key', labelKey: 'connections.field.MAIL_RESEND_API_KEY', type: 'secret' },
    ]) }),
});
/** Durable job notification mail: `DELIVERY_PROVIDER` selects none, SMTP or Resend. */
export const DURABLE_EMAIL_CONNECTION_DESCRIPTOR: NotificationConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'durable-email', name: 'Job notification email', labelKey: 'connections.durable-email', category: 'Mail', categoryKey: 'connections.category.mail',
    fields: Object.freeze<NotificationConnectionDescriptorField[]>([
      { key: 'DELIVERY_PROVIDER', label: 'Provider', labelKey: 'connections.field.DELIVERY_PROVIDER', type: 'select', options: ['none', 'smtp', 'resend'], defaultValue: 'none' },
      { key: 'DELIVERY_ACCOUNT_SCOPE', label: 'Account scope', labelKey: 'connections.field.DELIVERY_ACCOUNT_SCOPE', type: 'text' },
      { key: 'DELIVERY_FROM', label: 'Sender', labelKey: 'connections.field.DELIVERY_FROM', type: 'text' },
      { key: 'DELIVERY_RESEND_API_KEY', label: 'Resend API key', labelKey: 'connections.field.DELIVERY_RESEND_API_KEY', type: 'secret' },
      { key: 'DELIVERY_SMTP_HOST', label: 'SMTP host', labelKey: 'connections.field.DELIVERY_SMTP_HOST', type: 'text' },
      { key: 'DELIVERY_SMTP_PORT', label: 'Port', labelKey: 'connections.field.DELIVERY_SMTP_PORT', type: 'number', defaultValue: '587', min: 1, max: 65535 },
      { key: 'DELIVERY_SMTP_SECURE', label: 'Use TLS', labelKey: 'connections.field.DELIVERY_SMTP_SECURE', type: 'boolean', defaultValue: 'false' },
      { key: 'DELIVERY_SMTP_USER', label: 'SMTP username', labelKey: 'connections.field.DELIVERY_SMTP_USER', type: 'text' },
      { key: 'DELIVERY_SMTP_PASSWORD', label: 'SMTP password', labelKey: 'connections.field.DELIVERY_SMTP_PASSWORD', type: 'secret' },
    ]) }),
});
export const MAIL_CONNECTION_DESCRIPTORS: readonly NotificationConnectionDescriptor[] = Object.freeze([ACCOUNT_EMAIL_CONNECTION_DESCRIPTOR, DURABLE_EMAIL_CONNECTION_DESCRIPTOR]);

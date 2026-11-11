/**
 * Plain-data connection descriptors for hosted-checkout payment providers: profile id, environment keys, field types,
 * English display text and stable translation keys. It has no runtime dependency; an application turns
 * it into a saved connection profile with `localizeConnectionDescriptor` from
 * `@zucker-framework/config/connections` (matched structurally) and adds its own validation.
 * Ids and environment keys are a storage contract: saved configuration is keyed by them, so never rename one.
 */
export type PaymentConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface PaymentConnectionDescriptorField {
  readonly key: string; readonly label: string; readonly labelKey: string; readonly type: PaymentConnectionFieldType;
  readonly options?: readonly string[]; readonly defaultValue?: string; readonly description?: string; readonly min?: number; readonly max?: number;
}
export interface PaymentConnectionDescriptor {
  readonly profile: {
    readonly id: string; readonly name: string; readonly labelKey: string; readonly category: string; readonly categoryKey: string;
    readonly fields: readonly PaymentConnectionDescriptorField[];
  };
}

export const STRIPE_CONNECTION_DESCRIPTOR: PaymentConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'payment-stripe', name: 'Stripe', labelKey: 'connections.payment-stripe', category: 'Payments', categoryKey: 'connections.category.payments',
    fields: Object.freeze<PaymentConnectionDescriptorField[]>([
      { key: 'BILLING_STRIPE_ENABLED', label: 'Enabled', labelKey: 'connections.field.BILLING_STRIPE_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'BILLING_STRIPE_MODE', label: 'Mode', labelKey: 'connections.field.BILLING_STRIPE_MODE', type: 'select', options: ['test', 'live'] },
      { key: 'BILLING_STRIPE_ACCOUNT_SCOPE', label: 'Account scope', labelKey: 'connections.field.BILLING_STRIPE_ACCOUNT_SCOPE', type: 'text' },
      { key: 'STRIPE_SECRET_KEY', label: 'API secret key', labelKey: 'connections.field.STRIPE_SECRET_KEY', type: 'secret' },
      { key: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook signing secret', labelKey: 'connections.field.STRIPE_WEBHOOK_SECRET', type: 'secret' },
    ]) }),
});
export const PAYPAL_CONNECTION_DESCRIPTOR: PaymentConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'payment-paypal', name: 'PayPal', labelKey: 'connections.payment-paypal', category: 'Payments', categoryKey: 'connections.category.payments',
    fields: Object.freeze<PaymentConnectionDescriptorField[]>([
      { key: 'BILLING_PAYPAL_ENABLED', label: 'Enabled', labelKey: 'connections.field.BILLING_PAYPAL_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'BILLING_PAYPAL_MODE', label: 'Mode', labelKey: 'connections.field.BILLING_PAYPAL_MODE', type: 'select', options: ['sandbox', 'live'] },
      { key: 'BILLING_PAYPAL_ACCOUNT_SCOPE', label: 'Account scope', labelKey: 'connections.field.BILLING_PAYPAL_ACCOUNT_SCOPE', type: 'text' },
      { key: 'PAYPAL_CLIENT_ID', label: 'Client ID', labelKey: 'connections.field.PAYPAL_CLIENT_ID', type: 'text' },
      { key: 'PAYPAL_CLIENT_SECRET', label: 'Client secret', labelKey: 'connections.field.PAYPAL_CLIENT_SECRET', type: 'secret' },
      { key: 'PAYPAL_WEBHOOK_ID', label: 'Webhook ID', labelKey: 'connections.field.PAYPAL_WEBHOOK_ID', type: 'text' },
    ]) }),
});
export const CREEM_CONNECTION_DESCRIPTOR: PaymentConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'payment-creem', name: 'Creem', labelKey: 'connections.payment-creem', category: 'Payments', categoryKey: 'connections.category.payments',
    fields: Object.freeze<PaymentConnectionDescriptorField[]>([
      { key: 'BILLING_CREEM_ENABLED', label: 'Enabled', labelKey: 'connections.field.BILLING_CREEM_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'BILLING_CREEM_MODE', label: 'Mode', labelKey: 'connections.field.BILLING_CREEM_MODE', type: 'select', options: ['test', 'production'] },
      { key: 'BILLING_CREEM_ACCOUNT_SCOPE', label: 'Account scope', labelKey: 'connections.field.BILLING_CREEM_ACCOUNT_SCOPE', type: 'text' },
      { key: 'CREEM_API_KEY', label: 'API key', labelKey: 'connections.field.CREEM_API_KEY', type: 'secret' },
      { key: 'CREEM_WEBHOOK_SECRET', label: 'Webhook signing secret', labelKey: 'connections.field.CREEM_WEBHOOK_SECRET', type: 'secret' },
    ]) }),
});
/** Stripe, PayPal and Creem, in admin display order. */
export const PAYMENT_CONNECTION_DESCRIPTORS: readonly PaymentConnectionDescriptor[] = Object.freeze([STRIPE_CONNECTION_DESCRIPTOR, PAYPAL_CONNECTION_DESCRIPTOR, CREEM_CONNECTION_DESCRIPTOR]);

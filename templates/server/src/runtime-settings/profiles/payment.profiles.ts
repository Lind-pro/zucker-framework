import { CREEM_CONNECTION_DESCRIPTOR, PAYPAL_CONNECTION_DESCRIPTOR, STRIPE_CONNECTION_DESCRIPTOR } from '@zucker-framework/payment';
import { configuredBillingProviders } from '../../billing/providers';
import { defineConnectionProfile, localizeConnectionDescriptor } from '../registry';

/** Assemble only the provider being saved; the other two are forced off so their state cannot fail this save. */
function validatePayment(id: 'stripe' | 'paypal' | 'creem') {
  return (env: NodeJS.ProcessEnv) => { configuredBillingProviders({ ...env, BILLING_STRIPE_ENABLED: id === 'stripe' ? env.BILLING_STRIPE_ENABLED : 'false',
    BILLING_PAYPAL_ENABLED: id === 'paypal' ? env.BILLING_PAYPAL_ENABLED : 'false', BILLING_CREEM_ENABLED: id === 'creem' ? env.BILLING_CREEM_ENABLED : 'false' }); };
}
const label = (text: string) => ({ label: text });
/**
 * Payment credentials apply hot (WP 4.1c): new orders use the saved revision at once; existing orders,
 * subscriptions and refunds keep using the newest retained credentials of their own account (D12).
 */
export const PAYMENT_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'hot', validate: validatePayment('stripe'), profile: localizeConnectionDescriptor(STRIPE_CONNECTION_DESCRIPTOR, { category: '支付', fields: {
    BILLING_STRIPE_ENABLED: label('启用'), BILLING_STRIPE_MODE: label('模式'), BILLING_STRIPE_ACCOUNT_SCOPE: label('账户标识'),
    STRIPE_SECRET_KEY: label('API 密钥'), STRIPE_WEBHOOK_SECRET: label('Webhook 签名密钥') } }) }),
  defineConnectionProfile({ applyMode: 'hot', validate: validatePayment('paypal'), profile: localizeConnectionDescriptor(PAYPAL_CONNECTION_DESCRIPTOR, { category: '支付', fields: {
    BILLING_PAYPAL_ENABLED: label('启用'), BILLING_PAYPAL_MODE: label('模式'), BILLING_PAYPAL_ACCOUNT_SCOPE: label('账户标识'),
    PAYPAL_CLIENT_ID: label('Client ID'), PAYPAL_CLIENT_SECRET: label('Client Secret'), PAYPAL_WEBHOOK_ID: label('Webhook ID') } }) }),
  defineConnectionProfile({ applyMode: 'hot', validate: validatePayment('creem'), profile: localizeConnectionDescriptor(CREEM_CONNECTION_DESCRIPTOR, { category: '支付', fields: {
    BILLING_CREEM_ENABLED: label('启用'), BILLING_CREEM_MODE: label('模式'), BILLING_CREEM_ACCOUNT_SCOPE: label('账户标识'),
    CREEM_API_KEY: label('API 密钥'), CREEM_WEBHOOK_SECRET: label('Webhook 签名密钥') } }) }),
];

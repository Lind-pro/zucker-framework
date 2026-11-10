import { configuredBillingProviders } from '../../billing/providers';
import { connectionField, defineConnectionProfile } from '../registry';

const { boolean, secret, select, text } = connectionField;
/** Assemble only the provider being saved; the other two are forced off so their state cannot fail this save. */
function validatePayment(id: 'stripe' | 'paypal' | 'creem') {
  return (env: NodeJS.ProcessEnv) => { configuredBillingProviders({ ...env, BILLING_STRIPE_ENABLED: id === 'stripe' ? env.BILLING_STRIPE_ENABLED : 'false',
    BILLING_PAYPAL_ENABLED: id === 'paypal' ? env.BILLING_PAYPAL_ENABLED : 'false', BILLING_CREEM_ENABLED: id === 'creem' ? env.BILLING_CREEM_ENABLED : 'false' }); };
}
/** Payment credentials stay restart-to-apply (D1 option b) until revision-pinned payment credentials land. */
export const PAYMENT_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'restart', validate: validatePayment('stripe'), profile: { id: 'payment-stripe', name: 'Stripe', category: '支付', fields: [
    boolean('BILLING_STRIPE_ENABLED', '启用'), select('BILLING_STRIPE_MODE', '模式', ['test', 'live']),
    text('BILLING_STRIPE_ACCOUNT_SCOPE', '账户标识'), secret('STRIPE_SECRET_KEY', 'API 密钥'), secret('STRIPE_WEBHOOK_SECRET', 'Webhook 签名密钥')] } }),
  defineConnectionProfile({ applyMode: 'restart', validate: validatePayment('paypal'), profile: { id: 'payment-paypal', name: 'PayPal', category: '支付', fields: [
    boolean('BILLING_PAYPAL_ENABLED', '启用'), select('BILLING_PAYPAL_MODE', '模式', ['sandbox', 'live']),
    text('BILLING_PAYPAL_ACCOUNT_SCOPE', '账户标识'), text('PAYPAL_CLIENT_ID', 'Client ID'), secret('PAYPAL_CLIENT_SECRET', 'Client Secret'), text('PAYPAL_WEBHOOK_ID', 'Webhook ID')] } }),
  defineConnectionProfile({ applyMode: 'restart', validate: validatePayment('creem'), profile: { id: 'payment-creem', name: 'Creem', category: '支付', fields: [
    boolean('BILLING_CREEM_ENABLED', '启用'), select('BILLING_CREEM_MODE', '模式', ['test', 'production']),
    text('BILLING_CREEM_ACCOUNT_SCOPE', '账户标识'), secret('CREEM_API_KEY', 'API 密钥'), secret('CREEM_WEBHOOK_SECRET', 'Webhook 签名密钥')] } }),
];

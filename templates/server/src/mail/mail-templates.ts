import type { BuiltInMailTemplate } from '@zucker-framework/notification';

/**
 * Built-in transactional mail (bilingual HTML). An administrator can override any of them through
 * `management/email-templates` (a stored, active row with the same key wins). Variables are rendered
 * by `MailTemplateCatalog.interpolate`: text is HTML-escaped and a variable that starts an `href`
 * is restricted to http(s)/mailto, so callers pass raw values, never pre-escaped HTML.
 */
export const MAIL_TEMPLATE_KEYS = {
  verify: 'account.verify',
  reset: 'account.reset',
  welcome: 'account.welcome',
  receipt: 'billing.receipt',
  magicLink: 'account.magic-link',
  deletionScheduled: 'account.deletion-scheduled',
  deletionCompleted: 'account.deletion-completed',
  twoFactorReset: 'account.two-factor-reset',
} as const;
export type MailTemplateKey = typeof MAIL_TEMPLATE_KEYS[keyof typeof MAIL_TEMPLATE_KEYS];
export type MailLocale = 'en' | 'zh';

const SUBJECTS: Readonly<Record<MailTemplateKey, Readonly<Record<MailLocale, string>>>> = {
  'account.verify': { en: 'Verify your email', zh: '验证你的邮箱' },
  'account.reset': { en: 'Reset your password', zh: '重置你的密码' },
  'account.welcome': { en: 'Welcome aboard', zh: '欢迎加入' },
  'billing.receipt': { en: 'Your payment receipt', zh: '你的付款收据' },
  'account.magic-link': { en: 'Your sign-in link', zh: '你的登录链接' },
  'account.deletion-scheduled': { en: 'Your account is scheduled for deletion', zh: '你的账户已安排删除' },
  'account.deletion-completed': { en: 'Your account has been deleted', zh: '你的账户已删除' },
  'account.two-factor-reset': { en: 'Two-factor authentication was turned off', zh: '两步验证已被关闭' },
};
/** Localised default subject; a stored template's `subject` (single language) replaces it. */
export function defaultMailSubject(key: MailTemplateKey, locale: string | null | undefined): string {
  return SUBJECTS[key][mailLocale(locale)];
}
export function mailLocale(locale: string | null | undefined): MailLocale {
  return locale?.split(/[-_]/)[0] === 'zh' ? 'zh' : 'en';
}

/** Table-based layout with inline styles: the subset that renders consistently across mail clients. */
function layout(lang: MailLocale, heading: string, body: string, action?: { label: string; href: string }, footer = ''): string {
  const button = action ? `
          <tr><td style="padding:8px 0 24px">
            <a href="${action.href}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${action.label}</a>
          </td></tr>` : '';
  return `<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;padding:32px">
        <tr><td style="font-size:14px;color:#6b7280;padding-bottom:16px">{{siteName}}</td></tr>
        <tr><td style="font-size:22px;font-weight:700;padding-bottom:16px">${heading}</td></tr>
        <tr><td style="font-size:15px;line-height:1.6;padding-bottom:16px">${body}</td></tr>${button}
        <tr><td style="font-size:12px;line-height:1.5;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:16px">${footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const fallbackLink = (text: string) => `${text}<br><a href="{{link}}" style="color:#2563eb;word-break:break-all">{{link}}</a>`;

export const ACCOUNT_MAIL_TEMPLATES: BuiltInMailTemplate[] = [
  {
    key: MAIL_TEMPLATE_KEYS.verify,
    name: 'Account: verify e-mail',
    description: 'Sent at password sign-up and on "resend verification". Variables: siteName, link.',
    defaultSubject: SUBJECTS['account.verify'].en,
    contents: {
      en: layout('en', 'Confirm your email address', 'Use the button below to confirm this address. The link is valid for 30 minutes and can be used once.',
        { label: 'Verify email', href: '{{link}}' },
        fallbackLink('If you did not create an account, ignore this message. If the button does not work, open:')),
      zh: layout('zh', '确认你的邮箱地址', '点击下方按钮确认此邮箱。链接 30 分钟内有效，且只能使用一次。',
        { label: '验证邮箱', href: '{{link}}' },
        fallbackLink('如果你没有注册账户，请忽略此邮件。如果按钮无法打开，请访问：')),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.reset,
    name: 'Account: reset password',
    description: 'Sent by "forgot password". Variables: siteName, link.',
    defaultSubject: SUBJECTS['account.reset'].en,
    contents: {
      en: layout('en', 'Reset your password', 'Someone asked to reset the password for this account. The link is valid for 30 minutes and can be used once; resetting signs out every session.',
        { label: 'Choose a new password', href: '{{link}}' },
        fallbackLink('If you did not ask for this, ignore this message; your password stays the same. If the button does not work, open:')),
      zh: layout('zh', '重置你的密码', '有人请求重置此账户的密码。链接 30 分钟内有效，且只能使用一次；重置后所有会话都会退出登录。',
        { label: '设置新密码', href: '{{link}}' },
        fallbackLink('如果这不是你本人的操作，请忽略此邮件，密码不会改变。如果按钮无法打开，请访问：')),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.welcome,
    name: 'Account: welcome',
    description: 'Sent once the account can sign in (after verification, or at sign-up when verification is off or the provider verified the address). Variables: siteName, name, link.',
    defaultSubject: SUBJECTS['account.welcome'].en,
    contents: {
      en: layout('en', 'Welcome, {{name}}', 'Your account is ready. Open your console to get started.',
        { label: 'Open console', href: '{{link}}' }, 'You receive this message because an account was created with this address.'),
      zh: layout('zh', '欢迎你，{{name}}', '你的账户已准备就绪，打开控制台开始使用吧。',
        { label: '打开控制台', href: '{{link}}' }, '你收到此邮件是因为有人使用此邮箱创建了账户。'),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.receipt,
    name: 'Billing: payment receipt',
    description: 'Sent after a one-time purchase is fulfilled (best effort). Variables: siteName, name, orderId, description, amount, currency (amount actually paid, after any promotion), discount ("-5.00 USD (list price 20.00 USD)" or "—"), credits, paidAt, link.',
    defaultSubject: SUBJECTS['billing.receipt'].en,
    contents: {
      en: layout('en', 'Thank you for your purchase',
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8">
          <tr><td style="color:#6b7280;padding-right:16px">Item</td><td>{{description}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Amount paid</td><td>{{amount}} {{currency}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Discount</td><td>{{discount}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Credits</td><td>{{credits}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Order</td><td>{{orderId}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Paid</td><td>{{paidAt}}</td></tr>
        </table>`,
        { label: 'View orders', href: '{{link}}' }, 'This receipt confirms a payment processed for your account. Keep it for your records.'),
      zh: layout('zh', '感谢你的购买',
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8">
          <tr><td style="color:#6b7280;padding-right:16px">商品</td><td>{{description}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">实付金额</td><td>{{amount}} {{currency}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">优惠</td><td>{{discount}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">积分</td><td>{{credits}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">订单号</td><td>{{orderId}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">付款时间</td><td>{{paidAt}}</td></tr>
        </table>`,
        { label: '查看订单', href: '{{link}}' }, '此收据确认你的账户已完成一笔付款，请妥善保存。'),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.magicLink,
    name: 'Account: sign-in link',
    description: 'Sent by "email me a sign-in link" to an existing account (only when the account policy allows it). Variables: siteName, link.',
    defaultSubject: SUBJECTS['account.magic-link'].en,
    contents: {
      en: layout('en', 'Sign in to your account', 'Use the button below to sign in. The link is valid for 15 minutes and can be used once. If two-factor authentication is on, you will still be asked for a code.',
        { label: 'Sign in', href: '{{link}}' },
        fallbackLink('If you did not ask for this, ignore this message; nobody can sign in without this link. If the button does not work, open:')),
      zh: layout('zh', '登录你的账户', '点击下方按钮登录。链接 15 分钟内有效，且只能使用一次。如果开启了两步验证，仍需输入验证码。',
        { label: '登录', href: '{{link}}' },
        fallbackLink('如果这不是你本人的操作，请忽略此邮件；没有此链接无法登录。如果按钮无法打开，请访问：')),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.deletionScheduled,
    name: 'Account: deletion scheduled',
    description: 'Sent when the owner requests account deletion. Variables: siteName, executeAfter, link (cancels the deletion).',
    defaultSubject: SUBJECTS['account.deletion-scheduled'].en,
    contents: {
      en: layout('en', 'Your account will be deleted',
        'Your account and its personal data will be deleted after {{executeAfter}}. Every session was signed out and API keys were revoked. Orders, refunds and payment records are kept as required for accounting.',
        { label: 'Keep my account', href: '{{link}}' },
        fallbackLink('If you did not ask for this, use the link to cancel and then change your password. If the button does not work, open:')),
      zh: layout('zh', '你的账户将被删除',
        '你的账户及个人数据将在 {{executeAfter}} 之后删除。所有会话已退出登录，API 密钥已撤销。订单、退款和付款记录会按会计要求保留。',
        { label: '保留我的账户', href: '{{link}}' },
        fallbackLink('如果这不是你本人的操作，请使用此链接取消，然后修改密码。如果按钮无法打开，请访问：')),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.deletionCompleted,
    name: 'Account: deletion completed',
    description: 'Sent to the former address once the account was anonymised; the delivery log row is removed afterwards. Variables: siteName.',
    defaultSubject: SUBJECTS['account.deletion-completed'].en,
    contents: {
      en: layout('en', 'Your account has been deleted', 'Your account was deleted and its personal data erased. Orders, refunds and payment records are kept without your contact details as required for accounting.',
        undefined, 'This is the last message sent to this address about the account.'),
      zh: layout('zh', '你的账户已删除', '你的账户已删除，个人数据已清除。订单、退款和付款记录会按会计要求保留，但不再包含你的联系方式。',
        undefined, '这是关于此账户发送到该邮箱的最后一封邮件。'),
    },
  },
  {
    key: MAIL_TEMPLATE_KEYS.twoFactorReset,
    name: 'Account: two-factor reset by staff',
    description: 'Sent when an administrator turns off the account\'s two-factor authentication (e.g. lost device). Variables: siteName, link (account security page).',
    defaultSubject: SUBJECTS['account.two-factor-reset'].en,
    contents: {
      en: layout('en', 'Two-factor authentication was turned off',
        'An administrator turned off two-factor authentication for your account and removed its recovery codes. Every session was signed out. Sign in with your password and set up two-factor authentication again.',
        { label: 'Open security settings', href: '{{link}}' },
        fallbackLink('If you did not ask for this, change your password now and contact support. If the button does not work, open:')),
      zh: layout('zh', '两步验证已被关闭',
        '管理员已关闭你账户的两步验证并删除了恢复码，所有会话均已退出登录。请使用密码登录后重新设置两步验证。',
        { label: '打开安全设置', href: '{{link}}' },
        fallbackLink('如果这不是你本人的请求，请立即修改密码并联系客服。如果按钮无法打开，请访问：')),
    },
  },
];

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
} as const;
export type MailTemplateKey = typeof MAIL_TEMPLATE_KEYS[keyof typeof MAIL_TEMPLATE_KEYS];
export type MailLocale = 'en' | 'zh';

const SUBJECTS: Readonly<Record<MailTemplateKey, Readonly<Record<MailLocale, string>>>> = {
  'account.verify': { en: 'Verify your email', zh: '验证你的邮箱' },
  'account.reset': { en: 'Reset your password', zh: '重置你的密码' },
  'account.welcome': { en: 'Welcome aboard', zh: '欢迎加入' },
  'billing.receipt': { en: 'Your payment receipt', zh: '你的付款收据' },
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
    description: 'Sent after a one-time purchase is fulfilled (best effort). Variables: siteName, name, orderId, description, amount, currency, credits, paidAt, link.',
    defaultSubject: SUBJECTS['billing.receipt'].en,
    contents: {
      en: layout('en', 'Thank you for your purchase',
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8">
          <tr><td style="color:#6b7280;padding-right:16px">Item</td><td>{{description}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Amount</td><td>{{amount}} {{currency}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Credits</td><td>{{credits}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Order</td><td>{{orderId}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">Paid</td><td>{{paidAt}}</td></tr>
        </table>`,
        { label: 'View orders', href: '{{link}}' }, 'This receipt confirms a payment processed for your account. Keep it for your records.'),
      zh: layout('zh', '感谢你的购买',
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8">
          <tr><td style="color:#6b7280;padding-right:16px">商品</td><td>{{description}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">金额</td><td>{{amount}} {{currency}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">积分</td><td>{{credits}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">订单号</td><td>{{orderId}}</td></tr>
          <tr><td style="color:#6b7280;padding-right:16px">付款时间</td><td>{{paidAt}}</td></tr>
        </table>`,
        { label: '查看订单', href: '{{link}}' }, '此收据确认你的账户已完成一笔付款，请妥善保存。'),
    },
  },
];

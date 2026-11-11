import { describe, expect, it } from 'vitest';
import { MailTemplateCatalog } from '@zucker-framework/notification';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { ACCOUNT_MAIL_TEMPLATES, MAIL_TEMPLATE_KEYS, defaultMailSubject } from '@zucker-framework/back-office/mail';

/**
 * Rendering of the account-security mails (magic link, deletion scheduled/completed, staff 2FA reset)
 * through the same catalog the MailService uses: variables escaped, links restricted to http(s), no
 * unresolved placeholders, both languages. Synthetic values only.
 */
const catalog = new MailTemplateCatalog({
  database: { model: () => ({ findUnique: async () => null }) } as unknown as DatabaseAdapter,
  defaultLocale: 'en', contentFields: { en: 'htmlContentEn', zh: 'htmlContentZh' }, builtIns: ACCOUNT_MAIL_TEMPLATES,
});
async function render(key: string, locale: 'en' | 'zh', data: Record<string, unknown>) {
  return catalog.interpolate(catalog.select(await catalog.resolve(key), locale), { siteName: 'Synthetic <Site>', ...data });
}
const link = 'https://app.example.invalid/en/magic-link#ticket=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';

describe('account-security mail templates render', () => {
  for (const locale of ['en', 'zh'] as const) {
    it(`renders the sign-in link (${locale}) with the link in href and the site name escaped`, async () => {
      const html = await render(MAIL_TEMPLATE_KEYS.magicLink, locale, { link });
      expect(html).toContain(`href="${link}"`);
      expect(html).toContain('Synthetic &lt;Site&gt;');
      expect(html).not.toMatch(/\{\{\w+\}\}/);
      expect(html).toContain(locale === 'en' ? '15 minutes' : '15 分钟');
    });

    it(`renders the deletion-scheduled notice (${locale}) with the date and the cancel link`, async () => {
      const cancel = 'https://app.example.invalid/en/login#cancel-deletion=ticket_value';
      const html = await render(MAIL_TEMPLATE_KEYS.deletionScheduled, locale, { executeAfter: '2026-11-17 10:00 UTC', link: cancel });
      expect(html).toContain('2026-11-17 10:00 UTC');
      expect(html).toContain(`href="${cancel}"`);
      expect(html).not.toMatch(/\{\{\w+\}\}/);
    });

    it(`renders the deletion-completed notice (${locale}) without any link`, async () => {
      const html = await render(MAIL_TEMPLATE_KEYS.deletionCompleted, locale, {});
      expect(html).not.toMatch(/\{\{\w+\}\}/);
      expect(html).not.toContain('href=');
      expect(html).toContain(locale === 'en' ? 'Your account has been deleted' : '你的账户已删除');
    });

    it(`renders the staff two-factor reset notice (${locale})`, async () => {
      const security = 'https://app.example.invalid/en/account/security';
      const html = await render(MAIL_TEMPLATE_KEYS.twoFactorReset, locale, { link: security });
      expect(html).toContain(`href="${security}"`);
      expect(html).not.toMatch(/\{\{\w+\}\}/);
    });
  }

  it('neutralises a non-http link and escapes markup in text variables', async () => {
    const html = await render(MAIL_TEMPLATE_KEYS.deletionScheduled, 'en', { executeAfter: '<b>soon</b>', link: 'javascript:alert(1)' });
    // The fallback text may show the value as escaped text; no href may carry the scheme.
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toContain('<b>soon</b>');
    expect(html).toContain('&lt;b&gt;soon&lt;/b&gt;');
  });

  it('has localised default subjects for the new keys', () => {
    expect(defaultMailSubject('account.magic-link', 'zh-CN')).toBe('你的登录链接');
    expect(defaultMailSubject('account.deletion-scheduled', 'en')).toBe('Your account is scheduled for deletion');
    expect(defaultMailSubject('account.deletion-completed', 'zh')).toBe('你的账户已删除');
    expect(defaultMailSubject('account.two-factor-reset', 'en')).toBe('Two-factor authentication was turned off');
  });
});

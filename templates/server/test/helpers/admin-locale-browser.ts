/**
 * Locale-aware additions to fe-admin-browser.ts for specs that run the admin in English or switch
 * language. The fe-admin locale is stored as `zucker-admin-locale` (`zh-CN` | `en-US`).
 */
import { expect as browserExpect, type BrowserContext, type Page } from '@playwright/test';

export type AdminLocale = 'zh-CN' | 'en-US';
const copy = {
  'zh-CN': { username: '用户名', password: '密码', submit: '登录', language: '语言' },
  'en-US': { username: 'Username', password: 'Password', submit: 'Sign in', language: 'Language' },
} as const;

/** Start every page of the context in this locale (before the app reads localStorage). */
export async function presetLocale(context: BrowserContext, locale: AdminLocale) {
  await context.addInitScript((value) => {
    if (!localStorage.getItem('zucker-admin-locale')) localStorage.setItem('zucker-admin-locale', value);
  }, locale);
}

/**
 * The first visit to a fresh Vite dev server may optimize dependencies and reload; wait for the
 * login form with a generous timeout so later steps can use the normal page timeouts.
 */
export async function warmUp(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto('/login');
    await page.locator('input[name="username"]').waitFor({ state: 'visible', timeout: 45_000 });
    await page.waitForLoadState('networkidle');
  }
}

/** Sign in through the login form in the given locale and wait to leave the login route. */
export async function loginAs(page: Page, username: string, password: string, locale: AdminLocale = 'zh-CN') {
  const text = copy[locale];
  await page.goto('/login');
  await page.getByRole('textbox', { name: text.username, exact: true }).fill(username);
  await page.getByRole('textbox', { name: text.password, exact: true }).fill(password);
  await page.getByRole('button', { name: text.submit, exact: true }).click();
  await browserExpect(page).not.toHaveURL(/\/login(?:\?|$)/);
}

/** Switch with the visible header/login language select; `from` is the locale currently shown. */
export async function switchLanguage(page: Page, to: AdminLocale, from: AdminLocale = to === 'en-US' ? 'zh-CN' : 'en-US') {
  await page.getByRole('combobox', { name: copy[from].language, exact: true }).selectOption(to);
  await browserExpect(page.locator('html')).toHaveAttribute('lang', to);
}

/**
 * Single source of the routed locales. Both locales always ship; a generated project chooses its
 * default at create time through DEFAULT_LOCALE (inlined at build time by next.config.ts so the
 * proxy, server and browser bundles agree). Unset or empty means `en`.
 *
 * This module has no runtime imports so node tests can load it directly.
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export const FALLBACK_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Empty/unset selects the fallback; any other unknown value is a configuration error. */
export function resolveDefaultLocale(value: string | undefined): Locale {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return FALLBACK_LOCALE;
  if (!isLocale(trimmed))
    throw new Error(`DEFAULT_LOCALE must be one of ${LOCALES.join(', ')} (received "${trimmed}")`);
  return trimmed;
}

export const DEFAULT_LOCALE: Locale = resolveDefaultLocale(process.env.DEFAULT_LOCALE);

/** Routed locales with the default first, matching the order alternates and sitemaps emit. */
export const ROUTED_LOCALES: readonly Locale[] = [
  DEFAULT_LOCALE,
  ...LOCALES.filter((locale) => locale !== DEFAULT_LOCALE),
];

/** BCP 47 tags used for hreflang and Open Graph locale. */
export const LOCALE_TAGS: Record<Locale, { hreflang: string; openGraph: string }> = {
  en: { hreflang: 'en', openGraph: 'en_US' },
  zh: { hreflang: 'zh-CN', openGraph: 'zh_CN' },
};

/** Names shown in the switcher and the suggestion banner, each in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', zh: '中文' };

/** Banner copy is written in the suggested language so a visitor who cannot read the current one understands it. */
export const LOCALE_SUGGESTION: Record<Locale, { message: string; switchTo: string; dismiss: string }> = {
  en: { message: 'This site is also available in English.', switchTo: 'Switch to English', dismiss: 'Dismiss' },
  zh: { message: '本站提供中文版本。', switchTo: '切换到中文', dismiss: '关闭' },
};

/** Best supported locale from an Accept-Language-style preference list, or undefined. */
export function preferredLocale(preferences: readonly string[]): Locale | undefined {
  for (const preference of preferences) {
    const base = preference.trim().toLowerCase().split(/[-_;]/)[0];
    if (isLocale(base)) return base;
  }
  return undefined;
}

'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALE_NAMES, ROUTED_LOCALES, isLocale } from '@/lib/site/locales';

/** Switches language on the same page, keeping the path and query string. */
export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const t = useTranslations('shell'),
    locale = useLocale(),
    pathname = usePathname(),
    router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <select
      aria-label={t('language')}
      value={locale}
      disabled={pending}
      data-testid="locale-switcher"
      onChange={(event) => {
        const next = event.target.value;
        if (!isLocale(next) || next === locale) return;
        const search = typeof window === 'undefined' ? '' : window.location.search;
        startTransition(() => router.replace(`${pathname}${search}`, { locale: next }));
      }}
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm ${className}`}
    >
      {ROUTED_LOCALES.map((value) => (
        <option key={value} value={value} lang={value}>
          {LOCALE_NAMES[value]}
        </option>
      ))}
    </select>
  );
}
